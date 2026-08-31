import { registerApiRoute } from '@mastra/core/server';
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  listKnowledgeBases,
  updateKnowledgeBase,
} from '../../modules/knowledge/service.js';
import { withAuthenticatedWorkspace } from '../../modules/auth/workspace-context.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2_000;

export const listKnowledgeBasesRoute = registerApiRoute('/knowledge-bases', {
  method: 'GET',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) =>
    context.json(await listKnowledgeBases(authCtx.workspaceId)),
  ),
});

export const createKnowledgeBaseRoute = registerApiRoute('/knowledge-bases', {
  method: 'POST',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const input = validateCreateInput(await context.req.json<unknown>());
    if ('message' in input) return context.json(input, 400);
    return context.json(await createKnowledgeBase(authCtx.workspaceId, input), 201);
  }),
});

export const getKnowledgeBaseRoute = registerApiRoute('/knowledge-bases/:id', {
  method: 'GET',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: '知识库 id 格式不正确。' }, 400);
    const knowledgeBase = await getKnowledgeBase(authCtx.workspaceId, id);
    return knowledgeBase
      ? context.json(knowledgeBase)
      : context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
  }),
});

export const updateKnowledgeBaseRoute = registerApiRoute('/knowledge-bases/:id', {
  method: 'PATCH',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: '知识库 id 格式不正确。' }, 400);
    const input = validateUpdateInput(await context.req.json<unknown>());
    if ('message' in input) return context.json(input, 400);
    return context.json(await updateKnowledgeBase(authCtx.workspaceId, id, input));
  }),
});

export const deleteKnowledgeBaseRoute = registerApiRoute('/knowledge-bases/:id', {
  method: 'DELETE',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: '知识库 id 格式不正确。' }, 400);
    await deleteKnowledgeBase(authCtx.workspaceId, id);
    return context.body(null, 204);
  }),
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