import { registerApiRoute } from '@mastra/core/server';
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  listKnowledgeBases,
  updateKnowledgeBase,
} from '../../modules/knowledge/service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2_000;

export const listKnowledgeBasesRoute = registerApiRoute('/knowledge-bases', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => context.json(await listKnowledgeBases()),
});

export const createKnowledgeBaseRoute = registerApiRoute('/knowledge-bases', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    try {
      const input = validateCreateInput(await context.req.json<unknown>());
      if ('message' in input) return context.json(input, 400);
      return context.json(await createKnowledgeBase(input), 201);
    } catch (error) {
      return handleRouteError(context, error);
    }
  },
});

export const getKnowledgeBaseRoute = registerApiRoute('/knowledge-bases/:id', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: '知识库 id 格式不正确。' }, 400);
    try {
      const knowledgeBase = await getKnowledgeBase(id);
      return knowledgeBase
        ? context.json(knowledgeBase)
        : context.json({ message: '知识库不存在。' }, 404);
    } catch (error) {
      return handleRouteError(context, error);
    }
  },
});

export const updateKnowledgeBaseRoute = registerApiRoute('/knowledge-bases/:id', {
  method: 'PATCH',
  requiresAuth: false,
  handler: async (context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: '知识库 id 格式不正确。' }, 400);
    try {
      const input = validateUpdateInput(await context.req.json<unknown>());
      if ('message' in input) return context.json(input, 400);
      const knowledgeBase = await updateKnowledgeBase(id, input);
      return knowledgeBase
        ? context.json(knowledgeBase)
        : context.json({ message: '知识库不存在。' }, 404);
    } catch (error) {
      return handleRouteError(context, error);
    }
  },
});

export const deleteKnowledgeBaseRoute = registerApiRoute('/knowledge-bases/:id', {
  method: 'DELETE',
  requiresAuth: false,
  handler: async (context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: '知识库 id 格式不正确。' }, 400);
    try {
      return await deleteKnowledgeBase(id)
        ? context.body(null, 204)
        : context.json({ message: '知识库不存在。' }, 404);
    } catch (error) {
      return handleRouteError(context, error);
    }
  },
});

function validateCreateInput(body: unknown): { name: string; description?: string } | { message: string } {
  if (!isObject(body)) return { message: '请求体必须是 JSON 对象。' };
  const name = normalizeName(body.name);
  if (!name) return { message: `name 必须是 1 到 ${MAX_NAME_LENGTH} 个字符。` };
  const description = normalizeDescription(body.description);
  if (description === null) return { message: `description 不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符。` };
  return description === undefined ? { name } : { name, description };
}

function validateUpdateInput(body: unknown): { name?: string; description?: string } | { message: string } {
  if (!isObject(body)) return { message: '请求体必须是 JSON 对象。' };
  if (body.name === undefined && body.description === undefined) {
    return { message: '至少提供 name 或 description 之一。' };
  }
  const input: { name?: string; description?: string } = {};
  if (body.name !== undefined) {
    const name = normalizeName(body.name);
    if (!name) return { message: `name 必须是 1 到 ${MAX_NAME_LENGTH} 个字符。` };
    input.name = name;
  }
  if (body.description !== undefined) {
    const description = normalizeDescription(body.description);
    if (description === null) return { message: `description 必须是最多 ${MAX_DESCRIPTION_LENGTH} 个字符的字符串。` };
    input.description = description;
  }
  return input;
}

function normalizeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : undefined;
}

function normalizeDescription(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.length <= MAX_DESCRIPTION_LENGTH ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function handleRouteError(
  context: { json: (data: unknown, status?: number) => Response },
  error: unknown,
): Response {
  console.error('知识库请求失败：', error);
  return context.json({ message: '知识库服务暂时不可用，请稍后重试。' }, 500);
}