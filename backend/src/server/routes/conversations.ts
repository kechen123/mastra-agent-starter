import { registerApiRoute } from '@mastra/core/server';
import {
  createConversation,
  deleteConversation,
  getConversationWithMessages,
  listConversations,
  updateConversation,
} from '../../modules/conversations/service.js';
import { getAgentDefinition } from '../../core/agent/registry.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function handleError(context: { json: (data: unknown, status?: number) => Response }, error: unknown): Response {
  console.error('会话路由错误：', error);
  if (error instanceof Error) {
    if (error.message === '会话不存在。') return context.json({ message: error.message }, 404);
    if (error.message === 'Agent 不存在。') return context.json({ message: error.message }, 400);
    if (error.message === '知识库不存在。') return context.json({ message: error.message }, 400);
  }
  return context.json({ message: '服务暂时不可用，请稍后重试。' }, 500);
}

export const listConversationsRoute = registerApiRoute('/conversations', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => {
    try {
      return context.json(await listConversations());
    } catch (error) {
      return handleError(context, error);
    }
  },
});

export const createConversationRoute = registerApiRoute('/conversations', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    try {
      const body = await context.req.json<unknown>();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return context.json({ message: '请求体必须是 JSON 对象。' }, 400);
      }
      const { agentId, knowledgeBaseId, title } = body as Record<string, unknown>;
      if (typeof agentId !== 'string' || !getAgentDefinition(agentId)) {
        return context.json({ message: 'agentId 无效。' }, 400);
      }
      const kbId = knowledgeBaseId === undefined || knowledgeBaseId === null || knowledgeBaseId === '' ? null : String(knowledgeBaseId);
      if (kbId !== null && !isUuid(kbId)) {
        return context.json({ message: 'knowledgeBaseId 格式不正确。' }, 400);
      }
      const created = await createConversation({
        agentId,
        knowledgeBaseId: kbId,
        title: typeof title === 'string' ? title.trim() : undefined,
      });
      return context.json(created, 201);
    } catch (error) {
      return handleError(context, error);
    }
  },
});

export const getConversationRoute = registerApiRoute('/conversations/:id', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: 'id 格式不正确。' }, 400);
    try {
      return context.json(await getConversationWithMessages(id));
    } catch (error) {
      if (error instanceof Error && error.message === '会话不存在。') {
        return context.json({ message: '会话不存在。' }, 404);
      }
      return handleError(context, error);
    }
  },
});

export const updateConversationRoute = registerApiRoute('/conversations/:id', {
  method: 'PATCH',
  requiresAuth: false,
  handler: async (context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: 'id 格式不正确。' }, 400);
    try {
      const body = await context.req.json<unknown>();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return context.json({ message: '请求体必须是 JSON 对象。' }, 400);
      }
      const { title, agentId, knowledgeBaseId } = body as Record<string, unknown>;
      const input: { title?: string; agentId?: string; knowledgeBaseId?: string | null } = {};
      if (title !== undefined) input.title = typeof title === 'string' ? title.trim() : '';
      if (agentId !== undefined) {
        if (typeof agentId !== 'string' || !getAgentDefinition(agentId)) {
          return context.json({ message: 'agentId 无效。' }, 400);
        }
        input.agentId = agentId;
      }
      if (knowledgeBaseId !== undefined) {
        input.knowledgeBaseId = knowledgeBaseId === null || knowledgeBaseId === '' ? null : String(knowledgeBaseId);
        if (input.knowledgeBaseId !== null && !isUuid(input.knowledgeBaseId)) {
          return context.json({ message: 'knowledgeBaseId 格式不正确。' }, 400);
        }
      }
      const updated = await updateConversation(id, input);
      return context.json(updated);
    } catch (error) {
      if (error instanceof Error && error.message === '会话不存在。') {
        return context.json({ message: '会话不存在。' }, 404);
      }
      return handleError(context, error);
    }
  },
});

export const deleteConversationRoute = registerApiRoute('/conversations/:id', {
  method: 'DELETE',
  requiresAuth: false,
  handler: async (context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: 'id 格式不正确。' }, 400);
    try {
      const deleted = await deleteConversation(id);
      return deleted ? context.body(null, 204) : context.json({ message: '会话不存在。' }, 404);
    } catch (error) {
      return handleError(context, error);
    }
  },
});