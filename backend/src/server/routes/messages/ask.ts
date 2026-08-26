/**
 * POST /ask — 在已有会话上发起一次新的问答。
 *
 * 请求体：{ conversationId: string; message: string }
 * 响应：SSE 流，事件名 + 载荷与 regenerate 路由完全一致
 * （详见 `core/execution/ask-driver.ts`）。
 */
import { registerApiRoute } from '@mastra/core/server';
import {
  getConversationWithMessages,
  maybeUpdateTitleFromFirstMessage,
  saveUserMessage,
  createAssistantPending,
  updateAssistantStreaming,
} from '../../../modules/conversations/service.js';
import { buildAskStreamResponse, tryRegisterExecution } from '../../../core/execution/ask-driver.js';
import { isUuid } from '../../../core/execution/sse.js';

export const askRoute = registerApiRoute('/ask', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    try {
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

      const { conversation, messages: history } = await getConversationWithMessages(conversationId);

      // 保存用户消息
      await saveUserMessage(conversationId, message.trim());
      await maybeUpdateTitleFromFirstMessage(conversationId, message.trim());

      // 创建占位的助手消息（pending → streaming → 终态）
      const assistantMessage = await createAssistantPending(conversationId);

      const registered = tryRegisterExecution(assistantMessage.id);
      if ('conflict' in registered) {
        return context.json({ message: registered.conflict.message }, 409);
      }
      const abortController = registered.controller;

      await updateAssistantStreaming(assistantMessage.id);

      return buildAskStreamResponse({
        assistantMessageId: assistantMessage.id,
        conversationId,
        agentId: conversation.agentId,
        message: message.trim(),
        knowledgeBaseId: conversation.knowledgeBaseId,
        history,
        abortSignal: abortController.signal,
      }, { logTag: 'ask' });
    } catch (error) {
      console.error('问答请求失败：', error);
      if (error instanceof Error && error.message === '会话不存在。') {
        return context.json({ message: '会话不存在。' }, 404);
      }
      return context.json({ message: '服务暂时不可用，请稍后重试。' }, 500);
    }
  },
});
