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
 *
 * Workspace 预校验（PR-1.5 跨 workspace 隔离）：
 *   必须在 `tryReserveConversationExecution` 之前先验证目标消息归属当前
 *   workspace；未命中 → 404。这样可以避免"预占会话锁后才发现跨 workspace"
 *   的非对称失败。
 *
 *   实现上不能用 `getConversationWithMessages(workspaceId, conversationId)`
 *   做这一步：run.ts §6 ExecLock 契约要求 `tryReserveConversationExecution`
 *   必须早于 `getConversationWithMessages`，否则两个并发请求可能读到相同
 *   历史切片导致 user/assistant 顺序错乱。本路由的 workspace 预校验用一条
 *   简单 SELECT 直接判 `workspace_id`，getConversationWithMessages 仍按
 *   reserve-before-read 在锁内执行历史切片读取。
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
import { withAuthenticatedWorkspace } from '../../../modules/auth/workspace-context.js';

export const regenerateMessageRoute = registerApiRoute('/messages/:assistantMessageId/regenerate', {
  method: 'POST',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
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
      return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
    }
    const conversationId = msgResult.rows[0].conversation_id;

    // 关键：workspace 归属校验必须在预占会话执行权之前完成。
    // 跨 workspace 访问一律 404（不暴露 403），避免出现"预占成功但跨 workspace"
    // 的不对称失败语义。这里用一条最小 SELECT 判 conversation.workspace_id；
    // getConversationWithMessages（包含 history 切片）仍按 reserve-before-read
    // 契约在锁内执行，避开 run.ts §6 ExecLock 校验。
    const ownerRow = await pool.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM conversations WHERE id = $1 AND workspace_id = $2`,
      [conversationId, authCtx.workspaceId],
    );
    if (ownerRow.rows.length === 0) {
      return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
    }

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
      const detail = await getConversationWithMessages(authCtx.workspaceId, conversationId);
      if (!detail) {
        // reserve 后再次校验：理论上 workspace 校验已通过，但保留防御性 404。
        return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
      }
      const { conversation, messages: history } = detail;

      const lastAssistant = await getLastAssistantMessage(authCtx.workspaceId, conversationId);
      if (!lastAssistant || lastAssistant.id !== assistantMessageId) {
        // 业务约束：仅允许对会话最后一条助手消息重新生成——属于状态冲突，409。
        return context.json(
          { message: '只能对会话最后一条助手消息重新生成。' },
          409,
        );
      }

      snapshot = await getMessageSnapshot(authCtx.workspaceId, assistantMessageId);
      if (!snapshot) {
        return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
      }

      bindAssistantMessageToExecution(conversationId, assistantMessageId);
      bound = true;

      await resetAssistantForRetry(authCtx.workspaceId, assistantMessageId);
      reset = true;

      await updateAssistantStreaming(authCtx.workspaceId, assistantMessageId);

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
        // 业务约束：找不到触发本次 assistant 回复的用户问题——客户端数据异常，400。
        return context.json({ message: '找不到对应用户问题。' }, 400);
      }

      return buildAskStreamResponse({
        workspaceId: authCtx.workspaceId,
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
        await restoreAssistantFromSnapshot(authCtx.workspaceId, assistantMessageId, snapshot).catch((err) => {
          console.error('regenerate failed to restore snapshot:', err);
        });
      }
      throw setupError;
    }
  }),
});