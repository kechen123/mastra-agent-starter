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
import type { SourceInput, PdfPageBlock } from './parsers/types.js';

export class SensitiveSourceRejectedError extends Error {
  constructor() { super('检测到敏感凭据；当前安全凭据存储尚未完成，已拒绝保存。'); this.name = 'SensitiveSourceRejectedError'; }
}

export class SourceRejectedError extends Error {
  constructor(message: string) { super(message); this.name = 'SourceRejectedError'; }
}

export type { SourceInput };

const parserRegistry = new SourceParserRegistry();
const urlFetcher = new UrlFetcher();

/**
 * 测试钩子：把 recordUrlSource 使用的 URL fetcher 替换为 mock。
 *
 * 用途：URL E2E 测试需要让 recordUrlSource 拿到"可解析的真实 HTML body"
 * —— 但生产 fetcher 会拒绝 127.0.0.1 / localhost（防 SSRF）。集成测试通过
 * 此函数注入一个 fake，让 URL E2E 不依赖公网、不被 SSRF 防护拦下。
 *
 * 安全：仅在测试 fixture 内调用；生产代码绝不调用。测试结束后必须
 * `__resetUrlFetcherForTesting()` 把 fetcher 还原回默认实现，避免
 * 跨测试泄漏。
 */
let urlFetcherOverride: UrlFetcher | null = null;
export function __setUrlFetcherForTesting(replacement: UrlFetcher | null): void {
  urlFetcherOverride = replacement;
}
export function __resetUrlFetcherForTesting(): void {
  urlFetcherOverride = null;
}
function activeUrlFetcher(): UrlFetcher {
  return urlFetcherOverride ?? urlFetcher;
}

export interface RecordedSource {
  id: string;
  title: string;
  type: 'text' | 'file' | 'url';
  knowledgeBaseId: string;
  createdAt: string;
  chunkCount: number;
}

const DAYMIND_KNOWLEDGE_BASE = 'Daymind 记录';

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

/**
 * 文本规范化（CRLF 折叠 + 行距收敛 + trim）。
 * PDF/DOCX/URL/TXT/MD 全部走同一份规则，保证 contentHash 输入一致。
 */
function normalizeText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function recordTextSource(workspaceId: string, rawContent: string, title?: string): Promise<RecordedSource> {
  const normalized = normalizeText(rawContent);
  if (normalized.length === 0) throw new SourceRejectedError('记录内容不能为空。');
  const scan = scanSensitiveData(normalized);
  if (scan.hasSensitiveData) throw new SensitiveSourceRejectedError();
  const contentHash = createHash('sha256').update(normalized).digest('hex');
  const sourceTitle = title?.trim() || normalized.split('\n').find(Boolean)?.slice(0, 80) || '未命名文本记录';
  const dedupShortCircuit = await tryShortCircuitExistingSource({
    workspaceId, type: 'text', contentHash,
    fallback: { title: sourceTitle, normalizedContent: normalized, sourceMetadata: { parser: 'text', sourceFormat: 'txt' } },
  });
  if (dedupShortCircuit) return dedupShortCircuit;
  return persistSource({
    workspaceId,
    type: 'text',
    title: sourceTitle,
    contentHash,
    normalizedContent: normalized,
    sourceMetadata: { parser: 'text', sourceFormat: 'txt' },
  });
}

interface ShortCircuitArgs {
  workspaceId: string;
  type: 'text' | 'file' | 'url';
  contentHash: string;
  fallback: {
    title: string;
    normalizedContent: string;
    sourceMetadata: Record<string, unknown>;
  };
}

/**
 * 精确去重的关键路径：在调用任何 Storage finalize / embedTexts 之前，先用
 * `(workspace_id, content_hash)` 查 Source 投影。若已存在完整 Document
 * （即 chunks / embeddings 也齐备），直接返回既有 RecordedSource，
 * 不上传、不向量化、不新增任何 DB 行——是真正的"零副作用"短路。
 *
 * 返回 null 表示没有命中短路，调用方继续走正常 persistSource 流程。
 */
async function tryShortCircuitExistingSource(args: ShortCircuitArgs): Promise<RecordedSource | null> {
  const pool = getDatabasePool();
  const result = await pool.query<{
    source_id: string;
    source_title: string;
    source_type: string;
    created_at: Date;
    kb_id: string;
    document_id: string | null;
    chunks: string | null;
    embeddings: string | null;
  }>(
    `SELECT s.id AS source_id, s.title AS source_title, s.type AS source_type,
            s.created_at, kb.id AS kb_id,
            d.id AS document_id,
            (SELECT count(*)::text FROM document_chunks c WHERE c.document_id = d.id) AS chunks,
            (SELECT count(*)::text FROM document_embeddings e WHERE e.document_id = d.id) AS embeddings
       FROM sources s
       LEFT JOIN knowledge_bases kb
         ON kb.workspace_id = s.workspace_id AND kb.name = $2
       LEFT JOIN documents d
         ON d.source_id = s.id AND d.workspace_id = s.workspace_id
      WHERE s.workspace_id = $1 AND s.content_hash = $3
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [args.workspaceId, DAYMIND_KNOWLEDGE_BASE, args.contentHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  // 已有 Source，但 Document 还没创建（或 chunks/embeddings 缺位）→ 不能直接
  // 复用 `chunkCount`，让 persistSource 继续走完整补齐路径。
  if (!row.document_id || !row.chunks || !row.embeddings) return null;
  // chunks === '0' 也是合法的"零切分"——但 normalized 文本长度 > 0 时这不可能；
  // 我们保守地要求至少有 1 chunk。
  if (Number(row.chunks) === 0) return null;
  return {
    id: row.source_id,
    title: row.source_title ?? args.fallback.title,
    type: (row.source_type as 'text' | 'file' | 'url') ?? args.type,
    knowledgeBaseId: row.kb_id,
    createdAt: row.created_at.toISOString(),
    chunkCount: Number(row.chunks),
  };
}

interface SplitChunkWithMeta {
  content: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  heading?: string;
  page?: number;
}

/**
 * 把 PDF 的 pageBlocks 切分成 chunk，每个 chunk 记录其归属 page。
 * 切分按"先按 page 拼接、再统一 split"的策略：fullText 是各 page text 用 `\n\n`
 * 拼接的结果，先 split 出 chunk，再根据每个 chunk 在 fullText 中的起止位置反查
 * 它落在哪一页——这样 chunk 边界不会跨越 page，且 page 号能精确归属。
 */
function splitWithPageAttribution(fullText: string, pageBlocks: PdfPageBlock[] | undefined): SplitChunkWithMeta[] {
  const baseChunks = splitText(fullText);
  if (!pageBlocks || pageBlocks.length === 0) {
    return baseChunks.map((c) => ({ ...c }));
  }
  // 构造 char-offset → page 的快速映射
  const pageStarts: Array<{ offset: number; page: number }> = [];
  let cursor = 0;
  for (const block of pageBlocks) {
    pageStarts.push({ offset: cursor, page: block.page });
    cursor += block.text.length + 2; // '\n\n'
  }
  const findPage = (charIndex: number): number | undefined => {
    let lo = 0, hi = pageStarts.length - 1, ans: number | undefined = undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pageStarts[mid]!.offset <= charIndex) {
        ans = pageStarts[mid]!.page;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  };
  return baseChunks.map((c) => ({ ...c, page: findPage(c.startChar) }));
}

interface PersistSourceInput {
  workspaceId: string;
  type: 'text' | 'file' | 'url';
  title: string;
  contentHash: string;
  normalizedContent: string;
  sourceMetadata: Record<string, unknown>;
  file?: { originalName: string; mimeType: string; size: number; storageKey: string };
  pageBlocks?: PdfPageBlock[];
  headingSections?: Array<{ heading: string; startChar: number; endChar: number }>;
}

/**
 * 文本切片：优先 PDF pageBlocks 决定 page；DOCX headingSections 决定 heading。
 * heading 找不到时回退到 splitText 内部基于 markdown 的启发式。
 */
function splitWithAttribution(
  fullText: string,
  pageBlocks: PdfPageBlock[] | undefined,
  headingSections: Array<{ heading: string; startChar: number; endChar: number }> | undefined,
): SplitChunkWithMeta[] {
  const baseChunks = splitText(fullText);
  let chunks: SplitChunkWithMeta[] = baseChunks.map((c) => ({ ...c }));
  // 1) page attribution（PDF）
  if (pageBlocks && pageBlocks.length > 0) {
    const pageStarts: Array<{ offset: number; page: number }> = [];
    let cursor = 0;
    for (const block of pageBlocks) {
      pageStarts.push({ offset: cursor, page: block.page });
      cursor += block.text.length + 2; // '\n\n'
    }
    const findPage = (charIndex: number): number | undefined => {
      let lo = 0, hi = pageStarts.length - 1, ans: number | undefined = undefined;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pageStarts[mid]!.offset <= charIndex) {
          ans = pageStarts[mid]!.page;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return ans;
    };
    chunks = chunks.map((c) => ({ ...c, page: findPage(c.startChar) }));
  }
  // 2) heading attribution（DOCX）：取最近的（startChar ≤ chunk.startChar）heading 段。
  if (headingSections && headingSections.length > 0) {
    const sorted = [...headingSections].sort((a, b) => a.startChar - b.startChar);
    chunks = chunks.map((c) => {
      if (c.heading) return c;
      let ans: string | undefined = undefined;
      for (const sec of sorted) {
        if (sec.startChar <= c.startChar) ans = sec.heading;
        else break;
      }
      return { ...c, heading: ans ?? c.heading };
    });
  }
  return chunks;
}

async function persistSource(input: PersistSourceInput): Promise<RecordedSource> {
  const chunks = splitWithAttribution(input.normalizedContent, input.pageBlocks, input.headingSections);
  if (chunks.length === 0) {
    throw new SourceRejectedError('解析后文本为空，无法切片。');
  }
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
            page: chunk.page,
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
  // 1) 解析（纯本地）：拿不到文本就根本不入库，也不入对象存储。
  const parsed = await parserRegistry.parse({ kind: 'file', filename: file.filename, mimeType: file.mimeType, buffer: file.buffer });
  const normalized = normalizeText(parsed.text);
  if (normalized.length === 0) {
    // PDF 扫描型、加密、空模板；DOCX 仅含图片；统一在边界明确拒绝。
    throw new SourceRejectedError(`${ext.toUpperCase()} 解析后无可记录文本（可能为扫描型、加密或仅含图片）。`);
  }
  const scan = scanSensitiveData(normalized);
  if (scan.hasSensitiveData) throw new SensitiveSourceRejectedError();
  const contentHash = createHash('sha256').update(file.buffer).digest('hex');
  // 2) 去重优先：在 finalize 之前查 (workspace, contentHash)。
  const dedupShortCircuit = await tryShortCircuitExistingSource({
    workspaceId, type: 'file', contentHash,
    fallback: { title: parsed.title || file.filename, normalizedContent: normalized, sourceMetadata: { parser: parsed.metadata.parser, sourceFormat: parsed.metadata.sourceFormat, originalName: file.filename, mimeType: file.mimeType ?? ext, size: file.buffer.length, pageCount: parsed.metadata.pageCount, headings: parsed.metadata.headings } },
  });
  if (dedupShortCircuit) return dedupShortCircuit;
  // 3) staging → finalize → 持久化。
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
      pageBlocks: parsed.metadata.pageBlocks,
      headingSections: parsed.metadata.headingSections,
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
    fetched = await activeUrlFetcher().fetch({ url: originalUrl });
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
  const normalized = normalizeText(parsed.text);
  if (normalized.length === 0) throw new SourceRejectedError('URL 正文为空，未记录。');
  const scan = scanSensitiveData(normalized);
  if (scan.hasSensitiveData) throw new SensitiveSourceRejectedError();
  const contentHash = createHash('sha256').update(`${fetched.finalUrl}\n${normalized}`).digest('hex');
  const dedupShortCircuit = await tryShortCircuitExistingSource({
    workspaceId, type: 'url', contentHash,
    fallback: { title: parsed.title || originalUrl, normalizedContent: normalized, sourceMetadata: { parser: parsed.metadata.parser, sourceFormat: parsed.metadata.sourceFormat, originalUrl, finalUrl: fetched.finalUrl, fetchedAt: fetched.fetchedAt, contentType: fetched.contentType } },
  });
  if (dedupShortCircuit) return dedupShortCircuit;
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
