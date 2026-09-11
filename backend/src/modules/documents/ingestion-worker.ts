/**
 * PR-4.2 §8.1：异步 ingestion Worker。
 *
 * 启动路径：`backend/src/server/bootstrap.ts` 在 `startRunExecutor` /
 * `startApprovalTimeoutWorker` 之后调 `startIngestionWorker()`。
 *
 * 循环（每 1s tick）：
 *   1. `claimNextIngestionJob(WORKER_ID)` —— SKIP LOCKED 抢占。
 *   2. 按 `documents.status` 推进：`parsing → chunking → embedding →
 *      finalizing → ready`；每阶段调对应模块；
 *   3. 每 15s 心跳续 lease。
 *   4. 失败路径：
 *      - attempts < max_attempts → status='queued' +
 *        next_attempt_at = now() + exp_backoff；
 *      - attempts >= max_attempts → status='failed' + failure_reason。
 *   5. 终态（ready / failed / cancelled）：释放 lease。
 *
 * 关键不变量：
 *   - **绝不在**事务内做网络 / 文件 / embedding 调用；任何外部 IO
 *     都在事务外完成。
 *   - Worker 不调任何 HTTP 路由；所有阶段调用都直接走模块函数。
 *   - 跨实例安全：partial unique 阻止同一 document 同时被两个 worker
 *     抢占；SKIP LOCKED 保证两个 worker 不会在 tick 内抢到同一行。
 *   - 进度写：`documents.completed_chunks` 每写完一个 chunk 同步 +1，
 *     前端轮询即可看到真实进度。
 *   - 失败时 `documents.failure_reason` 写用户可见的脱敏错误文本；
 *     `document_ingestion_jobs.error_code` / `error_detail` 写机器可
 *     读字段（worker 不暴露内部 cause / response body）。
 *
 * Core-only 模式：
 *   - `ragEnabled=false` 时跳过 embedding 计算与 `document_embeddings`
 *     写入；只保留 chunk 文本写入。这样 Core-only 部署下 retriever
 *     自然退化为 keyword match（由后续 PR 决定是否实现）。
 */
import { randomUUID } from 'node:crypto';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { getDocumentStorage } from '../../infrastructure/storage/document-storage.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { config } from '../../config.js';
import { getParser } from './parsers/registry.js';
import { UnsupportedDocumentTypeError } from './parsers/types.js';
import { splitText, type TextChunk } from './text-splitter.js';
import {
  claimNextIngestionJob,
  heartbeatIngestionJob,
  markFailedTerminal,
  transitionIngestionStatus,
  type IngestionJobRow,
} from './jobs-repository.js';
import { embedTexts } from '../knowledge/rag/embedding-service.js';
import { getOrCreateActiveEmbeddingProfile } from '../knowledge/rag/embedding-profile-repository.js';
import { MinerUClientError, MinerUParseError } from './parsers/mineru-client.js';

const DEFAULT_LEASE_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 1_000;
const SWEEPER_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000; // 上限 5 分钟（PR-4.2 §8.1）

const WORKER_ID = `${process.env.HOSTNAME ?? 'host'}-${process.pid}-${randomUUID().slice(0, 8)}`;

declare global {
  // eslint-disable-next-line no-var
  var __xuanshuIngestionWorkerStarted: boolean | undefined;
}

let pollInterval: NodeJS.Timeout | null = null;
let sweeperInterval: NodeJS.Timeout | null = null;
const activeJobs = new Set<string>();

export function isIngestionWorkerStarted(): boolean {
  return Boolean(globalThis.__xuanshuIngestionWorkerStarted);
}

/**
 * 拉起 worker；幂等。同一进程多次调用不会重启。
 */
export async function startIngestionWorker(): Promise<void> {
  if (globalThis.__xuanshuIngestionWorkerStarted) return;
  globalThis.__xuanshuIngestionWorkerStarted = true;
  sweeperInterval = setInterval(() => {
    void sweepExpiredIngestionLeases();
  }, SWEEPER_INTERVAL_MS);
  sweeperInterval.unref?.();
  pollInterval = setInterval(() => {
    void claimAndRunOnce();
  }, POLL_INTERVAL_MS);
  pollInterval.unref?.();
  logger.info({ msg: 'Ingestion worker 已启动', workerId: WORKER_ID });
}

export async function stopIngestionWorker(): Promise<void> {
  globalThis.__xuanshuIngestionWorkerStarted = false;
  if (pollInterval) clearInterval(pollInterval);
  if (sweeperInterval) clearInterval(sweeperInterval);
  pollInterval = null;
  sweeperInterval = null;
  // 给正在跑的任务一点时间完成当前阶段；超时硬退出。
  const deadline = Date.now() + 5_000;
  while (activeJobs.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 测试 / 集成脚本入口：单次跑 claim + execute（不等 tick）。
 */
export async function runIngestionWorkerOnce(): Promise<IngestionJobRow | null> {
  return claimAndRunOnceSync();
}

/**
 * 单次 tick：抢一条 job；同步执行；返回抢到的行（或 null）。
 *
 * 把"抢 + 执行"封装到一个函数内，方便测试单步。
 */
async function claimAndRunOnce(): Promise<IngestionJobRow | null> {
  try {
    const job = await claimNextIngestionJob(WORKER_ID, DEFAULT_LEASE_MS);
    if (!job) return null;
    // 异步执行 tick 的 pipeline；不 await 避免阻塞后续 tick。
    activeJobs.add(job.id);
    void runJobPipeline(job).finally(() => activeJobs.delete(job.id));
    return job;
  } catch (err) {
    logger.error({ msg: 'claimAndRunOnce 失败', err });
    return null;
  }
}

/** 测试同步入口：等到 pipeline 走完再返回最新行。 */
async function claimAndRunOnceSync(): Promise<IngestionJobRow | null> {
  const job = await claimNextIngestionJob(WORKER_ID, DEFAULT_LEASE_MS);
  if (!job) return null;
  activeJobs.add(job.id);
  try {
    await runJobPipeline(job);
    return job;
  } finally {
    activeJobs.delete(job.id);
  }
}

/**
 * 单 job pipeline：parsing → chunking → embedding → finalizing → ready。
 *
 * 错误处理：
 *   - parse 阶段抛 `UnsupportedDocumentTypeError`：立刻终态 failed（不重试）；
 *   - parse / chunk 抛其它错误：attempts++ 重试，超限 → failed；
 *   - embedding 抛错：同上；
 *   - finalizing 抛错：同上；
 *   - DB 推进抛错：log + 不释放 lease，等下一轮 tick 通过 sweeper 接管。
 */
async function runJobPipeline(job: IngestionJobRow): Promise<void> {
  // 心跳定时器。
  const heartbeat = setInterval(() => {
    void heartbeatIngestionJob(job.id, WORKER_ID, DEFAULT_LEASE_MS).catch((err) => {
      logger.error({ msg: 'ingestion heartbeat failed', jobId: job.id, err });
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    await runPipelinePhases(job);
  } catch (err) {
    logger.error({ msg: 'ingestion pipeline failed', jobId: job.id, err });
    await handlePipelineError(job, err);
  } finally {
    clearInterval(heartbeat);
  }
}

async function runPipelinePhases(job: IngestionJobRow): Promise<void> {
  // 读 document 元数据。
  const docRow = await getDatabasePool().query<{
    id: string;
    workspace_id: string;
    knowledge_base_id: string;
    name: string;
    type: string;
    storage_key: string;
  }>(
    `SELECT id, workspace_id, knowledge_base_id, name, type, storage_key
       FROM documents
      WHERE id = $1 AND workspace_id = $2`,
    [job.documentId, job.workspaceId],
  );
  if (docRow.rows.length === 0) {
    // document 已被硬删；job 直接 failed 即可。
    await markFailedTerminal({
      jobId: job.id,
      workerId: WORKER_ID,
      errorCode: 'DOCUMENT_NOT_FOUND',
      errorDetail: 'document 行不存在。',
    });
    return;
  }
  const document = docRow.rows[0]!;

  // 1) parsing：从 storage 读 bytes → 解析。
  const transitioned = await transitionIngestionStatus({
    jobId: job.id,
    workerId: WORKER_ID,
    status: 'parsing',
  });
  if (!transitioned) {
    logger.warn({ msg: 'parsing 阶段 lease 已丢失，跳过本 job', jobId: job.id });
    return;
  }
  const bytes = await getDocumentStorage().getBytes(document.storage_key);
  const parser = getParser({ filename: document.name, mimeType: document.type });
  let parsed;
  try {
    parsed = await parser.parse({
      filename: document.name,
      mimeType: document.type,
      buffer: bytes,
    });
  } catch (error) {
    if (error instanceof UnsupportedDocumentTypeError) {
      // 用户上传时已校验过；这里再 throw 一次通常是 storage 文件被改坏。
      // 不重试，直接 failed。
      await markFailedTerminal({
        jobId: job.id,
        workerId: WORKER_ID,
        errorCode: 'UNSUPPORTED_DOCUMENT_TYPE',
        errorDetail: error.message.slice(0, 1_000),
      });
      return;
    }
    throw error;
  }

  // 2) chunking：调用 splitText，写入 document_chunks（不含 embedding）。
  const toChunking = await transitionIngestionStatus({
    jobId: job.id,
    workerId: WORKER_ID,
    status: 'chunking',
  });
  if (!toChunking) return;
  const textChunks: TextChunk[] = splitText(parsed.markdown);
  if (textChunks.length === 0) {
    // 空文档：跳过 embedding / chunk 写入，直接 finalizing。
    await transitionIngestionStatus({
      jobId: job.id,
      workerId: WORKER_ID,
      status: 'finalizing',
    });
    await finalizeReady({ job, document, totalChunks: 0, completedChunks: 0 });
    return;
  }
  // 删除旧 chunk（重试场景）+ 写新 chunk。
  await replaceChunks(job, document, textChunks, parsed);
  // 写完 chunks 后回写 total_chunks，让前端看到真实进度。
  await getDatabasePool().query(
    `UPDATE documents
        SET total_chunks = $3, completed_chunks = 0, updated_at = now()
      WHERE id = $1 AND workspace_id = $2`,
    [document.id, job.workspaceId, textChunks.length],
  );

  // 3) embedding：仅 ragEnabled 才计算并写入 document_embeddings。
  if (config.ragEnabled) {
    const toEmbedding = await transitionIngestionStatus({
      jobId: job.id,
      workerId: WORKER_ID,
      status: 'embedding',
    });
    if (!toEmbedding) return;
    const vectors = await embedTexts(textChunks.map((c) => c.content));
    await writeEmbeddings(job, document, textChunks, vectors);
    await getDatabasePool().query(
      `UPDATE documents
          SET completed_chunks = $3, updated_at = now()
        WHERE id = $1 AND workspace_id = $2`,
      [document.id, job.workspaceId, textChunks.length],
    );
  } else {
    // Core-only 模式：completed_chunks 直接等于 total_chunks（chunk 已落库）。
    await getDatabasePool().query(
      `UPDATE documents
          SET completed_chunks = total_chunks, updated_at = now()
        WHERE id = $1 AND workspace_id = $2`,
      [document.id, job.workspaceId],
    );
  }

  // 4) finalizing：状态推进，无副作用。
  const toFinalizing = await transitionIngestionStatus({
    jobId: job.id,
    workerId: WORKER_ID,
    status: 'finalizing',
  });
  if (!toFinalizing) return;

  // 5) ready：终态。
  await finalizeReady({
    job,
    document,
    totalChunks: textChunks.length,
    completedChunks: textChunks.length,
  });
}

async function replaceChunks(
  job: IngestionJobRow,
  document: {
    id: string;
    workspace_id: string;
    knowledge_base_id: string;
    name: string;
    type: string;
  },
  chunks: TextChunk[],
  parsed: { metadata: { parser: string; sourceFormat: string } },
): Promise<void> {
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM document_chunks WHERE document_id = $1 AND workspace_id = $2',
      [document.id, job.workspaceId],
    );
    const BATCH = 50;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const values: unknown[] = [];
      const rows: string[] = [];
      batch.forEach((chunk, idx) => {
        const offset = idx * 6;
        const metadata = {
          documentName: document.name,
          documentType: document.type,
          startChar: chunk.startChar,
          endChar: chunk.endChar,
          parser: parsed.metadata.parser,
          sourceFormat: parsed.metadata.sourceFormat,
          ...(chunk.heading ? { heading: chunk.heading } : {}),
        };
        values.push(
          job.workspaceId,
          document.knowledge_base_id,
          document.id,
          chunk.content,
          chunk.chunkIndex,
          JSON.stringify(metadata),
        );
        rows.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::jsonb)`);
      });
      await client.query(
        `INSERT INTO document_chunks
           (workspace_id, knowledge_base_id, document_id, content, chunk_index, metadata)
         VALUES ${rows.join(', ')}`,
        values,
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function writeEmbeddings(
  job: IngestionJobRow,
  document: { id: string; workspace_id: string },
  chunks: TextChunk[],
  vectors: number[][],
): Promise<void> {
  if (vectors.length !== chunks.length) {
    throw new Error(
      `embedding 返回数量不匹配：chunks=${chunks.length}, vectors=${vectors.length}`,
    );
  }
  // RAG 表（document_embeddings / embedding_profiles）由条件 DDL 创建；
  // Core-only 模式不会到这里（config.ragEnabled=false）。
  // 找到 workspace 当前激活 profile；PR-4 整改：第一次 ingest 原子
  // 创建 active 行（并发安全：partial unique 兜底）。
  const profile = await getOrCreateActiveEmbeddingProfile({
    workspaceId: job.workspaceId,
  });
  if (profile.dimensions !== vectors[0]?.length) {
    throw new Error(
      `embedding 维度不匹配：profile=${profile.dimensions}, actual=${vectors[0]?.length ?? '?'}`,
    );
  }

  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    // 删除旧 embeddings（重试场景）。
    await client.query(
      `DELETE FROM document_embeddings
        WHERE document_id = $1 AND workspace_id = $2 AND profile_id = $3`,
      [document.id, job.workspaceId, profile.id],
    );
    // 读 chunk id 列表（保持 chunk_index 顺序）。
    const chunkIds = await client.query<{ id: string; chunk_index: number }>(
      `SELECT id, chunk_index FROM document_chunks
        WHERE document_id = $1 AND workspace_id = $2
        ORDER BY chunk_index ASC`,
      [document.id, job.workspaceId],
    );
    const idByIndex = new Map<number, string>();
    for (const row of chunkIds.rows) idByIndex.set(row.chunk_index, row.id);

    // 批量写入 embeddings。
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const chunkId = idByIndex.get(chunk.chunkIndex);
      if (!chunkId) continue;
      const vector = vectors[i]!;
      await client.query(
        `INSERT INTO document_embeddings
           (workspace_id, document_id, chunk_id, profile_id, embedding, dimensions, content_hash)
         VALUES ($1, $2, $3, $4, $5::vector, $6, $7)
         ON CONFLICT (chunk_id, profile_id) DO UPDATE
           SET embedding = EXCLUDED.embedding,
               dimensions = EXCLUDED.dimensions,
               content_hash = EXCLUDED.content_hash,
               updated_at = now()`,
        [
          job.workspaceId,
          document.id,
          chunkId,
          profile.id,
          `[${vector.join(',')}]`,
          profile.dimensions,
          chunk.content.slice(0, 200),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function finalizeReady(input: {
  job: IngestionJobRow;
  document: { id: string; workspace_id: string };
  totalChunks: number;
  completedChunks: number;
}): Promise<void> {
  await transitionIngestionStatus({
    jobId: input.job.id,
    workerId: WORKER_ID,
    status: 'ready',
    totalChunks: input.totalChunks,
    completedChunks: input.completedChunks,
  });
}

/**
 * 失败处理：区分重试与终态。
 *
 * 规则：
 *   - attempts < max_attempts → 退避重试；
 *   - attempts >= max_attempts → markFailedTerminal。
 */
async function handlePipelineError(job: IngestionJobRow, err: unknown): Promise<void> {
  const safeMessage = toSafeErrorMessage(err);
  const errorCode = classifyError(err);

  const latest = await getDatabasePool().query<{
    attempts: number;
    max_attempts: number;
    status: IngestionJobRow['status'];
  }>(
    `SELECT attempts, max_attempts, status FROM document_ingestion_jobs WHERE id = $1`,
    [job.id],
  );
  const attempts = latest.rows[0]?.attempts ?? job.attempts;
  const maxAttempts = latest.rows[0]?.max_attempts ?? job.maxAttempts;
  const currentStatus = latest.rows[0]?.status ?? job.status;

  if (attempts >= maxAttempts) {
    await markFailedTerminal({
      jobId: job.id,
      workerId: WORKER_ID,
      errorCode,
      errorDetail: safeMessage,
    });
    return;
  }

  // 退避重试：2^attempts * 1s，封顶 MAX_BACKOFF_MS。
  const backoffMs = Math.min(MAX_BACKOFF_MS, 2 ** attempts * 1_000);
  // PR-4 整改：单事务内直接 status='queued' + 清 lease + 设
  // next_attempt_at，**不**再走 failed 瞬态 + flush。attempts 不动
  // ——attempts 只在 claimNextIngestionJob 抢占成功时 +1。
  // currentStatus 必须来自最新 SELECT（worker 跑过几个 phase 后可能
  // 已 'chunking' / 'embedding' / 'finalizing'），由 SQL 的
  // status = $4 守卫强制校验并发安全。
  const transitioned = await transitionIngestionStatus({
    jobId: job.id,
    workerId: WORKER_ID,
    status: 'queued',
    currentStatus,
    errorCode,
    errorDetail: safeMessage,
    requeue: true,
    requeueBackoffMs: backoffMs,
  });
  if (!transitioned) {
    logger.warn({ msg: 'requeue transition 失败（lease 已丢失或 status 不符），本 job 留给 sweeper', jobId: job.id });
    return;
  }
}

function classifyError(err: unknown): string {
  if (err instanceof UnsupportedDocumentTypeError) return 'UNSUPPORTED_DOCUMENT_TYPE';
  if (err instanceof MinerUClientError) return 'MINERU_CLIENT_ERROR';
  if (err instanceof MinerUParseError) return 'MINERU_PARSE_ERROR';
  const message = err instanceof Error ? err.message : '';
  if (message.startsWith('Embedding ')) return 'EMBEDDING_PROVIDER_ERROR';
  if (message.startsWith('getBytes:')) return 'STORAGE_OBJECT_MISSING';
  if (message.includes('embedding 维度不匹配')) return 'EMBEDDING_DIM_MISMATCH';
  return 'INGESTION_UNKNOWN_ERROR';
}

function toSafeErrorMessage(err: unknown): string {
  if (err instanceof UnsupportedDocumentTypeError) return err.message;
  if (err instanceof MinerUClientError || err instanceof MinerUParseError) return err.message;
  const message = err instanceof Error ? err.message : '未知处理错误。';
  return message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgresql://[REDACTED]@')
    .slice(0, 1_000);
}

/**
 * 后台 Orphan sweeper：lease_expires_at < now() 的 ingestion job，
 * 重置 attempts++ 让下轮 claimNext 接管。失败达 max_attempts 的终态
 * 由 attempt 计数自动推进到 failed，不需要 sweeper 介入。
 */
async function sweepExpiredIngestionLeases(): Promise<void> {
  try {
    const r = await getDatabasePool().query(
      `UPDATE document_ingestion_jobs
          SET lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              status = CASE
                WHEN attempts >= max_attempts THEN 'failed'
                ELSE 'queued'
              END,
              next_attempt_at = now() + INTERVAL '5 seconds',
              updated_at = now()
        WHERE lease_owner IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()
          AND status IN ('queued', 'parsing', 'chunking', 'embedding', 'finalizing', 'failed')`,
    );
    if ((r.rowCount ?? 0) > 0) {
      logger.warn({ msg: 'ingestion lease sweep', reclaimed: r.rowCount });
    }
  } catch (err) {
    logger.error({ msg: 'ingestion lease sweeper failed', err });
  }
}

export const _ingestionWorkerId = WORKER_ID;
