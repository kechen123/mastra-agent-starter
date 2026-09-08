/**
 * Phase 3.1 — Tool Policy / Approval 共享类型。
 *
 * 本模块是"数据访问基础"，**不**包含任何 Mastra SDK 调用、
 * agent_runs 状态切换、SSE 事件写入或 Tool 执行逻辑。
 *
 * 来源约束：architecture-v2.md §7 决策（tool_approval_requests 表 +
 * status 枚举 / 单 Run 内同 tool_call_id 唯一）。审批恢复键为
 * `(run_id, tool_call_id)`——Mastra 1.61 公开 API 的
 * agent.approveToolCall / declineToolCall 仅接受 runId、
 * 可选 toolCallId、reason，**没有**独立可持久化的 suspension
 * token，因此本模块不保留 suspensionId 字段。
 */

export type ToolPolicyEffect = 'allow' | 'deny' | 'require_approval';

export const TOOL_POLICY_EFFECTS: readonly ToolPolicyEffect[] = [
  'allow',
  'deny',
  'require_approval',
] as const;

export type ApprovalStatus =
  | 'pending'
  | 'approving'
  | 'declining'
  | 'approved'
  | 'approved_resume_indeterminate'
  | 'declined'
  | 'expired';

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'pending',
  'approving',
  'declining',
  'approved',
  'approved_resume_indeterminate',
  'declined',
  'expired',
] as const;

/** 可恢复动作状态机的"中间态"：Mastra SDK 调用进行中。 */
export const APPROVAL_INFLIGHT_STATUSES: readonly ApprovalStatus[] = [
  'approving',
  'declining',
] as const;

/** 终态：Mastra SDK 调用已结束（成功或被超时收敛）。 */
export const APPROVAL_TERMINAL_STATUSES: readonly ApprovalStatus[] = [
  'approved',
  'declined',
  'expired',
] as const;

export interface ToolPolicyRuleRow {
  id: string;
  workspaceId: string;
  toolId: string;
  effect: ToolPolicyEffect;
  conditions: unknown;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequestRow {
  id: string;
  workspaceId: string;
  runId: string;
  toolId: string;
  toolCallId: string;
  inputsHash: string;
  /** 已脱敏的 JSON 摘要；Repository 不存原始敏感输入。 */
  inputsSummary: unknown;
  status: ApprovalStatus;
  /**
   * 请求发起者：人类用户或 system-initiated。
   * PR-3.3 — NOT NULL FK → app_users(id)。system-initiated 路径走
   * `system-approval-worker` 预设用户 UUID；正常路径由 agent_runs.created_by
   * 注入。
   */
  requesterId: string;
  resolverId: string;
  /**
   * 抢占时即写入的"本次决策意图"——'approved' | 'declined'。
   * 让后续重试 / 跨重启恢复路径不再依赖外部信号。
   */
  decision: 'approved' | 'declined' | null;
  /** SDK 调用失败原因（最后一次）。 */
  resolverError: string | null;
  /** Mastra SDK 调用边界时间戳，用于"调用挂起"检测。 */
  mastraCallStartedAt: string | null;
  mastraCallCompletedAt: string | null;
  /**
   * PR-3.3 — Mastra SDK 已发起 resume 的边界时间戳；run executor 据此
   * 区分"已批准待续 Run"与"已批准 resume 已接管"。一旦写过，executor
   * 不再重复进入 streamAgent，避免双 resume。
   *
   * Replay Fix W2：approve SDK 抛错时**保留** `mastra_resume_started_at`
   * 不清——避免 scheduler 立即重新扫描再调一次 SDK；reconciler 在
   * listSuspendedRuns 确认仍 suspended 后才清。
   */
  mastraResumeStartedAt: string | null;
  /**
   * PR-3.3 Replay Fix W2：approve resume 失败次数。`consumeResumeStream`
   * 在 facade.approveToolCall 抛错时原子写入。每次 W2 事件 +1；
   * reconciler 扫描条件 `resume_attempts < MAX_RESUME_ATTEMPTS`。
   * 达上限后由 `failApprovalReconcile` 转人工介入。
   */
  resumeAttempts: number;
  /** 抢占 lease——中间态运行；终态时清空。 */
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface CreateApprovalRequestInput {
  workspaceId: string;
  runId: string;
  toolId: string;
  toolCallId: string;
  inputsHash: string;
  /** 已脱敏 JSON；Repository 直接 JSON.stringify 入库，不做内容裁剪。 */
  inputsSummary: unknown;
  /**
   * 请求发起者：人类用户 id。PR-3.3 — 必填非空（schema NOT NULL FK）。
   * system-initiated 路径走 `system-approval-worker` 预设用户 UUID；
   * 正常路径由 agent_runs.created_by 注入。agent_runs.created_by 为 NULL
   * 时 Repository 拒绝创建审批。
   */
  requesterId: string;
  /**
   * PR-3.3 — 初始 resolver_id（NOT NULL FK）。缺省 = requesterId（业务
   * 语义：发起者 = 终结者候选）。resolveApproval 由真正决策者覆盖。
   * system-initiated 路径传 `system-approval-worker` 用户 UUID。
   */
  resolverId?: string;
  expiresAt: string;
}

/**
 * 原子 resolve 的三态结果。设计要点：
 *   - 'not_found'：id 在该 workspace 下不存在；后续 HTTP 层映射为 404，
 *     不暴露"跨 workspace 存在但被隔离"的事实，避免越权嗅探；
 *   - 'already_resolved'：行存在但 status ≠ 'pending'；
 *     后续 HTTP 层映射为 409（已被处理）；
 *   - 'resolved'：本次 UPDATE 实际更新了 1 行，附 updated row。
 */
export type ResolveApprovalResult =
  | { kind: 'resolved'; row: ApprovalRequestRow }
  | { kind: 'not_found' }
  | { kind: 'already_resolved'; currentStatus: ApprovalStatus }
  | { kind: 'not_pending_yet'; currentStatus: ApprovalStatus };

export interface ResolveApprovalInput {
  workspaceId: string;
  /** 由 PG gen_random_uuid() 生成。 */
  approvalId: string;
  resolverId: string;
  /** 仅允许 'approved' | 'declined'；'expired' 由超时 worker 写。 */
  decision: Exclude<ApprovalStatus, 'pending' | 'approving' | 'declining' | 'expired'>;
}

/**
 * claimResolveApproval 的入参——进入中间态（approving / declining）
 * 时的抢占条件。
 *
 * leaseMs：与 agent_runs.lease_expires_at 协议一致（默认 60s + 心跳）。
 * workerId：抢占者身份标识；后续心跳与超时 worker 都用它判断。
 */
export interface ClaimResolveApprovalInput {
  workspaceId: string;
  approvalId: string;
  resolverId: string;
  decision: 'approved' | 'declined';
  leaseMs: number;
  workerId: string;
}

export type ClaimResolveApprovalResult =
  | { kind: 'claimed'; row: ApprovalRequestRow }
  | { kind: 'not_found' }
  | { kind: 'already_resolved'; currentStatus: ApprovalStatus }
  | { kind: 'lease_contended'; currentLeaseOwner: string | null };

/**
 * 标记 SDK 调用已完成的入参；本字段在 DB 与 Mastra Storage 不在同一
 * 事务的前提下，承载"恢复消费已启动"的事实。
 *
 * `mastraCallCompletedAt` 由 caller 写入；Repository 不再另起事务。
 */
export interface MarkInflightDoneInput {
  workspaceId: string;
  approvalId: string;
  workerId: string;
  /** 终态：'approved' | 'declined' | 'expired'。 */
  finalStatus: 'approved' | 'declined' | 'expired';
  /** SDK 调用失败原因（仅在 'declined' / 'expired' 终态下有意义；'approved' 一般为 null）。 */
  resolverError?: string | null;
  /**
   * PR-3.3 — SDK 调用失败时**保留中间态**模式。开启后：
   *   - 不会把 status 推到 finalStatus；
   *   - 仅写 `resolver_error` + `mastra_call_started_at = NULL`（清掉调用
   *     起点，让 lease 超时后能被 reconcile 接走重试）；
   *   - `resolved_at` 不写；
   *   - 仅当 status 仍为 'approving' / 'declining' 时允许 UPDATE。
   *
   * 默认 false——只有 state-machine 在 SDK 抛 transient error 时才置 true。
   */
  preserveOnError?: boolean;
}

export type MarkInflightDoneResult =
  | { kind: 'updated'; row: ApprovalRequestRow }
  | { kind: 'not_found' }
  | { kind: 'lease_lost'; currentStatus: ApprovalStatus }
  | { kind: 'unexpected_status'; currentStatus: ApprovalStatus };

/**
 * 抢占进入中间态后，失败回滚：把状态机退回 pending。
 *
 * 用途：claim 后、写 mastra_call_started_at 之前失败；或 claim 后 SDK
 * 调用前的轻错误；不要在 SDK 调用开始后调本函数——SDK 调用挂起时让
 * lease 自然超时即可。
 */
export interface ReleaseClaimInput {
  workspaceId: string;
  approvalId: string;
  workerId: string;
  reason: string;
}