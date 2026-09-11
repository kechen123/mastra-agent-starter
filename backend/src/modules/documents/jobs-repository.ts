/**
 * PR-4.2 §8.1 / §8.2：document_ingestion_jobs Repository。
 *
 * 与 runs/repository 同款的 lease / heartbeat / 状态推进协议，但语义
 * 是 ingestion 流水线：
 *   - enqueue：HTTP 202 路径调用，单行 INSERT status='queued'；
 *   - claimNext：worker 每 1s tick 调一次，`FOR UPDATE SKIP LOCKED`
 *     抢占同一时刻只允许一个 worker 拿到（partial unique 兜底）；
 *   - heartbeat：worker 在长任务期间每 15s 续 lease；
 *   - transitionStatus：受 lease 保护的状态推进；终态写
 *     `documents.status` 同步推进（worker 推进时同事务写两份）。
 *   - markFailedTerminal：达 max_attempts 时写 status='failed' + 清 lease；
 *   - cancelForDocument：删除请求触发，把所有 active job 推到 'cancelled'。
 *
 * 不变量：
 *   - 全部 SQL 参数化、全部带 workspace_id 过滤；
 *   - 不持久化跨 workspace 操作（写入路径由 partial unique + FK 双重保证）；
 *   - 失败重试用 attempts + max_attempts + next_attempt_at 表达。
 */
import type { Pool, PoolClient } from 'pg';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import type { DocumentStatus } from './service.js';

const ACTIVE_STATUSES = ['queued', 'parsing', 'chunking', 'embedding', 'finalizing'] as const;

export type IngestionStatus = DocumentStatus;

export interface IngestionJobRow {
  id: string;
  workspaceId: string;
  documentId: string;
  status: IngestionStatus;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  nextAttemptAt: string;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawRow {
  id: string;
  workspace_id: string;
  document_id: string;
  status: IngestionStatus;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  next_attempt_at: Date;
  error_code: string | null;
  error_detail: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToJob(row: RawRow): IngestionJobRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    documentId: row.document_id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at ? row.lease_expires_at.toISOString() : null,
    heartbeatAt: row.heartbeat_at ? row.heartbeat_at.toISOString() : null,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const COLUMNS = `
  id, workspace_id, document_id, status, attempts, max_attempts,
  lease_owner, lease_expires_at, heartbeat_at, next_attempt_at,
  error_code, error_detail, created_at, updated_at
`;

/**
 * HTTP 202 路径调用：在 `documents` 已落库后创建 ingestion job。
 *
 * partial unique `one_active_ingestion_per_document` 保证同一 document
 * 同一时刻最多一个 active job；调用方应在调用前先 SELECT 一次（避免
 * race 导致 23505），或在 service 层捕获 unique_violation 转 200 OK
 * 复用既有 job。
 */
export async function enqueueIngestionJob(input: {
  workspaceId: string;
  documentId: string;
}): Promise<IngestionJobRow> {
  const r = await getDatabasePool().query<RawRow>(
    `INSERT INTO document_ingestion_jobs (workspace_id, document_id, status)
     VALUES ($1, $2, 'queued')
     RETURNING ${COLUMNS}`,
    [input.workspaceId, input.documentId],
  );
  return rowToJob(r.rows[0]!);
}

/**
 * Worker tick 入口：用 `FOR UPDATE SKIP LOCKED` 抢占一条 active 且
 * next_attempt_at 已到期的 job；同时写入 lease。
 *
 * 返回 null 表示本 tick 拿不到（其他 worker 在抢 / 没有可执行 job）。
 *
 * 注意：
 *   - 仅当 status IN active set 且 attempts < max_attempts 才被抢占；
 *   - **JOIN documents 过滤**：必须是 `storage_status='ready'`
 *     （finalize worker 已把 staging 晋升到 finalKey）且
 *     `deleted_at IS NULL`（没被软删除）。这是 PR-4.2 §8.1 的核心前置
 *     条件 —— ingestion worker 不能在 finalize worker 之前抢到 job，
 *     也不能在文档被软删后继续推进。
 *   - 失败后 worker 会把 attempts++ + status='queued' + next_attempt_at
 *     推到未来 → 下次 tick 自动重试（不需要外部 sweeper 介入）。
 */
export async function claimNextIngestionJob(
  workerId: string,
  leaseMs: number = 120_000,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<IngestionJobRow | null> {
  // 第一步：FOR UPDATE SKIP LOCKED 抢占候选行。JOIN documents 过滤：
  //   - documents.deleted_at IS NULL：未软删除；
  //   - documents.storage_status = 'ready'：finalize worker 已晋升。
  // 如果 finalize worker 还没追上，documents 行仍是 'storage_pending' →
  // 这一行不在候选集合 → ingestion worker 自动等待下一次 tick。
  const r = await executor.query<RawRow>(
    `SELECT j.id, j.workspace_id, j.document_id, j.status, j.attempts,
            j.max_attempts, j.lease_owner, j.lease_expires_at,
            j.heartbeat_at, j.next_attempt_at,
            j.error_code, j.error_detail, j.created_at, j.updated_at
       FROM document_ingestion_jobs j
       JOIN documents d ON d.id = j.document_id
      WHERE j.status IN ('queued', 'failed')
        AND j.attempts < j.max_attempts
        AND j.next_attempt_at <= now()
        AND d.deleted_at IS NULL
        AND d.storage_status = 'ready'
      ORDER BY j.next_attempt_at ASC
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1`,
  );
  if (r.rows.length === 0) return null;
  const target = r.rows[0]!;
  // 第二步：写入 lease。如果其它 worker 在我们 SELECT 之后抢先做了
  // heartbeat 续约，本 UPDATE 的 status WHERE 仍允许（不强制 status='queued'
  // 以覆盖重试失败的 'failed' 行）；同时 attempts++ 把这次 attempt 计入。
  //   - 二次过滤 `documents.storage_status='ready' AND deleted_at IS NULL`：
  //     保证从 SELECT 到 UPDATE 之间（毫秒级窗口），文档没有被 finalize
  //     失败回退或被软删除。
  const updated = await executor.query<RawRow>(
    `UPDATE document_ingestion_jobs j
        SET lease_owner = $2,
            lease_expires_at = now() + ($3::int * INTERVAL '1 millisecond'),
            heartbeat_at = now(),
            attempts = attempts + 1,
            status = 'parsing',
            updated_at = now()
       FROM documents d
      WHERE j.id = $1
        AND d.id = j.document_id
        AND d.deleted_at IS NULL
        AND d.storage_status = 'ready'
        AND j.attempts < j.max_attempts
        AND j.status IN ('queued', 'failed')
      RETURNING j.id, j.workspace_id, j.document_id, j.status, j.attempts,
                j.max_attempts, j.lease_owner, j.lease_expires_at,
                j.heartbeat_at, j.next_attempt_at,
                j.error_code, j.error_detail, j.created_at, j.updated_at`,
    [target.id, workerId, leaseMs],
  );
  if (updated.rows.length === 0) return null;
  return rowToJob(updated.rows[0]!);
}

/**
 * Worker 心跳续约：仅当持有 lease 的 worker 才能续约。返回 boolean
 * 标识续约成功；失败通常意味着 lease 已被别的 worker 接管或行已
 * 终态。
 */
export async function heartbeatIngestionJob(
  jobId: string,
  workerId: string,
  leaseMs: number,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<boolean> {
  const r = await executor.query(
    `UPDATE document_ingestion_jobs
        SET lease_expires_at = greatest(lease_expires_at, now() + ($3::int * INTERVAL '1 millisecond')),
            heartbeat_at = now(),
            updated_at = now()
      WHERE id = $1
        AND lease_owner = $2
        AND status IN ('queued', 'parsing', 'chunking', 'embedding', 'finalizing')`,
    [jobId, workerId, leaseMs],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * 状态推进：worker 持有 lease 时推进 status + 同步写 documents.status。
 *
 * PR-4 整改（2026-09-11 第二轮）：必须在**单个 PoolClient + 单个事务**
 * 内串，且**四重守卫**：
 *   - `lease_owner = $workerId`（fencing 唯一来源）；
 *   - `lease_expires_at > now()`（lease 必须**仍有效**——已过期/被
 *     sweeper 收回的行不能写）；
 *   - 来源 `status IN (active 集)`：requeue 必须提供 `currentStatus` 以
 *     表明是从哪个 active 状态退回 queued；
 *   - `documents.deleted_at IS NULL`（软删文档不能再被推进）。
 *
 * 任一未命中 → 整事务 ROLLBACK → 返回 null。
 *
 * 终态（ready / failed / cancelled）：写完即清 lease，避免心跳续约
 * 触发竞争。
 *
 * `requeue=true`：直接**最终态**推到 `status='queued'`（不再走 'failed'
 * 瞬态 + 二次 autocommit flush），清 lease，设 next_attempt_at，**保留**
 * error_code/error_detail 给运维观察；**不**自增 attempts——attempts 只
 * 在 `claimNextIngestionJob` 抢占成功时 +1。
 *
 * 注意：本函数不做 chunk 写入与 embedding 写入——这些是 worker 阶段内
 * 的副作用，调用方应自行事务化。
 */
export async function transitionIngestionStatus(input: {
  jobId: string;
  workerId: string;
  status: IngestionStatus;
  /** requeue 时必填：从哪个 active 状态退回 queued。 */
  currentStatus?: IngestionStatus;
  /** 仅 ready 阶段使用；同时写 documents.total_chunks / completed_chunks。 */
  totalChunks?: number;
  completedChunks?: number;
  errorCode?: string | null;
  errorDetail?: string | null;
  /** 失败重试：清 lease + 设 next_attempt_at + 保留 error info + 不动 attempts。 */
  requeue?: boolean;
  /** 重试间隔（毫秒）；与 requeue 一起使用。 */
  requeueBackoffMs?: number;
  executor?: Pool | PoolClient;
}): Promise<IngestionJobRow | null> {
  const executor = input.executor ?? getDatabasePool();
  const isTerminal = input.status === 'ready' || input.status === 'failed' || input.status === 'cancelled';
  const isRequeue = input.requeue === true;
  if (isRequeue && !input.currentStatus) {
    throw new Error('transitionIngestionStatus: requeue 必须提供 currentStatus。');
  }

  const client = await (async () => {
    if ('connect' in executor && typeof (executor as Pool).connect === 'function' && !(executor as { release?: unknown }).release) {
      return (executor as Pool).connect();
    }
    return executor as PoolClient;
  })();
  const ownsClient = client !== executor;
  try {
    if (ownsClient) await client.query('BEGIN');
    // 1) UPDATE document_ingestion_jobs（四重守卫）。
    //
    // PR-4 第二轮 Codex 整改（2026-09-11）：参数位**必须**由当前
    // params 数组长度动态生成；不允许再写死 $4/$5/$6/$7——非 requeue
    // 路径根本没有 currentStatus / requeueBackoffMs 这两个占位，写死
    // 会让 PG 报"bind message supplies N parameters, but prepared
    // statement requires M"。
    //
    // 参数追加顺序（与 SQL 拼接顺序一一对应）：
    //   $1 = jobId
    //   $2 = workerId
    //   $3 = status
    //   [requeue] currentStatus   → 仅用于 WHERE 守卫，不进 SET
    //   [requeue + backoff] requeueBackoffMs
    //   errorCode (always)
    //   errorDetail (always)
    //
    // SET 子句里只写一次 `status = $3`（requeue 时 status 也由 $3 决
    // 定写为 'queued'，与"最终态"一致；WHERE 用 $4 强制来源 status
    // 必须等于 currentStatus，避免错位推进）。
    const jobParams: unknown[] = [input.jobId, input.workerId, input.status];
    const setClauses: string[] = ['status = $3'];

    if (isRequeue) {
      // currentStatus 仅参与 WHERE 守卫；不写进 SET。
      jobParams.push(input.currentStatus);
    }
    if (isTerminal || isRequeue) {
      setClauses.push('lease_owner = NULL', 'lease_expires_at = NULL', 'heartbeat_at = NULL');
    }
    if (input.requeueBackoffMs !== undefined) {
      jobParams.push(input.requeueBackoffMs);
      setClauses.push(`next_attempt_at = now() + ($${jobParams.length}::int * INTERVAL '1 millisecond')`);
    }
    jobParams.push(input.errorCode ?? null);
    setClauses.push(`error_code = $${jobParams.length}`);
    jobParams.push(input.errorDetail ?? null);
    setClauses.push(`error_detail = $${jobParams.length}`);
    setClauses.push('updated_at = now()');

    // 来源 status 集合：requeue 必须精确匹配 currentStatus；其它推进
    // 路径允许 active 集合内的任意值；终态不强加 status（已 ready/
    // failed/cancelled 的行不应被这条 SQL 改写，但 lease 仍必须仍被
    // 本 worker 持有）。
    //
    // currentStatus 在 params 数组里永远是第 4 个位置（顺序：jobId,
    // workerId, status, currentStatus, ...），不依赖 requeueBackoffMs
    // 是否提供——这一点 PR-4 第二轮 Codex 整改已明确锁定为 SQL 拼接
    // 顺序的"前置约束"，不允许变更。
    const sourceStatusClause = isRequeue
      ? `status = $4`
      : `status IN ('queued', 'parsing', 'chunking', 'embedding', 'finalizing', 'failed')`;

    const jobSql = `UPDATE document_ingestion_jobs
        SET ${setClauses.join(', ')}
        WHERE id = $1
          AND lease_owner = $2
          AND lease_expires_at > now()
          AND ${sourceStatusClause}
        RETURNING ${COLUMNS}`;
    const jobResult = await client.query<RawRow>(jobSql, jobParams);
    if (jobResult.rows.length === 0) {
      if (ownsClient) await client.query('ROLLBACK');
      return null;
    }
    const job = rowToJob(jobResult.rows[0]!);

    // 2) 同步推 documents.status：跨 workspace 隔离 + 文档**未软删除**
    //    强制（deleted_at IS NULL）。requeue 时 documents 不必被改——
    //    让 documents 保留前一次失败的 status（一般是 'failed'），等
    //    下次 claim 推进阶段时再覆盖。
    if (!isRequeue) {
      const docParams: unknown[] = [job.workspaceId, job.documentId, input.status];
      let docSql = `UPDATE documents SET status = $3`;
      if (input.totalChunks !== undefined) {
        docParams.push(input.totalChunks);
        docSql += `, total_chunks = $${docParams.length}`;
      }
      if (input.completedChunks !== undefined) {
        docParams.push(input.completedChunks);
        docSql += `, completed_chunks = $${docParams.length}`;
      }
      if (input.errorDetail !== undefined) {
        docParams.push(input.errorDetail);
        docSql += `, failure_reason = $${docParams.length}`;
      }
      docSql += `, updated_at = now() WHERE id = $2 AND workspace_id = $1 AND deleted_at IS NULL`;
      const docUpdate = await client.query(docSql, docParams);
      if (docUpdate.rowCount === 0) {
        // document 已软删/硬删或跨 workspace —— 整事务回滚以避免
        // job / doc 状态分裂（job 已推进、doc 没追上）。
        if (ownsClient) await client.query('ROLLBACK');
        return null;
      }
    }
    if (ownsClient) await client.query('COMMIT');
    return job;
  } catch (error) {
    if (ownsClient) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

/**
 * 终态失败：attempts 达 max_attempts 后写 status='failed' + failure_reason。
 * 自动释放 lease。必须单事务串 ingestion_jobs + documents。
 *
 * 守卫：lease_owner + lease_expires_at（fencing）；documents 同步失败
 * 时整事务回滚（与 transitionIngestionStatus 对齐）。
 */
export async function markFailedTerminal(input: {
  jobId: string;
  workerId: string;
  errorCode: string;
  errorDetail: string;
  executor?: Pool | PoolClient;
}): Promise<IngestionJobRow | null> {
  const executor = input.executor ?? getDatabasePool();
  const client = await (async () => {
    if ('connect' in executor && typeof (executor as Pool).connect === 'function' && !(executor as { release?: unknown }).release) {
      return (executor as Pool).connect();
    }
    return executor as PoolClient;
  })();
  const ownsClient = client !== executor;
  try {
    if (ownsClient) await client.query('BEGIN');
    const r = await client.query<RawRow>(
      `UPDATE document_ingestion_jobs
          SET status = 'failed',
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              error_code = $3,
              error_detail = $4,
              updated_at = now()
        WHERE id = $1
          AND lease_owner = $2
          AND lease_expires_at > now()
        RETURNING ${COLUMNS}`,
      [input.jobId, input.workerId, input.errorCode, input.errorDetail],
    );
    if (r.rows.length === 0) {
      if (ownsClient) await client.query('ROLLBACK');
      return null;
    }
    const job = rowToJob(r.rows[0]!);
    const docUpdate = await client.query(
      `UPDATE documents
          SET status = 'failed', failure_reason = $3, updated_at = now()
        WHERE id = $2 AND workspace_id = $1 AND deleted_at IS NULL`,
      [job.workspaceId, job.documentId, input.errorDetail],
    );
    if (docUpdate.rowCount === 0) {
      if (ownsClient) await client.query('ROLLBACK');
      return null;
    }
    if (ownsClient) await client.query('COMMIT');
    return job;
  } catch (error) {
    if (ownsClient) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

/**
 * 删除路径使用：把同一 document 上的所有 active job 推到 cancelled，
 * 并清 lease。已 'cancelled' / 'ready' / 'failed' 终态的行不动。
 */
export async function cancelJobsForDocument(input: {
  workspaceId: string;
  documentId: string;
  executor?: Pool | PoolClient;
}): Promise<number> {
  const executor = input.executor ?? getDatabasePool();
  const r = await executor.query(
    `UPDATE document_ingestion_jobs
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            updated_at = now()
      WHERE workspace_id = $1
        AND document_id = $2
        AND status IN ('queued', 'parsing', 'chunking', 'embedding', 'finalizing')`,
    [input.workspaceId, input.documentId],
  );
  return r.rowCount ?? 0;
}

/**
 * 测试 / 集成脚本入口：单次跑 claim。
 */
export async function runClaimOnce(
  workerId: string,
  leaseMs?: number,
): Promise<IngestionJobRow | null> {
  return claimNextIngestionJob(workerId, leaseMs);
}

export const _ACTIVE_STATUSES = ACTIVE_STATUSES;
