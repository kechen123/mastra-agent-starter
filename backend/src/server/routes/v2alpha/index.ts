/**
 * V2 路由注册：`/v1/v2alpha` 与 `/v1` 同行为入口。
 * Mastra 保留 `/api` 给内置路由，因此应用自定义路由不能使用 `/api` 前缀。
 *
 * 兼容窗口（architecture-v2.md §9.5.1）：
 *   - 阶段 2：v2alpha（前端主用） + v1（同行为）+ 旧根路径（弃用头）；
 *   - 阶段 3 之后：v2alpha 删除，前端切 v1；
 *   - 阶段 5 之后：旧根路径删除。
 */
import { registerApiRoute } from '@mastra/core/server';
import { withAuthenticatedWorkspace } from '../../../modules/auth/workspace-context.js';
import {
  resolveRequestIdFromContext,
  sharedHandlers,
  type AuthedCtxLike,
  type AuthedHandlerContext,
} from './shared-handlers.js';
import { withRequestId } from '../../../infrastructure/logging/request-id.js';

function runWith(handler: (auth: AuthedHandlerContext, ctx: AuthedCtxLike, deps: { base: 'v2alpha' | 'v1'; requestId: string }) => Promise<Response>, base: 'v2alpha' | 'v1') {
  return withAuthenticatedWorkspace(async (auth, context) => {
    const ctx = context as unknown as AuthedCtxLike;
    const requestId = resolveRequestIdFromContext(ctx);
    return withRequestId(requestId, () => handler(auth as AuthedHandlerContext, ctx, { base, requestId }));
  });
}

export const createConversationV2AlphaRoute = registerApiRoute('/v1/v2alpha/conversations', {
  method: 'POST',
  requiresAuth: true,
  handler: runWith(sharedHandlers.createConversation, 'v2alpha'),
});

export const createMessageV2AlphaRoute = registerApiRoute('/v1/v2alpha/conversations/:id/messages', {
  method: 'POST',
  requiresAuth: true,
  handler: runWith(sharedHandlers.createMessage, 'v2alpha'),
});

export const getConversationV2AlphaRoute = registerApiRoute('/v1/v2alpha/conversations/:id', {
  method: 'GET',
  requiresAuth: true,
  handler: runWith(sharedHandlers.getConversation, 'v2alpha'),
});

export const streamRunEventsV2AlphaRoute = registerApiRoute('/v1/v2alpha/runs/:runId/events', {
  method: 'GET',
  requiresAuth: true,
  handler: runWith(sharedHandlers.streamRunEvents, 'v2alpha'),
});

export const stopMessageV2AlphaRoute = registerApiRoute('/v1/v2alpha/messages/:id/stop', {
  method: 'POST',
  requiresAuth: true,
  handler: runWith(sharedHandlers.stopMessage, 'v2alpha'),
});

export const createConversationV1Route = registerApiRoute('/v1/conversations', {
  method: 'POST',
  requiresAuth: true,
  handler: runWith(sharedHandlers.createConversation, 'v1'),
});

export const createMessageV1Route = registerApiRoute('/v1/conversations/:id/messages', {
  method: 'POST',
  requiresAuth: true,
  handler: runWith(sharedHandlers.createMessage, 'v1'),
});

export const getConversationV1Route = registerApiRoute('/v1/conversations/:id', {
  method: 'GET',
  requiresAuth: true,
  handler: runWith(sharedHandlers.getConversation, 'v1'),
});

export const streamRunEventsV1Route = registerApiRoute('/v1/runs/:runId/events', {
  method: 'GET',
  requiresAuth: true,
  handler: runWith(sharedHandlers.streamRunEvents, 'v1'),
});

export const stopMessageV1Route = registerApiRoute('/v1/messages/:id/stop', {
  method: 'POST',
  requiresAuth: true,
  handler: runWith(sharedHandlers.stopMessage, 'v1'),
});
