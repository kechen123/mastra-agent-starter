/**
 * POST /messages/:id/stop — 终止正在进行的生成。
 *
 * 行为：
 *  - 内存执行控制器仍存活时，发 abort 信号；流的 `finally` 块负责落终态
 *    并收敛工具执行。
 *  - 控制器已不存在（进程重启 / 已终态化）但 DB 行仍为 pending / streaming
 *    时，直接落终态 + 收敛工具，确保用户可见状态与现实一致。
 */
import { registerApiRoute } from '@mastra/core/server';
import { abortExecution } from '../../../core/execution/controller.js';
import {
  convergeRunningToolExecutions,
} from '../../../modules/conversations/tool-executions.js';
import { finalizeAssistant } from '../../../modules/conversations/service.js';
import { getDatabasePool } from '../../../infrastructure/database/pool.js';
import { isUuid } from '../../../core/execution/sse.js';

export const stopMessageRoute = registerApiRoute('/messages/:id/stop', {
  method: 'POST',
  requiresAuth: true,
  handler: async (context) => {
    const id = context.req.param('id');
    if (!id || !isUuid(id)) {
      return context.json({ message: '消息 ID 格式不正确。' }, 400);
    }
    const { success, partialContent } = abortExecution(id);
    if (!success) {
      const pool = getDatabasePool();
      const msgResult = await pool.query<{ status: string; content: string }>(
        `SELECT status, content FROM messages WHERE id = $1`,
        [id],
      );
      const row = msgResult.rows[0];
      if (!row) {
        return context.json({ message: '消息不存在。' }, 404);
      }
      if (row.status === 'pending' || row.status === 'streaming') {
        const safeContent = row.content || partialContent || '';
        await finalizeAssistant(id, safeContent, [], 'stopped');
        await convergeRunningToolExecutions(id, 'stopped', 'stream_aborted');
        return context.json({ message: '已停止生成。', status: 'stopped' }, 200);
      }
      return context.json({ message: '无活跃生成可停止。', status: row.status }, 200);
    }
    // 活跃执行已被 abort，同步收敛本消息下仍处于 running 的 tool_executions。
    await convergeRunningToolExecutions(id, 'stopped', 'stream_aborted');
    return context.json({ message: '已停止生成。', status: 'stopped' }, 200);
  },
});
