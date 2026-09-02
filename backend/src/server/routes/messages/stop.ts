/**
 * POST /messages/:id/stop — 终止正在进行的生成（V2 兼容路径）。
 *
 * 行为：
 *  - 兼容旧 ask-driver 执行控制器与新 run-executor 控制器；
 *  - 控制器命中时：
 *      1. 发 abort 信号（run executor 也会被 abortRunByMessage 命中）；
 *      2. 同步在 DB 事务内收敛 Run + message + run-stopped 事件，
 *         防止 executor 的 finally 块在 stop 之后又写入 completed；
 *      3. 收敛仍处于 running 的 tool_executions。
 *  - 控制器已不存在（进程重启 / 已终态化）但 DB 行仍为 active 时，
 *    直接走事务收敛。
 *
 * Workspace 守卫（PR-1.5 跨 workspace 隔离）：
 *   任何路径都先验证消息归属当前 workspace；不命中 → 404，与 "not found"
 *   字节级一致，不暴露 403。
 *
 * 弃用响应头由 bootstrap.ts 的 withDeprecationHeaders 统一附加。
 */
import { registerApiRoute } from '@mastra/core/server';
import { abortExecution } from '../../../core/execution/controller.js';
import { abortRunByMessage } from '../../../core/execution/run-executor.js';
import {
  convergeRunningToolExecutions,
} from '../../../modules/conversations/tool-executions.js';
import { stopRunByMessageId } from '../../../modules/runs/service.js';
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

    const pool = getDatabasePool();
    // 关键：先验证消息归属当前 workspace，避免跨 workspace 误终止。
    const ownerRow = await pool.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM messages WHERE id = $1`,
      [id],
    );
    if (!ownerRow.rows[0] || ownerRow.rows[0].workspace_id !== authCtx.workspaceId) {
      return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
    }

    // 双保险：旧 ask-driver 执行控制器 + 新 run-executor 控制器都尝试中止。
    const legacy = abortExecution(id);
    const runnerAborted = abortRunByMessage(id);
    const controllerAlive = legacy.success || runnerAborted;
    const partialContent = legacy.partialContent ?? '';

    // 控制器存活时同步收敛 DB；executor 的 finally 不再写 completed（终态条件 WHERE）。
    if (controllerAlive) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await stopRunByMessageId(client, {
          workspaceId: authCtx.workspaceId,
          assistantMessageId: id,
          partialContent,
        });
        await client.query('COMMIT');
        if (!result.stopped && 'missing' in result) {
          return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
        }
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      } finally {
        client.release();
      }
      await convergeRunningToolExecutions(authCtx.workspaceId, id);
      return context.json({ message: '已停止生成。', status: 'stopped' }, 200);
    }

    // 控制器已不存在：DB 行若仍 active（pending / streaming）→ 走事务收敛。
    const msgResult = await pool.query<{ status: string; content: string }>(
      `SELECT status, content FROM messages WHERE id = $1`,
      [id],
    );
    const row = msgResult.rows[0];
    if (!row) {
      return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
    }
    if (row.status === 'pending' || row.status === 'streaming') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await stopRunByMessageId(client, {
          workspaceId: authCtx.workspaceId,
          assistantMessageId: id,
          partialContent: row.content || '',
        });
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      } finally {
        client.release();
      }
      await convergeRunningToolExecutions(authCtx.workspaceId, id);
      return context.json({ message: '已停止生成。', status: 'stopped' }, 200);
    }
    return context.json({ message: '无活跃生成可停止。', status: row.status }, 200);
  }),
});