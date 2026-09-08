/**
 * PR-3.3 — Tool Approval API（受保护路由）。
 *
 * 设计要点：
 *   - **必须**走 `withAuthenticatedWorkspace` 包装器——V2.3.6 §5.1 不变量；
 *     不允许 `X-Workspace-Id` / body.workspaceId 注入。
 *   - 路径前缀 `/v1/approvals`；不再走 root path——本组是新功能入口，
 *     不需要 §9.5.1 的 Deprecation/Sunset 兼容头。
 *   - 跨 workspace 读取一律返回 404（与 `getApprovalRequestById` 一致），
 *     不暴露存在性 / 越权嗅探面。
 *
 * 路由：
 *   - GET  `/v1/approvals`               列出当前 workspace 内所有 pending + inflight approvals
 *   - GET  `/v1/approvals/:id`           单条读取
 *   - POST `/v1/approvals/:id/resolve`   决策（approve / decline）
 *
 * `resolve` 必须走 `state-machine.resolveApproval`——saga + lease + SDK
 * 调用全部由该层管理；HTTP 层只做"取参数 → 调 state-machine → 映射
 * outcome 到 HTTP 响应"。失败 SDK 调用由 state-machine 写 'declined'
 * 兜底（resolverError 落到 DB + SSE）。
 *
 * 内层 handler 拆出（`listApprovalsHandler` / `getApprovalHandler` /
 * `resolveApprovalHandler`）— 单元测试可直接调，避开真实 session 解析；
 * `withAuthenticatedWorkspace` 包装只在外层 `registerApiRoute` 调用处
 * 应用，保持静态契约。
 */
import { registerApiRoute } from '@mastra/core/server';
import {
  getApprovalRequestById,
  listPendingApprovalRequests,
} from '../../modules/tool-policy/repository.js';
import {
  resolveApproval,
  listInflightApprovalRequests,
  type ApprovalDecision,
} from '../../modules/tool-policy/state-machine.js';
import { withAuthenticatedWorkspace, type AuthenticatedContext, type AuthenticatedRouteContextLike } from '../../modules/auth/workspace-context.js';
import { logger } from '../../infrastructure/logging/logger.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * 把 DB row 转成对外 JSON 形态：camelCase + 字段约束。
 *
 * 关键边界：
 *   - inputsSummary **不含**原始敏感 Tool 参数；只含 sanitize 后的
 *     `{kind, preview, count?}` 摘要结构 + hash。前端拿到原始结构由
 *     UI 层决定怎么呈现（kind 不同则展示策略不同）。
 *   - status 包含 `pending / approving / declining / approved / declined / expired`——
 *     前端按 status 决定卡片形态（待审批 / 处理中 / 已完成）。
 */
export interface ApprovalView {
  id: string;
  workspaceId: string;
  runId: string;
  toolId: string;
  toolCallId: string;
  status: string;
  decision: string | null;
  resolverError: string | null;
  /**
   * PR-3.3 — NOT NULL FK。system-initiated 续 Run / 超时收敛时为
   * `system-approval-worker` 预设用户 UUID。
   */
  requesterId: string;
  resolverId: string;
  inputsSummary: unknown;
  inputsHash: string;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
  /** PR-3.3 — Mastra resume 是否已被 run executor 接管；null 表示尚无。 */
  mastraResumeStartedAt: string | null;
}

export function rowToView(row: {
  id: string;
  workspaceId: string;
  runId: string;
  toolId: string;
  toolCallId: string;
  status: string;
  decision: string | null;
  resolverError: string | null;
  requesterId: string;
  resolverId: string;
  inputsSummary: unknown;
  inputsHash: string;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
  mastraResumeStartedAt?: string | null;
}): ApprovalView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    runId: row.runId,
    toolId: row.toolId,
    toolCallId: row.toolCallId,
    status: row.status,
    decision: row.decision,
    resolverError: row.resolverError,
    requesterId: row.requesterId,
    resolverId: row.resolverId,
    inputsSummary: row.inputsSummary,
    inputsHash: row.inputsHash,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    mastraResumeStartedAt: row.mastraResumeStartedAt ?? null,
  };
}

export const listApprovalsHandler = async (
  authCtx: AuthenticatedContext,
  context: AuthenticatedRouteContextLike,
): Promise<Response> => {
  const [pending, inflight] = await Promise.all([
    listPendingApprovalRequests(authCtx.workspaceId),
    listInflightApprovalRequests().then((rows) =>
      rows.filter((r) => r.workspaceId === authCtx.workspaceId),
    ),
  ]);
  return context.json({
    approvals: [...pending, ...inflight].map(rowToView),
  });
};

export const getApprovalHandler = async (
  authCtx: AuthenticatedContext,
  context: AuthenticatedRouteContextLike,
): Promise<Response> => {
  const id = context.req.param('id');
  if (!isUuid(id)) {
    return context.json(
      { error_code: 'INPUT_VALIDATION_FAILED', message: 'approvalId 格式不正确。' },
      422,
    );
  }
  const row = await getApprovalRequestById(authCtx.workspaceId, id);
  if (!row) {
    return context.json(
      { error_code: 'NOT_FOUND', message: '资源不存在。' },
      404,
    );
  }
  return context.json({ approval: rowToView(row) });
};

export const resolveApprovalHandler = async (
  authCtx: AuthenticatedContext,
  context: AuthenticatedRouteContextLike,
): Promise<Response> => {
  const id = context.req.param('id');
  if (!isUuid(id)) {
    return context.json(
      { error_code: 'INPUT_VALIDATION_FAILED', message: 'approvalId 格式不正确。' },
      422,
    );
  }
  const body = (await context.req.json<unknown>().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return context.json(
      { error_code: 'INPUT_VALIDATION_FAILED', message: '请求体必须是 JSON 对象。' },
      422,
    );
  }
  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'decline') {
    return context.json(
      {
        error_code: 'INPUT_VALIDATION_FAILED',
        message: 'decision 必须为 "approve" 或 "decline"。',
      },
      422,
    );
  }

  // 生产 facade 由 `server/bootstrap.ts` 在进程启动时已注入；
  // 单元测试路径通过 `_setMastraFacadeForTesting(fake)` 提前注入。
  // 任何情况下 facade 都应在 state-machine 内可用；万一未注入
  // （例如直接调用 handler 的脚本路径），state-machine 抛错会被
  // wrapper 兜底为 500。

  const outcome = await resolveApproval({
    workspaceId: authCtx.workspaceId,
    approvalId: id,
    resolverId: authCtx.userId,
    decision: decision as ApprovalDecision,
  });

  if (outcome.kind === 'not_found') {
    return context.json(
      { error_code: 'NOT_FOUND', message: '资源不存在。' },
      404,
    );
  }
  if (outcome.kind === 'already_resolved') {
    return context.json(
      {
        error_code: 'APPROVAL_ALREADY_RESOLVED',
        message: '审批请求已被处理。',
        currentStatus: outcome.currentStatus,
      },
      409,
    );
  }
  if (outcome.kind === 'lease_contended') {
    return context.json(
      {
        error_code: 'APPROVAL_INFLIGHT',
        message: '审批请求正在处理中，请稍候重试。',
        currentLeaseOwner: outcome.currentLeaseOwner,
      },
      409,
    );
  }
  // approved / declined：DB 已落库，SDK 接管由 run executor scheduler 在
  // 下个 tick 通过 `listApprovalsPendingResume` 拾起。这里**不**伪造
  // SDK 失败分支——`resolveApproval` 严格 DB-only，不可能产出 SDK 错误。
  return context.json({ approval: rowToView(outcome.row) }, 200);
};

export const listApprovalsRoute = registerApiRoute('/v1/approvals', {
  method: 'GET',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(listApprovalsHandler),
});

export const getApprovalRoute = registerApiRoute('/v1/approvals/:id', {
  method: 'GET',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(getApprovalHandler),
});

export const resolveApprovalRoute = registerApiRoute(
  '/v1/approvals/:id/resolve',
  {
    method: 'POST',
    requiresAuth: true,
    handler: withAuthenticatedWorkspace(resolveApprovalHandler),
  }
);