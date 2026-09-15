import { registerApiRoute } from '@mastra/core/server';
import { randomUUID } from 'node:crypto';
import {
  deleteDocument,
  findActiveDocumentBySha,
  getDocument,
  listDocuments,
  softDeleteDocument,
  type DocumentSummary,
} from '../../modules/documents/service.js';
import { getKnowledgeBase } from '../../modules/knowledge/service.js';
import { getDocumentStorage } from '../../infrastructure/storage/document-storage.js';
import { withAuthenticatedWorkspace } from '../../modules/auth/workspace-context.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import type { DocumentStorageStatus } from '../../modules/documents/service.js';
import {
  MAX_UPLOAD_FILE_SIZE,
  uploadBodyLimitMiddleware,
} from '../security/upload-body-limit.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const uploadDocumentRoute = registerApiRoute('/knowledge-bases/:id/documents', {
  method: 'POST',
  requiresAuth: true,
  // Mastra 将 Hono 类型内联在 @mastra/core；运行时 middleware 契约相同，
  // 但私有 symbol 让直接依赖的 Hono 类型无法结构兼容。
  middleware: uploadBodyLimitMiddleware as unknown as NonNullable<
    Parameters<typeof registerApiRoute>[1]['middleware']
  >,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const knowledgeBaseId = context.req.param('id');
    if (!isUuid(knowledgeBaseId)) return context.json({ message: '知识库 id 格式不正确。' }, 400);
    if (!(await getKnowledgeBase(authCtx.workspaceId, knowledgeBaseId))) {
      return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
    }
    const formData = await context.req.formData();
    const file = formData.get('file');
    const fileInput = validateFile(file);
    if ('message' in fileInput) return context.json(fileInput, 400);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fileInput.file.arrayBuffer());
    } catch {
      return context.json({ message: '读取上传文件失败。' }, 400);
    }

    // PR-4.2 §8.1（整改）：HTTP 202 异步上传。
    //   1) 落 staging（计算 sha256）；
    //   2) dedup 命中 → 200 + 既有 record + abort staging（命中是常态路径，
    //      不进事务，避免对同一 (workspace_id, knowledge_base_id, sha256)
    //      大量重复上传时反复 BEGIN）；
    //   3) 未命中 → **单事务** 串 3 个 INSERT（documents + ingestion_jobs
    //      + storage_finalize_jobs）。任何一步失败全部 ROLLBACK，不留
    //      orphan document row / orphan ingestion job。
    //   4) 跨并发 race：两个请求同时通过 `findActiveDocumentBySha`、
    //      同时进事务；partial unique `documents_dedup_unique_idx`
    //      (`workspace_id, knowledge_base_id, sha256` WHERE `deleted_at
    //      IS NULL`) 让其中一个 INSERT 抛 23505 → 整事务 ROLLBACK →
    //      重新跑 dedup 查询 → 返回 200 + abort staging。
    const buffer = Buffer.from(bytes);
    const uploadId = randomUUID();
    const { stagingKey, sha256 } = await getDocumentStorage().putStaging({
      uploadId,
      body: buffer,
      meta: { mimeType: fileInput.type, size: bytes.byteLength },
    });

    const existing = await findActiveDocumentBySha(
      authCtx.workspaceId,
      knowledgeBaseId,
      sha256,
    );
    if (existing) {
      // 命中：abort staging，向调用方返回已有 record（200）。
      await getDocumentStorage().abortStaging(stagingKey).catch(() => undefined);
      return context.json(existing, 200);
    }

    const finalKey = deriveFinalKey({
      workspaceId: authCtx.workspaceId,
      name: fileInput.name,
      sha256,
    });

    try {
      const { document, job } = await createUploadBundle({
        workspaceId: authCtx.workspaceId,
        knowledgeBaseId,
        name: fileInput.name,
        type: fileInput.type,
        size: bytes.byteLength,
        storageKey: finalKey,
        sha256,
        stagingKey,
      });
      return context.json(
        {
          documentId: document.id,
          jobId: job.id,
          status: document.status,
          stage: document.status,
          storageStatus: document.storageStatus,
        },
        202,
      );
    } catch (error) {
      // 23505 unique_violation：跨并发 race 导致两次上传同时穿过 dedup。
      // 重新查询一次（这次另一个 worker 已落库，能拿到）。命中后 abort
      // 本次 staging、返回 200 复用既有 record。
      if (isUniqueViolation(error)) {
        await getDocumentStorage().abortStaging(stagingKey).catch(() => undefined);
        const raced = await findActiveDocumentBySha(
          authCtx.workspaceId,
          knowledgeBaseId,
          sha256,
        );
        if (raced) {
          return context.json(raced, 200);
        }
        // 理论不应到达：另一 worker 落库后再次查询却查不到。
        // 把错误向上抛，让全局错误处理兜底 5xx。
      }
      throw error;
    }
  }),
});

export const listDocumentsRoute = registerApiRoute('/knowledge-bases/:id/documents', {
  method: 'GET',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const knowledgeBaseId = context.req.param('id');
    if (!isUuid(knowledgeBaseId)) return context.json({ message: '知识库 id 格式不正确。' }, 400);
    if (!(await getKnowledgeBase(authCtx.workspaceId, knowledgeBaseId))) {
      return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
    }
    return context.json(await listDocuments(authCtx.workspaceId, knowledgeBaseId));
  }),
});

export const getDocumentRoute = registerApiRoute('/documents/:id', {
  method: 'GET',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: '文档 id 格式不正确。' }, 400);
    const document = await getDocument(authCtx.workspaceId, id);
    return document
      ? context.json(document)
      : context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
  }),
});

export const deleteDocumentRoute = registerApiRoute('/documents/:id', {
  method: 'DELETE',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: '文档 id 格式不正确。' }, 400);
    // PR-4.2 §8.1：删除走单事务串联 4 个动作（documents 软删除 + finalize
    // 取消 + ingestion 取消 + outbox 入队）；HTTP 仍返回 204。
    await softDeleteDocument(authCtx.workspaceId, id);
    return context.body(null, 204);
  }),
});

function validateFile(value: FormDataEntryValue | null): { file: File; name: string; type: string } | { message: string } {
  if (!value || typeof value === 'string' || typeof value.arrayBuffer !== 'function') {
    return { message: '请使用 file 字段上传文件。' };
  }
  const name = value.name.trim();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  // 格式白名单由 ParserRegistry 统一管理，此处仅做基础校验
  if (value.size === 0) return { message: '不允许上传空文件。' };
  if (value.size > MAX_UPLOAD_FILE_SIZE) return { message: '文件不能超过 10 MB。' };
  return { file: value, name, type: extension || 'unknown' };
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * PR-4.2 §8.1：finalKey 命名空间。
 *
 * - `final/<workspaceId>/<sha256-prefix>-<safeName>.<ext>`
 * - sha256 前 16 字符作 collision-resistant 标识；后缀保留可读名。
 * - 不存任何敏感信息（无用户输入直接拼路径）；只做白名单字符过滤。
 */
function deriveFinalKey(input: { workspaceId: string; name: string; sha256: string }): string {
  const safeName = sanitizeFilename(input.name);
  const ext = safeName.includes('.') ? safeName.slice(safeName.lastIndexOf('.') + 1) : 'bin';
  return `final/${input.workspaceId}/${input.sha256.slice(0, 16)}-${Date.now()}.${ext}`;
}

function sanitizeFilename(name: string): string {
  // 仅保留 ASCII 字母数字 + 少数符号；其余替换为 '_'。限制长度避免路径过长。
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return cleaned.length > 0 ? cleaned : 'document';
}

/**
 * PR-4.2 §8.1（整改）：HTTP 202 路径上的 3 表原子写入。
 *
 * 必须在**单个 PoolClient / 单个事务**内串：
 *   - INSERT documents（partial unique `documents_dedup_unique_idx` 兜底）
 *   - INSERT document_ingestion_jobs
 *   - INSERT storage_finalize_jobs
 *
 * 任一步失败 → 整事务 ROLLBACK → 无 orphan document row / orphan job。
 *
 * 跨并发 race：两个 worker 同时通过 `findActiveDocumentBySha` dedup 检
 * 测时，第一个 INSERT documents 触发 partial unique → 23505 → caller
 * 走 catch 分支重新查 dedup。
 */
async function createUploadBundle(input: {
  workspaceId: string;
  knowledgeBaseId: string;
  name: string;
  type: string;
  size: number;
  storageKey: string;
  sha256: string;
  stagingKey: string;
}): Promise<{ document: DocumentSummary; job: { id: string } }> {
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    const document = await insertDocumentRow(client, {
      workspaceId: input.workspaceId,
      knowledgeBaseId: input.knowledgeBaseId,
      name: input.name,
      type: input.type,
      size: input.size,
      storageKey: input.storageKey,
      sha256: input.sha256,
    });
    const job = await insertIngestionJobRow(client, {
      workspaceId: input.workspaceId,
      documentId: document.id,
    });
    await insertFinalizeJobRow(client, {
      workspaceId: input.workspaceId,
      documentId: document.id,
      stagingKey: input.stagingKey,
      finalKey: input.storageKey,
    });
    await client.query('COMMIT');
    return { document, job: { id: job.id } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertDocumentRow(
  client: import('pg').PoolClient,
  input: {
    workspaceId: string;
    knowledgeBaseId: string;
    name: string;
    type: string;
    size: number;
    storageKey: string;
    sha256: string;
  },
): Promise<DocumentSummary> {
  const r = await client.query<{
    id: string;
    knowledge_base_id: string;
    name: string;
    type: string;
    size: string;
    status: DocumentSummary['status'];
    storage_status: DocumentStorageStatus;
    storage_key: string;
    sha256: string;
    total_chunks: number;
    completed_chunks: number;
    error_message: string | null;
    failure_reason: string | null;
    deleted_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `INSERT INTO documents (
       workspace_id, knowledge_base_id, name, type, size,
       status, storage_status, storage_key, sha256
     )
     VALUES ($1, $2, $3, $4, $5, 'queued', 'storage_pending', $6, $7)
     RETURNING
       id, knowledge_base_id, name, type, size,
       status, storage_status, storage_key, sha256,
       total_chunks, completed_chunks,
       error_message, failure_reason,
       deleted_at, created_at, updated_at`,
    [
      input.workspaceId,
      input.knowledgeBaseId,
      input.name,
      input.type,
      input.size,
      input.storageKey,
      input.sha256,
    ],
  );
  const row = r.rows[0]!;
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
    chunkCount: 0,
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function insertIngestionJobRow(
  client: import('pg').PoolClient,
  input: { workspaceId: string; documentId: string },
): Promise<{ id: string }> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO document_ingestion_jobs (workspace_id, document_id, status)
     VALUES ($1, $2, 'queued')
     RETURNING id`,
    [input.workspaceId, input.documentId],
  );
  if (!r.rows[0]) {
    throw new Error('insertIngestionJobRow: 没有返回行');
  }
  return { id: r.rows[0].id };
}

async function insertFinalizeJobRow(
  client: import('pg').PoolClient,
  input: { workspaceId: string; documentId: string; stagingKey: string; finalKey: string },
): Promise<void> {
  await client.query(
    `INSERT INTO storage_finalize_jobs (
       workspace_id, document_id, staging_key, final_key
     ) VALUES ($1, $2, $3, $4)`,
    [input.workspaceId, input.documentId, input.stagingKey, input.finalKey],
  );
}

/**
 * 判断 PG 抛错是否为 unique_violation（SQLSTATE 23505）。
 * pg 驱动把 SQLSTATE 挂在 err.code。
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === '23505';
}

// PR-4 第二轮 Codex 整改（2026-09-11）：把 createUploadBundle /
// isUniqueViolation 公开导出，供 `tests/integration/pr4-async-doc-rag-core.ts`
// 在 23505 race 测试里调用真实上传事务链，**不复刻** INSERT SQL。
// 生产路由仍只走 `uploadDocument` 暴露 HTTP 202；这两个导出是测试
// / 工具入口。
export { createUploadBundle, isUniqueViolation };

// 保留导入以避免 lint 报"未使用"。
export const _legacySymbols = { deleteDocument };
