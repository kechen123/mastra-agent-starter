/**
 * POST /messages/:id/stop — 终止正在进行的生成。
 *
 * 行为：
 *  - 内存执行控制器仍存活时，发 abort 信号；流的 `finally` 块负责落终态
 *    并收敛工具执行。
 *  - 控制器已不存在（进程重启 / 已终态化）但 DB 行仍为 pending / streaming
 *    时，直接落终态 + 收敛工具，确保用户可见状态与现实一致。
 *
 * Workspace 守卫（PR-1.5 跨 workspace 隔离）：
 *   在调用 `abortExecution(id)` 之前必须先验证目标消息归属当前 workspace，
 *   否则攻击者仅凭 UUID 就能让其他 workspace 的生成被 abort。验证失败 → 404，
 *   与 "not found" 字节级一致，不暴露 403。
 */
import { registerApiRoute } from '@mastra/core/server';
import { abortExecution } from '../../../core/execution/controller.js';
import {
  convergeRunningToolExecutions,
} from '../../../modules/conversations/tool-executions.js';
import { finalizeAssistant } from '../../../modules/conversations/service.js';
import { getDatabasePool } from '../../../infrastructure/database/pool.js';
import { isUuid } from '../../../core/execution/sse.js';
import { withAuthenticatedWorkspace } from '../../../modules/auth/workspace-context.js';

export const stopMessageRoute = registerApiRoute('/messages/:id/stop', {
  method: 'POST',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const id = context.req.param('id');
    if (!id || !isUuid(id)) {
      return context.json({ message: '消息 ID 格式不正确。' }, 400);
    }

    // 关键：先验证消息归属当前 workspace，避免跨 workspace 误终止。
    // 未命中（消息不存在 / 归属其他 workspace）一律返回 404，与"资源不存在"字节级一致。
    const pool = getDatabasePool();
    const ownerRow = await pool.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM messages WHERE id = $1`,
      [id],
    );
    if (!ownerRow.rows[0] || ownerRow.rows[0].workspace_id !== authCtx.workspaceId) {
      return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
    }

    const { success, partialContent } = abortExecution(id);
    if (!success) {
      const msgResult = await pool.query<{ status: string; content: string }>(
        `SELECT status, content FROM messages WHERE id = $1`,
        [id],
      );
      const row = msgResult.rows[0];
      if (!row) {
        return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
      }
      if (row.status === 'pending' || row.status === 'streaming') {
        const safeContent = row.content || partialContent || '';
        await finalizeAssistant(authCtx.workspaceId, id, safeContent, [], 'stopped');
        await convergeRunningToolExecutions(authCtx.workspaceId, id);
        return context.json({ message: '已停止生成。', status: 'stopped' }, 200);
      }
      return context.json({ message: '无活跃生成可停止。', status: row.status }, 200);
    }
    // 活跃执行已被 abort，同步收敛本消息下仍处于 running 的 tool_executions。
    await convergeRunningToolExecutions(authCtx.workspaceId, id);
    return context.json({ message: '已停止生成。', status: 'stopped' }, 200);
  }),
});