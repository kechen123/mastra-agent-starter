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
import {
  buildRunTerminalPayload,
  mergeCitationsByChunkId,
} from '../../modules/runs/citation-merge.js';
import { getAgentDefinition } from '../agent/registry.js';
import { getToolDefinition } from '../tool/registry.js';
import {
  consumeAgentStream,
  streamAgent,
  type StreamEvent,
} from '../agent/runtime.js';
import { config } from '../../config.js';
import {
  getConversationWithMessages,
} from '../../modules/conversations/service.js';
import {
  upsertToolExecution,
  finalizeToolExecutionByCallId,
} from '../../modules/conversations/tool-executions.js';
import type { Citation } from '../../modules/citations/types.js';
import { logRequest } from '../../infrastructure/logging/request-id.js';
import { getRunEventsBus } from '../../modules/runs/run-events-bus.js';
import { getLiveDeltaBus } from '../../modules/runs/live-delta-bus.js';
import {
  listApprovalsPendingResume,
} from '../../modules/tool-policy/repository.js';
import {
  sweepExpiredApprovalResumeLeases,
  type SweepApprovalResumeResult,
} from './approval-resume-recovery.js';
import type { ApprovalRequestRow } from '../../modules/tool-policy/types.js';
import {
  _getMastraFacade,
  MAX_RESUME_ATTEMPTS,
  RESUME_RECONCILE_BACKOFF_MS,
  claimApprovalForReconcile,
  failApprovalReconcile,
  listApprovalsPendingReconcile,
  markApprovalResumeIndeterminate,
  revertApprovalForReconcile,
  type MastraAgentFacade,
  type SuspendedRunSnapshot,
} from '../../modules/tool-policy/state-machine.js';

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
  citations: Citation[];
  /** Mastra toolCallId → 项目 tool_executions.id，供完成/失败时落库。 */
  toolExecutionMap: Map<string, string>;
  /**
   * PR-3.3 — 是否处于"工具调用挂起审批"分支：streamAgent 推完
   * approval-requested 事件后自然结束；Run 状态保持 waiting_approval，
   * 资源已释放。true → 终态处理路径**不**写 stopped/failed/completed，
   * 只清理 activeExecutions。
   */
  armedForResume: boolean;
}

const activeExecutions = new Map<string, ActiveExecution>();
let sweeperInterval: NodeJS.Timeout | null = null;
let pollInterval: NodeJS.Timeout | null = null;
let resumeSchedulerInterval: NodeJS.Timeout | null = null;
let reconcileIndeterminateInterval: NodeJS.Timeout | null = null;

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
  // PR-3.3 — Resume 调度器：扫 "status='approved' AND mastra_resume_started_at
  // IS NULL" 的 approval 行，原子抢占 mastra_resume_started_at，再走
  // claimAndRunOnce 复用同一条 streamAgent 路径续 Run。1s tick 与 claim loop
  // 同频，避免跨进程争抢时多 worker 同时 resume。
  resumeSchedulerInterval = setInterval(() => {
    void resumeAwaitingRunsOnce();
  }, 1_000);
  resumeSchedulerInterval.unref?.();
  // PR-3.3 Replay Fix W2 — Reconciliation 调度器：扫
  // `status='approved_resume_indeterminate' AND lease_expires_at < now()
  // AND resume_attempts < MAX` 的行，调 facade.listSuspendedRuns 严格校验。
  // 5s tick——此路径仅在 approve SDK 抛错后激活，背压低。
  reconcileIndeterminateInterval = setInterval(() => {
    void reconcileIndeterminateApprovalsOnce();
  }, 5_000);
  reconcileIndeterminateInterval.unref?.();
  logger.info({ msg: 'Run executor 已启动', workerId: WORKER_ID });
}

export async function stopRunExecutor(): Promise<void> {
  globalThis.__xuanshuRunExecutorStarted = false;
  if (sweeperInterval) clearInterval(sweeperInterval);
  if (pollInterval) clearInterval(pollInterval);
  if (resumeSchedulerInterval) clearInterval(resumeSchedulerInterval);
  if (reconcileIndeterminateInterval) clearInterval(reconcileIndeterminateInterval);
  sweeperInterval = null;
  pollInterval = null;
  resumeSchedulerInterval = null;
  reconcileIndeterminateInterval = null;
  await getRunEventsBus().stop();
  await getLiveDeltaBus().stop();
}

async function sweepOnce(): Promise<void> {
  // 1) PR-3.3.2 Hard-Crash 专用 sweeper：识别"approval 已写
  //    mastra_resume_started_at + Run running + lease 已过期"
  //    孤儿（典型：worker 在 SDK 调用前 / 中 / 终态落库前死亡，
  //    JavaScript catch 不会执行），按 Tool 元数据分流：
  //    - 幂等 Tool → 转 approved_resume_indeterminate + Run → waiting_approval
  //    - 非幂等 / 未注册 Tool → 人工介入 + Run → failed
  //    - declined / expired 硬崩溃 → 明确错误码 + Run → failed（不重放）
  //    这一步必须在普通 sweepExpiredLeases 之前——否则普通
  //    lease sweeper 会把孤儿 Run 写成 'failed' + LEASE_EXPIRED，
  //    留下"approved + mastra_resume_started_at + failed LEASE_EXPIRED"
  //    不可恢复的孤儿组合。
  try {
    const reclaimed = await sweepExpiredApprovalResumeLeases({
      backoffMs: RESUME_RECONCILE_BACKOFF_MS,
      maxAttempts: MAX_RESUME_ATTEMPTS,
    });
    if (reclaimed.scanned > 0) {
      logger.warn(
        {
          msg: 'hard-crash approval-resume leases reaped',
          scanned: reclaimed.scanned,
          reclaimed: reclaimed.reclaimed,
          manualIntervention: reclaimed.manualIntervention,
          hardCrashFailClosed: reclaimed.hardCrashFailClosed,
          skipped: reclaimed.skipped,
        },
        'hard-crash approval-resume leases reaped',
      );
    }
  } catch (err) {
    logger.error({ msg: 'hard-crash approval-resume sweeper failed', err });
  }
  // 2) 普通 lease sweeper：只处理 status IN ('queued', 'running') +
  //    无 approval 上下文的孤儿 Run。
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

/**
 * PR-3.3 Replay Fix — Resume 调度器入口（worker 是**唯一** SDK 调用者）。
 *
 * 行为：
 *   1. 扫描 `tool_approval_requests` 中 status IN ('approved','declined',
 *      'expired') AND mastra_resume_started_at IS NULL 的行（跨 workspace）；
 *   2. 对每一行**原子事务**抢占：
 *        a. `UPDATE tool_approval_requests` 写 `mastra_resume_started_at`
 *           条件：`status IN (...) AND mastra_resume_started_at IS NULL`；
 *        b. `UPDATE agent_runs` waiting_approval → 'running'（条件 WHERE）；
 *        c. `INSERT agent_run_events(type='run-resumed')`。
 *      三者**同事务**：任一失败整体 ROLLBACK——approval 留在终态 +
 *      `mastra_resume_started_at IS NULL`，下次 tick 重新抢占，**不会**
 *      留下"已写 markMastra 但 Run 未接管"的脑裂永久卡住；
 *   3. 把 `runRow` 交给 `consumeResumeStream`；worker 在那里按
 *      `approval.status` 选 `facade.approveToolCall` /
 *      `facade.declineToolCall` 拿回 stream；**这是**整个 PR-3.3 Replay Fix
 *      中**唯一**发起 Mastra SDK 的地方；
 *   4. 终态：调 completeRun / stopRun / failRun 推进 Run + 收敛 messages /
 *      checkpoint / SSE；同一 worker 完成全部收尾。
 *
 * 三个 crash window 的 lease/reconcile 行为：
 *   - W1（事务回滚）：`mastra_resume_started_at` 未写入；下次 tick 重新
 *     抢占；Run 保持 waiting_approval，等待下次成功；
 *   - W2（事务成功但 facade.approveToolCall / facade.declineToolCall
 *     抛错）：Run 已 leased + 状态 running；写 run-failed + 释放 lease。
 *     approval 状态不变（用户决策已记录），Run 失败由用户重发指令恢复；
 *     approval **不**重试（mastra_resume_started_at 已写，下次 tick 不再
 *     扫到，避免双 SDK 调用）；
 *   - W3（consumeAgentStream 迭代中抛错）：同 W2。
 *
 * 不变量：
 *   - state-machine 不再调 SDK；
 *   - 不调 streamAgent(prompt)（无重发模型请求）；
 *   - 不走 HTTP 路由：stream 由 worker 直接消费，不暴露给前端 SSE；
 *   - facade.listSuspendedRuns 仅在跨重启恢复路径
 *     （`recoverSuspendedRunsOnce`）调用；本函数**不**主动调
 *     listSuspendedRuns。
 */
async function resumeAwaitingRunsOnce(): Promise<void> {
  let pending: ApprovalRequestRow[] = [];
  try {
    pending = await listApprovalsPendingResume();
  } catch (err) {
    logger.error({ msg: 'resumeAwaitingRunsOnce 扫描失败', err });
    return;
  }
  for (const approval of pending) {
    // ─────────────── 原子事务：claim + Run→running + run-resumed 事件 ───────────────
    const client = await getDatabasePool().connect();
    let runRow: {
      id: string;
      workspace_id: string;
      conversation_id: string;
      assistant_message_id: string;
      agent_id: string;
      model: string;
      provider: string;
      request_id: string;
      created_by: string | null;
    } | null = null;
    let txCommitted = false;
    let txDecision: 'claimed' | 'lost' | 'run_already_converged' = 'lost';
    try {
      await client.query('BEGIN');
      const claim = await client.query<Record<string, unknown>>(
        `UPDATE tool_approval_requests
            SET mastra_resume_started_at = now(),
                updated_at = now()
          WHERE id = $1
            AND workspace_id = $2
            AND status IN ('approved', 'declined', 'expired')
            AND mastra_resume_started_at IS NULL
        RETURNING id, status, resolver_error`,
        [approval.id, approval.workspaceId],
      );
      if (claim.rowCount === 0) {
        // 已被另一 worker 抢占。
        await client.query('COMMIT');
        txCommitted = true;
        txDecision = 'lost';
        continue;
      }
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE agent_runs
            SET status = 'running',
                started_at = COALESCE(started_at, now()),
                lease_owner = $3,
                lease_expires_at = now() + ($4::int * INTERVAL '1 millisecond'),
                heartbeat_at = now(),
                updated_at = now()
          WHERE id = $1
            AND workspace_id = $2
            AND status = 'waiting_approval'
        RETURNING id, workspace_id, conversation_id, assistant_message_id,
                  agent_id, model, provider, request_id, created_by`,
        [approval.runId, approval.workspaceId, WORKER_ID, DEFAULT_LEASE_MS],
      );
      const runRowRaw = updated.rows[0];
      if (!runRowRaw) {
        // Run 已不在 waiting_approval（被 reconcile 提前收敛 / 异常
        // 路径）。**回滚**整个事务，让 approval 留给下次 tick。
        await client.query('ROLLBACK');
        txCommitted = true;
        txDecision = 'run_already_converged';
        continue;
      }
      runRow = runRowRaw as unknown as typeof runRow;
      await insertRunEvent(client, {
        runId: approval.runId,
        workspaceId: approval.workspaceId,
        type: 'run-resumed',
        payload: {
          approvalId: approval.id,
          toolId: approval.toolId,
          toolCallId: approval.toolCallId,
          decision: approval.status,
        },
      });
      await client.query('COMMIT');
      txCommitted = true;
      txDecision = 'claimed';
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      logger.error({
        msg: 'resumeAwaitingRunsOnce 原子事务失败（claim 回滚，下次 tick 重试）',
        approvalId: approval.id,
        runId: approval.runId,
        err,
      });
      continue;
    } finally {
      client.release();
    }

    if (!txCommitted || txDecision !== 'claimed' || !runRow) continue;

    // ─────────────── SDK 调用 + stream 消费 ───────────────
    void consumeResumeStream(approval, runRow).catch((err) => {
      logger.error({
        msg: 'consumeResumeStream 失败',
        approvalId: approval.id,
        runId: approval.runId,
        err,
      });
    });
  }
}

/**
 * PR-3.3 Replay Fix — Resume stream 消费（worker **唯一** SDK 调用点）。
 *
 * 输入：approval 是已由 `resumeAwaitingRunsOnce` 原子事务
 * markMastraResumeStarted 的行（status IN approved|declined|expired）。
 *
 * 流程：
 *   1. 按 `approval.status` 选 SDK 调用——同一 (run_id, tool_call_id)
 *      **最多**一次 SDK 调用：
 *        - approved    → facade.approveToolCall
 *        - declined    → facade.declineToolCall(reason = resolver_error ||
 *                       'declined_by_resolver')
 *        - expired     → facade.declineToolCall(reason = 'expired')
 *   2. 用 `consumeAgentStream(execution, stream)` 翻译 stream → 业务事件；
 *   3. 推 Run 终态（completeRun / stopRun / failRun）+ messages +
 *      checkpoint + SSE；同一 worker 完成全部收尾。
 *
 * crash windows：
 *   - W2（`approval.status === 'approved'` 且 facade.approveToolCall
 *     抛错——"调用结果不确定"窗口）：
 *     **不**写 Run → failed、**不**永久不重试。改走 reconciliation：
 *     1) 原子 `markApprovalResumeIndeterminate`（status → 'approved_
 *        resume_indeterminate'，resume_attempts += 1，写 resolver_error，
 *        保留 mastra_resume_started_at 阻止 scheduler 立即重扫再调 SDK）；
 *     2) 同一事务：把 agent_runs 'running' → 'waiting_approval' + 清 lease
 *        + INSERT 'approval-resume-indeterminate' 事件；
 *     3) 等 lease 到期（30_000ms backoff），由 reconciler 调
 *        `facade.listSuspendedRuns` 严格校验 runId / toolCallId /
 *        workspaceId / agentId——确认仍 suspended 才允许重试 approve；
 *        否则 fail-closed 写 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_*
 *        ` + Run → failed。
 *   - W2'（`approval.status === 'declined' | 'expired'` 且
 *     facade.declineToolCall 抛错——decline 语义幂等）：
 *     Run → failed + 释放 lease。approval 状态不变（用户决策已记录）；
 *     approval **不**重试，避免双 SDK 调用。
 *   - W3（consumeAgentStream 在首个 yield 前抛错）：同 W2 / W2'。
 *   - W4（consumeAgentStream 迭代中抛错）：同 W2 / W2'。
 */

/**
 * PR-3.3 Replay Fix W2 — Reconciliation 调度器：恢复"调用结果不确定"
 * 状态的审批。
 *
 * 行为（**严格 fail-closed**）：
 *   1. 扫描 `status='approved_resume_indeterminate' AND lease_expires_at
 *      < now() AND resume_attempts < MAX_RESUME_ATTEMPTS` 的行；
 *   2. 抢占 lease（`claimApprovalForReconcile`）—防止两个 reconciler
 *      并发处理同一行；
 *   3. 读 agent_runs 拿 agent_id / conversation_id；调
 *      `facade.listSuspendedRuns({ threadId, resourceId, workspaceId,
 *      agentId })` 校验 SDK 端状态；
 *   4. **严格校验**返回快照：
 *        - 必须存在 `runId === approval.runId` 的快照；
 *        - workspaceId === approval.workspaceId；
 *        - agentId（若 SDK 提供）=== approval.runId 对应的 agent_id；
 *        - toolCallId（若 SDK 提供）=== approval.toolCallId；
 *        - status 字段（若 SDK 提供） === 'suspended' 或类似在挂标记。
 *   5. **确认仍 suspended + identity 匹配**：
 *      `revertApprovalForReconcile`（DB-only：status → 'approved' +
 *      清 mastra_resume_started_at）。scheduler 自然重新接管、调
 *      facade.approveToolCall 重试——本函数**不**直接调 SDK；
 *   6. **校验失败**（无快照 / identity 不匹配 / 状态无法确认 /
 *      facade.listSuspendedRuns 自身抛错）：
 *      `failApprovalReconcile` 写人工介入错误 + `failRun` 写 Run → failed
 *      + INSERT 'approval-reconcile-manual-intervention' 事件。**不**
 *      盲目重复 SDK；
 *
 * 不调用 facade.approveToolCall / facade.declineToolCall——避免
 * 双重执行风险。
 */
async function reconcileIndeterminateApprovalsOnce(): Promise<void> {
  let pending: ApprovalRequestRow[] = [];
  try {
    pending = await listApprovalsPendingReconcile(MAX_RESUME_ATTEMPTS);
  } catch (err) {
    logger.error({ msg: 'reconcileIndeterminateApprovalsOnce 扫描失败', err });
    return;
  }

  let facade: MastraAgentFacade;
  try {
    facade = _getMastraFacade();
  } catch (err) {
    logger.error({
      msg: 'reconcileIndeterminateApprovalsOnce: 未注入 Mastra facade',
      err,
    });
    return;
  }

  for (const approval of pending) {
    try {
      // 每次 claim 使用独立令牌，防止同进程迟到请求撞上自己后来的租约。
      const reconcileOwner = `${WORKER_ID}:${randomUUID()}`;
      // 1) 抢占 lease。
      const claim = await claimApprovalForReconcile({
        workspaceId: approval.workspaceId,
        approvalId: approval.id,
        workerId: reconcileOwner,
        leaseMs: DEFAULT_LEASE_MS,
        maxAttempts: MAX_RESUME_ATTEMPTS,
      });
      if (claim.kind !== 'claimed') {
        // lease_contended / attempts_exhausted / unexpected_status /
        // not_found —— 跳过本行；其他 tick 会再尝试。
        continue;
      }

      // 2) 读 agent_runs 拿 agent_id + conversation_id。
      const runRow = await getDatabasePool().query<{
        agent_id: string;
        conversation_id: string;
        status: string;
      }>(
        `SELECT agent_id, conversation_id, status FROM agent_runs
          WHERE id = $1 AND workspace_id = $2`,
        [approval.runId, approval.workspaceId],
      );
      const r = runRow.rows[0];
      if (!r) {
        await failApprovalReconcile({
          workspaceId: approval.workspaceId,
          approvalId: approval.id,
          workerId: reconcileOwner,
          resolverError:
            'APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED: agent_run not found',
        });
        logger.error({
          msg: 'reconcile: agent_run 已不存在',
          approvalId: approval.id,
          runId: approval.runId,
        });
        continue;
      }

      // approveToolCall 已进入“调用结果不确定”窗口时，只有明确声明为
      // idempotent 的 Tool 才允许在 SDK 仍 suspended 的前提下自动重试。
      // 未注册 / 非幂等 Tool 的外部副作用无法由本地 DB 证明未发生，必须
      // fail-closed 进入人工介入，不能因为 SDK snapshot 仍可见就盲目重放。
      const toolDefinition = getToolDefinition(approval.toolId);
      if (!toolDefinition?.metadata.idempotent) {
        await markReconcileFailedAndFailRun(
          approval,
          r.status,
          'APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED: '
            + `tool ${approval.toolId} is not registered as idempotent; `
            + 'automatic approve replay is forbidden',
          reconcileOwner,
        );
        continue;
      }

      // 3) 调 facade.listSuspendedRuns 严格校验。
      let snapshots: SuspendedRunSnapshot[];
      try {
        snapshots = await facade.listSuspendedRuns({
          threadId: r.conversation_id,
          resourceId: approval.workspaceId,
          workspaceId: approval.workspaceId,
          agentId: r.agent_id,
        });
      } catch (listErr) {
        // listSuspendedRuns 自身抛错：保留 lease（等下次 tick）；不写
        // 错误——可能是网络抖动。reconciler 持有 lease，lease 过期
        // 后下次 tick 重新尝试。
        logger.error({
          msg: 'reconcile: listSuspendedRuns 抛错（保留 lease 等下次 tick）',
          approvalId: approval.id,
          runId: approval.runId,
          err: listErr,
        });
        continue;
      }

      // 4) 严格校验：必须找到 runId / toolCallId 完全匹配的快照。
      //    workspace 隔离由 query 入口的 `workspaceId` + 资源（threadId =
      //    conversation_id、resourceId = workspaceId）+ snapshot 必含的
      //    runId/toolCallId 共同保证；不再依赖 snapshot.workspaceId（v1.61
      //    SDK 公共 API 不暴露 workspaceId，避免假设 schema）。
      const matched = snapshots.find((s) => {
        if (s.runId !== approval.runId) return false;
        return s.toolCallId === approval.toolCallId
          && s.threadId === r.conversation_id
          && s.resourceId === approval.workspaceId
          && s.status === 'suspended';
      });

      if (!matched) {
        // 校验失败——写人工介入 + Run → failed。
        await markReconcileFailedAndFailRun(
          approval,
          r.status,
          'APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED: '
            + 'listSuspendedRuns did not return matching suspended snapshot '
            + `(runId=${approval.runId}, toolCallId=${approval.toolCallId}, `
            + `workspaceId=${approval.workspaceId})`,
          reconcileOwner,
        );
        continue;
      }

      // 5) 校验通过 → revert（DB-only）。scheduler 走 normal 路径重试 approve。
      const reverted = await revertApprovalForReconcile({
        workspaceId: approval.workspaceId,
        approvalId: approval.id,
        workerId: reconcileOwner,
      });
      if (reverted.kind !== 'reverted') {
        await markReconcileFailedAndFailRun(
          approval,
          r.status,
          'APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED: '
            + 'revertApprovalForReconcile failed after listSuspendedRuns '
            + `confirmed suspended (result=${reverted.kind})`,
          reconcileOwner,
        );
        continue;
      }
      logger.info({
        msg: 'reconcile: 确认仍 suspended，scheduler 将重试 approve',
        approvalId: approval.id,
        runId: approval.runId,
        resumeAttempts: reverted.row.resumeAttempts,
      });
    } catch (err) {
      logger.error({
        msg: 'reconcile: 单行失败',
        approvalId: approval.id,
        runId: approval.runId,
        err,
      });
    }
  }
}

/**
 * Reconciler 校验失败 / 写人工介入错误 + Run → failed + 写事件。
 *
 * 调用语义：本函数仅做 DB 写入 + Run 终态推进；**不**调 SDK。
 */
async function markReconcileFailedAndFailRun(
  approval: ApprovalRequestRow,
  currentRunStatus: string,
  resolverError: string,
  reconcileOwner: string,
): Promise<void> {
  // 2) Run → failed。条件 WHERE 仅在当前仍是 'running' 或 'waiting_approval'
  //    时生效——已被外部 sweep / stop 收敛为终态的 Run 不再回写。
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    // 租约 fence、人工介入标记、Run / message / event 必须同事务提交。
    const failed = await failApprovalReconcile({
      workspaceId: approval.workspaceId,
      approvalId: approval.id,
      resolverError,
      workerId: reconcileOwner,
    }, client);
    if (failed.kind !== 'failed') {
      await client.query('ROLLBACK');
      return;
    }
    const updated = await client.query(
      `UPDATE agent_runs
          SET status           = 'failed',
              error_code       = 'APPROVAL_RECONCILE_MANUAL_INTERVENTION',
              completed_at     = now(),
              lease_owner      = NULL,
              lease_expires_at = NULL,
              heartbeat_at     = NULL,
              updated_at       = now()
        WHERE id = $1
          AND workspace_id = $2
          AND status IN ('waiting_approval', 'running')
        RETURNING id`,
      [approval.runId, approval.workspaceId],
    );
    if (updated.rowCount === 0) {
      await client.query('COMMIT');
      logger.warn({
        msg: 'reconcile: Run 已不在 waiting_approval / running，跳过回写',
        approvalId: approval.id,
        runId: approval.runId,
        currentRunStatus,
      });
      return;
    }
    await client.query(
      `UPDATE messages
          SET content = COALESCE(NULLIF(content, ''),
                       '审批已确认但 SDK 调用结果不确定，需人工介入。'),
              citations = '[]'::jsonb,
              status    = 'failed'
        WHERE id = (
          SELECT assistant_message_id FROM agent_runs
           WHERE id = $1 AND workspace_id = $2
        )
          AND workspace_id = $2`,
      [approval.runId, approval.workspaceId],
    );
    await insertRunEvent(client, {
      runId: approval.runId,
      workspaceId: approval.workspaceId,
      type: 'run-failed',
      payload: {
        approvalId: approval.id,
        toolId: approval.toolId,
        toolCallId: approval.toolCallId,
        errorCode: 'APPROVAL_RECONCILE_MANUAL_INTERVENTION',
        reason: resolverError,
      },
    });
    await client.query('COMMIT');
    logger.error({
      msg: 'reconcile: 校验失败 → 人工介入 + Run → failed',
      approvalId: approval.id,
      runId: approval.runId,
      reason: resolverError,
    });
  } catch (writeErr) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    logger.error({
      msg: 'reconcile: 写 Run → failed 事务失败',
      approvalId: approval.id,
      runId: approval.runId,
      err: writeErr,
    });
  } finally {
    client.release();
  }
}

async function consumeResumeStream(
  approval: ApprovalRequestRow,
  r: {
    id: string;
    workspace_id: string;
    conversation_id: string;
    assistant_message_id: string;
    agent_id: string;
    model: string;
    provider: string;
    request_id: string;
    created_by: string | null;
  },
): Promise<void> {
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
    citations: [],
    toolExecutionMap: new Map(),
    armedForResume: false,
  };
  activeExecutions.set(r.id, execution);

  const heartbeatTimer = setInterval(() => {
    void heartbeatRunLease(r.id, WORKER_ID, DEFAULT_LEASE_MS).catch((err) => {
      logger.error({ msg: 'resume heartbeat failed', runId: r.id, err });
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  let exitType: 'done' | 'stopped' | 'error' | 'waiting_approval' = 'done';
  let exitContent = '';
  let exitError: string | undefined;
  let facade: MastraAgentFacade;
  try {
    facade = _getMastraFacade();
  } catch (err) {
    // 未注入 facade（生产路径必须由 run executor 启动期注入）——
    // fail-closed：写 run-failed。
    await failRun(
      r as unknown as QueuedRow,
      'failed',
      'PROVIDER_UNAVAILABLE',
      execution,
      err instanceof Error ? err : new Error(String(err)),
    );
    clearInterval(heartbeatTimer);
    activeExecutions.delete(r.id);
    return;
  }

  // PR-3.3 — requesterId 必须非空。resume 路径同样依赖 agent_runs.created_by
  // 真实用户身份（下游若再触发 approval-requested 必须填入真实 requester_id）。
  if (!r.created_by) {
    await failRun(
      r as unknown as QueuedRow,
      'failed',
      'INPUT_VALIDATION_FAILED',
      execution,
      new Error('agent_runs.created_by 为 NULL；拒绝续 Run。'),
    );
    clearInterval(heartbeatTimer);
    activeExecutions.delete(r.id);
    return;
  }

  let stream: AsyncIterable<unknown>;
  try {
    // ── 选 SDK ─ 同一 (run_id, tool_call_id) **只调一次** ─────────────────
    if (approval.status === 'approved') {
      stream = await facade.approveToolCall({
        runId: approval.runId,
        toolCallId: approval.toolCallId,
        workspaceId: approval.workspaceId,
      });
    } else if (approval.status === 'declined') {
      const reason = approval.resolverError || 'declined_by_resolver';
      stream = await facade.declineToolCall({
        runId: approval.runId,
        toolCallId: approval.toolCallId,
        reason,
        workspaceId: approval.workspaceId,
      });
    } else if (approval.status === 'expired') {
      stream = await facade.declineToolCall({
        runId: approval.runId,
        toolCallId: approval.toolCallId,
        reason: 'expired',
        workspaceId: approval.workspaceId,
      });
    } else {
      throw new Error(
        `consumeResumeStream: 非终态 approval (status=${approval.status}) 不应被 worker 接管。`,
      );
    }
  } catch (err) {
    // W2 — SDK 抛出。
    logger.error({
      msg: 'facade.approveToolCall / facade.declineToolCall 抛错（W2 crash window）',
      approvalId: approval.id,
      runId: approval.runId,
      status: approval.status,
      err,
    });
    clearInterval(heartbeatTimer);

    if (approval.status === 'approved') {
      // W2 approve — 调用结果不确定窗口。**不**写 run-failed；走
      // reconciliation：markApprovalResumeIndeterminate + 把 Run 推回
      // 'waiting_approval' + INSERT 'approval-resume-indeterminate' 事件。
      // reconciler 在 lease 到期后调 listSuspendedRuns 严格校验，确认
      // 仍 suspended 才允许重试 approve；否则 fail-closed 写人工介入。
      //
      // **attempts 耗尽分支**：当本次失败使 `resume_attempts >=
      // MAX_RESUME_ATTEMPTS` 时，**不再**把 Run 推回 waiting_approval；
      // 改走 fail-closed：approval 保持 approved_resume_indeterminate +
      // mastra_resume_started_at 保留 + resolver_error 覆盖为明确人工介入
      // 错误码；Run → failed + error_code = APPROVAL_RECONCILE_MANUAL_
      // INTERVENTION_ATTEMPTS_EXHAUSTED。三者同事务，要么全部收敛要么
      // 全部回滚——不会出现"Run 已 failed 但 approval 还在
      // approved + mastra_resume_started_at 仍为空"的脑裂状态。
      const w2Error = err instanceof Error ? err.message : String(err);
      const w2Client = await getDatabasePool().connect();
      try {
        await w2Client.query('BEGIN');
        const marked = await markApprovalResumeIndeterminate(
          {
            workspaceId: approval.workspaceId,
            approvalId: approval.id,
            resolverError: `APPROVE_SDK_INDETERMINATE: ${w2Error}`.slice(0, 1000),
            backoffMs: RESUME_RECONCILE_BACKOFF_MS,
          },
          w2Client,
        );
        if (marked.kind !== 'marked') {
          // approval 已被外部改写（极少见，例如运维手工 cleanup）。
          // 回滚 Run 更新，避免写出"Run 退到 waiting_approval 但 approval
          // 还在 approved + mastra_resume_started_at 已写"的脑裂状态。
          await w2Client.query('ROLLBACK');
          logger.warn({
            msg: 'W2 markApprovalResumeIndeterminate 失败，跳过 Run 复原',
            approvalId: approval.id,
            runId: approval.runId,
            result: marked.kind,
          });
          activeExecutions.delete(r.id);
          return;
        }
        const exhausted = marked.row.resumeAttempts >= MAX_RESUME_ATTEMPTS;
        if (exhausted) {
          // ── attempts 耗尽：fail-closed 收敛。────────────────────────
          // 1) approval：覆盖 resolver_error 为明确人工介入码；**保留**
          //    mastra_resume_started_at（运维需要时间戳对照 SDK 端状态）；
          //    **保留** status='approved_resume_indeterminate'（运维
          //    检索语义与 reconciler 跳过该行一致——scanner 过滤
          //    `resume_attempts < MAX`，已耗尽行天然排除）。
          const exhaustedError = `APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED: ` +
            `resume_attempts=${marked.row.resumeAttempts} >= MAX=${MAX_RESUME_ATTEMPTS}; ` +
            `last_sdk_error=${w2Error}`.slice(0, 1000);
          await w2Client.query(
            `UPDATE tool_approval_requests
                SET resolver_error = $3,
                    updated_at     = now()
              WHERE id = $1
                AND workspace_id = $2
                AND status = 'approved_resume_indeterminate'`,
            [approval.id, approval.workspaceId, exhaustedError],
          );
          // 2) Run → failed + error_code 同一错误码前缀。
          //    条件 WHERE 限定 status IN ('running','waiting_approval')
          //    ——已被外部 sweep / stop 收敛为终态的 Run 不再回写。
          await w2Client.query(
            `UPDATE agent_runs
                SET status           = 'failed',
                    error_code       = 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED',
                    completed_at     = now(),
                    lease_owner      = NULL,
                    lease_expires_at = NULL,
                    heartbeat_at     = NULL,
                    updated_at       = now()
              WHERE id = $1
                AND workspace_id = $2
                AND status IN ('running', 'waiting_approval')`,
            [approval.runId, approval.workspaceId],
          );
          // 3) message 收敛为失败态（best-effort；与 failRun 保持一致）。
          await w2Client.query(
            `UPDATE messages
                SET content = COALESCE(NULLIF($3, ''),
                             '审批已确认但 SDK 连续失败达上限，需人工介入。'),
                    citations = '[]'::jsonb,
                    status = 'failed'
              WHERE id = (
                SELECT assistant_message_id FROM agent_runs
                 WHERE id = $1 AND workspace_id = $2
              )
                AND workspace_id = $2`,
            [approval.runId, approval.workspaceId, ''],
          );
          // 4) 写 run-failed 事件（与 failRun / markReconcileFailedAndFailRun
          //    保持一致 schema）。
          await insertRunEvent(w2Client, {
            runId: approval.runId,
            workspaceId: approval.workspaceId,
            type: 'run-failed',
            payload: {
              approvalId: approval.id,
              toolId: approval.toolId,
              toolCallId: approval.toolCallId,
              errorCode: 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED',
              reason: exhaustedError,
              resumeAttempts: marked.row.resumeAttempts,
            },
          });
          await w2Client.query('COMMIT');
          logger.error({
            msg: 'W2 approve SDK 抛错达上限：attempts 耗尽 → 人工介入 + Run → failed',
            approvalId: approval.id,
            runId: approval.runId,
            resumeAttempts: marked.row.resumeAttempts,
            maxAttempts: MAX_RESUME_ATTEMPTS,
            error: w2Error,
          });
        } else {
          // 把 Run 推回 'waiting_approval' + 清 Run lease——这是 scheduler
          // 重新接管的契约；reconciler 校验通过后会清 mastra_resume_started_at
          // 让 scheduler 自然接管。
          await w2Client.query(
            `UPDATE agent_runs
                SET status           = 'waiting_approval',
                    lease_owner      = NULL,
                    lease_expires_at = NULL,
                    heartbeat_at     = NULL,
                    completed_at     = NULL,
                    error_code       = NULL,
                    updated_at       = now()
              WHERE id = $1
                AND workspace_id = $2
                AND status = 'running'`,
            [approval.runId, approval.workspaceId],
          );
          await insertRunEvent(w2Client, {
            runId: approval.runId,
            workspaceId: approval.workspaceId,
            type: 'run-resumed',
            payload: {
              approvalId: approval.id,
              toolId: approval.toolId,
              toolCallId: approval.toolCallId,
              decision: 'approved_resume_indeterminate',
              reason: w2Error,
              resumeAttempts: marked.row.resumeAttempts,
            },
          });
          await w2Client.query('COMMIT');
          logger.warn({
            msg: 'W2 approve SDK 抛错：进入 reconciliation',
            approvalId: approval.id,
            runId: approval.runId,
            resumeAttempts: marked.row.resumeAttempts,
            error: w2Error,
          });
        }
      } catch (writeErr) {
        try { await w2Client.query('ROLLBACK'); } catch { /* ignore */ }
        logger.error({
          msg: 'W2 markApprovalResumeIndeterminate 事务失败',
          approvalId: approval.id,
          runId: approval.runId,
          err: writeErr,
        });
      } finally {
        w2Client.release();
      }
      activeExecutions.delete(r.id);
      return;
    }

    // W2' — declined / expired：decline 语义幂等，不走 reconciliation。
    await failRun(
      r as unknown as QueuedRow,
      'failed',
      'PROVIDER_UNAVAILABLE',
      execution,
      err instanceof Error ? err : new Error(String(err)),
    );
    activeExecutions.delete(r.id);
    return;
  }

  try {
    for await (const event of consumeAgentStream(
      {
        workspaceId: approval.workspaceId,
        runId: approval.runId,
        requesterId: r.created_by as string,
        abortSignal: abortController.signal,
      },
      stream,
    )) {
      await handleStreamEvent(event, execution);
      if (event.type === 'done') {
        exitType = 'done';
        exitContent = event.content;
        execution.citations = event.citations;
        break;
      }
      if (event.type === 'stopped') {
        exitType = 'stopped';
        // V2 终态语义：content/citations 必须来自 execution 的 immutable
        // 快照（delta 累积），不取 stream 的 stopped event 内部 content——
        // 后者只是上游发出的中断信号，内容可能不完整。
        exitContent = execution.fullText;
        break;
      }
      if (event.type === 'error') {
        exitType = 'error';
        exitError = event.error;
        break;
      }
      // resume stream 中再次触发 approval-requested：第二个 Tool 仍
      // 需审批；持久化逻辑已由 consumeAgentStream 完成，Run 进入
      // waiting_approval，executor 不写终止态。
      if (event.type === 'approval-requested') {
        execution.armedForResume = true;
        exitType = 'waiting_approval';
        break;
      }
    }
  } catch (err) {
    exitType = 'error';
    exitError = (err as Error).message ?? '未知错误';
  } finally {
    clearInterval(heartbeatTimer);
  }

  await flushLiveDelta(execution);

  if (execution.armedForResume || exitType === 'waiting_approval') {
    logRequest('info', {
      msg: 'resume 后 Run 再次挂起审批',
      runId: r.id,
      workspaceId: r.workspace_id,
    });
    activeExecutions.delete(r.id);
    return;
  }

  if (exitType === 'done') {
    await completeRun(r as unknown as QueuedRow, execution, exitContent);
  } else if (exitType === 'stopped') {
    await stopRun(r as unknown as QueuedRow, execution, exitContent);
  } else {
    await failRun(
      r as unknown as QueuedRow,
      'failed',
      'PROVIDER_UNAVAILABLE',
      execution,
      new Error(exitError ?? '生成失败。'),
    );
  }
  activeExecutions.delete(r.id);
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
  // PR-3.3: approval-requested 事件需要 `requesterId` 才能让审批 API 在
  // resolve 时区分"哪个 workspace 用户提出了这次工具调用"。来自
  // agent_runs.created_by；为空表示 system-initiated 续 Run。
  created_by: string | null;
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
    citations: [],
    toolExecutionMap: new Map(),
    armedForResume: false,
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
  let knowledgeBaseId: string | null = null;
  try {
    const detail = await getConversationWithMessages(r.workspace_id, r.conversation_id);
    history = detail?.messages ?? [];
    knowledgeBaseId = detail?.conversation.knowledgeBaseId ?? null;
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
    // Phase 3.0：把业务 ↔ Mastra 标识映射透传给 streamAgent。
    // - runId     ←  r.id             (agent_runs.id)
    // - threadId  ←  r.conversation_id(conversations.id)
    // - resourceId←  r.workspace_id   (workspaces.id)
    // 这三个字段在 agent.stream() 时由 Runtime 透传到 Mastra 公开
    // streamOptions，使框架的 workflow snapshot 与我们的业务表走同一组
    // 标识。缺一不可；任何一个缺失都会让"跨重启恢复审批 Run"的入口失
    // 效（v1 stable 的 snapshot key = runId + memory.{thread,resource}）。
    //
    // PR-3.3 — requesterId 必须非空：agent_runs.created_by 为 NULL 时
    // 拒绝启动 Run（fail-closed）；否则任何 Tool 审批请求的
    // requester_id 都无法填写真实用户。
    if (!r.created_by) {
      throw new Error(
        `executeRun: agent_runs(id=${r.id}).created_by 为 NULL；` +
          'Run 必须由真实用户创建才能进入审批闭环。',
      );
    }
    for await (const event of streamAgent({
      workspaceId: r.workspace_id,
      agentId: r.agent_id,
      prompt: extractPromptFromHistory(history),
      conversationId: r.conversation_id,
      knowledgeBaseId,
      history,
      abortSignal: abortController.signal,
      runId: r.id,
      threadId: r.conversation_id,
      resourceId: r.workspace_id,
      requesterId: r.created_by,
    })) {
      await handleStreamEvent(event, execution);
      if (event.type === 'done') { exitType = 'done'; exitContent = event.content; execution.citations = event.citations; break; }
      if (event.type === 'stopped') {
        exitType = 'stopped';
        // V2 终态语义：content 来自 execution.fullText 快照，
        // 不取 stream stopped event 的 content（可能为空）。
        exitContent = execution.fullText;
        break;
      }
      if (event.type === 'error') { exitType = 'error'; exitError = event.error; break; }
      // PR-3.3: 工具调用挂起审批 → streamAgent 已经把 Run 推到
      // waiting_approval 并释放 lease；executor **不**写终止态，让审批
      // worker / API 推进 Run。execution.armedForResume=true 后，下方
      // 终态分支**不**走 stopRun/completeRun/failRun，仅清理本地资源。
      // 真正续 Run 由 `resumeAwaitingRunsOnce()` 调度器在 approval
      // 收敛到 'approved' 后驱动。
      if (event.type === 'approval-requested') {
        execution.armedForResume = true;
        break;
      }
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

  if (execution.armedForResume) {
    // 工具调用挂起审批：Run 状态保持 waiting_approval（streamAgent 已
    // 写过）；lease 在 streamAgent 阶段已释放；不调用任何终态函数。
    // 本 execution 仅清理 activeExecutions 表项。
    logRequest('info', {
      msg: 'run 已挂起审批，等待 resume',
      runId: r.id,
      workspaceId: r.workspace_id,
    });
    activeExecutions.delete(r.id);
    return;
  }

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
  if (event.type === 'tool-call-start') {
    try {
      // upsertToolExecution 幂等：同 toolCallId 重复调用只产生 1 行；事件
      // replay / SSE 重放不会重复 INSERT。
      await upsertToolExecution({
        workspaceId: execution.workspaceId,
        messageId: execution.assistantMessageId,
        runId: execution.runId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.input as Record<string, unknown>,
      });
    } catch (err) {
      logger.error({ msg: 'create tool execution failed', runId: execution.runId, err });
    }
    await writeRunEvent(execution, 'tool-call-started', {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
    return;
  }
  if (event.type === 'tool-call-complete') {
    // finalize 走 toolCallId：缺失 start 行的 approval resume 也能安全收敛；
    // 已终态的行不覆写。backfill 时通过 agent_runs 反查 messageId，
    // toolName 由 event 显式提供（PR-review Item 4）。
    try {
      await finalizeToolExecutionByCallId({
        workspaceId: execution.workspaceId,
        runId: execution.runId,
        toolCallId: event.toolCallId,
        result: (event.output as Record<string, unknown> | null) ?? null,
        status: 'success',
        toolName: event.toolName,
      });
    } catch (err) {
      logger.error({ msg: 'finalize tool execution failed', runId: execution.runId, err });
    }
    await writeRunEvent(execution, 'tool-call-completed', {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
    return;
  }
  if (event.type === 'tool-call-error') {
    try {
      await finalizeToolExecutionByCallId({
        workspaceId: execution.workspaceId,
        runId: execution.runId,
        toolCallId: event.toolCallId,
        result: null,
        status: 'error',
        error: 'tool_error',
        toolName: event.toolName,
      });
    } catch (err) {
      logger.error({ msg: 'finalize failed tool execution failed', runId: execution.runId, err });
    }
    await writeRunEvent(execution, 'tool-call-failed', {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      errorCode: 'tool_error',
    });
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
          AND lease_owner = $3
          AND status IN ('queued','running','waiting_approval')
        RETURNING id`,
      [r.id, r.workspace_id, WORKER_ID],
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      logger.warn({ msg: 'completeRun 跳过：Run 已终态或当前 worker 已丢失 lease', runId: r.id });
      return;
    }
    await client.query(
      `UPDATE messages
          SET content = $3, citations = $4::jsonb, status = 'completed'
        WHERE id = $1 AND workspace_id = $2`,
      [r.assistant_message_id, r.workspace_id, content, JSON.stringify(execution.citations)],
    );
    await writeFinalCheckpoint(client, r, execution, content);
    await insertRunEvent(client, {
      runId: r.id,
      workspaceId: r.workspace_id,
      type: 'run-completed',
      // PR-review Round 2 Item 1：终态事件必须携带权威 citations，
      // 前端不再依赖 messages 重拉。contentLength 仍保留做长度断言。
      // PR-review Round 3 Item 3：payload 构造统一用 buildRunTerminalPayload。
      payload: buildRunTerminalPayload(content, execution.citations ?? []),
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
          AND lease_owner = $3
          AND status IN ('queued','running','waiting_approval')
        RETURNING id`,
      [r.id, r.workspace_id, WORKER_ID],
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      logger.warn({ msg: 'stopRun 跳过：Run 已终态或当前 worker 已丢失 lease', runId: r.id });
      return;
    }
    // V2 终态收敛：
    //   - content 用 V2 ActiveExecution 的 immutable 文本快照（execution.fullText
    //     或调用方传入的 content）。空字符串合法：contentLength=0。
    //   - citations 仅在 incoming 快照非空时合并写入；若快照为空（[]）→ 保留
    //     DB 现有引用，避免 COALESCE($4::jsonb, citations) 把空数组误覆盖
    //     （PR-review Item 3）。合并策略（PR-review Round 2 Item 4 修复）：
    //     按 `chunkId` 取并集，incoming 优先；同 chunkId 视作同一引用。
    //
    //   PR-review Round 5 Item 1 + Round 6 Item 1：先在变量层把
    //   "最终 citations"统一为一个数组 `finalCitationsForPayload`，
    //   随后 messages UPDATE（可能跳过 citations 列）/ SSE run-stopped
    //   payload 都用同一个数组。SSE 与 HTTP 通道必须携带完全一致
    //   的终态快照。
    //
    //   空 incoming 不代表最终 citations 为空：当 messages.citations
    //   已有引用、execution.citations=[]（典型：abort 时只持有部分
    //   快照或运行时从未累积引用）→ 跳过 UPDATE 让 DB 保留已有引用，
    //   但 finalCitationsForPayload **必须**取 DB 当前值，而不是 []。
    //   否则 SSE 会告知前端"无引用"，UI 与 DB 不一致直到用户刷新。
    const incoming = Array.isArray(execution.citations) ? execution.citations : null;
    let finalCitationsForPayload: ReadonlyArray<unknown>;
    if (incoming && incoming.length > 0) {
      const existingRow = await client.query<{ citations: unknown }>(
        `SELECT citations FROM messages WHERE id = $1 AND workspace_id = $2`,
        [r.assistant_message_id, r.workspace_id],
      );
      const existing = Array.isArray(existingRow.rows[0]?.citations)
        ? (existingRow.rows[0].citations as Array<Record<string, unknown>>)
        : [];
      // PR-review Round 3 Item 3：合并逻辑提取至 citation-merge.ts，
      // service.ts / run-executor.ts / 测试三者共用同一实现。
      const merged = mergeCitationsByChunkId(existing, incoming).merged as Array<
        Record<string, unknown>
      >;
      finalCitationsForPayload = merged;
      await client.query(
        `UPDATE messages
            SET content = $3,
                citations = $4::jsonb,
                status = 'stopped'
          WHERE id = $1 AND workspace_id = $2`,
        [r.assistant_message_id, r.workspace_id, content, JSON.stringify(merged)],
      );
    } else {
      // incoming 为空：不覆写 messages.citations（DB 已保留已有引用），
      //   但 finalCitationsForPayload 必须取 DB 当前值 —— SSE payload
      //   向 UI 报告"实际保留的最终引用"，与 messages 表保持一致。
      const existingRow = await client.query<{ citations: unknown }>(
        `SELECT citations FROM messages WHERE id = $1 AND workspace_id = $2`,
        [r.assistant_message_id, r.workspace_id],
      );
      finalCitationsForPayload = Array.isArray(existingRow.rows[0]?.citations)
        ? (existingRow.rows[0]?.citations as ReadonlyArray<unknown>)
        : [];
      await client.query(
        `UPDATE messages
            SET content = $3,
                status = 'stopped'
          WHERE id = $1 AND workspace_id = $2`,
        [r.assistant_message_id, r.workspace_id, content],
      );
    }
    await writeFinalCheckpoint(client, r, execution, content);
    await insertRunEvent(client, {
      runId: r.id,
      workspaceId: r.workspace_id,
      type: 'run-stopped',
      // PR-review Round 2 Item 1：stop 路径同样需要把 V2 终态收敛
      // 写入的 content + citations 同步到 SSE 终态事件，前端不依赖
      // 重拉 messages 就能拿到权威快照。
      // PR-review Round 3 Item 3：payload 构造统一用 buildRunTerminalPayload。
      // PR-review Round 5 Item 1：payload 使用 finalCitationsForPayload
      // （已合并并持久化的最终数组），不再用 execution.citations。
      payload: buildRunTerminalPayload(content, finalCitationsForPayload),
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
          AND lease_owner = $4
          AND status IN ('queued','running','waiting_approval')
        RETURNING id`,
      [r.id, errorCode, r.workspace_id, WORKER_ID],
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      logger.warn({ msg: 'failRun 跳过：Run 已终态或当前 worker 已丢失 lease', runId: r.id, errorCode });
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
 * 测试 / 集成脚本入口：单次跑 resume 调度器（不等 setInterval tick）。
 * 真实 PG 集成测试通过此入口驱动 resume 行为，无需启 executor 后台循环。
 */
export async function runResumeSchedulerOnce(): Promise<void> {
  await resumeAwaitingRunsOnce();
}

/**
 * 测试 / 集成脚本入口：单次跑 reconciliation（不等 setInterval tick）。
 */
export async function runReconcileIndeterminateOnce(): Promise<void> {
  await reconcileIndeterminateApprovalsOnce();
}

/**
 * 测试 / 集成脚本入口：单次跑 lease sweeper（不等 setInterval tick）。
 */
export async function runLeaseSweeperOnce(): Promise<void> {
  await sweepOnce();
}

/**
 * 测试 / 集成脚本入口：单次跑 hard-crash approval-resume sweeper。
 *
 * 仅触发新加的 PR-3.3.2 路径（`sweepExpiredApprovalResumeLeases`），
 * 不跑普通 lease sweeper——便于测试断言本路径的写入行为。
 *
 * 返回 `SweepApprovalResumeResult` 以便测试断言 scanned / reclaimed /
 * manualIntervention / hardCrashFailClosed / skipped 等字段。
 */
export async function runHardCrashApprovalResumeSweeperOnce(): Promise<SweepApprovalResumeResult> {
  const result = await sweepExpiredApprovalResumeLeases({
    backoffMs: RESUME_RECONCILE_BACKOFF_MS,
    maxAttempts: MAX_RESUME_ATTEMPTS,
  });
  logger.info(
    {
      msg: 'hard-crash approval-resume sweeper tick (test entry)',
      scanned: result.scanned,
      reclaimed: result.reclaimed,
      manualIntervention: result.manualIntervention,
      hardCrashFailClosed: result.hardCrashFailClosed,
      skipped: result.skipped,
    },
    'hard-crash approval-resume sweeper tick (test entry)',
  );
  return result;
}

/**
 * 把所有当前活跃 executions 列出来；测试 / 调试用。
 */
export function listActiveExecutions(): Array<{ runId: string; assistantMessageId: string }> {
  return Array.from(activeExecutions.values()).map((e) => ({
    runId: e.runId,
    assistantMessageId: e.assistantMessageId,
  }));
}

/**
 * 强制终止一个运行中的 Run（POST /messages/:id/stop 路径）。
 *
 * 单一 V2 终态收敛语义（PR-3.x → 本轮加固）：
 *   - 命中活跃 execution → 调 AbortController 中断 stream，把当前的
 *     `fullText` / `citations` 快照带回去；
 *     这是 V2 ActiveExecution 的"权威 immutable 文本快照"——
 *     HTTP 路由、stop 事件 payload、run-stopped 写入都必须共用同一个
 *     snapshot，绝不混用 legacy controller 的 `partialContent`。
 *   - 未命中 → `{ kind: 'not_hit' }`；路由层继续走 `stopRunByMessageId`
 *     的事务收敛（DB 行 active 但 controller 已被 GC）路径。
 *
 * 不可重复调用就破坏终态：abort 只发信号，不直接落 DB；真正的
 * `stopped` 收敛由 stream 的 finally → `stopRun`（run-executor 内
 * 同事务路径）写一次；后续重复 abort 是 no-op。
 */
export type AbortRunResult =
  | { kind: 'not_hit' }
  | {
      kind: 'aborted';
      runId: string;
      workspaceId: string;
      /** 当前累积的文本快照。空字符串也是合法终态（contentLength=0）。 */
      fullText: string;
      /** 当前累积的引用。停止时只追加、不清除。 */
      citations: Citation[];
    };

export function abortRunByMessage(messageId: string): AbortRunResult {
  for (const execution of activeExecutions.values()) {
    if (execution.assistantMessageId === messageId) {
      execution.abortController.abort();
      return {
        kind: 'aborted',
        runId: execution.runId,
        workspaceId: execution.workspaceId,
        fullText: execution.fullText,
        citations: execution.citations,
      };
    }
  }
  return { kind: 'not_hit' };
}

// 兼容：让 ask-driver / 旧路由不依赖本模块的 config（config 已经导入）
export const _providerDefault = config.chatProvider;
