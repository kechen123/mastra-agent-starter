/**
 * POST /ask — 在已有会话上发起一次新的问答。
 *
 * 请求体：{ conversationId: string; message: string }
 * 响应：SSE 流，事件名 + 载荷与 regenerate 路由完全一致
 * （详见 `core/execution/ask-driver.ts`）。
 *
 * 会话级执行互斥（reserve-before-read）：
 *  1. 完成请求体校验后，**立即**对 `conversationId` 调用
 *     `tryReserveConversationExecution` 原子预占；冲突直接返回 409，
 *     不写用户消息、不创建助手消息。
 *  2. reserve 成功后，**所有**决定性状态读取（`getConversationWithMessages`）
 *     必须在锁内完成。锁外读取的历史可能在另一并发请求写入后失效，
 *     进而导致 user/assistant 顺序错乱。
 *  3. setup 阶段（历史读取、保存用户消息、创建助手消息、bind、streaming 切换）
 *     任意一步失败，本路由负责释放会话锁；助手消息若已创建，再用
 *     `convergeAssistantToFailed` 收敛为 failed。
 *  4. SSE Response 构造成功后，执行权交给 `buildAskStreamResponse` 的
 *     `finally` 块，由它释放内存执行记录。
 */
import { registerApiRoute } from '@mastra/core/server';
import {
  convergeAssistantToFailed,
  createAssistantPending,
  getConversationWithMessages,
  maybeUpdateTitleFromFirstMessage,
  saveUserMessage,
  updateAssistantStreaming,
} from '../../../modules/conversations/service.js';
import { buildAskStreamResponse } from '../../../core/execution/ask-driver.js';
import {
  bindAssistantMessageToExecution,
  cleanupConversationExecution,
  tryReserveConversationExecution,
} from '../../../core/execution/controller.js';
import { isUuid } from '../../../core/execution/sse.js';
import { withAuthenticatedWorkspace } from '../../../modules/auth/workspace-context.js';

export const askRoute = registerApiRoute('/ask', {
  method: 'POST',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const body = await context.req.json<unknown>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return context.json({ message: '请求体必须是 JSON 对象。' }, 400);
    }
    const { conversationId, message } = body as Record<string, unknown>;
    if (typeof conversationId !== 'string' || !isUuid(conversationId)) {
      return context.json({ message: 'conversationId 格式不正确。' }, 400);
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      return context.json({ message: '请输入问题。' }, 400);
    }
    if (message.trim().length > 2000) {
      return context.json({ message: '问题不能超过 2000 个字符。' }, 400);
    }

    // 关键：必须在任何 DB 状态读取之前原子预占会话执行权。
    // 同会话的另一 ask / regenerate 若已活跃，立即返回 409。
    const reserved = tryReserveConversationExecution(conversationId);
    if ('conflict' in reserved) {
      return context.json({ message: reserved.conflict.message }, 409);
    }

    let assistantMessageId: string | null = null;
    try {
      // 锁内读取：history 一定是本次会话锁持有期间的快照，
      // 不会被另一并发请求交错写入。null → 跨 workspace 访问 / 会话不存在 → 404。
      const detail = await getConversationWithMessages(authCtx.workspaceId, conversationId);
      if (!detail) {
        // 跨 workspace / 会话不存在：reserve 已成功预占会话执行权，必须在 404 之前释放锁。
        cleanupConversationExecution(conversationId);
        return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
      }
      const { conversation, messages: history } = detail;

      await saveUserMessage(authCtx.workspaceId, conversationId, message.trim());
      await maybeUpdateTitleFromFirstMessage(authCtx.workspaceId, conversationId, message.trim());

      const assistantMessage = await createAssistantPending(authCtx.workspaceId, conversationId);
      assistantMessageId = assistantMessage.id;

      bindAssistantMessageToExecution(conversationId, assistantMessage.id);

      await updateAssistantStreaming(authCtx.workspaceId, assistantMessage.id);

      return buildAskStreamResponse({
        workspaceId: authCtx.workspaceId,
        assistantMessageId: assistantMessage.id,
        conversationId,
        agentId: conversation.agentId,
        message: message.trim(),
        knowledgeBaseId: conversation.knowledgeBaseId,
        history,
        abortSignal: reserved.controller.signal,
      }, { logTag: 'ask' });
    } catch (setupError) {
      // setup 阶段失败：释放会话锁；若助手消息已创建，把它收敛为 failed。
      cleanupConversationExecution(conversationId);
      if (assistantMessageId) {
        await convergeAssistantToFailed(authCtx.workspaceId, assistantMessageId).catch((err) => {
          console.error('setup 失败后收敛助手消息失败：', err);
        });
      }
      throw setupError;
    }
  }),
});