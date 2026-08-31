import { registerApiRoute } from '@mastra/core/server';
import {
  DocumentIngestionError,
  ingestDocument,
  type IngestionChunk,
} from '../../modules/documents/ingestion.js';
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
} from '../../modules/documents/service.js';
import { getKnowledgeBase } from '../../modules/knowledge/service.js';
import { embedTexts } from '../../modules/knowledge/rag/embedding-service.js';
import { getParser } from '../../modules/documents/parsers/registry.js';
import { UnsupportedDocumentTypeError } from '../../modules/documents/parsers/types.js';
import { withAuthenticatedWorkspace } from '../../modules/auth/workspace-context.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const CHUNK_SIZE = 1_000;
const CHUNK_OVERLAP = 150;

export const uploadDocumentRoute = registerApiRoute('/knowledge-bases/:id/documents', {
  method: 'POST',
  requiresAuth: true,
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
    let parsed;
    try {
      const parser = getParser({ filename: fileInput.name, mimeType: fileInput.type });
      parsed = await parser.parse({
        filename: fileInput.name,
        mimeType: fileInput.type,
        buffer: Buffer.from(bytes),
      });
    } catch (error) {
      if (error instanceof UnsupportedDocumentTypeError) {
        return context.json({ message: error.message }, 400);
      }
      throw error;
    }

    const created = await createDocument(authCtx.workspaceId, knowledgeBaseId, {
      name: fileInput.name,
      type: fileInput.type,
      size: bytes.byteLength,
    });

    const textChunks = splitText(parsed.markdown);
    if (textChunks.length === 0) {
      // 空文档：跳过 embedding / chunk 写入，直接返回已创建记录。
      return context.json(created, 201);
    }
    const embeddings = await embedTexts(textChunks.map((c) => c.content));
    const ingestionChunks: IngestionChunk[] = textChunks.map((c, i) => ({
      content: c.content,
      chunkIndex: c.chunkIndex,
      startChar: c.startChar,
      endChar: c.endChar,
      embedding: embeddings[i]!,
      parser: parsed.metadata.parser,
      sourceFormat: parsed.metadata.sourceFormat,
      ...(c.heading ? { heading: c.heading } : {}),
    }));

    try {
      const document = await ingestDocument(authCtx.workspaceId, created.id, ingestionChunks);
      return context.json(document, 201);
    } catch (error) {
      if (error instanceof DocumentIngestionError) {
        return context.json(
          { message: '文档处理失败，可通过文档详情查看处理状态。', documentId: error.documentId },
          500,
        );
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
    await deleteDocument(authCtx.workspaceId, id);
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
  if (value.size > MAX_FILE_SIZE) return { message: '文件不能超过 10 MB。' };
  return { file: value, name, type: extension || 'unknown' };
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

interface TextChunk {
  content: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  heading?: string;
}

/**
 * 与 `modules/documents/ingestion.ts` 的拆分逻辑保持一致：按 CHUNK_SIZE 切片，
 * 在候选分隔符中寻找最晚的合理断点。该函数在路由层 inline 以避免改动 ingestion.ts。
 */
// TODO: extract splitText to a shared module — currently duplicated to keep this PR scoped to routes/
function splitText(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const targetEnd = Math.min(start + CHUNK_SIZE, text.length);
    const end = targetEnd === text.length ? targetEnd : findBoundary(text, start, targetEnd);
    const content = text.slice(start, end).trim();
    if (content) {
      chunks.push({
        content,
        chunkIndex: chunks.length,
        startChar: start,
        endChar: end,
        heading: findHeading(text, start),
      });
    }
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

function findBoundary(text: string, start: number, targetEnd: number): number {
  const minimumBoundary = start + Math.floor(CHUNK_SIZE * 0.5);
  const candidates = ['\n\n', '\n', '。', '！', '？', '；'];
  let best = -1;
  let boundaryLength = 0;
  for (const delimiter of candidates) {
    const index = text.lastIndexOf(delimiter, targetEnd - 1);
    if (index >= minimumBoundary && index > best) {
      best = index;
      boundaryLength = delimiter.length;
    }
  }
  return best >= 0 ? best + boundaryLength : targetEnd;
}

function findHeading(text: string, position: number): string | undefined {
  const headingAtChunkStart = text.slice(position).match(/^#{1,6}\s+([^\n]+)/)?.[1]?.trim();
  if (headingAtChunkStart) return headingAtChunkStart;
  const preceding = text.slice(0, position);
  const matches = [...preceding.matchAll(/^#{1,6}\s+(.+)$/gm)];
  const heading = matches.at(-1)?.[1]?.trim();
  return heading || undefined;
}