import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { getDocumentStorage } from '../../infrastructure/storage/document-storage.js';
import { splitText } from '../documents/text-splitter.js';
import { embedTexts } from '../knowledge/rag/embedding-service.js';
import { getOrCreateActiveEmbeddingProfile } from '../knowledge/rag/embedding-profile-repository.js';
import { scanSensitiveData } from './sensitive-data-scanner.js';
import { SourceParserRegistry } from './parsers/registry.js';
import {
  UrlFetcher,
  UrlFetchTimeoutError,
  UrlFetchTooLargeError,
  UnsupportedUrlError,
  UnsafeUrlError,
} from './parsers/url-fetcher.js';
import type { SourceInput } from './parsers/types.js';

export class SensitiveSourceRejectedError extends Error {
  constructor() { super('检测到敏感凭据；当前安全凭据存储尚未完成，已拒绝保存。'); this.name = 'SensitiveSourceRejectedError'; }
}

export class SourceRejectedError extends Error {
  constructor(message: string) { super(message); this.name = 'SourceRejectedError'; }
}

export type { SourceInput };

const parserRegistry = new SourceParserRegistry();
const urlFetcher = new UrlFetcher();

export interface RecordedSource {
  id: string;
  title: string;
  type: 'text' | 'file' | 'url';
  knowledgeBaseId: string;
  createdAt: string;
  chunkCount: number;
}

const DAYMIND_KNOWLEDGE_BASE = 'Daymind 记录';

/**
 * Daymind 内部索引只按 workspace 解析。它不是 Conversation 的状态，也不应
 * 由前端传递或选择；保留 Knowledge Base 仅是为了复用既有 pgvector Retriever。
 */
export async function getDaymindKnowledgeBaseId(workspaceId: string): Promise<string | null> {
  const result = await getDatabasePool().query<{ id: string }>(
    `SELECT id FROM knowledge_bases
      WHERE workspace_id = $1 AND name = $2
      ORDER BY created_at ASC
      LIMIT 1`,
    [workspaceId, DAYMIND_KNOWLEDGE_BASE],
  );
  return result.rows[0]?.id ?? null;
}

export async function recordTextSource(workspaceId: string, rawContent: string, title?: string): Promise<RecordedSource> {
  const scan = scanSensitiveData(rawContent);
  if (scan.hasSensitiveData) throw new SensitiveSourceRejectedError();
  const normalized = rawContent.trim().replace(/\r\n/g, '\n');
  const contentHash = createHash('sha256').update(normalized).digest('hex');
  const sourceTitle = title?.trim() || normalized.split('\n').find(Boolean)?.slice(0, 80) || '未命名文本记录';
  return persistSource({
    workspaceId,
    type: 'text',
    title: sourceTitle,
    contentHash,
    normalizedContent: normalized,
    sourceMetadata: { parser: 'text', sourceFormat: 'txt' },
  });
}

/**
 * 把单条 Source 持久化到 sources / documents / document_chunks /
 * document_embeddings；并把 KB 与 Source 的幂等 upsert 收敛到同一事务里。
 *
 * 公共路径（text / file / url）都走这里，所以：
  - 工作区级 advisory lock 保证 KB 创建幂等；
  - Source upsert 由 (workspace_id, content_hash) 唯一约束保证；
  - 已有 Document 时短路返回，避免重复点击产生多份 chunks/embeddings。
 */
async function persistSource(input: {
  workspaceId: string;
  type: 'text' | 'file' | 'url';
  title: string;
  contentHash: string;
  normalizedContent: string;
  sourceMetadata: Record<string, unknown>;
  file?: { originalName: string; mimeType: string; size: number; storageKey: string };
}): Promise<RecordedSource> {
  const chunks = splitText(input.normalizedContent);
  const vectors = config.ragEnabled ? await embedTexts(chunks.map((c) => c.content)) : [];
  const profile = config.ragEnabled ? await getOrCreateActiveEmbeddingProfile({ workspaceId: input.workspaceId }) : null;
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.workspaceId]);
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM knowledge_bases WHERE workspace_id = $1 AND name = $2 ORDER BY created_at LIMIT 1',
      [input.workspaceId, DAYMIND_KNOWLEDGE_BASE],
    );
    let knowledgeBaseId = existing.rows[0]?.id;
    if (!knowledgeBaseId) {
      const created = await client.query<{ id: string }>(
        `INSERT INTO knowledge_bases (workspace_id, name, description)
         VALUES ($1, $2, 'Daymind 自动维护的已记录资料索引。')
         RETURNING id`,
        [input.workspaceId, DAYMIND_KNOWLEDGE_BASE],
      );
      knowledgeBaseId = created.rows[0]?.id;
    }
    if (!knowledgeBaseId) throw new Error('无法初始化 Daymind 资料索引。');
    const sourceInsert = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO sources (workspace_id, type, title, raw_content, normalized_content, content_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (workspace_id, content_hash) DO UPDATE SET updated_at = now()
       RETURNING id, created_at`,
      [input.workspaceId, input.type, input.title, input.normalizedContent, input.normalizedContent, input.contentHash, JSON.stringify(input.sourceMetadata)],
    );
    const sourceRow = sourceInsert.rows[0]!;
    const existingDocument = await client.query<{ id: string }>(
      `SELECT id FROM documents
        WHERE workspace_id = $1 AND knowledge_base_id = $2 AND source_id = $3
        ORDER BY created_at ASC
        LIMIT 1`,
      [input.workspaceId, knowledgeBaseId, sourceRow.id],
    );
    if (existingDocument.rows[0]) {
      await client.query('COMMIT');
      return {
        id: sourceRow.id,
        title: input.title,
        type: input.type,
        knowledgeBaseId,
        createdAt: sourceRow.created_at.toISOString(),
        chunkCount: chunks.length,
      };
    }
    const documentInsert = await client.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, knowledge_base_id, source_id, name, type, size, status, storage_status, storage_key, sha256, total_chunks, completed_chunks)
       VALUES ($1, $2, $3, $4, $5, $6, 'ready', 'ready', $7, $8, $9, $9)
       RETURNING id`,
      [
        input.workspaceId,
        knowledgeBaseId,
        sourceRow.id,
        input.title,
        input.type,
        input.file?.size ?? Buffer.byteLength(input.normalizedContent),
        input.file?.storageKey ?? `inline/${sourceRow.id}`,
        input.contentHash,
        chunks.length,
      ],
    );
    const documentId = documentInsert.rows[0]!.id;
    for (const chunk of chunks) {
      const r = await client.query<{ id: string }>(
        `INSERT INTO document_chunks (workspace_id, knowledge_base_id, document_id, content, chunk_index, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
        [
          input.workspaceId,
          knowledgeBaseId,
          documentId,
          chunk.content,
          chunk.chunkIndex,
          JSON.stringify({
            heading: chunk.heading,
            sourceId: sourceRow.id,
            parser: input.sourceMetadata.parser,
            sourceFormat: input.sourceMetadata.sourceFormat,
          }),
        ],
      );
      if (profile && vectors[chunk.chunkIndex]) {
        await client.query(
          `INSERT INTO document_embeddings (workspace_id, profile_id, document_id, chunk_id, embedding, dimensions, content_hash)
           VALUES ($1, $2, $3, $4, $5::vector, $6, $7)`,
          [
            input.workspaceId,
            profile.id,
            documentId,
            r.rows[0]!.id,
            `[${vectors[chunk.chunkIndex]!.join(',')}]`,
            profile.dimensions,
            createHash('sha256').update(chunk.content).digest('hex'),
          ],
        );
      }
    }
    await client.query('COMMIT');
    return {
      id: sourceRow.id,
      title: input.title,
      type: input.type,
      knowledgeBaseId,
      createdAt: sourceRow.created_at.toISOString(),
      chunkCount: chunks.length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function recordFileSource(workspaceId: string, file: {
  filename: string; mimeType?: string; buffer: Buffer;
}): Promise<RecordedSource> {
  if (file.buffer.length === 0) throw new SourceRejectedError('不允许上传空文件。');
  if (file.buffer.length > 10 * 1024 * 1024) throw new SourceRejectedError('文件不能超过 10 MB。');
  const ext = (file.filename.split('.').pop() ?? '').toLowerCase();
  if (!['txt', 'md', 'pdf', 'docx'].includes(ext)) throw new SourceRejectedError(`不支持的文件类型：.${ext}`);
  const parsed = await parserRegistry.parse({ kind: 'file', filename: file.filename, mimeType: file.mimeType, buffer: file.buffer });
  const scan = scanSensitiveData(parsed.text);
  if (scan.hasSensitiveData) throw new SensitiveSourceRejectedError();
  const normalized = parsed.text;
  const contentHash = createHash('sha256').update(file.buffer).digest('hex');
  // 1) staging：先入 staging 命名空间，便于 finalize 失败时回滚。
  const uploadId = randomUUID();
  const { stagingKey } = await getDocumentStorage().putStaging({
    uploadId,
    body: file.buffer,
    meta: { mimeType: file.mimeType ?? ext, size: file.buffer.length },
  });
  const finalKey = `final/${workspaceId}/${contentHash.slice(0, 16)}-${Date.now()}.${ext}`;
  try {
    await getDocumentStorage().finalize(stagingKey, finalKey);
  } catch (err) {
    await getDocumentStorage().abortStaging(stagingKey).catch(() => undefined);
    throw err;
  }
  try {
    return await persistSource({
      workspaceId,
      type: 'file',
      title: parsed.title || file.filename,
      contentHash,
      normalizedContent: normalized,
      sourceMetadata: {
        parser: parsed.metadata.parser,
        sourceFormat: parsed.metadata.sourceFormat,
        originalName: file.filename,
        mimeType: file.mimeType ?? ext,
        size: file.buffer.length,
        storageKey: finalKey,
        pageCount: parsed.metadata.pageCount,
        headings: parsed.metadata.headings,
      },
      file: {
        originalName: file.filename,
        mimeType: file.mimeType ?? ext,
        size: file.buffer.length,
        storageKey: finalKey,
      },
    });
  } catch (err) {
    // 持久化失败：清掉已晋升的 final，避免对象孤儿。
    await getDocumentStorage().remove(finalKey).catch(() => undefined);
    throw err;
  }
}

export async function recordUrlSource(workspaceId: string, originalUrl: string): Promise<RecordedSource> {
  let fetched;
  try {
    fetched = await urlFetcher.fetch({ url: originalUrl });
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new SourceRejectedError(err.message);
    if (err instanceof UnsupportedUrlError) throw new SourceRejectedError(err.message);
    if (err instanceof UrlFetchTimeoutError) throw new SourceRejectedError(err.message);
    if (err instanceof UrlFetchTooLargeError) throw new SourceRejectedError(err.message);
    throw err;
  }
  const parsed = await parserRegistry.parse({
    kind: 'url',
    originalUrl,
    finalUrl: fetched.finalUrl,
    fetchedAt: fetched.fetchedAt,
    body: fetched.body,
  });
  if (parsed.text.trim().length === 0) throw new SourceRejectedError('URL 正文为空，未记录。');
  const scan = scanSensitiveData(parsed.text);
  if (scan.hasSensitiveData) throw new SensitiveSourceRejectedError();
  const normalized = parsed.text;
  const contentHash = createHash('sha256').update(`${fetched.finalUrl}\n${normalized}`).digest('hex');
  return persistSource({
    workspaceId,
    type: 'url',
    title: parsed.title || originalUrl,
    contentHash,
    normalizedContent: normalized,
    sourceMetadata: {
      parser: parsed.metadata.parser,
      sourceFormat: parsed.metadata.sourceFormat,
      originalUrl,
      finalUrl: fetched.finalUrl,
      fetchedAt: fetched.fetchedAt,
      contentType: fetched.contentType,
    },
  });
}
