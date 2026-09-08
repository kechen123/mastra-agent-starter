/**
 * PR-3.3 — Tool Approval Timeout & Reconciliation Worker。
 *
 * 这是 backend 进程内**唯一**负责以下工作的循环：
 *   1. 扫描 pending 且 expires_at < now 的 approval，逐个调 `expireApproval`
 *      把 status 推到 `expired`（DB-only 决策登记，不调 SDK）；
 *   2. 启动期 / 周期 tick 调 `reconcileInflightApprovals`，接管
 *      lease 已过期的 inflight 行（DB-only 收敛）；
 *
 * 与 run executor 的边界（**严格 DB-only**）：
 *   - timeout worker **不**调 Mastra SDK、**不**消费 resume stream；
 *   - 这些职责由 run executor 的 scheduler / reconciler 唯一执行；
 *   - timeout worker 的产出（status='expired' / inflight 收敛）会被
 *     scheduler 在下个 tick 通过 `listApprovalsPendingResume` 拾起，
 *     走标准 approveToolCall / declineToolCall 路径；
 *
 * 设计动机：timeout worker 与 run executor 各自独立计时，互不依赖。
 * 本阶段不要求"重启后自动续 Run"（那是后续阶段），但**必须**保证
 * "超时收敛"与"SDK 接管"在 cron-less 的单进程下也能工作。
 */
import {
  expireApproval,
  reconcileInflightApprovals,
  listExpiredPendingApprovals,
  type ExpireApprovalOutcome,
} from './state-machine.js';
import { logger } from '../../infrastructure/logging/logger.js';

const DEFAULT_TICK_INTERVAL_MS = 15_000;

interface WorkerConfig {
  tickIntervalMs?: number;
}

let _interval: NodeJS.Timeout | null = null;
let _running = false;

declare global {
  // 单进程内全局暴露运行入口（HMR / dev 重启用）
  // eslint-disable-next-line no-var
  var __xuanshuApprovalWorkerStarted: boolean | undefined;
}

export function isApprovalWorkerStarted(): boolean {
  return Boolean(globalThis.__xuanshuApprovalWorkerStarted);
}

/**
 * 启动 worker——幂等。
 *
 * 流程：
 *   1. 立刻跑一次 reconcile（接管 lease 已过期的 inflight 行）；
 *   2. 然后进入周期 tick：先 expire，再 reconcile。
 *
 * 失败隔离：每次 tick 包在 try/catch 里——单次失败不会中断后续 tick。
 */
export async function startApprovalTimeoutWorker(
  config: WorkerConfig = {},
): Promise<void> {
  if (globalThis.__xuanshuApprovalWorkerStarted) return;
  globalThis.__xuanshuApprovalWorkerStarted = true;

  const tickMs = config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;

  // 启动期先 reconcile。
  try {
    const summary = await reconcileInflightApprovals();
    logger.info({
      msg: 'approval worker: 启动期 reconcile 完成',
      ...summary,
    });
  } catch (err) {
    logger.error({ msg: 'approval worker: 启动期 reconcile 失败', err });
  }

  _interval = setInterval(() => {
    void runOnceSafely();
  }, tickMs);
  _interval.unref?.();
  logger.info({ msg: 'approval worker 已启动', tickMs });
}

export async function stopApprovalTimeoutWorker(): Promise<void> {
  globalThis.__xuanshuApprovalWorkerStarted = false;
  if (_interval) clearInterval(_interval);
  _interval = null;
  // 等当前 tick 完成。
  while (_running) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function runOnceSafely(): Promise<void> {
  if (_running) return; // 单飞：上一次 tick 仍在跑就跳过。
  _running = true;
  try {
    await expirePendingOnce();
    await reconcileOnce();
  } catch (err) {
    logger.error({ msg: 'approval worker: tick 失败', err });
  } finally {
    _running = false;
  }
}

/**
 * 扫描 pending 过期 approval 列表，逐个调 expireApproval（DB-only
 * 决策登记：pending → expired，resolver_id = system-approval-worker）。
 *
 * 不调 SDK / 不消费 stream / 不写 Run 终态——Run 由 scheduler 在下个
 * tick 通过 `listApprovalsPendingResume` 拾起 `status='expired'` 行，
 * 走 `facade.declineToolCall(reason='expired')` 收尾。
 *
 * 单行失败不影响后续行。
 */
async function expirePendingOnce(): Promise<void> {
  let expired: Awaited<ReturnType<typeof listExpiredPendingApprovals>>;
  try {
    expired = await listExpiredPendingApprovals();
  } catch (err) {
    logger.error({ msg: 'approval worker: listExpiredPendingApprovals 失败', err });
    return;
  }
  if (expired.length === 0) return;
  logger.info({
    msg: 'approval worker: 发现过期 pending，开始收敛',
    count: expired.length,
  });
  for (const row of expired) {
    const outcome: ExpireApprovalOutcome = await expireApproval({
      workspaceId: row.workspaceId,
      approvalId: row.id,
    });
    if (outcome.kind === 'expired') {
      logger.info({
        msg: 'approval worker: 已超时收敛',
        approvalId: row.id,
        runId: row.runId,
      });
    } else if (
      outcome.kind === 'already_resolved' ||
      outcome.kind === 'not_pending_yet'
    ) {
      // 并发：被其他 resolver 处理了 / row expires_at 已被改写。
      // 不记日志——正常路径。
    } else if (outcome.kind === 'not_found') {
      logger.warn({
        msg: 'approval worker: row 不存在（外部 cleanup？）',
        approvalId: row.id,
      });
    }
  }
}

async function reconcileOnce(): Promise<void> {
  try {
    const summary = await reconcileInflightApprovals();
    if (summary.dbOnlyTakenOver > 0) {
      logger.info({
        msg: 'approval worker: reconcile 完成',
        ...summary,
      });
    }
  } catch (err) {
    logger.error({ msg: 'approval worker: reconcile 失败', err });
  }
}