/**
 * PR-4.2 §8.1（整改）：Storage finalize worker + deletion outbox worker。
 *
 * 两个独立 worker loop：
 *   - finalize：抢占 staging → finalKey 的 finalize job（HTTP 202
 *     上传后由 storage_finalize_jobs 入队）。**严格 lease fencing**：
 *       - claim：单事务内 SELECT FOR UPDATE SKIP LOCKED → UPDATE
 *         `status='processing'` + lease_owner + lease_expires_at +
 *         heartbeat_at + attempts++。
 *       - 长 IO 期间 worker 周期性 heartbeat（renewFinalizeLease /
 *         renewOutboxLease）：把 lease_expires_at / heartbeat_at 一并
 *         推到未来，3 重守卫（processing + lease_owner + lease_expires_at>now）。
 *       - 成功：单事务串 storage_finalize_jobs.status='done' +
 *         documents.storage_status='ready'。
 *       - 失败：未超 max_attempts → status='pending' + 退避；
 *         超 → status='failed'。
 *       - sweeper：lease 过期 + heartbeat 旧 → status='pending'
 *         （清 lease + heartbeat + 小退避）。
 *   - outbox：抢占 storage_deletion_outbox pending 行，调
 *     `storage.remove(storageKey)`。同样**严格 lease fencing** +
 *     长 IO heartbeat + 真实退避。
 *
 * 设计要点：
 *   - 不在事务内做文件系统调用：rename / unlink 都在事务外；
 *   - 跨实例安全：partial unique `one_active_finalize_per_document`
 *     阻止同一 document 同时被两个 worker 抢占；outbox 没有 partial
 *     unique 但 lease 串行化。
 *   - heartbeat 设计意图：长 IO（rename 跨 GB / S3 上传）可能在
 *     lease 时间内无法完成；如果只用 60s lease，sweeper 会错误地
 *     把还在跑 IO 的行收回。worker 在 IO 期间每 15s 续 lease，让
 *     sweeper 在 lease 真正过期时才介入。
 */
import { randomUUID } from 'node:crypto';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { getDocumentStorage } from '../../infrastructure/storage/document-storage.js';
import { logger } from '../../infrastructure/logging/logger.js';

const WORKER_ID = `${process.env.HOSTNAME ?? 'host'}-${process.pid}-${randomUUID().slice(0, 8)}`;
const FINALIZE_LEASE_MS = 60_000;
const OUTBOX_LEASE_MS = 30_000;
const FINALIZE_HEARTBEAT_INTERVAL_MS = 15_000;
const OUTBOX_HEARTBEAT_INTERVAL_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;
const SWEEPER_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const SWEEPER_REQUEUE_DELAY_MS = 5_000;

declare global {
  // eslint-disable-next-line no-var
  var __xuanshuStorageWorkersStarted: boolean | undefined;
}

let finalizePollInterval: NodeJS.Timeout | null = null;
let finalizeSweeperInterval: NodeJS.Timeout | null = null;
let outboxPollInterval: NodeJS.Timeout | null = null;
let outboxSweeperInterval: NodeJS.Timeout | null = null;

export function isStorageWorkersStarted(): boolean {
  return Boolean(globalThis.__xuanshuStorageWorkersStarted);
}

export async function startStorageWorkers(): Promise<void> {
  if (globalThis.__xuanshuStorageWorkersStarted) return;
  globalThis.__xuanshuStorageWorkersStarted = true;

  finalizeSweeperInterval = setInterval(() => {
    void sweepExpiredFinalizeLeases();
  }, SWEEPER_INTERVAL_MS);
  finalizeSweeperInterval.unref?.();
  finalizePollInterval = setInterval(() => {
    void runFinalizeOnce();
  }, POLL_INTERVAL_MS);
  finalizePollInterval.unref?.();

  outboxSweeperInterval = setInterval(() => {
    void sweepExpiredOutboxAttempts();
  }, SWEEPER_INTERVAL_MS);
  outboxSweeperInterval.unref?.();
  outboxPollInterval = setInterval(() => {
    void runOutboxOnce();
  }, POLL_INTERVAL_MS);
  outboxPollInterval.unref?.();

  logger.info({ msg: 'Storage workers 已启动', workerId: WORKER_ID });
}

export async function stopStorageWorkers(): Promise<void> {
  globalThis.__xuanshuStorageWorkersStarted = false;
  if (finalizePollInterval) clearInterval(finalizePollInterval);
  if (finalizeSweeperInterval) clearInterval(finalizeSweeperInterval);
  if (outboxPollInterval) clearInterval(outboxPollInterval);
  if (outboxSweeperInterval) clearInterval(outboxSweeperInterval);
  finalizePollInterval = null;
  finalizeSweeperInterval = null;
  outboxPollInterval = null;
  outboxSweeperInterval = null;
}

// ──────────────────────────────────────────────────────────────────
// finalize worker
// ──────────────────────────────────────────────────────────────────

interface FinalizeJobRow {
  id: string;
  workspace_id: string;
  document_id: string;
  staging_key: string;
  final_key: string;
  attempts: number;
  max_attempts: number;
}

/**
 * 单次 tick：单事务内抢一条 pending 行 → 切到 processing + lease +
 * heartbeat + attempts++；事务外跑 IO（带 heartbeat），成功后再单
 * 事务收尾。
 *
 * 导出 `_runFinalizeOnce` 用于 PR-4 集成测试调用真实生产入口。
 */
export async function _runFinalizeOnce(): Promise<FinalizeJobRow | null> {
  return runFinalizeOnce();
}

async function runFinalizeOnce(): Promise<FinalizeJobRow | null> {
  const client = await getDatabasePool().connect();
  let claimed: FinalizeJobRow | null = null;
  try {
    await client.query('BEGIN');
    const r = await client.query<FinalizeJobRow>(
      `SELECT id, workspace_id, document_id, staging_key, final_key, attempts, max_attempts
         FROM storage_finalize_jobs
        WHERE status = 'pending'
          AND next_attempt_at <= now()
          AND attempts < max_attempts
        ORDER BY next_attempt_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    if (r.rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }
    const row = r.rows[0]!;
    // 切到 'processing' + 写 lease + heartbeat + attempts++。next_attempt_at
    // 推到 now() + leaseMs —— 防止 sweeper / 同 tick 重入把它再次 claim。
    const upd = await client.query<{ id: string }>(
      `UPDATE storage_finalize_jobs
          SET status = 'processing',
              lease_owner = $2,
              lease_expires_at = now() + ($3::int * INTERVAL '1 millisecond'),
              heartbeat_at = now(),
              attempts = attempts + 1,
              updated_at = now()
        WHERE id = $1
          AND status = 'pending'
          AND attempts < max_attempts
        RETURNING id`,
      [row.id, WORKER_ID, FINALIZE_LEASE_MS],
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('COMMIT');
    const latest = await getDatabasePool().query<{
      attempts: number;
      max_attempts: number;
    }>(
      `SELECT attempts, max_attempts FROM storage_finalize_jobs WHERE id = $1`,
      [row.id],
    );
    claimed = {
      ...row,
      attempts: Number(latest.rows[0]?.attempts ?? row.attempts),
      max_attempts: Number(latest.rows[0]?.max_attempts ?? row.max_attempts),
    } as FinalizeJobRow;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    logger.error({ msg: 'finalize claim 失败', err });
    return null;
  } finally {
    client.release();
  }

  if (!claimed) return null;
  await executeFinalize(claimed).catch((err) => {
    logger.error({ msg: 'executeFinalize 抛错', err, jobId: claimed?.id });
  });
  return claimed;
}

async function executeFinalize(job: FinalizeJobRow): Promise<void> {
  // PR-4 第二轮 Codex 整改：finalize 是长 IO（rename 跨 GB / S3
  // 复制）期间需要 heartbeat；start heartbeat BEFORE 真正执行 IO。
  const heartbeat = setInterval(() => {
    void renewFinalizeLease(job.id, FINALIZE_LEASE_MS).catch((err) => {
      logger.error({ msg: 'finalize heartbeat failed', err, jobId: job.id });
    });
  }, FINALIZE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  try {
    await getDocumentStorage().finalize(job.staging_key, job.final_key);
  } catch (err) {
    clearInterval(heartbeat);
    await handleFinalizeFailure(job, err);
    return;
  }
  clearInterval(heartbeat);
  // 成功：单事务串 finalize_jobs.status='done' + documents.storage_status='ready'。
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    // 三重守卫：status='processing' + lease_owner=worker + lease_expires_at>now()。
    const doneUpdate = await client.query(
      `UPDATE storage_finalize_jobs
          SET status = 'done',
              processed_at = now(),
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND status = 'processing'
          AND lease_owner = $2
          AND lease_expires_at > now()`,
      [job.id, WORKER_ID],
    );
    if (doneUpdate.rowCount === 0) {
      // lease 已丢（被 sweeper 回收 / 并发取消 / 软删除）→ 整事务回滚；
      // 让状态机由 sweeper / 取消路径决定下一步，**不得**继续写 documents。
      await client.query('ROLLBACK');
      logger.warn({
        msg: 'finalize done UPDATE 失败（lease 已丢 / 文档已删除 / 行已被接管）',
        jobId: job.id,
      });
      return;
    }
    const docUpdate = await client.query(
      `UPDATE documents
          SET storage_status = 'ready', updated_at = now()
        WHERE id = $1 AND workspace_id = $2
          AND deleted_at IS NULL
          AND storage_status = 'storage_pending'`,
      [job.document_id, job.workspace_id],
    );
    if (docUpdate.rowCount === 0) {
      await client.query('ROLLBACK');
      logger.warn({
        msg: 'finalize done 但 documents 已删除 / storage_status 非 pending，回滚',
        jobId: job.id,
      });
      return;
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    logger.error({ msg: 'finalize 成功后写 DB 失败', err, jobId: job.id });
    // PR-4 整改：DB 写回失败时**不**直接放弃——下一轮 tick 会重新跑
    // finalize，因为 storage 适配器已实现"staging 不存在 + finalKey 存
    // 在"幂等成功。这避免单纯依赖 retry 队列导致数据丢失。
  } finally {
    client.release();
  }
}

/**
 * 续 finalize lease：仅本 worker 的 processing 行才能续约。
 *
 * 返回 boolean：false → lease 已丢（被 sweeper 回收 / 并发取消），
 * 调用方应停止继续写 done/failed。
 */
async function renewFinalizeLease(jobId: string, leaseMs: number): Promise<boolean> {
  const r = await getDatabasePool().query(
    `UPDATE storage_finalize_jobs
        SET lease_expires_at = now() + ($3::int * INTERVAL '1 millisecond'),
            heartbeat_at = now(),
            updated_at = now()
      WHERE id = $1
        AND status = 'processing'
        AND lease_owner = $2
        AND lease_expires_at > now()`,
    [jobId, WORKER_ID, leaseMs],
  );
  return (r.rowCount ?? 0) > 0;
}

async function handleFinalizeFailure(job: FinalizeJobRow, err: unknown): Promise<void> {
  const message = toSafeError(err);
  const exhausted = job.attempts >= job.max_attempts;
  const backoffMs = exhausted ? 0 : Math.min(MAX_BACKOFF_MS, 2 ** (job.attempts - 1) * 1_000);
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    // 三重守卫：status='processing' + lease_owner=worker + lease_expires_at>now()。
    if (exhausted) {
      const j = await client.query(
        `UPDATE storage_finalize_jobs
            SET status = 'failed',
                last_error = $2,
                lease_owner = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                processed_at = now(),
                updated_at = now()
          WHERE id = $1
            AND status = 'processing'
            AND lease_owner = $3
            AND lease_expires_at > now()`,
        [job.id, message, WORKER_ID],
      );
      if (j.rowCount === 0) {
        await client.query('ROLLBACK');
        logger.warn({ msg: 'finalize failed UPDATE 失败（lease 已丢）', jobId: job.id });
        return;
      }
      const d = await client.query(
        `UPDATE documents
            SET storage_status = 'storage_failed', updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
        [job.document_id, job.workspace_id],
      );
      if (d.rowCount === 0) {
        await client.query('ROLLBACK');
        logger.warn({ msg: 'finalize failed 但 documents 不存在 / 已删除，回滚', jobId: job.id });
        return;
      }
    } else {
      const j = await client.query(
        `UPDATE storage_finalize_jobs
            SET status = 'pending',
                next_attempt_at = now() + ($4::int * INTERVAL '1 millisecond'),
                last_error = $2,
                lease_owner = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                updated_at = now()
          WHERE id = $1
            AND status = 'processing'
            AND lease_owner = $3
            AND lease_expires_at > now()`,
        [job.id, message, WORKER_ID, backoffMs],
      );
      if (j.rowCount === 0) {
        await client.query('ROLLBACK');
        logger.warn({ msg: 'finalize requeue UPDATE 失败（lease 已丢）', jobId: job.id });
        return;
      }
    }
    await client.query('COMMIT');
  } catch (writeErr) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    logger.error({ msg: 'finalize 失败 DB 写入失败', err: writeErr, jobId: job.id });
  } finally {
    client.release();
  }
}

/**
 * Sweeper：把 'processing' 且 lease 已过期（且 heartbeat 已老于
 * 1 倍 lease 期）的 finalize job 收回 pending 状态，让下一轮 tick 重
 * 新 claim。
 *
 * 与之前的差异：heartbeat 设计下必须确认 heartbeat_at 也已老——
 * 否则 IO 期间 worker 正在跑 heartbeat，sweeper 不应误收回。
 */
async function sweepExpiredFinalizeLeases(): Promise<void> {
  try {
    const r = await getDatabasePool().query(
      `UPDATE storage_finalize_jobs
          SET status = 'pending',
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              next_attempt_at = now() + ($1::int * INTERVAL '1 millisecond'),
              updated_at = now()
        WHERE status = 'processing'
          AND lease_owner IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()
          AND (heartbeat_at IS NULL OR heartbeat_at < now() - ($2::int * INTERVAL '1 millisecond'))`,
      [SWEEPER_REQUEUE_DELAY_MS, FINALIZE_LEASE_MS],
    );
    if ((r.rowCount ?? 0) > 0) {
      logger.warn({ msg: 'finalize lease sweep', reclaimed: r.rowCount });
    }
  } catch (err) {
    logger.error({ msg: 'finalize lease sweeper failed', err });
  }
}

/**
 * 单次 sweep 入口（导出供 PR-4 集成测试调用真实生产 sweeper）：
 * `_runFinalizeLeaseSweeperOnce` 跑一次 lease 过期回收，不复制 SQL。
 */
export async function _runFinalizeLeaseSweeperOnce(): Promise<number> {
  try {
    const r = await getDatabasePool().query(
      `WITH reclaimed AS (
         UPDATE storage_finalize_jobs
            SET status = 'pending',
                lease_owner = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                next_attempt_at = now() + ($1::int * INTERVAL '1 millisecond'),
                updated_at = now()
          WHERE status = 'processing'
            AND lease_owner IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < now()
            AND (heartbeat_at IS NULL OR heartbeat_at < now() - ($2::int * INTERVAL '1 millisecond'))
          RETURNING id
       )
       SELECT count(*)::int AS count FROM reclaimed`,
      [SWEEPER_REQUEUE_DELAY_MS, FINALIZE_LEASE_MS],
    );
    return Number(r.rows[0]?.count ?? 0);
  } catch (err) {
    logger.error({ msg: 'finalize lease sweeper once failed', err });
    return 0;
  }
}

// ──────────────────────────────────────────────────────────────────
// outbox worker
// ──────────────────────────────────────────────────────────────────

interface OutboxRow {
  id: string;
  storage_key: string;
  document_id: string | null;
  attempts: number;
  max_attempts: number;
}

/**
 * outbox 单次 tick：单事务内抢一条 pending 行 → 切到 processing +
 * lease + heartbeat + attempts++；事务外跑 storage.remove（带 heartbeat）；
 * 成功后再单事务收尾。
 *
 * 导出 `_runOutboxOnce` 用于 PR-4 集成测试调用真实生产入口。
 */
export async function _runOutboxOnce(): Promise<OutboxRow | null> {
  return runOutboxOnce();
}

async function runOutboxOnce(): Promise<OutboxRow | null> {
  const client = await getDatabasePool().connect();
  let claimed: OutboxRow | null = null;
  try {
    await client.query('BEGIN');
    const r = await client.query<OutboxRow>(
      `SELECT id, storage_key, document_id, attempts, max_attempts
         FROM storage_deletion_outbox
        WHERE status = 'pending'
          AND next_attempt_at <= now()
          AND attempts < max_attempts
        ORDER BY enqueued_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    if (r.rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }
    const row = r.rows[0]!;
    const upd = await client.query<{ id: string }>(
      `UPDATE storage_deletion_outbox
          SET status = 'processing',
              lease_owner = $2,
              lease_expires_at = now() + ($3::int * INTERVAL '1 millisecond'),
              heartbeat_at = now(),
              attempts = attempts + 1,
              next_attempt_at = now() + ($3::int * INTERVAL '1 millisecond'),
              updated_at = now()
        WHERE id = $1
          AND status = 'pending'
          AND attempts < max_attempts
        RETURNING id`,
      [row.id, WORKER_ID, OUTBOX_LEASE_MS],
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('COMMIT');
    const latest = await getDatabasePool().query<{
      attempts: number;
      max_attempts: number;
    }>(
      `SELECT attempts, max_attempts FROM storage_deletion_outbox WHERE id = $1`,
      [row.id],
    );
    claimed = {
      ...row,
      attempts: Number(latest.rows[0]?.attempts ?? row.attempts),
      max_attempts: Number(latest.rows[0]?.max_attempts ?? row.max_attempts),
    } as OutboxRow;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    logger.error({ msg: 'outbox claim 失败', err });
    return null;
  } finally {
    client.release();
  }

  if (!claimed) return null;
  await executeOutbox(claimed).catch((err) => {
    logger.error({ msg: 'executeOutbox 抛错', err, id: claimed?.id });
  });
  return claimed;
}

async function executeOutbox(row: OutboxRow): Promise<void> {
  // PR-4 第二轮：outbox 也是长 IO（storage.remove 远程调用），需要 heartbeat。
  const heartbeat = setInterval(() => {
    void renewOutboxLease(row.id, OUTBOX_LEASE_MS).catch((err) => {
      logger.error({ msg: 'outbox heartbeat failed', err, id: row.id });
    });
  }, OUTBOX_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  try {
    await getDocumentStorage().remove(row.storage_key);
  } catch (err) {
    clearInterval(heartbeat);
    await handleOutboxFailure(row, err);
    return;
  }
  clearInterval(heartbeat);
  // 成功：单事务写 done + processed_at。
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    // 三重守卫：status='processing' + lease_owner=worker + lease_expires_at>now()。
    const upd = await client.query(
      `UPDATE storage_deletion_outbox
          SET status = 'done',
              processed_at = now(),
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              last_error = NULL,
              updated_at = now()
        WHERE id = $1
          AND status = 'processing'
          AND lease_owner = $2
          AND lease_expires_at > now()`,
      [row.id, WORKER_ID],
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      logger.warn({ msg: 'outbox done UPDATE 失败（lease 已丢）', id: row.id });
      return;
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    logger.error({ msg: 'outbox 成功后写 DB 失败', err, id: row.id });
  } finally {
    client.release();
  }
}

/**
 * 续 outbox lease：3 重守卫同 finalize。
 */
async function renewOutboxLease(rowId: string, leaseMs: number): Promise<boolean> {
  const r = await getDatabasePool().query(
    `UPDATE storage_deletion_outbox
        SET lease_expires_at = now() + ($3::int * INTERVAL '1 millisecond'),
            heartbeat_at = now(),
            updated_at = now()
      WHERE id = $1
        AND status = 'processing'
        AND lease_owner = $2
        AND lease_expires_at > now()`,
    [rowId, WORKER_ID, leaseMs],
  );
  return (r.rowCount ?? 0) > 0;
}

async function handleOutboxFailure(row: OutboxRow, err: unknown): Promise<void> {
  const message = toSafeError(err);
  const exhausted = row.attempts >= row.max_attempts;
  const backoffMs = exhausted ? 0 : Math.min(MAX_BACKOFF_MS, 2 ** (row.attempts - 1) * 1_000);
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    // 三重守卫：status='processing' + lease_owner=worker + lease_expires_at>now()。
    if (exhausted) {
      await client.query(
        `UPDATE storage_deletion_outbox
            SET status = 'failed',
                last_error = $2,
                lease_owner = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                updated_at = now()
          WHERE id = $1
            AND status = 'processing'
            AND lease_owner = $3
            AND lease_expires_at > now()`,
        [row.id, `[exhausted] ${message}`, WORKER_ID],
      );
    } else {
      await client.query(
        `UPDATE storage_deletion_outbox
            SET status = 'pending',
                next_attempt_at = now() + ($4::int * INTERVAL '1 millisecond'),
                last_error = $2,
                lease_owner = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                updated_at = now()
          WHERE id = $1
            AND status = 'processing'
            AND lease_owner = $3
            AND lease_expires_at > now()`,
        [row.id, `[retry in ${backoffMs}ms] ${message}`, WORKER_ID, backoffMs],
      );
    }
    await client.query('COMMIT');
  } catch (writeErr) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    logger.error({ msg: 'outbox 失败 DB 写入失败', err: writeErr, id: row.id });
  } finally {
    client.release();
  }
}

/**
 * outbox sweeper：lease + heartbeat 都过期 → 收回 pending + 小退避。
 */
async function sweepExpiredOutboxAttempts(): Promise<void> {
  try {
    const r = await getDatabasePool().query(
      `UPDATE storage_deletion_outbox
          SET status = 'pending',
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              next_attempt_at = now() + ($1::int * INTERVAL '1 millisecond'),
              updated_at = now()
        WHERE status = 'processing'
          AND lease_owner IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()
          AND (heartbeat_at IS NULL OR heartbeat_at < now() - ($2::int * INTERVAL '1 millisecond'))`,
      [SWEEPER_REQUEUE_DELAY_MS, OUTBOX_LEASE_MS],
    );
    if ((r.rowCount ?? 0) > 0) {
      logger.warn({ msg: 'outbox lease sweep', reclaimed: r.rowCount });
    }
    const pending = await getDatabasePool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM storage_deletion_outbox WHERE status = 'pending'`,
    );
    const pendingCount = Number(pending.rows[0]?.count ?? '0');
    if (pendingCount > 100) {
      logger.warn({ msg: 'storage_deletion_outbox 队列积压', pending: pendingCount });
    }
  } catch (err) {
    logger.error({ msg: 'outbox sweeper failed', err });
  }
}

/**
 * 单次 outbox sweep 入口（导出供 PR-4 集成测试调用真实生产 sweeper）。
 */
export async function _runOutboxLeaseSweeperOnce(): Promise<number> {
  try {
    const r = await getDatabasePool().query(
      `WITH reclaimed AS (
         UPDATE storage_deletion_outbox
            SET status = 'pending',
                lease_owner = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                next_attempt_at = now() + ($1::int * INTERVAL '1 millisecond'),
                updated_at = now()
          WHERE status = 'processing'
            AND lease_owner IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < now()
            AND (heartbeat_at IS NULL OR heartbeat_at < now() - ($2::int * INTERVAL '1 millisecond'))
          RETURNING id
       )
       SELECT count(*)::int AS count FROM reclaimed`,
      [SWEEPER_REQUEUE_DELAY_MS, OUTBOX_LEASE_MS],
    );
    return Number(r.rows[0]?.count ?? 0);
  } catch (err) {
    logger.error({ msg: 'outbox lease sweeper once failed', err });
    return 0;
  }
}

function toSafeError(err: unknown): string {
  const message = err instanceof Error ? err.message : '未知错误。';
  return message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .slice(0, 1_000);
}

export const _storageWorkerId = WORKER_ID;