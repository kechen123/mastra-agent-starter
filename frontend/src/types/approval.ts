/**
 * Tool approval feature types (PR-3.3).
 *
 * 单点职责：定义前端审批卡片需要的 approval 视图类型 + 输入摘要
 * (sanitized summary) 的渲染结构。
 *
 * 设计要点：
 *   - **不**持久化原始敏感 Tool 参数；只接收后端 `sanitizeToolInputs`
 *     输出的 `{kind, preview, count?}` 摘要；
 *   - status 是后端 `ApprovalStatus` 全集（含 pending / approving /
 *     declining / approved / declined / expired），前端按 status 决定
 *     卡片形态；
 *   - decision / resolverError 字段可能为 null——已 finalized 行也会
 *     保留，供"已拒绝 / 已过期"卡片展示。
 */

export type ApprovalStatus =
  | 'pending'
  | 'approving'
  | 'declining'
  | 'approved'
  | 'declined'
  | 'expired';

export interface ApprovalSummaryLeaf {
  kind:
    | 'string'
    | 'number'
    | 'boolean'
    | 'null'
    | 'array'
    | 'object'
    | 'empty'
    | 'truncated'
    | 'other';
  /** 截断到 200 字符的展示值；truncated 时 preview 含 '...'。 */
  preview: string;
  /** 仅 array / object 节点有；表示子节点数量（截断前）。 */
  count?: number;
}

export type ApprovalSummary = Record<string, ApprovalSummaryLeaf>;

export interface ApprovalView {
  id: string;
  workspaceId: string;
  runId: string;
  toolId: string;
  toolCallId: string;
  status: ApprovalStatus;
  decision: 'approved' | 'declined' | null;
  resolverError: string | null;
  requesterId: string;
  resolverId: string | null;
  inputsSummary: ApprovalSummary;
  inputsHash: string;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ApprovalListResponse {
  approvals: ApprovalView[];
}

export interface ApprovalDetailResponse {
  approval: ApprovalView;
}

export interface ApprovalResolveResponse {
  approval: ApprovalView;
  /** SDK 调用失败时由 state-machine 兜底写 'declined'——前端用于区分用户主动 vs 系统失败。 */
  sdkFailed?: boolean;
}

export interface ApprovalResolveErrorBody {
  error_code:
    | 'NOT_FOUND'
    | 'INPUT_VALIDATION_FAILED'
    | 'APPROVAL_ALREADY_RESOLVED'
    | 'APPROVAL_INFLIGHT'
    | 'APPROVAL_LEASE_LOST'
    | 'INTERNAL_ERROR';
  message: string;
  currentStatus?: ApprovalStatus;
  currentLeaseOwner?: string | null;
}
