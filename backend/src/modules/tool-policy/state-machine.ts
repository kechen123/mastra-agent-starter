/**
 * PR-3.3 Replay Fix — Tool Approval State Machine。
 *
 * 关键不变量（**比 PR-3.3 旧版本严格**）：
 *   1. **本模块不调 Mastra SDK**——state-machine 只负责"决策登记"
 *      （pending → approved/declined/expired + resolver_id + resolved_at）。
 *      HTTP 路由层 `resolveApprovalHandler` 也只调本函数，不直接接触
 *      Mastra。
 *   2. **worker 是唯一**的 `facade.approveToolCall / facade.declineToolCall`
 *      调用方与**唯一**的消费返回 stream 的执行者。
 *   3. approve / decline / expired 三种决策统一由 worker 走同一条
 *      `consumeResumeStream` 路径；本模块的 `expireApproval` 也只写 DB
 *      终态（`status='expired'`），不发起 SDK。
 *   4. `releaseClaim` 不写 `resolver_id = NULL`：保留原决策者审计身份
 *      或定义合法平台身份（system-approval-worker）。
 *
 * 数据库 ↔ Mastra Storage **不在**同一事务；我们走 saga + 状态机 +
 * 单飞 + 租约 (lease) + 超时 worker。worker 的原子事务保证：
 *   - `markMastraResumeStarted`（写 mastra_resume_started_at）
 *   - `UPDATE agent_runs` waiting_approval → running（条件 WHERE）
 *   - `INSERT agent_run_events(type='run-resumed')`
 * 三者同事务，任一失败整体回滚——approval 可被下次 tick 重新抢占。
 *
 * 三个 crash window 的 lease/reconcile 行为：
 *   - W1（worker claim 成功但 SDK 调用前崩溃）：整事务回滚，approval
 *     留在终态 + `mastra_resume_started_at IS NULL`，下次 tick 重新
 *     抢占；
 *   - W2（SDK 调用抛出）：approval 留在终态 + mastra_resume_started_at
 *     已设置；Run 走 `failRun` + 写 `run-failed` 事件。approval 状态
 *     不变（用户决策已记录），Run 失败由用户重发指令恢复；
 *   - W3（stream 消费中断）：同 W2 —— Run fail。
 *
 * `takeoverInflightApproval` 在新流程下基本不可达（state-machine 不会
 * 写出中间态），保留函数仅为防御：若数据库被外部手工写入 inflight 行
 * 仍能收敛为终态，但**不**发起 SDK（DB-only takeover）。
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../../infrastructure/logging/logger.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import {
  type ApprovalRequestRow,
  type ApprovalStatus,
  type ResolveApprovalResult,
} from './types.js';
import {
  expireApprovalRequest as repoExpire,
  type ExpireApprovalResult,
  getApprovalRequestById,
  listInflightApprovalRequests,
  releaseClaim,
  resolveApprovalRequest,
  takeoverInflightLease,
} from './repository.js';

const DEFAULT_LEASE_MS = 60_000;

/**
 * PR-3.3 Replay Fix W2 — approve resume 最大重试次数。
 *
 * `consumeResumeStream` 调 `facade.approveToolCall` 抛错时 +
 * `resume_attempts`；超过此上限后 reconciler **不**再扫这行
 * （`resume_attempts < MAX_RESUME_ATTEMPTS`），由
 * `failApprovalReconcile` 转人工介入。
 */
export const MAX_RESUME_ATTEMPTS = 3;

/**
 * PR-3.3 Replay Fix W2 — 每次 W2 后 lease 到期 backoff（ms）。
 *
 * reconciler 在 `lease_expires_at < now()` 后才扫描该行——避免
 * 紧接 SDK 失败后立刻重试（让 SDK 端 / 网络有时间恢复）。
 */
export const RESUME_RECONCILE_BACKOFF_MS = 30_000;

/**
 * `agent.approveToolCall` / `agent.declineToolCall` / `agent.listSuspendedRuns`
 * 的最小契约；由运行期注入——测试可传 fake。
 *
 * 真实调用签名（Mastra 1.61）：
 *   - agent.approveToolCall({ runId, toolCallId }) → AsyncIterable<chunk>
 *     （v1.61 起该方法返回的 stream 是"从审批挂起点续推"的真实恢复流；
 *     不再是 `Promise<unknown>`。）
 *   - agent.declineToolCall({ runId, toolCallId, reason }) → 同上语义。
 *   - agent.listSuspendedRuns({ threadId, resourceId }) → SuspendedRunSnapshot[]
 *     是 **Agent 实例方法**（非 Mastra 单例方法）。
 *
 * 注意：本类型把 `runId / toolCallId / workspaceId` 视为强契约——任何
 * 缺失都会让上层 fail-closed（避免 fallback general-chat / 静默空数组）。
 *
 * PR-3.3 Replay Fix：**只有 worker** 持有本类型的实例并发起调用；
 * 本模块（state-machine）**不持有** facade 引用——`getMastraFacade` 等
 * 主动拿 facade 的 API 已被删除。
 */
export interface MastraAgentFacade {
  approveToolCall(args: {
    runId: string;
    toolCallId: string;
    /** 强必填：facade 必须用它做 per-workspace agent 解析；缺失即抛错。 */
    workspaceId: string;
  }): Promise<AsyncIterable<unknown>>;
  declineToolCall(args: {
    runId: string;
    toolCallId: string;
    reason: string;
    /** 强必填：facade 必须用它做 per-workspace agent 解析；缺失即抛错。 */
    workspaceId: string;
  }): Promise<AsyncIterable<unknown>>;
  /**
   * 仅恢复路径使用：返回 threadId/resourceId 命中的 suspended runs。
   * 用于跨重启 / listSuspendedRuns 校验。
   *
   * 必须透传 workspaceId 与 agentId；facade 在缺失时会拒绝执行。
   * 返回结构对齐 Mastra 1.61 公开 API：`SuspendedRunSnapshot[]`。
   * Agent 实例方法（**不**是 Mastra 单例方法）。
   */
  listSuspendedRuns(args: ListSuspendedRunsArgs): Promise<SuspendedRunSnapshot[]>;
}

/**
 * `listSuspendedRuns` 返回的每条快照的最小契约。
 * 上层必须严格校验 threadId / resourceId / workspaceId / runId / toolCallId
 * 是否齐全；任一缺失即 fail-closed，禁止 fallback general-chat / 静默空数组。
 */
export interface SuspendedRunSnapshot {
  runId: string;
  toolCallId?: string;
  threadId?: string;
  resourceId?: string;
  status?: string;
}

/**
 * 恢复调度器调用 listSuspendedRuns 时的入参；
 * agentId 由 run executor 从 agent_runs.agent_id 透传，避免 facade 在
 * SDK 边界反查 conversation（避免循环依赖与多余 SQL）。
 */
export interface ListSuspendedRunsArgs {
  threadId: string;
  resourceId: string;
  workspaceId: string;
  agentId: string;
}

let _mastraFacadeOverride: MastraAgentFacade | null = null;

/**
 * 测试钩子：注入 fake Mastra facade。生产路径绝不调本函数。
 *
 * 注：本模块不再调用 facade；此钩子保留以兼容 production facade 安装
 * 流程（`mastra-facade.ts::installProductionMastraFacade` 仍通过本钩子
 * 注入）。worker 直接 import facade 的方式来获取。
 */
export function _setMastraFacadeForTesting(
  facade: MastraAgentFacade | null,
): void {
  _mastraFacadeOverride = facade;
}

/**
 * 测试 / 生产路径获取 facade 的统一 getter。
 *
 * **本函数仅供 worker 调用**——state-machine（resolveApproval /
 * expireApproval）**不**调本函数。命名 `_getMastraFacade` 以表达
 * "本模块对外暴露给 worker 的受控入口"；未注入时抛错（fail-closed）。
 */
export function _getMastraFacade(): MastraAgentFacade {
  if (_mastraFacadeOverride) return _mastraFacadeOverride;
  throw new Error(
    'state-machine: 未注入 Mastra facade——运行期必须由 run executor 注入；' +
      '测试通过 _setMastraFacadeForTesting 注入 fake。',
  );
}

const WORKER_ID = `${process.env.HOSTNAME ?? 'host'}-${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * 平台系统 resolver 的真实用户 UUID——由 init.sql 阶段 3.3 段
 * INSERT 一行 `app_users` 行（`system-approval-worker`）支撑。
 * 与用户主动 resolve 在审计维度上明确区分（username 字段），同时
 * 满足 `tool_approval_requests.resolver_id` 的 FK 约束。
 */
const SYSTEM_RESOLVER_USERNAME = 'system-approval-worker';

let _cachedSystemResolverId: string | null = null;

export async function getSystemResolverUserId(): Promise<string> {
  if (_cachedSystemResolverId) return _cachedSystemResolverId;
  const pool = getDatabasePool();
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM app_users
      WHERE username_normalized = $1
      LIMIT 1`,
    [SYSTEM_RESOLVER_USERNAME],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error(
      `state-machine: 平台系统用户 ${SYSTEM_RESOLVER_USERNAME} 未在 app_users 中；` +
        '请先执行 backend/database/init.sql 阶段 3.3 段',
    );
  }
  _cachedSystemResolverId = row.id;
  return row.id;
}

/**
 * 测试钩子：清空系统 resolver 缓存，让 fake 注入路径可重新解析。
 */
export function _resetSystemResolverCacheForTesting(): void {
  _cachedSystemResolverId = null;
}

export type ApprovalDecision = 'approve' | 'decline';

export interface ResolveApprovalOptions {
  workspaceId: string;
  approvalId: string;
  resolverId: string;
  decision: ApprovalDecision;
  leaseMs?: number;
}

export type ResolveApprovalOutcome =
  | { kind: 'approved'; row: ApprovalRequestRow }
  | { kind: 'declined'; row: ApprovalRequestRow }
  | { kind: 'not_found' }
  | { kind: 'already_resolved'; currentStatus: string }
  | { kind: 'lease_contended'; currentLeaseOwner: string | null };

/**
 * PR-3.3 Replay Fix — resolveApproval 只做"决策登记"，**不**调 SDK。
 *
 * 行为：
 *   - 原子 UPDATE 把 `pending → approved|declined`，同步写
 *     `resolver_id / decision / resolved_at`，清 lease。
 *   - 0 行更新时再做一次 SELECT 区分 not_found / already_resolved。
 *
 * 不再做任何 SDK 调用；worker (`runResumeSchedulerOnce`) 是唯一
 * approveToolCall / declineToolCall 调用者。
 */
export async function resolveApproval(
  opts: ResolveApprovalOptions,
): Promise<ResolveApprovalOutcome> {
  const decision = opts.decision === 'approve' ? 'approved' : 'declined';
  const result = await resolveApprovalRequest({
    workspaceId: opts.workspaceId,
    approvalId: opts.approvalId,
    resolverId: opts.resolverId,
    decision,
  });
  if (result.kind === 'resolved') {
    return { kind: decision, row: result.row };
  }
  if (result.kind === 'not_found') return { kind: 'not_found' };
  if (result.kind === 'already_resolved') {
    return { kind: 'already_resolved', currentStatus: result.currentStatus };
  }
  // not_pending_yet 不应出现（resolveApproval 不带 expires_at 约束）；
  // 防御性映射。
  return { kind: 'already_resolved', currentStatus: result.currentStatus };
}

/**
 * 释放抢占——本函数仅在 claim 成功后、SDK 调用**未发起**前调用；
 * SDK 调用已开始（`markMastraCallStarted` 已成功）时**不**要调用本函数，
 * 因为 SDK 调用可能仍在进行；让 lease 自然超时。
 *
 * PR-3.3 修订：保留 `resolver_id` 与 `decision`（不写 NULL）；详见
 * `repository.ts::releaseClaim`。
 */
export async function releaseApprovalClaim(args: {
  workspaceId: string;
  approvalId: string;
  reason: string;
}): Promise<{ kind: 'released' } | { kind: 'lost' }> {
  const result = await releaseClaim({
    workspaceId: args.workspaceId,
    approvalId: args.approvalId,
    workerId: WORKER_ID,
    reason: args.reason,
  });
  if (result.kind === 'lost') return { kind: 'lost' };
  return { kind: 'released' };
}

/**
 * PR-3.3 Replay Fix — expireApproval 也只做"决策登记"，**不**调 SDK。
 *
 * 行为：
 *   - 原子 UPDATE 把 `pending → expired`，resolver_id 写
 *     `system-approval-worker` 平台 UUID；同步清 lease。
 *   - WHERE 子句带 `expires_at < now()` —— 并发 race（race 后 resolver
 *     立即 approve / decline）会得到 `not_pending_yet`，原状态保留；
 *   - 不调 facade；worker (`runResumeSchedulerOnce`) 扫到
 *     `status='expired'` 后调 `facade.declineToolCall(reason='expired')`
 *     收尾 Run。
 *
 * 同一 (run_id, tool_call_id) 在一次决策中**最多**一次 SDK 调用——
 * worker 抢占后只调一次 facade，之后无论 stream 怎样都直接推 Run 终态。
 */
export type ExpireApprovalOutcome =
  | { kind: 'expired'; row: ApprovalRequestRow }
  | { kind: 'not_found' }
  | { kind: 'already_resolved'; currentStatus: string }
  | { kind: 'not_pending_yet' };

export async function expireApproval(args: {
  workspaceId: string;
  approvalId: string;
  leaseMs?: number;
}): Promise<ExpireApprovalOutcome> {
  void args.leaseMs; // 保留签名兼容；本路径不走 lease
  const resolverId = await getSystemResolverUserId();
  const result: ExpireApprovalResult = await repoExpire({
    workspaceId: args.workspaceId,
    approvalId: args.approvalId,
    resolverId,
    decision: 'declined', // 注：expire 路径写 status='expired'，decision 写 'declined'
  });
  if (result.kind === 'resolved') {
    return { kind: 'expired', row: result.row };
  }
  if (result.kind === 'not_found') return { kind: 'not_found' };
  if (result.kind === 'already_resolved') {
    return { kind: 'already_resolved', currentStatus: result.currentStatus };
  }
  if (result.kind === 'not_pending_yet') {
    return { kind: 'not_pending_yet' };
  }
  // 防御兜底
  return { kind: 'not_found' };
}

/**
 * 跨重启 / 进程崩溃后恢复（DB-only 防御路径）：扫描所有 inflight 行，
 * 对 lease 已过期的行尝试 DB-only 收敛为终态，**不**发起 SDK。
 *
 * 调用时机：backend 启动期（一次性）、以及周期 worker 的每次 tick。
 *
 * 行为契约：
 *   - lease_active → 跳过（其他 worker 仍在处理）；
 *   - not_inflight → 跳过（已被别的 worker 完成 / 已超时收敛）；
 *   - **不调 SDK**——若 approval 在 inflight 状态被 takeover，**只**做
 *     DB 推进（status='declined' / resolver_error=TAKEOVER_DB_ONLY），
 *     不再尝试 facade；worker 不会再次扫到 inflight（只扫三态终态），
 *     Run 保持 waiting_approval —— 由下次 reconcile 周期再观察。
 *
 * 实际上 PR-3.3 Replay Fix 下 inflight 不可达（state-machine 不写
 * 中间态），本函数保留仅为 schema 兜底。
 */
export interface ReconcileSummary {
  scanned: number;
  dbOnlyTakenOver: number;
  leaseActive: number;
  notInflight: number;
  errors: number;
}

export async function reconcileInflightApprovals(): Promise<ReconcileSummary> {
  const inflight = await listInflightApprovalRequests();
  const summary: ReconcileSummary = {
    scanned: inflight.length,
    dbOnlyTakenOver: 0,
    leaseActive: 0,
    notInflight: 0,
    errors: 0,
  };

  for (const row of inflight) {
    try {
      const claimed = await takeoverInflightLease(
        row.workspaceId,
        row.id,
        WORKER_ID,
        DEFAULT_LEASE_MS,
      );
      if (!claimed) {
        summary.leaseActive += 1;
        continue;
      }
      // DB-only 收敛：inflight + lease 过期时把 status 推到 'declined'，
      // resolver_error 标记为 takeover 路径；**不**调 facade。
      // 若 (run_id, tool_call_id) 对应的 Run 仍在 waiting_approval，
      // 状态机会让 Run → stopped + APPROAL_TLE_RECOVERED 由后续 Run
      // 检测。
      const pool = getDatabasePool();
      await pool.query(
        `UPDATE tool_approval_requests
            SET status = 'declined',
                resolver_error = COALESCE(resolver_error, 'TAKEOVER_DB_ONLY'),
                resolved_at = now(),
                updated_at = now(),
                lease_owner = NULL,
                lease_expires_at = NULL
          WHERE id = $1 AND workspace_id = $2
            AND status IN ('approving', 'declining')`,
        [row.id, row.workspaceId],
      );
      summary.dbOnlyTakenOver += 1;
    } catch (err) {
      summary.errors += 1;
      logger.error({
        msg: 'approval reconcile: 处理单行失败',
        approvalId: row.id,
        runId: row.runId,
        err,
      });
    }
  }

  return summary;
}

// Re-export for downstream modules / tests.
export { listInflightApprovalRequests } from './repository.js';
export { listExpiredPendingApprovals } from './repository.js';
export { getApprovalRequestById } from './repository.js';
export { createApprovalRequest } from './repository.js';
export { listPendingApprovalRequests } from './repository.js';
export { listApprovalsPendingResume } from './repository.js';
// PR-3.3 Replay Fix W2：reconciler 扫描 + 抢占 + 回滚 / 失败原语。
export {
  listApprovalsPendingReconcile,
  claimApprovalForReconcile,
  revertApprovalForReconcile,
  failApprovalReconcile,
} from './repository.js';
export { markApprovalResumeIndeterminate } from './repository.js';

// 兼容：保持 row 类型可访问。
export type { ApprovalRequestRow, ApprovalStatus };
export type { ResolveApprovalResult };

// 注意: `takeoverInflightApproval` 在 PR-3.3 Replay Fix 后**不再**对外
// 公开（state-machine 不写 inflight 中间态，takeover 不可达）。
// 防御性保留内部 helper 给 reconcileInflightApprovals 用；外部代码
// 不应直接调。如需接管应走 worker 路径。