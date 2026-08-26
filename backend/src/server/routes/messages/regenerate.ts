/**
 * POST /messages/:assistantMessageId/regenerate — 在会话内重新生成最近一条
 * 助手消息。
 *
 * 先校验目标消息确实是该会话最后一条 assistant 消息，再重建历史切片并复用
 * 同一 ask driver。SSE 事件名 + 载荷与 /ask 字节兼容。
 */
import { registerApiRoute } from '@mastra/core/server';
import {
  getConversationWithMessages,
  resetAssistantForRetry,
  getLastAssistantMessage,
  updateAssistantStreaming,
} from '../../../modules/conversations/service.js';
import {
  buildAskStreamResponse,
  tryRegisterExecution,
} from '../../../core/execution/ask-driver.js';
import { isExecutionActive } from '../../../core/execution/controller.js';
import { isUuid } from '../../../core/execution/sse.js';
import { getDatabasePool } from '../../../infrastructure/database/pool.js';

export const regenerateMessageRoute = registerApiRoute('/messages/:assistantMessageId/regenerate', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    try {
      const assistantMessageId = context.req.param('assistantMessageId');
      if (!assistantMessageId || !isUuid(assistantMessageId)) {
        return context.json({ message: '消息 ID 格式不正确。' }, 400);
      }

      const pool = getDatabasePool();
      const msgResult = await pool.query<{ conversation_id: string }>(
        `SELECT conversation_id FROM messages WHERE id = $1`,
        [assistantMessageId],
      );
      if (!msgResult.rows[0]) {
        return context.json({ message: '消息不存在。' }, 404);
      }
      const conversationId = msgResult.rows[0].conversation_id;

      const { conversation, messages: history } = await getConversationWithMessages(conversationId);

      const lastAssistant = await getLastAssistantMessage(conversationId);
      if (!lastAssistant || lastAssistant.id !== assistantMessageId) {
        return context.json({ message: '只能对会话最后一条助手消息重新生成。' }, 409);
      }

      if (isExecutionActive(assistantMessageId)) {
        return context.json({ message: '该消息正在生成中，请等待完成或停止后再试。' }, 409);
      }

      const assistantIndex = history.findIndex((m) => m.id === assistantMessageId);
      const priorHistory = history.slice(0, assistantIndex);
      let triggeringUserMessage: typeof priorHistory[number] | undefined;
      for (let i = assistantIndex - 1; i >= 0; i--) {
        if (history[i]!.role === 'user') {
          triggeringUserMessage = history[i];
          break;
        }
      }
      if (!triggeringUserMessage) {
        return context.json({ message: '找不到对应用户问题。' }, 400);
      }

      await resetAssistantForRetry(assistantMessageId);

      const registered = tryRegisterExecution(assistantMessageId);
      if ('conflict' in registered) {
        return context.json({ message: registered.conflict.message }, 409);
      }
      const abortController = registered.controller;

      await updateAssistantStreaming(assistantMessageId);

      return buildAskStreamResponse({
        assistantMessageId,
        conversationId,
        agentId: conversation.agentId,
        message: triggeringUserMessage.content,
        knowledgeBaseId: conversation.knowledgeBaseId,
        history: priorHistory,
        abortSignal: abortController.signal,
      }, { logTag: 'regenerate' });
    } catch (error) {
      console.error('重新生成请求失败：', error);
      if (error instanceof Error && error.message === '会话不存在。') {
        return context.json({ message: '会话不存在。' }, 404);
      }
      return context.json({ message: '服务暂时不可用，请稍后重试。' }, 500);
    }
  },
});
