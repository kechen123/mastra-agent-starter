/**
 * POST /messages/:assistantMessageId/regenerate — 在会话内重新生成最近一条
 * 助手消息。
 *
 * 先校验目标消息确实是该会话最后一条 assistant 消息，再重建历史切片并复用
 * 同一 ask driver。SSE 事件名 + 载荷与 /ask 字节兼容。
 *
 * 会话级执行互斥（reserve-before-read）：
 *  1. 通过 messageId 查询得到 conversationId 后，**立即**
 *     `tryReserveConversationExecution(conversationId)` 预占；冲突直接 409。
 *  2. reserve 成功后，**所有**决定性状态读取（`getConversationWithMessages`、
 *     `getLastAssistantMessage`、`getMessageSnapshot`）必须在锁内完成。
 *  3. setup 阶段（history / lastAssistant / snapshot 读取、bind、reset、
 *     streaming 切换、历史切片）任意一步失败，本路由释放会话锁。
 *  4. 只有在已经执行 `resetAssistantForRetry` 之后失败，才按快照恢复目标消息，
 *     且仅当消息仍处于 pending/streaming 时写入。
 *  5. SSE Response 构造成功后，执行权交给 `buildAskStreamResponse` 的 finally。
 */
import { registerApiRoute } from '@mastra/core/server';
import {
  getConversationWithMessages,
  getLastAssistantMessage,
  getMessageSnapshot,
  resetAssistantForRetry,
  restoreAssistantFromSnapshot,
  updateAssistantStreaming,
} from '../../../modules/conversations/service.js';
import {
  buildAskStreamResponse,
} from '../../../core/execution/ask-driver.js';
import {
  bindAssistantMessageToExecution,
  cleanupConversationExecution,
  cleanupExecution,
  tryReserveConversationExecution,
} from '../../../core/execution/controller.js';
import { isUuid } from '../../../core/execution/sse.js';
import { getDatabasePool } from '../../../infrastructure/database/pool.js';

export const regenerateMessageRoute = registerApiRoute('/messages/:assistantMessageId/regenerate', {
  method: 'POST',
  requiresAuth: true,
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

      // 关键：在得到 conversationId 之后、任何业务读取之前立即预占会话。
      const reserved = tryReserveConversationExecution(conversationId);
      if ('conflict' in reserved) {
        return context.json({ message: reserved.conflict.message }, 409);
      }

      let bound = false;
      let reset = false;
      let snapshot: Awaited<ReturnType<typeof getMessageSnapshot>> = null;
      try {
        // 以下所有读取与决策都在锁内完成。
        const { conversation, messages: history } = await getConversationWithMessages(conversationId);

        const lastAssistant = await getLastAssistantMessage(conversationId);
        if (!lastAssistant || lastAssistant.id !== assistantMessageId) {
          throw new Error('只能对会话最后一条助手消息重新生成。');
        }

        snapshot = await getMessageSnapshot(assistantMessageId);
        if (!snapshot) {
          throw new Error('消息不存在。');
        }

        bindAssistantMessageToExecution(conversationId, assistantMessageId);
        bound = true;

        await resetAssistantForRetry(assistantMessageId);
        reset = true;

        await updateAssistantStreaming(assistantMessageId);

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
          throw new Error('找不到对应用户问题。');
        }

        return buildAskStreamResponse({
          assistantMessageId,
          conversationId,
          agentId: conversation.agentId,
          message: triggeringUserMessage.content,
          knowledgeBaseId: conversation.knowledgeBaseId,
          history: priorHistory,
          abortSignal: reserved.controller.signal,
        }, { logTag: 'regenerate' });
      } catch (setupError) {
        // setup 阶段失败：释放执行权；若已重置过，按快照恢复目标消息。
        if (bound) {
          cleanupExecution(assistantMessageId);
        } else {
          // 仅预占未绑定时也要把会话锁释放，避免孤儿预占。
          cleanupConversationExecution(conversationId);
        }
        if (reset && snapshot) {
          await restoreAssistantFromSnapshot(assistantMessageId, snapshot).catch((err) => {
            console.error('regenerate 失败后恢复快照失败：', err);
          });
        }
        throw setupError;
      }
    } catch (error) {
      console.error('重新生成请求失败：', error);
      if (error instanceof Error && error.message === '会话不存在。') {
        return context.json({ message: '会话不存在。' }, 404);
      }
      if (error instanceof Error && error.message === '消息不存在。') {
        return context.json({ message: '消息不存在。' }, 404);
      }
      if (error instanceof Error && error.message === '只能对会话最后一条助手消息重新生成。') {
        return context.json({ message: error.message }, 409);
      }
      if (error instanceof Error && error.message === '找不到对应用户问题。') {
        return context.json({ message: error.message }, 400);
      }
      return context.json({ message: '服务暂时不可用，请稍后重试。' }, 500);
    }
  },
});
