import { registerApiRoute } from '@mastra/core/server';
import { DocumentIngestionError, ingestDocument } from '../services/document-ingestion.js';
import { deleteDocument, getDocument, listDocuments } from '../services/documents.js';
import { getKnowledgeBase } from '../services/knowledge-bases.js';
import { UnsupportedDocumentTypeError } from '../document-parsers/types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export const uploadDocumentRoute = registerApiRoute('/knowledge-bases/:id/documents', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    const knowledgeBaseId = context.req.param('id');
    if (!isUuid(knowledgeBaseId)) return context.json({ message: '知识库 id 格式不正确。' }, 400);
    try {
      if (!(await getKnowledgeBase(knowledgeBaseId))) {
        return context.json({ message: '知识库不存在。' }, 404);
      }
      const formData = await context.req.formData();
      const file = formData.get('file');
      const fileInput = validateFile(file);
      if ('message' in fileInput) return context.json(fileInput, 400);
      const document = await ingestDocument({
        knowledgeBaseId,
        name: fileInput.name,
        type: fileInput.type,
        bytes: new Uint8Array(await fileInput.file.arrayBuffer()),
      });
      return context.json(document, 201);
    } catch (error) {
      if (error instanceof UnsupportedDocumentTypeError) {
        return context.json({ message: error.message }, 400);
      }
      if (error instanceof DocumentIngestionError) {
        return context.json({ message: '文档处理失败，可通过文档详情查看处理状态。', documentId: error.documentId }, 500);
      }
      return handleRouteError(context, error);
    }
  },
});

export const listDocumentsRoute = registerApiRoute('/knowledge-bases/:id/documents', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => {
    const knowledgeBaseId = context.req.param('id');
    if (!isUuid(knowledgeBaseId)) return context.json({ message: '知识库 id 格式不正确。' }, 400);
    try {
      if (!(await getKnowledgeBase(knowledgeBaseId))) {
        return context.json({ message: '知识库不存在。' }, 404);
      }
      return context.json(await listDocuments(knowledgeBaseId));
    } catch (error) {
      return handleRouteError(context, error);
    }
  },
});

export const getDocumentRoute = registerApiRoute('/documents/:id', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: '文档 id 格式不正确。' }, 400);
    try {
      const document = await getDocument(id);
      return document ? context.json(document) : context.json({ message: '文档不存在。' }, 404);
    } catch (error) {
      return handleRouteError(context, error);
    }
  },
});

export const deleteDocumentRoute = registerApiRoute('/documents/:id', {
  method: 'DELETE',
  requiresAuth: false,
  handler: async (context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: '文档 id 格式不正确。' }, 400);
    try {
      return await deleteDocument(id)
        ? context.body(null, 204)
        : context.json({ message: '文档不存在。' }, 404);
    } catch (error) {
      return handleRouteError(context, error);
    }
  },
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

function handleRouteError(
  context: { json: (data: unknown, status?: number) => Response },
  error: unknown,
): Response {
  console.error('文档请求失败：', error);
  return context.json({ message: '文档服务暂时不可用，请稍后重试。' }, 500);
}
