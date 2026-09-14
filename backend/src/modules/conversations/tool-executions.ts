/**
 * Tool execution persistence (V2 阶段 2 引入 tool_call_id 统一 ID)。
 *
 * 设计目标：
 *   - DB 行的 `id` 仅作为内部 PK；
 *   - 业务统一 ID = `tool_call_id`（Mastra toolCallId），在
 *     (workspace_id, run_id, tool_call_id) 上 UNIQUE；
 *   - SSE / Mastra / approval resume / 历史恢复 / 前端卡片都用
 *     `tool_call_id` 关联；
 *   - create/upsert 幂等（同一 toolCallId 多次写只产生 1 行）；
 *   - complete/fail 对缺失 start 必须安全 no-op（approval resume
 *     不会先产生 started 行）；
 *   - event replay 不重复新增行；
 *   - finish 不覆写已存在的合法终态（result / status）。
 *
 * 仅 fresh-DB 路径生效；既有库 schema 已存在的 tool_executions 表
 * 没有 tool_call_id 列，需要按 init.sql 重置后才能跑这条路径。
 */
import {
  CrossWorkspaceAccessError,
} from '../../server/error-mapping.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { buildBackfillError, pickBackfillStatus } from '../runs/citation-merge.js';

// re-export 让测试与上下游模块直接引用共享纯函数（避免再次复制）。
export { pickBackfillStatus, buildBackfillError } from '../runs/citation-merge.js';

export type ExecutionStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled';

export interface ToolExecutionRecord {
  /** DB 主键。 */
  id: string;
  /** 业务统一 ID：Mastra toolCallId。 */
  toolCallId: string;
  runId: string | null;
  messageId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  status: ExecutionStatus;
  error?: string;
  startedAt: Date;
  finishedAt?: Date;
}

/**
 * 幂等创建 / upsert tool_execution。
 *
 * 行为：
 *   - 同 (workspace_id, run_id, tool_call_id) 已存在 → 直接返回已有 id，
 *     不重写（即使 args 不一致也不覆盖——tool_call_id 是同一调用就应等价）；
 *   - 不存在 → INSERT，返回新 id；
 *   - 跨 workspace 访问 message → 抛 CrossWorkspaceAccessError（404）。
 *
 * 与 run executor 配合：事件 replay 时重复调用不会重复 INSERT。
 */
export async function upsertToolExecution(input: {
  workspaceId: string;
  messageId: string;
  runId: string | null;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<string> {
  if (!input.toolCallId) {
    throw new Error('upsertToolExecution: toolCallId is required');
  }
  const pool = getDatabasePool();
  // 父 message 归属校验
  const msgCheck = await pool.query<{ id: string }>(
    'SELECT id FROM messages WHERE id = $1 AND workspace_id = $2',
    [input.messageId, input.workspaceId],
  );
  if (msgCheck.rows.length === 0) {
    throw new CrossWorkspaceAccessError();
  }

  // 两类唯一约束要分别作为 conflict target：
  //   - 非 NULL run_id：表级 UNIQUE(workspace_id, run_id, tool_call_id)；
  //   - NULL run_id：部分唯一索引 tool_executions_null_run_unique。
  // PostgreSQL 不会把不含谓词的 conflict target 推断成部分索引；若 NULL
  // 路径仍沿用三列 target，重复 SSE replay 会直接抛 23505，而不是幂等返回。
  const conflictTarget = input.runId === null
    ? 'ON CONFLICT (workspace_id, tool_call_id) WHERE run_id IS NULL DO NOTHING'
    : 'ON CONFLICT (workspace_id, run_id, tool_call_id) DO NOTHING';
  const insertResult = await pool.query<{ id: string }>(
    `INSERT INTO tool_executions (
        workspace_id, message_id, run_id, tool_call_id, tool_name, args, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'running')
      ${conflictTarget}
      RETURNING id`,
    [
      input.workspaceId,
      input.messageId,
      input.runId,
      input.toolCallId,
      input.toolName,
      JSON.stringify(input.args),
    ],
  );
  if (insertResult.rows[0]) return insertResult.rows[0].id;

  // 已存在：回查 id 返回。限定 workspace 防御越权。
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM tool_executions
      WHERE workspace_id = $1 AND run_id IS NOT DISTINCT FROM $2 AND tool_call_id = $3
      LIMIT 1`,
    [input.workspaceId, input.runId, input.toolCallId],
  );
  if (!existing.rows[0]) {
    // 极少见：ON CONFLICT 命中但 SELECT 找不到（理论上不会）。
    throw new Error(
      `upsertToolExecution: ON CONFLICT hit but SELECT returned no row (toolCallId=${input.toolCallId})`,
    );
  }
  return existing.rows[0].id;
}

/**
 * 完成 / 失败 tool execution；幂等。
 *
 * 行为：
 *   - 行已存在且处于终态（success / error / cancelled）→ 不覆写
 *     （return false）；
 *   - 行已存在但非终态 → 写 result / status / error / finished_at；
 *   - 行不存在（典型：approval resume 缺失 start 行，或 legacy sink
 *     在 run_id=NULL 路径下被独立 finalize）→ 按需 backfill 一行审计记录：
 *       * 有 runId：通过 `agent_runs.assistant_message_id` 反查 messageId；
 *         通过 backfill 传入的 `toolName` 落库；`args` 留空对象
 *         （审计字段，不臆造执行参数）。
 *       * 无 runId（legacy 兜底）：必须显式提供 `messageId`；否则视为
 *         上游数据缺失 → 抛错（不允许静默丢弃事件）。
 *     backfill 的状态默认 `cancelled`，并写 `error` 标注
 *     'finalized_without_start'，避免误把 backfill 当成正常完成。
 *
 * 返回 true 表示确实写了终态（含 backfill），false 表示幂等 no-op。
 */
export async function finalizeToolExecutionByCallId(input: {
  workspaceId: string;
  runId: string | null;
  toolCallId: string;
  result: Record<string, unknown> | null;
  status: Extract<ExecutionStatus, 'success' | 'error' | 'cancelled'>;
  error?: string;
  /** backfill 时必填（与 runId 必须同时存在；缺一即抛错）。 */
  toolName?: string;
  messageId?: string;
}): Promise<boolean> {
  if (!input.toolCallId) return false;
  const pool = getDatabasePool();
  // 第一步：尝试直接 UPDATE（按 stable ID）。
  const updateResult = await pool.query<{ id: string; status: string }>(
    `UPDATE tool_executions
        SET result = $4, status = $5, error = $6, finished_at = now()
      WHERE workspace_id = $1
        AND run_id IS NOT DISTINCT FROM $2
        AND tool_call_id = $3
        AND status NOT IN ('success', 'error', 'cancelled')
      RETURNING id, status`,
    [
      input.workspaceId,
      input.runId,
      input.toolCallId,
      input.result ? JSON.stringify(input.result) : null,
      input.status,
      input.error ?? null,
    ],
  );
  if ((updateResult.rowCount ?? 0) > 0) return true;

  // 第二步：UPDATE 没命中 → 检查是否行已存在但已终态（幂等）。
  const existingTerminal = await pool.query<{ id: string }>(
    `SELECT id FROM tool_executions
      WHERE workspace_id = $1
        AND run_id IS NOT DISTINCT FROM $2
        AND tool_call_id = $3
        AND status IN ('success', 'error', 'cancelled')
      LIMIT 1`,
    [input.workspaceId, input.runId, input.toolCallId],
  );
  if (existingTerminal.rowCount && existingTerminal.rowCount > 0) {
    return false; // 已终态，不覆写。
  }

  // 第三步：行不存在 → backfill 审计行。解析 messageId 来源。
  let messageId: string | null = input.messageId ?? null;
  const toolName: string | null = input.toolName ?? null;
  if (input.runId) {
    // 通过 agent_runs 反查 assistant_message_id；这是 PR-review Item 4
    // 强制要求：不允许在缺失关联的行上凭空写入。
    const runRow = await pool.query<{ assistant_message_id: string }>(
      `SELECT assistant_message_id FROM agent_runs
        WHERE id = $1 AND workspace_id = $2`,
      [input.runId, input.workspaceId],
    );
    if (runRow.rows[0]) {
      messageId = runRow.rows[0].assistant_message_id;
    }
  }
  if (!messageId || !toolName) {
    // 既无 runId 关联，也未显式给出 messageId/toolName → 数据缺失，
    // 不允许用 NULL/默认值兜底（避免把事件静默丢失或挂到错误消息下）。
    throw new Error(
      `finalizeToolExecutionByCallId: 缺失 start 行且无法反查 messageId（toolCallId=${input.toolCallId}, runId=${input.runId ?? 'null'}）`,
    );
  }
  // backfill：插入审计行；NULL run_id 路径走部分唯一索引
  // `tool_executions_null_run_unique`，同 workspace + toolCallId 不重复。
  // PR-review Round 2 Item 3 修复：保留输入的终态（status='success'/
  // 'error'/'cancelled'），用 error 字段额外打 'finalized_without_start'
  // 标记区分正常收敛与 start 行缺失的特殊场景。前端"已取消"显示
  // 之前错误地把 complete/error 一起标成 cancelled。
  const backfillStatus = pickBackfillStatus(input.status);
  const backfillError = buildBackfillError(input.error);
  const insertResult = await pool.query<{ id: string }>(
    `INSERT INTO tool_executions (
        workspace_id, message_id, run_id, tool_call_id, tool_name,
        args, result, status, error, started_at, finished_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, now(), now())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.workspaceId,
      messageId,
      input.runId,
      input.toolCallId,
      toolName,
      JSON.stringify({}),
      input.result ? JSON.stringify(input.result) : null,
      backfillStatus,
      backfillError,
    ],
  );
  return (insertResult.rowCount ?? 0) > 0;
}

/**
 * 把某条消息下仍处于 running 的 tool_executions 收敛到终态。
 *
 * 在流结束、异常或停止信号时调用，确保不会出现 status='running' 的孤儿行。
 * 该路径保持 runId 无关——只按 (workspace_id, message_id) 收敛。
 */
export async function convergeRunningToolExecutions(
  workspaceId: string,
  messageId: string,
): Promise<number> {
  const pool = getDatabasePool();
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

/**
 * 批量按 messageIds 拉 tool_executions，返回 Map<messageId, ToolExecutionRecord[]>。
 *
 * 一次性拉所有行 → 上层按 messageId 分组；消除 N+1。
 */
export async function getToolExecutionsByMessages(
  workspaceId: string,
  messageIds: ReadonlyArray<string>,
): Promise<Map<string, ToolExecutionRecord[]>> {
  const out = new Map<string, ToolExecutionRecord[]>();
  if (messageIds.length === 0) return out;
  const pool = getDatabasePool();
  const result = await pool.query<{
    id: string;
    tool_call_id: string;
    run_id: string | null;
    message_id: string;
    tool_name: string;
    args: unknown;
    result: unknown;
    status: string;
    error: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT id, tool_call_id, run_id, message_id, tool_name, args, result,
            status, error, started_at, finished_at
       FROM tool_executions
      WHERE workspace_id = $1 AND message_id = ANY($2::uuid[])
      ORDER BY started_at ASC`,
    [workspaceId, messageIds as string[]],
  );
  for (const r of result.rows) {
    const rec: ToolExecutionRecord = {
      id: r.id,
      toolCallId: r.tool_call_id,
      runId: r.run_id,
      messageId: r.message_id,
      toolName: r.tool_name,
      args: (r.args as Record<string, unknown>) ?? {},
      result: r.result ? (r.result as Record<string, unknown>) : undefined,
      status: r.status as ExecutionStatus,
      error: r.error ?? undefined,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
    };
    const list = out.get(r.message_id);
    if (list) list.push(rec);
    else out.set(r.message_id, [rec]);
  }
  return out;
}

/**
 * 单条消息便捷查询（保持向后兼容）；批量场景优先用 getToolExecutionsByMessages。
 */
export async function getToolExecutionsByMessage(
  workspaceId: string,
  messageId: string,
): Promise<ToolExecutionRecord[]> {
  const map = await getToolExecutionsByMessages(workspaceId, [messageId]);
  return map.get(messageId) ?? [];
}
