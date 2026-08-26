import { getDatabasePool } from '../../database/pool.js';

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface ToolExecutionRecord {
  id: string;
  conversationId: string;
  messageId: string;
  toolId: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: ExecutionStatus;
  errorCode?: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
}

export async function createToolExecution(
  conversationId: string,
  messageId: string,
  toolId: string,
  input: Record<string, unknown>,
): Promise<string> {
  const pool = getDatabasePool();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO tool_executions (conversation_id, message_id, tool_id, input, status)
     VALUES ($1, $2, $3, $4, 'running')
     RETURNING id`,
    [conversationId, messageId, toolId, JSON.stringify(input)],
  );
  return result.rows[0]!.id;
}

export async function finalizeToolExecution(
  id: string,
  output: Record<string, unknown> | null,
  status: Extract<ExecutionStatus, 'completed' | 'failed' | 'stopped'>,
  errorCode?: string,
): Promise<void> {
  const pool = getDatabasePool();
  const completedAt = new Date();
  const startedResult = await pool.query<{ started_at: Date }>(
    `SELECT started_at FROM tool_executions WHERE id = $1`,
    [id],
  );
  const startedAt = startedResult.rows[0]?.started_at;
  const durationMs = startedAt ? Math.max(0, completedAt.getTime() - new Date(startedAt).getTime()) : undefined;

  await pool.query(
    `UPDATE tool_executions
     SET output = $2, status = $3, error_code = $4, completed_at = $5, duration_ms = $6
     WHERE id = $1`,
    [id, output ? JSON.stringify(output) : null, status, errorCode ?? null, completedAt, durationMs ?? null],
  );
}

/**
 * Converge any still-running tool executions for a given message to a
 * terminal status. Called on stream end, exception, or stop signal so that
 * no row stays at status='running' forever.
 */
export async function convergeRunningToolExecutions(
  messageId: string,
  status: Extract<ExecutionStatus, 'stopped' | 'failed'>,
  errorCode?: string,
): Promise<number> {
  const pool = getDatabasePool();
  const completedAt = new Date();
  const result = await pool.query<{ id: string; started_at: Date }>(
    `UPDATE tool_executions
     SET status = $2,
         error_code = COALESCE($3, error_code),
         completed_at = COALESCE(completed_at, $4),
         duration_ms = COALESCE(duration_ms, GREATEST(0, EXTRACT(EPOCH FROM ($4 - started_at)) * 1000)::int)
     WHERE message_id = $1 AND status = 'running'
     RETURNING id, started_at`,
    [messageId, status, errorCode ?? null, completedAt],
  );
  return result.rowCount ?? 0;
}

export async function getToolExecutionsByMessage(messageId: string): Promise<ToolExecutionRecord[]> {
  const pool = getDatabasePool();
  const result = await pool.query<
    { id: string; conversation_id: string; message_id: string; tool_id: string; input: unknown; output: unknown; status: string; error_code: string | null; started_at: Date; completed_at: Date | null; duration_ms: number | null }
  >(
    `SELECT id, conversation_id, message_id, tool_id, input, output, status, error_code, started_at, completed_at, duration_ms
     FROM tool_executions WHERE message_id = $1 ORDER BY started_at ASC`,
    [messageId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    toolId: r.tool_id,
    input: (r.input as Record<string, unknown>) ?? {},
    output: r.output ? (r.output as Record<string, unknown>) : undefined,
    status: r.status as ExecutionStatus,
    errorCode: r.error_code ?? undefined,
    startedAt: r.started_at,
    completedAt: r.completed_at ?? undefined,
    durationMs: r.duration_ms ?? undefined,
  }));
}
