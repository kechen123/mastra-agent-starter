/**
 * Tool Policy / Approval Repository（数据访问层）。
 *
 * 约束：
 *   - 所有 SQL 走参数化（pg 占位符 $N），不拼接字符串；
 *   - 全部读取都强制 workspace_id 过滤；跨 workspace 读取在本层
 *     即返回 null / not_found，让上游 HTTP 层能统一映射为 404；
 *   - 原子 resolve 走"UPDATE ... WHERE id=$1 AND workspace_id=$2
 *     AND status='pending'"条件，1 行 / 0 行可区分；0 行时再用一次
 *     SELECT（带同样 workspace 过滤）判定 not_found vs already_resolved；
 *   - inputs_summary 仅接收"已脱敏"的 JSON；Repository 不记录原始
 *     敏感输入，不打印 raw inputs；本层不调用 Mastra SDK / 不写 SSE
 *     事件 / 不切换 agent_runs.status / 不执行 Tool——这些动作属于
 *     PR-3.3 状态机（state-machine.ts）和 Tool Gateway。
 *
 * PR-3.3.0 扩展：可恢复动作状态机。
 *   - 新增 `claimResolveApproval` / `releaseClaim` / `markInflightDone`
 *     / `heartbeatApprovalLease` 四个原语，构成"中间态抢占 → SDK
 *     调用 → 收敛为终态"的最小闭环；
 *   - 终态切换仍用条件 UPDATE 保留（`status IN ('pending',
 *     'approving','declining')`），保证不会把已 finalized 的行
 *     重新写一遍；
 *   - 所有抢占都受 lease_owner / lease_expires_at 约束：抢占条件
 *     UPDATE 会拒绝 lease 已被别人持有的行。
 */
import type { Pool, PoolClient } from 'pg';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import {
  type ApprovalRequestRow,
  type ApprovalStatus,
  type ClaimResolveApprovalInput,
  type ClaimResolveApprovalResult,
  type CreateApprovalRequestInput,
  type MarkInflightDoneInput,
  type MarkInflightDoneResult,
  type ReleaseClaimInput,
  type ResolveApprovalInput,
  type ResolveApprovalResult,
  type ToolPolicyRuleRow,
} from './types.js';

// PR-3.3.2 Hard-Crash Sweeper 已迁移到 `core/execution/approval-resume-
// recovery.ts` —— 跨 tool_approval_requests / agent_runs / messages /
// agent_run_events 的 orchestration 不属于本 Repository 层。Repository
// 仅暴露纯 tool_approval_requests 行级原语（接受 PoolClient；不读 Tool
// 注册表、不写 agent_runs / messages / agent_run_events、不决定 Run 终态）。
// 旧导出名 `sweepExpiredApprovalResumeLeases` / `SweepApprovalResumeResult`
// / `SweepApprovalResumeOptions` 由 `modules/tool-policy/index.ts` re-export
// 自 execution 层以保持旧 import 路径兼容。

const APPROVAL_COLUMNS = `id, workspace_id, run_id, tool_id, tool_call_id,
  inputs_hash, inputs_summary, status, requester_id, resolver_id,
  decision, resolver_error,
  mastra_call_started_at, mastra_call_completed_at, mastra_resume_started_at,
  resume_attempts,
  lease_owner, lease_expires_at,
  expires_at, created_at, resolved_at`;

const POLICY_COLUMNS = `id, workspace_id, tool_id, effect, conditions,
  created_by, created_at, updated_at`;

function rowToApproval(row: Record<string, unknown>): ApprovalRequestRow {
  const requesterId = row.requester_id as string | null;
  const resolverId = row.resolver_id as string | null;
  // PR-3.3 — requesterId / resolverId 必填（NOT NULL FK）。任何 null
  // 都视为 schema 不一致（说明有路径绕过了 NOT NULL 校验）；抛错
  // 避免上层误以为是"待填"。
  if (!requesterId) {
    throw new Error(
      `rowToApproval: requester_id 为 NULL (row=${row.id})；违反 NOT NULL FK。`,
    );
  }
  // resolverId 在 claim 之前可能为 NULL（业务上：pending 时还没人接）。
  // 这种情况由 rowToApproval 的调用方按 row.status 判断；类型上
  // ApprovalRequestRow.resolverId 是 string，pending 行不会被 state-machine
  // 路径查询。state-machine 查到的都是已 claim / 已 finalize 的行。
  // 为兼容 SELECT 整张表（含 pending 行）的边界，resolverId 缺失
  // 时返回空字符串 + 让调用方按 status 区分。
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    runId: row.run_id as string,
    toolId: row.tool_id as string,
    toolCallId: row.tool_call_id as string,
    inputsHash: row.inputs_hash as string,
    inputsSummary: row.inputs_summary ?? {},
    status: row.status as ApprovalStatus,
    requesterId,
    resolverId: resolverId ?? '',
    decision: (row.decision as 'approved' | 'declined' | null) ?? null,
    resolverError: (row.resolver_error as string | null) ?? null,
    mastraCallStartedAt: row.mastra_call_started_at
      ? new Date(row.mastra_call_started_at as string).toISOString()
      : null,
    mastraCallCompletedAt: row.mastra_call_completed_at
      ? new Date(row.mastra_call_completed_at as string).toISOString()
      : null,
    mastraResumeStartedAt: row.mastra_resume_started_at
      ? new Date(row.mastra_resume_started_at as string).toISOString()
      : null,
    resumeAttempts: (row.resume_attempts as number | null | undefined) ?? 0,
    leaseOwner: (row.lease_owner as string | null) ?? null,
    leaseExpiresAt: row.lease_expires_at
      ? new Date(row.lease_expires_at as string).toISOString()
      : null,
    expiresAt: new Date(row.expires_at as string).toISOString(),
    createdAt: new Date(row.created_at as string).toISOString(),
    resolvedAt: row.resolved_at
      ? new Date(row.resolved_at as string).toISOString()
      : null,
  };
}

function rowToPolicy(row: Record<string, unknown>): ToolPolicyRuleRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    toolId: row.tool_id as string,
    effect: row.effect as ToolPolicyRuleRow['effect'],
    conditions: row.conditions ?? {},
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

/**
 * 创建一个 `pending` 的审批请求。
 *
 * 唯一性约束由 DB 兜底：
 *   - UNIQUE(run_id, tool_call_id)
 * 重复 INSERT 会抛 PG 23505 unique_violation；上层（PR-3.3 续 Run）
 * 必须据此决定是返回已存在的 row 还是拒绝重试。
 *
 * 审批恢复键为 `(run_id, tool_call_id)`——对齐 Mastra 1.61
 * `agent.approveToolCall({ runId, toolCallId })` 的入参；
 * 不存在独立可持久化的 suspension token。
 *
 * PR-3.3 — `requesterId` 必须非空。正常业务路径由 `agent_runs.created_by`
 * 注入；system-initiated 路径（如超时 worker / 续 Run）由调用方主动传
 * `system-approval-worker` 真实 UUID 入参，**不**允许传 null 写库。
 */
export async function createApprovalRequest(
  input: CreateApprovalRequestInput,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ApprovalRequestRow> {
  if (!input.requesterId) {
    throw new Error(
      'createApprovalRequest: requesterId 必填；agent_runs.created_by 为 NULL 时必须拒绝创建审批，' +
        '禁止传 null 让 PG 写 NULL 进 requester_id。',
    );
  }
  // PR-3.3 — resolver_id 也是 NOT NULL FK（schema 阶段 3.3 段）。
  // 业务语义：发起者（requester）即终结者（resolver）的初始候选——
  // 创建时 resolver_id 写入 requester_id；后续 resolveApproval 由真正
  // 决策者覆盖。system-initiated 路径同样由 `system-approval-worker`
  // 预设用户 UUID 占位（resolveApproval 时覆盖）。
  const initialResolverId = input.resolverId ?? input.requesterId;
  const r = await executor.query<Record<string, unknown>>(
    `INSERT INTO tool_approval_requests (
       workspace_id, run_id, tool_id, tool_call_id,
       inputs_hash, inputs_summary, status,
       requester_id, resolver_id, expires_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6::jsonb, 'pending',
       $7::uuid, $8::uuid, $9
     )
     RETURNING ${APPROVAL_COLUMNS}`,
    [
      input.workspaceId,
      input.runId,
      input.toolId,
      input.toolCallId,
      input.inputsHash,
      JSON.stringify(input.inputsSummary ?? {}),
      input.requesterId,
      initialResolverId,
      input.expiresAt,
    ],
  );
  return rowToApproval(r.rows[0]!);
}

/**
 * 按 (workspace_id, id) 读取审批请求。命中本 workspace 才返回 row，
 * 跨 workspace 一律返回 null（不抛错；让上游 HTTP 层映射为 404，
 * 避免越权嗅探 row 是否存在）。
 */
export async function getApprovalRequestById(
  workspaceId: string,
  approvalId: string,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ApprovalRequestRow | null> {
  const r = await executor.query<Record<string, unknown>>(
    `SELECT ${APPROVAL_COLUMNS}
       FROM tool_approval_requests
      WHERE id = $1 AND workspace_id = $2`,
    [approvalId, workspaceId],
  );
  const row = r.rows[0];
  return row ? rowToApproval(row) : null;
}

/**
 * 列出当前 workspace 内所有 pending 审批。
 *
 * Phase 3.1 仅暴露"列表 / 按 ID 读 / resolve"三个最小动作；
 * 后续 PR-3.3 的"过滤 / 分页 / 排序"在本阶段不实现。
 */
export async function listPendingApprovalRequests(
  workspaceId: string,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ApprovalRequestRow[]> {
  const r = await executor.query<Record<string, unknown>>(
    `SELECT ${APPROVAL_COLUMNS}
       FROM tool_approval_requests
      WHERE workspace_id = $1 AND status = 'pending'
      ORDER BY created_at ASC`,
    [workspaceId],
  );
  return r.rows.map(rowToApproval);
}

/**
 * PR-3.3 — 原子 resolve：从 `pending` 直接落到终态 `approved` /
 * `declined`，**不**经过中间态，**不**调 Mastra SDK。
 *
 * 业务语义（PR-3.3 Replay Fix）：
 *   - state-machine 的 resolve 路径只负责"决策登记"（pending → 终态 +
 *     resolver_id + resolved_at）；
 *   - **不**调用 facade.approveToolCall / facade.declineToolCall；SDK 调用
 *     由 worker（`runResumeSchedulerOnce`）作为唯一执行者发起。
 *
 * 实现细节：
 *   - 保留 `WHERE status='pending'` 条件；
 *   - 0 行更新时再做一次 SELECT 区分 not_found vs already_resolved；
 *   - SELECT 与 UPDATE 共用一个 Pool 连接（PG 同一连接的 read-your-writes
 *     语义保证），无竞态。
 */
export async function resolveApprovalRequest(
  input: ResolveApprovalInput,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ResolveApprovalResult> {
  const r = await executor.query<Record<string, unknown>>(
    `UPDATE tool_approval_requests
        SET status = $3,
            decision = $3,
            resolver_id = $4,
            resolver_error = NULL,
            resolved_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            mastra_call_started_at = NULL,
            mastra_call_completed_at = now(),
            updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND status = 'pending'
      RETURNING ${APPROVAL_COLUMNS}`,
    [input.approvalId, input.workspaceId, input.decision, input.resolverId],
  );
  const updated = r.rows[0];
  if (updated) {
    return { kind: 'resolved', row: rowToApproval(updated) };
  }
  const lookup = await executor.query<{ status: ApprovalStatus }>(
    `SELECT status FROM tool_approval_requests
      WHERE id = $1 AND workspace_id = $2`,
    [input.approvalId, input.workspaceId],
  );
  const current = lookup.rows[0];
  if (!current) return { kind: 'not_found' };
  return { kind: 'already_resolved', currentStatus: current.status };
}

/**
 * PR-3.3 — 原子 expire：从 `pending` 直接落到终态 `expired`，resolver_id
 * 必须是 `system-approval-worker` 平台用户 UUID。
 *
 * 语义：超时 worker 推 `expired` 时**不**调 facade（worker 会随后调
 * `facade.declineToolCall(reason='expired')` 收尾 Run）。
 *
 * 附加约束：`expires_at < now()` 才允许 expire——避免并发 race（race
 * 后 resolver 立即 approve / decline）。
 */
export type ExpireApprovalResult =
  | { kind: 'resolved'; row: ApprovalRequestRow }
  | { kind: 'not_found' }
  | { kind: 'already_resolved'; currentStatus: ApprovalStatus }
  | { kind: 'not_pending_yet'; currentStatus: ApprovalStatus };

export async function expireApprovalRequest(
  input: ResolveApprovalInput,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ExpireApprovalResult> {
  const r = await executor.query<Record<string, unknown>>(
    `UPDATE tool_approval_requests
        SET status = 'expired',
            decision = 'declined',
            resolver_id = $3,
            resolver_error = NULL,
            resolved_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            mastra_call_started_at = NULL,
            mastra_call_completed_at = now(),
            updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND status = 'pending'
        AND expires_at < now()
      RETURNING ${APPROVAL_COLUMNS}`,
    [input.approvalId, input.workspaceId, input.resolverId],
  );
  const updated = r.rows[0];
  if (updated) {
    return { kind: 'resolved', row: rowToApproval(updated) };
  }
  const lookup = await executor.query<{ status: ApprovalStatus }>(
    `SELECT status FROM tool_approval_requests
      WHERE id = $1 AND workspace_id = $2`,
    [input.approvalId, input.workspaceId],
  );
  const current = lookup.rows[0];
  if (!current) return { kind: 'not_found' };
  if (current.status !== 'pending') {
    return { kind: 'already_resolved', currentStatus: current.status };
  }
  // status='pending' 但 expires_at 未到：特殊早退——state-machine 把它映射为
  // `not_pending_yet`。
  return { kind: 'not_pending_yet', currentStatus: current.status };
}

/**
 * PR-3.3 — 列出"决策已收敛、resume 尚未由 run executor 接管"的审批。
 *
 * 覆盖三种终态：approved / declined / expired。worker 对三者走同一
 * `consumeResumeStream` 路径——按 status 选 facade 调用：
 *   - approved    → facade.approveToolCall
 *   - declined    → facade.declineToolCall(reason = resolver_error || 'declined_by_resolver')
 *   - expired     → facade.declineToolCall(reason = 'expired')
 *
 * 不带 workspace 过滤——executor 调度器是平台层作业。
 */
export async function listApprovalsPendingResume(
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ApprovalRequestRow[]> {
  const r = await executor.query<Record<string, unknown>>(
    `SELECT ${APPROVAL_COLUMNS}
       FROM tool_approval_requests
      WHERE status IN ('approved', 'declined', 'expired')
        AND mastra_resume_started_at IS NULL
      ORDER BY resolved_at ASC`,
  );
  return r.rows.map(rowToApproval);
}

/**
 * 列出所有 inflight（approving / declining）的审批——给超时 worker 用。
 * **不**做 workspace 过滤：超时 worker 是平台层作业，需要跨 Workspace
 * 扫描。
 */
export async function listInflightApprovalRequests(
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ApprovalRequestRow[]> {
  const r = await executor.query<Record<string, unknown>>(
    `SELECT ${APPROVAL_COLUMNS}
       FROM tool_approval_requests
      WHERE status IN ('approving', 'declining')
      ORDER BY created_at ASC`,
  );
  return r.rows.map(rowToApproval);
}

/**
 * 列出所有 pending 且 expires_at < now 的审批——给超时 worker 触发
 * 收敛（先转 expired 再 attempt 调用 Mastra declineToolCall）。
 * **不**做 workspace 过滤：超时 worker 是平台层作业。
 */
export async function listExpiredPendingApprovals(
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ApprovalRequestRow[]> {
  const r = await executor.query<Record<string, unknown>>(
    `SELECT ${APPROVAL_COLUMNS}
       FROM tool_approval_requests
      WHERE status = 'pending' AND expires_at < now()
      ORDER BY expires_at ASC`,
  );
  return r.rows.map(rowToApproval);
}

/**
 * 抢占进入中间态（approving / declining）：
 *   - 条件 1：status='pending' AND (lease_owner IS NULL OR lease_expires_at < now())
 *   - 条件 2：同 workspace；
 *   - 写入 decision / resolver_id / lease_owner / lease_expires_at；
 *   - 同步把 status 推进到对应中间态（'approving' | 'declining'）。
 *
 * 单飞约束由部分唯一索引
 *   `tool_approval_requests_run_tool_call_inflight_unique`
 * （status IN ('approving','declining')）兜底：两个并发 claim 只能
 * 一个更新成功，另一个走 0 行分支。
 */
export async function claimResolveApproval(
  input: ClaimResolveApprovalInput,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ClaimResolveApprovalResult> {
  const inflightStatus = input.decision === 'approved' ? 'approving' : 'declining';
  const r = await executor.query<Record<string, unknown>>(
    `UPDATE tool_approval_requests
        SET status            = $3,
            decision          = $4,
            resolver_id       = $5,
            lease_owner       = $6,
            lease_expires_at  = now() + ($7::int * INTERVAL '1 millisecond'),
            updated_at        = now()
      WHERE id = $1
        AND workspace_id = $2
        AND status = 'pending'
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
      RETURNING ${APPROVAL_COLUMNS}`,
    [
      input.approvalId,
      input.workspaceId,
      inflightStatus,
      input.decision,
      input.resolverId,
      input.workerId,
      input.leaseMs,
    ],
  );
  const updated = r.rows[0];
  if (updated) return { kind: 'claimed', row: rowToApproval(updated) };

  // 0 行：在 caller 事务 / 连接上回读（同 workspace 过滤）区分
  // not_found / already_resolved / lease_contended。
  const lookup = await executor.query<{
    status: ApprovalStatus;
    lease_owner: string | null;
  }>(
    `SELECT status, lease_owner FROM tool_approval_requests
      WHERE id = $1 AND workspace_id = $2`,
    [input.approvalId, input.workspaceId],
  );
  const current = lookup.rows[0];
  if (!current) return { kind: 'not_found' };
  if (current.status !== 'pending') {
    return { kind: 'already_resolved', currentStatus: current.status };
  }
  // status='pending' 但 0 行更新：说明 lease 被另一 worker 持有。
  return { kind: 'lease_contended', currentLeaseOwner: current.lease_owner };
}

/**
 * 抢占后写 SDK 调用"开始"边界：mastra_call_started_at = now()。
 *
 * 条件：仍由本 worker 持有 lease。0 行 = lease 已丢（别的 worker 已
 * 抢占回来）或状态已被改。出错时由上层决定 abort 与不终止 Mastra
 * 调用（既然本 worker 失去 lease，对应 SDK 调用应被视为 no-op）。
 */
export async function markMastraCallStarted(
  workspaceId: string,
  approvalId: string,
  workerId: string,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ApprovalRequestRow | null> {
  const r = await executor.query<Record<string, unknown>>(
    `UPDATE tool_approval_requests
        SET mastra_call_started_at = now(),
            updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND lease_owner = $3
        AND status IN ('approving', 'declining')
      RETURNING ${APPROVAL_COLUMNS}`,
    [approvalId, workspaceId, workerId],
  );
  const updated = r.rows[0];
  return updated ? rowToApproval(updated) : null;
}

/**
 * SDK 调用失败 / claim 后失败 → 把中间态回滚为 pending，让其它 worker
 * 可再次抢占。
 *
 * 注意：调用方**必须**保证未真正发起 Mastra SDK 调用；本函数用于
 * claim 成功但未进入 SDK 调用之前的回滚场景。一旦
 * `markMastraCallStarted` 已写过，**不**应再调本函数——SDK 调用可能
 * 已在进行；让 lease 自然超时即可。
 *
 * PR-3.3 修订：**不**把 `resolver_id` 写 NULL ——保留原决策者的审计
 * 身份。状态退回 pending 后另一 worker 可再次 claim；`decision` 字段
 * 也保留——它是 claim 时记录的，与 resolver_id 强相关。
 */
export async function releaseClaim(
  input: ReleaseClaimInput,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<{ kind: 'released'; row: ApprovalRequestRow } | { kind: 'lost' }> {
  const r = await executor.query<Record<string, unknown>>(
    `UPDATE tool_approval_requests
        SET status            = 'pending',
            resolver_error    = $4,
            lease_owner       = NULL,
            lease_expires_at  = NULL,
            mastra_call_started_at   = NULL,
            mastra_call_completed_at = NULL,
            updated_at        = now()
      WHERE id = $1
        AND workspace_id = $2
        AND lease_owner = $3
        AND status IN ('approving', 'declining')
        AND mastra_call_started_at IS NULL
      RETURNING ${APPROVAL_COLUMNS}`,
    [input.approvalId, input.workspaceId, input.workerId, input.reason],
  );
  const updated = r.rows[0];
  if (!updated) return { kind: 'lost' };
  return { kind: 'released', row: rowToApproval(updated) };
}

/**
 * SDK 调用完成（成功或失败）→ 把中间态推到终态：
 *   - 写 `mastra_call_completed_at = now()`；
 *   - 写 `resolved_at`；
 *   - 写 `resolver_error`（如失败）；
 *   - 清 lease；
 *   - 仅当本 worker 仍持有 lease 且仍处于中间态时才允许 UPDATE。
 *
 * 不允许从 'pending' 直接到终态——任何写终态都要求先 claim 走过中间态。
 *
 * PR-3.3 — preserveOnError 模式：当 SDK 调用抛 transient error（网络 /
 * 超时 / 5xx），state-machine 会传 `preserveOnError: true` ——本函数
 * **不**推 status 到 finalStatus，仅写 `resolver_error` 并清
 * `mastra_call_started_at` 触发 lease 过期 → reconcile 接走重试。
 *
 * 双轨语义：
 *   - preserveOnError=false → 终态（'approved' | 'declined' | 'expired'）；
 *   - preserveOnError=true  → 保留中间态，lease 自然超时后由 reconcile 接管。
 */
export async function markInflightDone(
  input: MarkInflightDoneInput,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<MarkInflightDoneResult> {
  if (input.preserveOnError) {
    // 保留中间态：仅写 resolver_error + 清 mastra_call_started_at。
    const r = await executor.query<Record<string, unknown>>(
      `UPDATE tool_approval_requests
          SET resolver_error          = $3,
              mastra_call_started_at = NULL,
              mastra_call_completed_at = NULL,
              lease_expires_at        = now(),
              updated_at              = now()
        WHERE id = $1
          AND workspace_id = $2
          AND lease_owner = $4
          AND status IN ('approving', 'declining')
        RETURNING ${APPROVAL_COLUMNS}`,
      [
        input.approvalId,
        input.workspaceId,
        input.resolverError ?? null,
        input.workerId,
      ],
    );
    const updated = r.rows[0];
    if (updated) return { kind: 'updated', row: rowToApproval(updated) };
    const lookup = await executor.query<{ status: ApprovalStatus }>(
      `SELECT status FROM tool_approval_requests
        WHERE id = $1 AND workspace_id = $2`,
      [input.approvalId, input.workspaceId],
    );
    const current = lookup.rows[0];
    if (!current) return { kind: 'not_found' };
    if (current.status === 'approving' || current.status === 'declining') {
      return { kind: 'lease_lost', currentStatus: current.status };
    }
    return { kind: 'unexpected_status', currentStatus: current.status };
  }

  const r = await executor.query<Record<string, unknown>>(
    `UPDATE tool_approval_requests
        SET status                  = $3,
            resolver_error          = $4,
            mastra_call_completed_at = now(),
            resolved_at             = now(),
            lease_owner             = NULL,
            lease_expires_at        = NULL,
            updated_at              = now()
      WHERE id = $1
        AND workspace_id = $2
        AND lease_owner = $5
        AND status IN ('approving', 'declining')
      RETURNING ${APPROVAL_COLUMNS}`,
    [
      input.approvalId,
      input.workspaceId,
      input.finalStatus,
      input.resolverError ?? null,
      input.workerId,
    ],
  );
  const updated = r.rows[0];
  if (updated) return { kind: 'updated', row: rowToApproval(updated) };

  // 0 行：诊断到底是 lease_lost 还是 unexpected_status。
  const lookup = await executor.query<{ status: ApprovalStatus }>(
    `SELECT status FROM tool_approval_requests
      WHERE id = $1 AND workspace_id = $2`,
    [input.approvalId, input.workspaceId],
  );
  const current = lookup.rows[0];
  if (!current) return { kind: 'not_found' };
  if (current.status === 'approving' || current.status === 'declining') {
    // 仍 inflight 但 lease 已被抢走（workerId 不匹配）。
    return { kind: 'lease_lost', currentStatus: current.status };
  }
  return { kind: 'unexpected_status', currentStatus: current.status };
}

/**
 * 心跳续约中间态 lease——仅当本 worker 持有 lease 时续约成功。
 */
export async function heartbeatApprovalLease(
  workspaceId: string,
  approvalId: string,
  workerId: string,
  leaseMs: number,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<boolean> {
  const r = await executor.query(
    `UPDATE tool_approval_requests
        SET lease_expires_at = greatest(
              COALESCE(lease_expires_at, now()),
              now() + ($4::int * INTERVAL '1 millisecond')
            ),
            updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND lease_owner = $3
        AND status IN ('approving', 'declining')`,
    [approvalId, workspaceId, workerId, leaseMs],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * PR-3.3 Replay Fix — `markMastraResumeStarted` 已弃用。
 *
 * run executor 已**改为内联 SQL** 在单一原子事务里
 * 写 `mastra_resume_started_at` + 推 `agent_runs` waiting_approval →
 * running + INSERT run-resumed 事件；因此 `markMastraResumeStarted`
 * 不再被 production 代码调用。新逻辑见
 * `core/execution/run-executor.ts::resumeAwaitingRunsOnce`。
 */

/**
 * 跨重启 / 接管式 claim——与 `claimResolveApproval` 不同，本函数
 * 保留既有 decision / resolver_id / status，仅替换 lease_owner /
 * lease_expires_at，让新 worker 接续原 SDK 调用（典型场景：lease
 * 已过期，原 worker 已死，恢复 worker 接管）。
 *
 * 条件：status IN ('approving','declining') 且 lease 已过期或 NULL。
 * 0 行 = 已被另一 worker 接管。
 */
export async function takeoverInflightLease(
  workspaceId: string,
  approvalId: string,
  workerId: string,
  leaseMs: number,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ApprovalRequestRow | null> {
  const r = await executor.query<Record<string, unknown>>(
    `UPDATE tool_approval_requests
        SET lease_owner             = $3,
            lease_expires_at        = now() + ($4::int * INTERVAL '1 millisecond'),
            resolver_error          = COALESCE(resolver_error, 'TAKEOVER_FROM_LEASE_EXPIRED'),
            mastra_resume_started_at= COALESCE(mastra_resume_started_at, now()),
            updated_at              = now()
      WHERE id = $1
        AND workspace_id = $2
        AND status IN ('approving', 'declining')
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      RETURNING ${APPROVAL_COLUMNS}`,
    [approvalId, workspaceId, workerId, leaseMs],
  );
  const updated = r.rows[0];
  return updated ? rowToApproval(updated) : null;
}

// ────────────────────────────────────────────────────────────────────
// PR-3.3 Replay Fix W2 — approve SDK 调用结果不确定窗口。
//
// 触发点：`consumeResumeStream` 调 `facade.approveToolCall` 抛错。
// 该异常属于"调用结果不确定"窗口——可能未发起、可能 SDK 已执行但
// stream 未返回。任何"立即写 Run → failed"或"盲目重试"都会导致
// 双重执行风险。本模块负责：
//   1. `markApprovalResumeIndeterminate` 把 status 推到
//      `approved_resume_indeterminate`（中间态），resume_attempts
//      += 1，写 resolver_error 保留诊断；**保留**
//      `mastra_resume_started_at` 阻止 scheduler 立即重扫再调 SDK；
//   2. `listApprovalsPendingReconcile` 给 reconciler 扫描用；
//   3. `claimApprovalForReconcile` reconciler 抢占 lease；
//   4. `revertApprovalForReconcile` 校验通过后转回 'approved' +
//      清 mastra_resume_started_at，让 scheduler 自然接管；
//   5. `failApprovalReconcile` 校验失败 / 人工介入终态——保留
//      indeterminate + 写明确人工介入错误，**不**清
//      mastra_resume_started_at（运维已无法通过自动恢复推进 Run）。
//
// 全部 5 个原语**纯 DB**：不调 Mastra SDK、不写 agent_runs.status、
// 不发 SSE；这些副作用由 run-executor 组合。
// ────────────────────────────────────────────────────────────────────

export interface MarkApprovalResumeIndeterminateInput {
  workspaceId: string;
  approvalId: string;
  resolverError: string;
  /** 下次 reconciler 可扫描时间（典型 30_000ms backoff）。 */
  backoffMs: number;
}

export type MarkApprovalResumeIndeterminateResult =
  | { kind: 'marked'; row: ApprovalRequestRow }
  | { kind: 'not_found' }
  | { kind: 'unexpected_status'; currentStatus: ApprovalStatus };

/**
 * W2 路径：把 `status='approved' AND mastra_resume_started_at NOT NULL`
 * 的行原子推到 `approved_resume_indeterminate`，resume_attempts += 1，
 * 清 lease_owner，lease_expires_at 设为 `now() + backoffMs`。
 *
 * **不**清 `mastra_resume_started_at`——scheduler 扫描条件是
 * `status IN ('approved','declined','expired') AND mastra_resume_started_at
 * IS NULL`，本函数把 status 推到 `approved_resume_indeterminate`
 * 即从 scheduler 扫描集中移除，不会被双重调用。
 */
export async function markApprovalResumeIndeterminate(
  input: MarkApprovalResumeIndeterminateInput,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<MarkApprovalResumeIndeterminateResult> {
  const r = await executor.query<Record<string, unknown>>(
    `UPDATE tool_approval_requests
        SET status          = 'approved_resume_indeterminate',
            resume_attempts = resume_attempts + 1,
            resolver_error  = $3,
            lease_owner     = NULL,
            lease_expires_at= now() + ($4::int * INTERVAL '1 millisecond'),
            updated_at      = now()
      WHERE id = $1
        AND workspace_id = $2
        AND status = 'approved'
        AND mastra_resume_started_at IS NOT NULL
      RETURNING ${APPROVAL_COLUMNS}`,
    [input.approvalId, input.workspaceId, input.resolverError, input.backoffMs],
  );
  const updated = r.rows[0];
  if (updated) return { kind: 'marked', row: rowToApproval(updated) };
  const lookup = await executor.query<{ status: ApprovalStatus }>(
    `SELECT status FROM tool_approval_requests
      WHERE id = $1 AND workspace_id = $2`,
    [input.approvalId, input.workspaceId],
  );
  const current = lookup.rows[0];
  if (!current) return { kind: 'not_found' };
  return { kind: 'unexpected_status', currentStatus: current.status };
}

export interface ClaimApprovalForReconcileInput {
  workspaceId: string;
  approvalId: string;
  workerId: string;
  leaseMs: number;
  /** reconciler 过滤上限；`resume_attempts < maxAttempts`。 */
  maxAttempts: number;
}

export type ClaimApprovalForReconcileResult =
  | { kind: 'claimed'; row: ApprovalRequestRow }
  | { kind: 'not_found' }
  | { kind: 'lease_contended'; currentLeaseOwner: string | null }
  | { kind: 'unexpected_status'; currentStatus: ApprovalStatus }
  | { kind: 'attempts_exhausted'; currentAttempts: number };

/**
 * Reconciler 抢占——把 `approved_resume_indeterminate` 行的 lease_owner
 * 设为 workerId。条件：
 *   - status='approved_resume_indeterminate'
 *   - (lease_owner IS NULL OR lease_expires_at < now())
 *   - resume_attempts < maxAttempts（避免对已达上限的行重复触发）
 *
 * 0 行 → 通过 SELECT 区分 not_found / lease_contended /
 * unexpected_status / attempts_exhausted。
 */
export async function claimApprovalForReconcile(
  input: ClaimApprovalForReconcileInput,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ClaimApprovalForReconcileResult> {
  const r = await executor.query<Record<string, unknown>>(
    `UPDATE tool_approval_requests
        SET lease_owner      = $3,
            lease_expires_at = now() + ($4::int * INTERVAL '1 millisecond'),
            updated_at       = now()
      WHERE id = $1
        AND workspace_id = $2
        AND status = 'approved_resume_indeterminate'
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
        AND resume_attempts < $5
        AND (resolver_error IS NULL OR resolver_error NOT LIKE 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_%')
      RETURNING ${APPROVAL_COLUMNS}`,
    [
      input.approvalId,
      input.workspaceId,
      input.workerId,
      input.leaseMs,
      input.maxAttempts,
    ],
  );
  const updated = r.rows[0];
  if (updated) return { kind: 'claimed', row: rowToApproval(updated) };

  const lookup = await executor.query<{
    status: ApprovalStatus;
    lease_owner: string | null;
    resume_attempts: number;
  }>(
    `SELECT status, lease_owner, resume_attempts
       FROM tool_approval_requests
      WHERE id = $1 AND workspace_id = $2`,
    [input.approvalId, input.workspaceId],
  );
  const current = lookup.rows[0];
  if (!current) return { kind: 'not_found' };
  if (current.status !== 'approved_resume_indeterminate') {
    return { kind: 'unexpected_status', currentStatus: current.status };
  }
  if (current.resume_attempts >= input.maxAttempts) {
    return { kind: 'attempts_exhausted', currentAttempts: current.resume_attempts };
  }
  return { kind: 'lease_contended', currentLeaseOwner: current.lease_owner };
}

export interface RevertApprovalForReconcileInput {
  workspaceId: string;
  approvalId: string;
  workerId: string;
}

export type RevertApprovalForReconcileResult =
  | { kind: 'reverted'; row: ApprovalRequestRow }
  | { kind: 'not_found' }
  | { kind: 'unexpected_status'; currentStatus: ApprovalStatus };

/**
 * Reconciler 校验通过：`listSuspendedRuns` 确认仍 suspended 且
 * identity 匹配 → 把 `approved_resume_indeterminate` 转回 `'approved'`，
 * **清** `mastra_resume_started_at`，让 scheduler 走正常 resume 路径。
 *
 * 注意：本函数**不**发 SDK、**不**写 Run——清 mastra_resume_started_at
 * 后 scheduler 自然接管；Run 仍保持 'waiting_approval'（W2 阶段已
 * 写）。
 */
export async function revertApprovalForReconcile(
  input: RevertApprovalForReconcileInput,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<RevertApprovalForReconcileResult> {
  const r = await executor.query<Record<string, unknown>>(
    `UPDATE tool_approval_requests
        SET status                 = 'approved',
            mastra_resume_started_at = NULL,
            lease_owner            = NULL,
            lease_expires_at       = NULL,
            updated_at             = now()
      WHERE id = $1
        AND workspace_id = $2
          AND status = 'approved_resume_indeterminate'
          AND lease_owner = $3 AND lease_expires_at > now()
        RETURNING ${APPROVAL_COLUMNS}`,
    [input.approvalId, input.workspaceId, input.workerId],
  );
  const updated = r.rows[0];
  if (updated) return { kind: 'reverted', row: rowToApproval(updated) };
  const lookup = await executor.query<{ status: ApprovalStatus }>(
    `SELECT status FROM tool_approval_requests
      WHERE id = $1 AND workspace_id = $2`,
    [input.approvalId, input.workspaceId],
  );
  const current = lookup.rows[0];
  if (!current) return { kind: 'not_found' };
  return { kind: 'unexpected_status', currentStatus: current.status };
}

export interface FailApprovalReconcileInput {
  workspaceId: string;
  approvalId: string;
  workerId: string;
  /** 人工介入错误；写入 `resolver_error` 字段供运维检索。 */
  resolverError: string;
}

export type FailApprovalReconcileResult =
  | { kind: 'failed'; row: ApprovalRequestRow }
  | { kind: 'not_found' }
  | { kind: 'unexpected_status'; currentStatus: ApprovalStatus };

/**
 * Reconciler 校验失败 / 人工介入终态：把
 * `approved_resume_indeterminate` 行的 `resolver_error` 写为指定
 * 错误（**不**改 status），清 lease。Run 由 run-executor 写为
 * `failed` + 错误码 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED`。
 *
 * 关键不变量：`mastra_resume_started_at` **不**清——Run 已经处于
 * "SDK 调用结果不确定"语义；保持时间戳便于运维对照 SDK 端状态。
 */
export async function failApprovalReconcile(
  input: FailApprovalReconcileInput,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<FailApprovalReconcileResult> {
  const r = await executor.query<Record<string, unknown>>(
    `UPDATE tool_approval_requests
        SET resolver_error   = $3,
            lease_owner      = NULL,
            lease_expires_at = NULL,
            updated_at       = now()
      WHERE id = $1
        AND workspace_id = $2
          AND status = 'approved_resume_indeterminate'
          AND lease_owner = $4 AND lease_expires_at > now()
        RETURNING ${APPROVAL_COLUMNS}`,
    [input.approvalId, input.workspaceId, input.resolverError, input.workerId],
  );
  const updated = r.rows[0];
  if (updated) return { kind: 'failed', row: rowToApproval(updated) };
  const lookup = await executor.query<{ status: ApprovalStatus }>(
    `SELECT status FROM tool_approval_requests
      WHERE id = $1 AND workspace_id = $2`,
    [input.approvalId, input.workspaceId],
  );
  const current = lookup.rows[0];
  if (!current) return { kind: 'not_found' };
  return { kind: 'unexpected_status', currentStatus: current.status };
}

/**
 * 列出"lease 已到期 + 未被抢占 + 重试未达上限"的 indeterminate 行。
 *
 * reconciler 扫描条件：
 *   - status = 'approved_resume_indeterminate'
 *   - (lease_owner IS NULL OR lease_expires_at < now())
 *   - resume_attempts < maxAttempts
 *   - **排除** `resolver_error LIKE 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_%'`
 *     的行——一旦 W2 exhausted / listSuspendedRuns 校验失败，resolver_error
 *     即被覆盖为以 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_` 开头的人工介入
 *     错误码（`ATTEMPTS_EXHAUSTED` 或 `REQUIRED`）；这些行**永久**退出
 *     自动 reconciler 扫描集，避免重复调 `facade.listSuspendedRuns` 与
 *     重复日志噪声。Run 已被 `markReconcileFailedAndFailRun` /
 *     W2 exhausted 路径写为 `failed`，进入人工介入流程；approval 行
 *     本身仍保留（供运维对照 SDK 端状态）。
 *
 * 不带 workspace 过滤——reconciler 是平台层作业。
 */
export async function listApprovalsPendingReconcile(
  maxAttempts: number,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ApprovalRequestRow[]> {
  const r = await executor.query<Record<string, unknown>>(
    `SELECT ${APPROVAL_COLUMNS}
       FROM tool_approval_requests
      WHERE status = 'approved_resume_indeterminate'
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
        AND resume_attempts < $1
        AND (resolver_error IS NULL
             OR resolver_error NOT LIKE 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_%')
      ORDER BY lease_expires_at ASC NULLS FIRST`,
    [maxAttempts],
  );
  return r.rows.map(rowToApproval);
}
//
// Phase 3.1 仅落出最小 Repository（upsert / getByToolId）；后续 PR
// 才会接入 evaluator（PR-3.2）与策略管理 UI（PR-3.3+）。本层不接
// Mastra SDK / 不在解析时改 agent_runs.status。

export interface UpsertPolicyRuleInput {
  workspaceId: string;
  toolId: string;
  effect: ToolPolicyRuleRow['effect'];
  conditions?: unknown;
  createdBy: string;
}

/**
 * upsert 基础规则：同 (workspace_id, tool_id) 仅一条；返回最新 row。
 */
export async function upsertPolicyRule(
  input: UpsertPolicyRuleInput,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ToolPolicyRuleRow> {
  const r = await executor.query<Record<string, unknown>>(
    `INSERT INTO tool_policy_rules (
       workspace_id, tool_id, effect, conditions, created_by
     ) VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (workspace_id, tool_id) DO UPDATE
       SET effect     = EXCLUDED.effect,
           conditions = EXCLUDED.conditions,
           updated_at = now()
     RETURNING ${POLICY_COLUMNS}`,
    [
      input.workspaceId,
      input.toolId,
      input.effect,
      JSON.stringify(input.conditions ?? {}),
      input.createdBy,
    ],
  );
  return rowToPolicy(r.rows[0]!);
}

/**
 * 按 (workspace_id, tool_id) 读取规则；不存在返回 null。
 * 不存在的 tool_id 在 evaluator 处被视为"未声明策略"——由 PR-3.2
 * 决定 default effect，本层只做查询。
 */
export async function getPolicyRule(
  workspaceId: string,
  toolId: string,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<ToolPolicyRuleRow | null> {
  const r = await executor.query<Record<string, unknown>>(
    `SELECT ${POLICY_COLUMNS}
       FROM tool_policy_rules
      WHERE workspace_id = $1 AND tool_id = $2`,
    [workspaceId, toolId],
  );
  const row = r.rows[0];
  return row ? rowToPolicy(row) : null;
}

/**
 * PR-3.3 — 通过 (workspace_id, run_id) 反查 agent_runs.agent_id。
 *
 * 用途：Mastra SDK 的 `approveToolCall / declineToolCall` 不带 agent 维度
 * （仅 runId + toolCallId），但我们的 Mastra 单例是按 agent 注册表派发
 * 的，所以 facade 在 SDK 调用前需要 runId → agentId 映射。
 *
 * 安全：带 `workspace_id` 过滤；即使调用方传错 workspaceId，返回 null
 * 而不是跨 workspace 命中——facade 在该情况下退化到 'general-chat' 兜底
 * 不会越权。
 */
export async function getAgentIdByRun(
  workspaceId: string,
  runId: string,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<string | null> {
  const r = await executor.query<{ agent_id: string }>(
    `SELECT agent_id FROM agent_runs
      WHERE id = $1 AND workspace_id = $2`,
    [runId, workspaceId],
  );
  const row = r.rows[0];
  return row ? row.agent_id : null;
}
