import { getDatabasePool } from '../../database/pool.js';

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface ToolExecutionRecord {
  id: string;
  conversationId: string;
  messageId: string;
  skillId: string;
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
  skillId: string,
  input: Record<string, unknown>,
): Promise<string> {
  const pool = getDatabasePool();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO skill_executions (conversation_id, message_id, skill_id, input, status)
     VALUES ($1, $2, $3, $4, 'running')
     RETURNING id`,
    [conversationId, messageId, skillId, JSON.stringify(input)],
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
    `SELECT started_at FROM skill_executions WHERE id = $1`,
    [id],
  );
  const startedAt = startedResult.rows[0]?.started_at;
  const durationMs = startedAt ? Math.max(0, completedAt.getTime() - new Date(startedAt).getTime()) : undefined;

  await pool.query(
    `UPDATE skill_executions
     SET output = $2, status = $3, error_code = $4, completed_at = $5, duration_ms = $6
     WHERE id = $1`,
    [id, output ? JSON.stringify(output) : null, status, errorCode ?? null, completedAt, durationMs ?? null],
  );
}

export async function getToolExecutionsByMessage(messageId: string): Promise<ToolExecutionRecord[]> {
  const pool = getDatabasePool();
  const result = await pool.query<
    { id: string; conversation_id: string; message_id: string; skill_id: string; input: unknown; output: unknown; status: string; error_code: string | null; started_at: Date; completed_at: Date | null; duration_ms: number | null }
  >(
    `SELECT id, conversation_id, message_id, skill_id, input, output, status, error_code, started_at, completed_at, duration_ms
     FROM skill_executions WHERE message_id = $1 ORDER BY started_at ASC`,
    [messageId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    skillId: r.skill_id,
    input: (r.input as Record<string, unknown>) ?? {},
    output: r.output ? (r.output as Record<string, unknown>) : undefined,
    status: r.status as ExecutionStatus,
    errorCode: r.error_code ?? undefined,
    startedAt: r.started_at,
    completedAt: r.completed_at ?? undefined,
    durationMs: r.duration_ms ?? undefined,
  }));
}
