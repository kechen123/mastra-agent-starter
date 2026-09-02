/**
 * Run Executor：阶段 2 起的核心执行单元。
 *
 * 模型：
 *   - POST `/conversations/:id/messages` 在事务内创建 queued Run；
 *   - 本模块独立进程 / 独立计时器持续 `claimNextRun()`：
 *       1. 抢占：UPDATE agent_runs SET lease_owner, lease_expires_at = now()+60s
 *          WHERE status='queued' AND (lease_owner IS NULL OR lease_expires_at < now())
 *          ORDER BY created_at LIMIT 1 RETURNING *;
 *       2. 同一事务内 UPDATE status='running', started_at=now() + INSERT run-started
 *          事件；
 *       3. 进入"以 250~500ms / 512 字符 阈值写 content-checkpoint"循环驱动
 *          `streamAgent`；
 *       4. 终态：同事务内 UPDATE agent_runs.status + messages.status + 写 run-* 事件；
 *       5. 心跳：每 15s 在 lease 上 UPDATE；
 *       6. lease 过期 → 后台 sweeper 转 failed + LEASE_EXPIRED + run-failed 事件。
 *
 * 多实例：每个 backend 进程都跑 executor；DB partial unique 保证单 Run 仅被
 * 抢占一次（FOR UPDATE SKIP LOCKED）。
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  claimRunLease,
  heartbeatRunLease,
  insertRunEvent,
  publishLiveDelta,
  sweepExpiredLeases,
  type RunRow,
  type RunEventType,
} from '../../modules/runs/repository.js';
import { getAgentDefinition } from '../agent/registry.js';
import { streamAgent, type StreamEvent } from '../agent/runtime.js';
import { config } from '../../config.js';
import {
  getConversationWithMessages,
} from '../../modules/conversations/service.js';
import { logRequest } from '../../infrastructure/logging/request-id.js';
import { getRunEventsBus } from '../../modules/runs/run-events-bus.js';
import { getLiveDeltaBus } from '../../modules/runs/live-delta-bus.js';

const DEFAULT_LEASE_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const CHECKPOINT_INTERVAL_MS = 400;
const CHECKPOINT_CHARS = 512;
// 实时增量：低延迟短批次推送。约 30ms 或累计 ≤256 字符触发一次 flush，
// payload 通过 LISTEN/NOTIFY `agent_run_live_deltas_channel` 分发，不写入
// agent_run_events、不分配 SSE id；缺失不影响最终一致性（checkpoint 兜底）。
const LIVE_DELTA_FLUSH_MS = 30;
const LIVE_DELTA_MAX_CHARS = 256;

const WORKER_ID = `${process.env.HOSTNAME ?? 'host'}-${process.pid}-${randomUUID().slice(0, 8)}`;

interface ActiveExecution {
  runId: string;
  workspaceId: string;
  assistantMessageId: string;
  conversationId: string;
  abortController: AbortController;
  fullText: string;
  lastCheckpointAt: number;
  lastCheckpointLength: number;
  // 实时增量通道：累积到 LIVE_DELTA_FLUSH_MS / LIVE_DELTA_MAX_CHARS 时
  // 通过 publishLiveDelta 推送；与 checkpoint 节流独立。
  liveBuffer: string;
  liveLastFlushAt: number;
}

const activeExecutions = new Map<string, ActiveExecution>();
let sweeperInterval: NodeJS.Timeout | null = null;
let pollInterval: NodeJS.Timeout | null = null;

declare global {
  // 单进程内全局暴露运行入口（HMR / dev 重启用）
  // eslint-disable-next-line no-var
  var __xuanshuRunExecutorStarted: boolean | undefined;
}

export function isExecutorStarted(): boolean {
  return Boolean(globalThis.__xuanshuRunExecutorStarted);
}

/**
 * 把 executor 拉起。幂等；同一进程多次调用不会重启。
 * 测试 / 集成脚本可在 import 后调一次。
 */
export async function startRunExecutor(): Promise<void> {
  if (globalThis.__xuanshuRunExecutorStarted) return;
  globalThis.__xuanshuRunExecutorStarted = true;
  await getRunEventsBus().start();
  await getLiveDeltaBus().start();
  sweeperInterval = setInterval(() => {
    void sweepOnce();
  }, 30_000);
  sweeperInterval.unref?.();
  pollInterval = setInterval(() => {
    void claimAndRunOnce();
  }, 1_000);
  pollInterval.unref?.();
  logger.info({ msg: 'Run executor 已启动', workerId: WORKER_ID });
}

export async function stopRunExecutor(): Promise<void> {
  globalThis.__xuanshuRunExecutorStarted = false;
  if (sweeperInterval) clearInterval(sweeperInterval);
  if (pollInterval) clearInterval(pollInterval);
  sweeperInterval = null;
  pollInterval = null;
  await getRunEventsBus().stop();
  await getLiveDeltaBus().stop();
}

async function sweepOnce(): Promise<void> {
  try {
    const swept = await sweepExpiredLeases(getDatabasePool());
    if (swept.length > 0) {
      logRequest('warn', {
        msg: 'orphan run leases reaped',
        runId: swept.map((r) => r.id).join(','),
      });
    }
  } catch (err) {
    logger.error({ msg: 'lease sweeper failed', err });
  }
}

async function claimAndRunOnce(): Promise<void> {
  let client;
  try {
    client = await getDatabasePool().connect();
  } catch (err) {
    logger.error({ msg: 'executor 抢不到 DB connection', err });
    return;
  }
  try {
    await client.query('BEGIN');
    const r = await client.query<Record<string, unknown>>(
      `SELECT id, workspace_id, conversation_id, assistant_message_id,
              agent_id, provider, model, status, request_id, created_by,
              created_at
         FROM agent_runs
        WHERE status = 'queued'
          AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    const row = r.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return;
    }
    const runId = row.id as string;
    await client.query(
      `UPDATE agent_runs
          SET status = 'running',
              started_at = now(),
              lease_owner = $2,
              lease_expires_at = now() + ($3::int * INTERVAL '1 millisecond'),
              heartbeat_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [runId, WORKER_ID, DEFAULT_LEASE_MS],
    );
    await insertRunEvent(client, {
      runId,
      workspaceId: row.workspace_id as string,
      type: 'run-started',
      payload: { agentId: row.agent_id, model: row.model },
    });
    await client.query('COMMIT');
    void executeRun(row).catch((err) => {
      logger.error({ msg: 'executeRun failed unexpectedly', runId, err });
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    logger.error({ msg: 'claimAndRunOnce failed', err });
  } finally {
    client.release();
  }
}

interface QueuedRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  assistant_message_id: string;
  agent_id: string;
  model: string;
  provider: string;
  request_id: string;
}

async function executeRun(row: Record<string, unknown>): Promise<void> {
  const r = row as unknown as QueuedRow;
  const abortController = new AbortController();
  const execution: ActiveExecution = {
    runId: r.id,
    workspaceId: r.workspace_id,
    assistantMessageId: r.assistant_message_id,
    conversationId: r.conversation_id,
    abortController,
    fullText: '',
    lastCheckpointAt: Date.now(),
    lastCheckpointLength: 0,
    liveBuffer: '',
    liveLastFlushAt: Date.now(),
  };
  activeExecutions.set(r.id, execution);

  // 心跳
  const heartbeatTimer = setInterval(() => {
    void heartbeatRunLease(r.id, WORKER_ID, DEFAULT_LEASE_MS).catch((err) => {
      logger.error({ msg: 'heartbeat failed', runId: r.id, err });
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // 加载历史消息（V2.3.6 §5.1：workspace 严格隔离）
  let history;
  try {
    const detail = await getConversationWithMessages(r.workspace_id, r.conversation_id);
    history = detail?.messages ?? [];
  } catch (err) {
    await failRun(r, 'failed', 'PROVIDER_UNAVAILABLE', execution, err instanceof Error ? err : new Error(String(err)));
    clearInterval(heartbeatTimer);
    activeExecutions.delete(r.id);
    return;
  }

  const def = getAgentDefinition(r.agent_id);
  if (!def) {
    await failRun(r, 'failed', 'INPUT_VALIDATION_FAILED', execution, new Error('Agent 不存在。'));
    clearInterval(heartbeatTimer);
    activeExecutions.delete(r.id);
    return;
  }

  // 触发 streaming status（消息侧状态推进：pending → streaming）
  await getDatabasePool().query(
    `UPDATE messages SET status = 'streaming'
      WHERE id = $1 AND workspace_id = $2`,
    [r.assistant_message_id, r.workspace_id],
  );

  let exitType: 'done' | 'stopped' | 'error' = 'done';
  let exitContent = '';
  let exitError: string | undefined;
  try {
    for await (const event of streamAgent({
      workspaceId: r.workspace_id,
      agentId: r.agent_id,
      prompt: extractPromptFromHistory(history),
      conversationId: r.conversation_id,
      knowledgeBaseId: null,
      history,
      abortSignal: abortController.signal,
    })) {
      await handleStreamEvent(event, execution);
      if (event.type === 'done') { exitType = 'done'; exitContent = event.content; break; }
      if (event.type === 'stopped') { exitType = 'stopped'; exitContent = event.content; break; }
      if (event.type === 'error') { exitType = 'error'; exitError = event.error; break; }
    }
  } catch (err) {
    exitType = 'error';
    exitError = (err as Error).message ?? '未知错误';
  } finally {
    clearInterval(heartbeatTimer);
  }

  // 终态路径**之前**必须先 flush 未发出的 live delta。
  // PR-2.4 修复：run-completed / run-stopped 事件写入后，SSE handler
  // 可能关闭连接；若此时还有未推送的 live delta，前端会丢失末尾片段。
  // final checkpoint（completeRun / stopRun 内写入）仍然作为可靠兜底；
  // 即便实时通道异常，已落库的事件也能保证最终文本正确。
  // 终态事务语义不能因此破坏：flushLiveDelta 自身是非事务的独立 NOTIFY，
  // 且不会在事务 BEGIN/COMMIT 之间发生。
  await flushLiveDelta(execution);

  if (exitType === 'done') {
    await completeRun(r, execution, exitContent);
  } else if (exitType === 'stopped') {
    await stopRun(r, execution, exitContent);
  } else {
    await failRun(r, 'failed', 'PROVIDER_UNAVAILABLE', execution, new Error(exitError ?? '生成失败。'));
  }
  activeExecutions.delete(r.id);
}

function extractPromptFromHistory(history: Array<{ role: 'user' | 'assistant'; content: string }>): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === 'user') return history[i]!.content;
  }
  return '';
}

async function handleStreamEvent(event: StreamEvent, execution: ActiveExecution): Promise<void> {
  if (event.type === 'delta') {
    execution.fullText += event.text;
    execution.liveBuffer += event.text;
    const now = Date.now();
    const lengthDelta = execution.fullText.length - execution.lastCheckpointLength;
    // checkpoint 节流：每 CHECKPOINT_INTERVAL_MS 或累积 +CHECKPOINT_CHARS
    if (now - execution.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS || lengthDelta >= CHECKPOINT_CHARS) {
      await writeCheckpoint(execution);
      execution.lastCheckpointAt = now;
      execution.lastCheckpointLength = execution.fullText.length;
    }
    // 实时增量节流：每 LIVE_DELTA_FLUSH_MS 或累计 LIVE_DELTA_MAX_CHARS。
    // 缺实时增量不影响最终一致性——下一次 checkpoint 兜底覆盖。
    if (
      execution.liveBuffer.length > 0 &&
      (now - execution.liveLastFlushAt >= LIVE_DELTA_FLUSH_MS ||
        execution.liveBuffer.length >= LIVE_DELTA_MAX_CHARS)
    ) {
      await flushLiveDelta(execution);
    }
    return;
  }
  if (event.type === 'tool-call-start' || event.type === 'tool-call-complete' || event.type === 'tool-call-error') {
    // 阶段 2 的 tool 事件占位（与决策 4 对齐 type 集合）；phase 3 接入 Tool Policy 后再做完整 sink。
    const map: Record<string, RunEventType> = {
      'tool-call-start': 'tool-call-started',
      'tool-call-complete': 'tool-call-completed',
      'tool-call-error': 'run-failed',
    };
    const payload = event as unknown as Record<string, unknown>;
    await writeRunEvent(execution, map[event.type] ?? 'content-checkpoint', payload);
    return;
  }
}

async function writeCheckpoint(execution: ActiveExecution): Promise<void> {
  await writeRunEvent(execution, 'content-checkpoint', {
    text: execution.fullText,
    accumulatedLength: execution.fullText.length,
  });
}

/**
 * 把 liveBuffer 通过 LISTEN/NOTIFY 推给所有后端实例的 SSE 连接。
 * 不写入 agent_run_events、不分配 SSE id；payload 受 8KB 限制。
 * flush 失败仅记日志——checkpoint 仍会兜底覆盖前端文本。
 */
async function flushLiveDelta(execution: ActiveExecution): Promise<void> {
  if (execution.liveBuffer.length === 0) return;
  const text = execution.liveBuffer;
  execution.liveBuffer = '';
  execution.liveLastFlushAt = Date.now();
  try {
    await publishLiveDelta({
      runId: execution.runId,
      workspaceId: execution.workspaceId,
      text,
    });
  } catch (err) {
    logger.warn({
      msg: 'publishLiveDelta failed（实时增量丢失，下一次 checkpoint 兜底）',
      runId: execution.runId,
      err,
    });
  }
}

async function writeRunEvent(execution: ActiveExecution, type: RunEventType, payload: unknown): Promise<void> {
  const client = await getDatabasePool().connect();
  try {
    await insertRunEvent(client, {
      runId: execution.runId,
      workspaceId: execution.workspaceId,
      type,
      payload,
    });
  } catch (err) {
    logger.error({ msg: 'writeRunEvent failed', runId: execution.runId, err });
  } finally {
    client.release();
  }
}

/**
 * checkpoint 是节流写入，终态前必须补齐最后一份文本快照。
 * 否则短回复可能只发出首个 checkpoint，前端实时显示会落后于最终落库内容。
 */
async function writeFinalCheckpoint(
  client: PoolClient,
  r: QueuedRow,
  execution: ActiveExecution,
  content: string,
): Promise<void> {
  if (content.length === 0 || execution.lastCheckpointLength >= content.length) return;
  await insertRunEvent(client, {
    runId: r.id,
    workspaceId: r.workspace_id,
    type: 'content-checkpoint',
    payload: {
      text: content,
      accumulatedLength: content.length,
    },
  });
  execution.lastCheckpointLength = content.length;
}

async function completeRun(r: QueuedRow, execution: ActiveExecution, content: string): Promise<void> {
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    // 条件 WHERE：若 Run 已被 V2 stopMessage / 手动 sweep 收敛为 stopped / failed，
    // 不允许 executor 把状态回写成 completed。
    const updated = await client.query(
      `UPDATE agent_runs
          SET status = 'completed',
              completed_at = now(),
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND workspace_id = $2
          AND status IN ('queued','running','waiting_approval')
        RETURNING id`,
      [r.id, r.workspace_id],
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      logger.warn({ msg: 'completeRun 跳过：Run 已处于终态', runId: r.id });
      return;
    }
    await client.query(
      `UPDATE messages
          SET content = $3, citations = '[]'::jsonb, status = 'completed'
        WHERE id = $1 AND workspace_id = $2`,
      [r.assistant_message_id, r.workspace_id, content],
    );
    await writeFinalCheckpoint(client, r, execution, content);
    await insertRunEvent(client, {
      runId: r.id,
      workspaceId: r.workspace_id,
      type: 'run-completed',
      payload: { contentLength: content.length },
    });
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    logger.error({ msg: 'completeRun failed', runId: r.id, err });
  } finally {
    client.release();
  }
}

async function stopRun(r: QueuedRow, execution: ActiveExecution, content: string): Promise<void> {
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE agent_runs
        SET status = 'stopped',
              completed_at = now(),
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND workspace_id = $2
          AND status IN ('queued','running','waiting_approval')
        RETURNING id`,
      [r.id, r.workspace_id],
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      logger.warn({ msg: 'stopRun 跳过：Run 已处于终态', runId: r.id });
      return;
    }
    await client.query(
      `UPDATE messages
          SET content = COALESCE(NULLIF($3, ''), ''),
              citations = '[]'::jsonb,
              status = 'stopped'
        WHERE id = $1 AND workspace_id = $2`,
      [r.assistant_message_id, r.workspace_id, content],
    );
    await writeFinalCheckpoint(client, r, execution, content);
    await insertRunEvent(client, {
      runId: r.id,
      workspaceId: r.workspace_id,
      type: 'run-stopped',
      payload: { contentLength: content.length },
    });
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    logger.error({ msg: 'stopRun failed', runId: r.id, err });
  } finally {
    client.release();
  }
}

async function failRun(
  r: QueuedRow,
  _status: 'failed',
  errorCode: string,
  execution: ActiveExecution,
  err: Error,
): Promise<void> {
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    // 终态收敛同样带条件 WHERE：若已被 stop 流程标记为 stopped，
    // 不再回写成 failed（保留用户主动停止的事实）。
    const updated = await client.query(
      `UPDATE agent_runs
        SET status = 'failed',
              error_code = $2,
              completed_at = now(),
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND workspace_id = $3
          AND status IN ('queued','running','waiting_approval')
        RETURNING id`,
      [r.id, errorCode, r.workspace_id],
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      logger.warn({ msg: 'failRun 跳过：Run 已处于终态', runId: r.id, errorCode });
      return;
    }
    await client.query(
      `UPDATE messages
          SET content = COALESCE(NULLIF($3, ''), '生成已中断，请稍后重试。'),
              citations = '[]'::jsonb,
              status = 'failed'
        WHERE id = $1 AND workspace_id = $2`,
      [r.assistant_message_id, r.workspace_id, execution.fullText],
    );
    await insertRunEvent(client, {
      runId: r.id,
      workspaceId: r.workspace_id,
      type: 'run-failed',
      payload: { errorCode, message: err.message },
    });
    await client.query('COMMIT');
    logRequest('error', {
      msg: 'run failed',
      workspaceId: r.workspace_id,
      conversationId: r.conversation_id,
      runId: r.id,
      errorCode,
    });
  } catch (writeErr) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    logger.error({ msg: 'failRun DB write failed', runId: r.id, err: writeErr });
  } finally {
    client.release();
  }
}

// 兼容 ask-driver 的旧接口（/ask 路由仍调用）
export { tryReserveConversationExecution } from './controller.js';

// 不再 export：run executor 通过本模块自动启动；调用方不需手动拉起。
export const _executorWorkerId = WORKER_ID;

/**
 * 把所有当前活跃 executions 列出来；测试 / 调试用。
 */
export function listActiveExecutions(): Array<{ runId: string; assistantMessageId: string }> {
  return Array.from(activeExecutions.values()).map((e) => ({
    runId: e.runId,
    assistantMessageId: e.assistantMessageId,
  }));
}

/** 强制终止一个运行中的 Run（POST /messages/:id/stop 路径）。 */
export function abortRunByMessage(messageId: string): boolean {
  for (const execution of activeExecutions.values()) {
    if (execution.assistantMessageId === messageId) {
      execution.abortController.abort();
      return true;
    }
  }
  return false;
}

// 兼容：让 ask-driver / 旧路由不依赖本模块的 config（config 已经导入）
export const _providerDefault = config.chatProvider;
