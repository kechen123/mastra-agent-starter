/**
 * agent_runs + agent_run_events 的 Repository。
 *
 * 约束：
 *   - 单实例 worker 通过 lease_owner / lease_expires_at 抢占 Run；
 *   - 状态推进 / 事件写入必须在同一事务（阶段 2 §6.3）；
 *   - SSE 重连通过 agent_run_events.id > lastEventId 拉历史；
 *   - 多实例后端用 PG LISTEN/NOTIFY 扇出唤醒信号（run-events-bus.ts）。
 */
import type { Pool, PoolClient } from 'pg';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { getRequestId } from '../../infrastructure/logging/request-id.js';
import { jsonEnvelopeSplitBytes, splitByJsonTextBytes } from './live-delta-splitter.js';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'stopped'
  | 'failed';

export type RunEventType =
  | 'run-queued'
  | 'run-started'
  | 'content-checkpoint'
  | 'tool-call-started'
  | 'tool-call-completed'
  | 'approval-requested'
  | 'approval-resolved'
  | 'run-completed'
  | 'run-stopped'
  | 'run-failed';

export interface RunRow {
  id: string;
  workspaceId: string;
  conversationId: string;
  assistantMessageId: string;
  agentId: string;
  provider: string;
  model: string;
  status: RunStatus;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  parentRunId: string | null;
  requestId: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunEventRow {
  id: number;
  runId: string;
  workspaceId: string;
  type: RunEventType;
  payload: unknown;
  createdAt: string;
}

export interface CreateRunInput {
  workspaceId: string;
  conversationId: string;
  assistantMessageId: string;
  agentId: string;
  provider: string;
  model: string;
  requestId?: string;
  parentRunId?: string | null;
  createdBy: string;
}

export interface ListEventsOptions {
  runId: string;
  workspaceId: string;
  afterId?: number;
  limit?: number;
}

function rowToRun(row: Record<string, unknown>): RunRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    conversationId: row.conversation_id as string,
    assistantMessageId: row.assistant_message_id as string,
    agentId: row.agent_id as string,
    provider: row.provider as string,
    model: row.model as string,
    status: row.status as RunStatus,
    inputTokens: (row.input_tokens as number) ?? 0,
    outputTokens: (row.output_tokens as number) ?? 0,
    estimatedCostUsd: Number(row.estimated_cost_usd ?? 0),
    startedAt: row.started_at ? new Date(row.started_at as string).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
    errorCode: (row.error_code as string | null) ?? null,
    parentRunId: (row.parent_run_id as string | null) ?? null,
    requestId: row.request_id as string,
    leaseOwner: (row.lease_owner as string | null) ?? null,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at as string).toISOString() : null,
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at as string).toISOString() : null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

const RUN_COLUMNS = `id, workspace_id, conversation_id, assistant_message_id, agent_id,
  provider, model, status, input_tokens, output_tokens, estimated_cost_usd,
  started_at, completed_at, error_code, parent_run_id, request_id,
  lease_owner, lease_expires_at, heartbeat_at, created_by, created_at, updated_at`;

export const LIVE_DELTA_CHANNEL = 'agent_run_live_deltas_channel';

export async function createQueuedRun(
  input: CreateRunInput,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<RunRow> {
  const r = await executor.query<Record<string, unknown>>(
    `INSERT INTO agent_runs (
       workspace_id, conversation_id, assistant_message_id, agent_id,
       provider, model, status, request_id, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8)
     RETURNING ${RUN_COLUMNS}`,
    [
      input.workspaceId,
      input.conversationId,
      input.assistantMessageId,
      input.agentId,
      input.provider,
      input.model,
      input.requestId ?? getRequestId() ?? '',
      input.createdBy,
    ],
  );
  return rowToRun(r.rows[0]!);
}

/**
 * 写一条事件 + NOTIFY 后端实例。本函数必须在事务内由 caller 调用，
 * 不能独立 BEGIN/COMMIT——阶段 2 §6.3 强制要求事件与状态变更同事务。
 *
 * 返回写入的事件 id（agent_run_events.id，BIGINT IDENTITY）。
 */
export async function insertRunEvent(
  client: PoolClient,
  args: {
    runId: string;
    workspaceId: string;
    type: RunEventType;
    payload?: unknown;
  },
): Promise<number> {
  const r = await client.query<{ id: number }>(
    `INSERT INTO agent_run_events (run_id, workspace_id, type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [args.runId, args.workspaceId, args.type, JSON.stringify(args.payload ?? {})],
  );
  const id = Number(r.rows[0]!.id);
  // NOTIFY channel；channel 名固定，后端 bus（run-events-bus.ts）订阅它。
  // payload 仅放 runId + eventId，订阅方再回 DB 取完整数据。
  // pg_notify 的第二参有 8000 byte 限制；UUID + 数字不会触达。
  await client.query(`SELECT pg_notify('agent_run_events_channel', $1)`, [`${args.runId}:${id}`]);
  return id;
}

/**
 * 实时增量 publish：与 insertRunEvent 走的是完全独立的 channel，不写
 * agent_run_events、不分配 BIGINT IDENTITY id；任何后端实例 LISTEN 到
 * 都可推到本地 SSE 连接。
 *
 * payload 形如 `{runId, text}`，受 8KB pg_notify 限制；调用方负责把单批
 * text 控制在 ~256 字符以内，避免超限。
 *
 * 本函数**不**做事务绑定——它必须是非事务、单次、独立的 NOTIFY，因为
 * 写入实时增量应当尽可能廉价；不阻塞流式循环。
 */
/**
 * 发布一条实时增量到 LISTEN/NOTIFY 通道。
 *
 * 安全约束（PR-2.4 修复 commit）：
 *   - 单次 NOTIFY payload UTF-8 字节必须始终 < 8000（PG hard limit）。
 *     我们保留 7900 byte 作为安全上限（`LIVE_DELTA_MAX_PAYLOAD_BYTES`）。
 *   - 拆分依据是**最终 JSON payload 的 UTF-8 字节数**，不是原始 text 字节数。
 *     因为 `"` / `\` / 控制字符在 JSON 中会被转义（占更多字节），按原始字节
 *     算会让最终 payload 越界。
 *   - envelope 的固定开销（`{"runId":"<uuid>","text":""}` 字节长度 - 空 text 占位）
 *     用 `jsonEnvelopeOverheadBytes` 一次算出，传给 splitter。
 *   - 拆分不破坏 Unicode 字符（不拆 surrogate pair / 多字节字符边界）。
 *   - 若单字符本身超阈值（极少见），丢弃并 log；不让一个异常字符
 *     阻塞后续缓冲。
 *
 * 本函数**不**做事务绑定——它必须是非事务、单次、独立的 NOTIFY，因为
 * 写入实时增量应当尽可能廉价；不阻塞流式循环。
 */
export async function publishLiveDelta(args: {
  runId: string;
  workspaceId: string;
  text: string;
}): Promise<void> {
  const envelope = JSON.stringify({ runId: args.runId });
  // envelope 在 text 之前/之后的固定字节开销（text 部分可能为空、也可能含 escape）。
  const { prefixBytes: envelopePrefixBytes, suffixBytes: envelopeSuffixBytes } =
    jsonEnvelopeSplitBytes({ runId: args.runId });

  const split = splitByJsonTextBytes({
    text: args.text,
    envelopePrefixBytes,
    envelopeSuffixBytes,
    maxPayloadBytes: LIVE_DELTA_MAX_PAYLOAD_BYTES,
  });
  if (split.droppedBytes > 0) {
    // 极少见：单字符超阈值。仅记日志，不抛错——不能因一个字符卡住流。
    const { logger } = await import('../../infrastructure/logging/logger.js');
    logger.warn({
      msg: 'live delta 丢弃超大单字符（JSON 字节开销 ≥ maxTextBytes）；继续发送其余增量',
      runId: args.runId,
      droppedBytes: split.droppedBytes,
      envelopePrefixBytes,
      envelopeSuffixBytes,
      maxPayloadBytes: LIVE_DELTA_MAX_PAYLOAD_BYTES,
    });
  }

  if (split.chunks.length === 0) return;

  // 一次 NOTIFY 一条包。性能可接受：单 chunk ≤ 7900B，且正常情况下
  // text 远小于此，几乎总是 1 chunk。
  for (const chunk of split.chunks) {
    const payload = `${envelope},"text":${JSON.stringify(chunk)}}`;
    // 兜底校验：正常输入下 splitter 已保证 < 7900B；若 envelope 字段意外扩展
    // 或 Buffer 边界变了，这里抛错阻止越界 NOTIFY 进入 PG。
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    if (payloadBytes >= 8000) {
      throw new Error(
        `publishLiveDelta: 内部错误，payload byte=${payloadBytes} >= 8000`,
      );
    }
    const client = await getDatabasePool().connect();
    try {
      await client.query(`SELECT pg_notify('${LIVE_DELTA_CHANNEL}', $1)`, [payload]);
    } finally {
      client.release();
    }
  }
}

/** PG NOTIFY payload 字节硬上限的安全阈值；保留 100 byte 余量。 */
const LIVE_DELTA_MAX_PAYLOAD_BYTES = 7900;

export async function listRunEvents(
  options: ListEventsOptions,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<RunEventRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 1000, 1), 5000);
  const params: unknown[] = [options.runId, options.workspaceId];
  let where = `run_id = $1 AND workspace_id = $2`;
  if (typeof options.afterId === 'number' && options.afterId >= 0) {
    params.push(options.afterId);
    where += ` AND id > $${params.length}`;
  }
  params.push(limit);
  const r = await executor.query<Record<string, unknown>>(
    `SELECT id, run_id, workspace_id, type, payload, created_at
       FROM agent_run_events
      WHERE ${where}
      ORDER BY id ASC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    runId: row.run_id as string,
    workspaceId: row.workspace_id as string,
    type: row.type as RunEventType,
    payload: row.payload ?? {},
    createdAt: new Date(row.created_at as string).toISOString(),
  }));
}

export async function getRunById(
  runId: string,
  workspaceId: string,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<RunRow | null> {
  const r = await executor.query<Record<string, unknown>>(
    `SELECT ${RUN_COLUMNS} FROM agent_runs
      WHERE id = $1 AND workspace_id = $2`,
    [runId, workspaceId],
  );
  const row = r.rows[0];
  return row ? rowToRun(row) : null;
}

/**
 * Worker 抢占 Run：
 *   - 仅 queued / running 行可抢占；
 *   - lease_owner 为 NULL / lease_expires_at 过期 / NULL 都被视为可抢占；
 *   - 抢占成功返回更新后的行；并发抢占失败返回 null。
 */
export async function claimRunLease(
  runId: string,
  workerId: string,
  leaseMs: number,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<RunRow | null> {
  const r = await executor.query<Record<string, unknown>>(
    `UPDATE agent_runs
        SET lease_owner = $2,
            lease_expires_at = now() + ($3::int * INTERVAL '1 millisecond'),
            heartbeat_at = now(),
            updated_at = now()
      WHERE id = $1
        AND status IN ('queued', 'running')
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
      RETURNING ${RUN_COLUMNS}`,
    [runId, workerId, leaseMs],
  );
  const row = r.rows[0];
  return row ? rowToRun(row) : null;
}

/**
 * Worker 心跳续约：仅当持有 lease 的 worker 才能续约。
 */
export async function heartbeatRunLease(
  runId: string,
  workerId: string,
  leaseMs: number,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<boolean> {
  const r = await executor.query(
    `UPDATE agent_runs
        SET lease_expires_at = greatest(lease_expires_at, now() + ($3::int * INTERVAL '1 millisecond')),
            heartbeat_at = now(),
            updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [runId, workerId, leaseMs],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * 后台 Orphan 回收：扫 lease_expires_at < now() 的 queued/running 行，
 * 转 failed + LEASE_EXPIRED，并写 run-failed 事件。
 *
 * 实现要点（V2.3.6 §6.3）：
 *   - Run 状态、消息状态、事件写入必须处于同一事务；
 *   - 不论传入 Pool 还是 PoolClient，本函数都开一个新事务；
 *     调用方传入 PoolClient 时，意味着 caller 已经持有一个事务，我们
 *     只把 sweep 当作"在同一事务内多写几行"使用，但 caller 仍负责
 *     BEGIN / COMMIT。
 *   - waiting_approval 不在此路径（阶段 3 走 tool_approval_requests.expires_at）。
 *
 *   - 终态 UPDATE 带 WHERE status IN ('queued','running') 条件，
 *     防止覆写已 stopped / failed 的 Run（V2 §6.4 阻断项 5）。
 */
export async function sweepExpiredLeases(
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<RunRow[]> {
  const isPoolClient = !('connect' in executor);
  const client: PoolClient = isPoolClient
    ? (executor as PoolClient)
    : await (executor as Pool).connect();
  // 记号：是不是 caller 已经 BEGIN 了。
  const callerOwnedTx = isPoolClient;
  try {
    if (!callerOwnedTx) {
      await client.query('BEGIN');
    }
    const expired = await client.query<Record<string, unknown>>(
      `UPDATE agent_runs
          SET status = 'failed',
              error_code = 'LEASE_EXPIRED',
              completed_at = now(),
              updated_at = now()
        WHERE status IN ('queued', 'running')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()
        RETURNING ${RUN_COLUMNS}`,
    );
    const rows = expired.rows.map(rowToRun);
    for (const row of rows) {
      // 消息侧收敛带条件 WHERE：避免覆盖已 stopped/failed 的 message。
      await client.query(
        `UPDATE messages
            SET status = 'failed',
                content = COALESCE(NULLIF(content, ''), '生成已中断，请稍后重试。'),
                citations = '[]'::jsonb
          WHERE id = $1
            AND workspace_id = $2
            AND status IN ('pending', 'streaming')`,
        [row.assistantMessageId, row.workspaceId],
      );
      await insertRunEvent(client, {
        runId: row.id,
        workspaceId: row.workspaceId,
        type: 'run-failed',
        payload: { errorCode: 'LEASE_EXPIRED' },
      });
    }
    if (!callerOwnedTx) {
      await client.query('COMMIT');
    }
    return rows;
  } catch (error) {
    if (!callerOwnedTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    throw error;
  } finally {
    if (!callerOwnedTx) {
      client.release();
    }
  }
}