import {
  ResourceNotFoundError,
  CrossWorkspaceAccessError,
} from '../../server/error-mapping.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';

export type ExecutionStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled';

export interface ToolExecutionRecord {
  id: string;
  messageId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  status: ExecutionStatus;
  error?: string;
  startedAt: Date;
  finishedAt?: Date;
}

export async function createToolExecution(
  workspaceId: string,
  messageId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const pool = getDatabasePool();
  // 父 message 不属于 workspace → 跨 workspace 访问，抛 CrossWorkspaceAccessError（404）。
  const msgCheck = await pool.query<{ id: string }>(
    'SELECT id FROM messages WHERE id = $1 AND workspace_id = $2',
    [messageId, workspaceId],
  );
  if (msgCheck.rows.length === 0) {
    throw new CrossWorkspaceAccessError();
  }

  const result = await pool.query<{ id: string }>(
    `INSERT INTO tool_executions (workspace_id, message_id, tool_name, args, status)
     VALUES ($1, $2, $3, $4, 'running')
     RETURNING id`,
    [workspaceId, messageId, toolName, JSON.stringify(args)],
  );
  return result.rows[0]!.id;
}

export async function finalizeToolExecution(
  workspaceId: string,
  execId: string,
  result: Record<string, unknown> | null,
  status: Extract<ExecutionStatus, 'success' | 'error' | 'cancelled'>,
  error?: string,
): Promise<void> {
  const pool = getDatabasePool();
  // 参数位顺序：$1=execId（WHERE id），$2=workspaceId（WHERE workspace_id），
  // $3=result（SET result），$4=status（SET status），$5=error（SET error）。
  // 历史回归（PR-1.2 关闭审查发现）：原 SQL 用 $2/$3/$4 映射到 result/status/
  // error，导致 UUID 落到 JSONB 列上直接报 type cast 错。已按 Codex 整改。
  const updateResult = await pool.query<{ id: string }>(
    `UPDATE tool_executions
        SET result = $3, status = $4, error = $5, finished_at = now()
      WHERE id = $1 AND workspace_id = $2
      RETURNING id`,
    [execId, workspaceId, result ? JSON.stringify(result) : null, status, error ?? null],
  );
  // 用户资源写：rowCount===0 → 抛 ResourceNotFoundError（404）。
  if (updateResult.rowCount === 0) {
    throw new ResourceNotFoundError('工具执行记录不存在。');
  }
}

/**
 * 把某条消息下仍处于 running 的 tool_executions 收敛到终态。
 * 在流结束、异常或停止信号时调用，确保不会出现 status='running' 的孤儿行。
 */
export async function convergeRunningToolExecutions(
  workspaceId: string,
  messageId: string,
): Promise<number> {
  const pool = getDatabasePool();
  // internal idempotent —— 跨 workspace 一律按"未命中"语义处理；行不存在或已
  // 收敛的视为正常收敛结果（0 行）。
  const result = await pool.query<{ id: string }>(
    `UPDATE tool_executions
        SET status = 'cancelled',
            error = COALESCE(error, 'converged'),
            finished_at = COALESCE(finished_at, now())
      WHERE message_id = $1 AND workspace_id = $2 AND status = 'running'
      RETURNING id`,
    [messageId, workspaceId],
  );
  return result.rowCount ?? 0;
}

export async function getToolExecutionsByMessage(
  workspaceId: string,
  messageId: string,
): Promise<ToolExecutionRecord[]> {
  const pool = getDatabasePool();
  const result = await pool.query<
    { id: string; message_id: string; tool_name: string; args: unknown; result: unknown; status: string; error: string | null; started_at: Date; finished_at: Date | null }
  >(
    `SELECT id, message_id, tool_name, args, result, status, error, started_at, finished_at
       FROM tool_executions
      WHERE message_id = $1 AND workspace_id = $2
      ORDER BY started_at ASC`,
    [messageId, workspaceId],
  );
  // 查询类：跨 workspace 0 行返空数组（不抛错，与其他 query 语义一致）。
  return result.rows.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    toolName: r.tool_name,
    args: (r.args as Record<string, unknown>) ?? {},
    result: r.result ? (r.result as Record<string, unknown>) : undefined,
    status: r.status as ExecutionStatus,
    error: r.error ?? undefined,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
  }));
}