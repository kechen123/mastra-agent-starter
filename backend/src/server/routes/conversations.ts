import { registerApiRoute } from '@mastra/core/server';
import {
  createConversation,
  deleteConversation,
  getConversationWithMessages,
  listConversations,
  updateConversation,
} from '../../modules/conversations/service.js';
import { getAgentDefinition } from '../../core/agent/registry.js';
import { withAuthenticatedWorkspace } from '../../modules/auth/workspace-context.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export const listConversationsRoute = registerApiRoute('/conversations', {
  method: 'GET',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) =>
    context.json(await listConversations(authCtx.workspaceId)),
  ),
});

export const createConversationRoute = registerApiRoute('/conversations', {
  method: 'POST',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
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
    const created = await createConversation(authCtx.workspaceId, {
      agentId,
      knowledgeBaseId: kbId,
      title: typeof title === 'string' ? title.trim() : undefined,
    });
    return context.json(created, 201);
  }),
});

export const getConversationRoute = registerApiRoute('/conversations/:id', {
  method: 'GET',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: 'id 格式不正确。' }, 400);
    const detail = await getConversationWithMessages(authCtx.workspaceId, id);
    if (!detail) {
      return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
    }
    return context.json(detail);
  }),
});

export const updateConversationRoute = registerApiRoute('/conversations/:id', {
  method: 'PATCH',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: 'id 格式不正确。' }, 400);
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
    return context.json(await updateConversation(authCtx.workspaceId, id, input));
  }),
});

export const deleteConversationRoute = registerApiRoute('/conversations/:id', {
  method: 'DELETE',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const id = context.req.param('id');
    if (!isUuid(id)) return context.json({ message: 'id 格式不正确。' }, 400);
    await deleteConversation(authCtx.workspaceId, id);
    return context.body(null, 204);
  }),
});