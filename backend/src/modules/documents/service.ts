import {
  ResourceNotFoundError,
  CrossWorkspaceAccessError,
} from '../../server/error-mapping.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';

/**
 * PR-4.1 §8.1：文档状态机 8 态。
 *
 * - queued / parsing / chunking / embedding / finalizing / ready / failed / cancelled
 * - 取消语义：删除请求走单事务写入 `cancelled` + 软删除 + outbox，
 *   而不是硬删行（保留 outbox 重试需要 document_id 仍可读）。
 * - ingestion worker 推进时与 `document_ingestion_jobs.status` 同步写。
 */
export type DocumentStatus =
  | 'queued'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'finalizing'
  | 'ready'
  | 'failed'
  | 'cancelled';

/**
 * PR-4.1 §8.1：对象存储侧生命周期。Core 与 RAG 都用，与 `vector` 扩展无关。
 * - `storage_pending`：HTTP 202 刚返回、staging 还在 finalize worker 队列里。
 * - `ready`：finalize 成功、对象已落到 finalKey；ingestion worker 的前置条件。
 * - `storage_failed`：finalize 5 次重试耗尽，等待人工介入（仍可让 document
 *   进入 failed ingestion 路径，避免前端永远转圈）。
 */
export type DocumentStorageStatus = 'storage_pending' | 'ready' | 'storage_failed';

export interface DocumentSummary {
  id: string;
  knowledgeBaseId: string;
  name: string;
  type: string;
  size: number;
  status: DocumentStatus;
  storageStatus: DocumentStorageStatus;
  storageKey: string;
  sha256: string;
  totalChunks: number;
  completedChunks: number;
  errorMessage: string | null;
  failureReason: string | null;
  chunkCount: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DocumentRow {
  id: string;
  knowledge_base_id: string;
  name: string;
  type: string;
  size: string | number;
  status: DocumentStatus;
  storage_status: DocumentStorageStatus;
  storage_key: string;
  sha256: string;
  total_chunks: number;
  completed_chunks: number;
  error_message: string | null;
  failure_reason: string | null;
  chunk_count: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const documentFields = `
  d.id,
  d.knowledge_base_id,
  d.name,
  d.type,
  d.size,
  d.status,
  d.storage_status,
  d.storage_key,
  d.sha256,
  d.total_chunks,
  d.completed_chunks,
  d.error_message,
  d.failure_reason,
  COUNT(c.id)::int AS chunk_count,
  d.deleted_at,
  d.created_at,
  d.updated_at
`;

const documentJoins = `
  FROM documents d
  LEFT JOIN document_chunks c ON c.document_id = d.id
`;

/**
 * PR-4.1 §8.1：HTTP 202 路径立即落库的最小 INSERT。
 *
 * 注意：service 层只负责"占位 + 入队"，并不解析 / embedding。真正的
 * parse / chunk / embed / finalize 由 ingestion worker 异步推进；
 * 这里把 `status='queued' + storage_status='storage_pending'` 落定后
 * 立即返回给路由层。
 */
export async function createDocument(
  workspaceId: string,
  knowledgeBaseId: string,
  input: {
    name: string;
    type: string;
    size: number;
    storageKey: string;
    sha256: string;
  },
): Promise<DocumentSummary> {
  const pool = getDatabasePool();
  // 父 KB 不属于 workspace → 跨 workspace 访问，抛 CrossWorkspaceAccessError（404）。
  const kbCheck = await pool.query<{ id: string }>(
    'SELECT id FROM knowledge_bases WHERE id = $1 AND workspace_id = $2',
    [knowledgeBaseId, workspaceId],
  );
  if (kbCheck.rows.length === 0) {
    throw new CrossWorkspaceAccessError();
  }

  const result = await pool.query<DocumentRow>(`
    WITH created AS (
      INSERT INTO documents (
        workspace_id, knowledge_base_id, name, type, size,
        status, storage_status, storage_key, sha256
      )
      VALUES ($1, $2, $3, $4, $5, 'queued', 'storage_pending', $6, $7)
      RETURNING
        id, knowledge_base_id, name, type, size,
        status, storage_status, storage_key, sha256,
        total_chunks, completed_chunks,
        error_message, failure_reason,
        deleted_at, created_at, updated_at
    )
    SELECT created.*, 0::int AS chunk_count FROM created
  `, [
    workspaceId,
    knowledgeBaseId,
    input.name,
    input.type,
    input.size,
    input.storageKey,
    input.sha256,
  ]);
  return toDocument(result.rows[0]!);
}

export async function listDocuments(
  workspaceId: string,
  knowledgeBaseId?: string,
): Promise<DocumentSummary[]> {
  const filterKb = knowledgeBaseId ? 'AND d.knowledge_base_id = $2' : '';
  const result = await getDatabasePool().query<DocumentRow>(`
    SELECT ${documentFields}
    ${documentJoins}
    WHERE d.workspace_id = $1 ${filterKb}
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `, knowledgeBaseId ? [workspaceId, knowledgeBaseId] : [workspaceId]);
  return result.rows.map(toDocument);
}

export async function getDocument(workspaceId: string, docId: string): Promise<DocumentSummary | null> {
  const result = await getDatabasePool().query<DocumentRow>(`
    SELECT ${documentFields}
    ${documentJoins}
    WHERE d.id = $1 AND d.workspace_id = $2
    GROUP BY d.id
  `, [docId, workspaceId]);
  // 查询类：跨 workspace 0 行返 null（不抛错，与其他 query 语义一致）。
  return result.rows[0] ? toDocument(result.rows[0]) : null;
}

/**
 * 通过 (workspace_id, knowledge_base_id, sha256) 命中现有未软删 record。
 *
 * 调用方使用此函数避免重复上传：若 dedup 命中，HTTP 上传路由应跳过
 * 入队与 storage 写入，并把已有 record 返回给调用方（前端视为"上传成功"）。
 *
 * 注意：调用方仍要负责清理 staging 对象；此函数不主动 remove。
 */
export async function findActiveDocumentBySha(
  workspaceId: string,
  knowledgeBaseId: string,
  sha256: string,
): Promise<DocumentSummary | null> {
  const result = await getDatabasePool().query<DocumentRow>(`
    SELECT ${documentFields}
    ${documentJoins}
    WHERE d.workspace_id = $1
      AND d.knowledge_base_id = $2
      AND d.sha256 = $3
      AND d.deleted_at IS NULL
    GROUP BY d.id
    ORDER BY d.created_at DESC
    LIMIT 1
  `, [workspaceId, knowledgeBaseId, sha256]);
  return result.rows[0] ? toDocument(result.rows[0]) : null;
}

export async function updateDocumentStatus(
  workspaceId: string,
  docId: string,
  status: DocumentStatus,
  errorMessage: string | null = null,
): Promise<void> {
  const result = await getDatabasePool().query(`
    UPDATE documents
    SET status = $3, error_message = $4, updated_at = now()
    WHERE id = $1 AND workspace_id = $2
  `, [docId, workspaceId, status, errorMessage]);
  // 用户资源写：rowCount===0 → 抛 ResourceNotFoundError（404）。
  if (result.rowCount === 0) {
    throw new ResourceNotFoundError('文档不存在。');
  }
}

/**
 * PR-4.1 §8.1：软删除走单事务串联 4 个动作（documents / outbox /
 * finalize_jobs / ingestion_jobs）。失败全部回滚，保留 outbox 与 jobs
 * 的可重放语义；硬删除留待维护者手动执行。
 */
export async function softDeleteDocument(workspaceId: string, docId: string): Promise<void> {
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 1. 读出 storage_key（用于 outbox）；该行必须属于 workspace。
    const docLookup = await client.query<{ storage_key: string }>(
      'SELECT storage_key FROM documents WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
      [docId, workspaceId],
    );
    if (docLookup.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new ResourceNotFoundError('文档不存在。');
    }
    const storageKey = docLookup.rows[0]!.storage_key;

    // 2. documents 软删除 + status='cancelled'。outbox 用 SET NULL FK，
    //    因此软删不会"带走"outbox；outbox worker 必须能在文档行不可见后
    //    仍凭 storage_key 把对象清掉。
    await client.query(
      `UPDATE documents
       SET deleted_at = now(), status = 'cancelled', updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
      [docId, workspaceId],
    );

    // 3. storage finalize jobs 取消，避免 worker 再去 finalize 一个
    //    已被取消的对象。PR-4.2 整改：也要取消 'processing' 行（被
    //    worker 抢占但尚未提交 done 的瞬态）—— 否则 worker 可能在已
    //    被软删的 document 上把 storage_status='ready'。同时清
    //    heartbeat_at 与 ingestion jobs 对齐。
    await client.query(
      `UPDATE storage_finalize_jobs
       SET status = 'cancelled',
           lease_owner = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           updated_at = now()
       WHERE document_id = $1 AND workspace_id = $2
         AND status IN ('pending', 'processing')`,
      [docId, workspaceId],
    );

    // 4. 任何 active ingestion job 也一起 cancelled。**PR-4 整改**：
    //    必须清 lease_owner / lease_expires_at / heartbeat_at——否则已
    //    软删除文档会被旧 worker 拿着 stale lease 继续推进 documents
    //    行（已 deleted_at IS NULL 通过 SELECT，但 worker 不知道）。
    await client.query(
      `UPDATE document_ingestion_jobs
       SET status = 'cancelled',
           lease_owner = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           updated_at = now()
       WHERE document_id = $1 AND workspace_id = $2
         AND status IN ('queued', 'parsing', 'chunking', 'embedding', 'finalizing')`,
      [docId, workspaceId],
    );

    // 5. outbox：唯一的"必须最终清零"载体；attempts 由 worker 重试时 ++。
    await client.query(
      `INSERT INTO storage_deletion_outbox (storage_key, document_id)
       VALUES ($1, $2)`,
      [storageKey, docId],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 保留旧 `deleteDocument` 行为供尚未迁移的调用方使用（PR-4 范围内仅
 * 给 fallback）。新代码必须走 `softDeleteDocument`。
 */
export async function deleteDocument(workspaceId: string, docId: string): Promise<boolean> {
  const result = await getDatabasePool().query(
    'DELETE FROM documents WHERE id = $1 AND workspace_id = $2',
    [docId, workspaceId],
  );
  // 用户资源写：rowCount===0 → 抛 ResourceNotFoundError（404）。
  if (result.rowCount === 0) {
    throw new ResourceNotFoundError('文档不存在。');
  }
  return true;
}

function toDocument(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    name: row.name,
    type: row.type,
    size: Number(row.size),
    status: row.status,
    storageStatus: row.storage_status,
    storageKey: row.storage_key,
    sha256: row.sha256,
    totalChunks: row.total_chunks,
    completedChunks: row.completed_chunks,
    errorMessage: row.error_message,
    failureReason: row.failure_reason,
    chunkCount: row.chunk_count,
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
