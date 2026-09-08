/**
 * PR-3.3 — Tool Approval Gateway (Runtime 端)。
 *
 * 责任：在 streamAgent 真实 agent.stream() 路径接入"服务端策略感知的
 * requireToolApproval"。该函数**不是** Mastra SDK 的命令式包装，而是
 * 把 ToolDefinition metadata + Workspace 的 tool_policy_rules 决策
 * 翻译成 Mastra streamOptions.requireToolApproval(ctx) → boolean。
 *
 * 信任边界：
 *   - 仅信任 `ctx.toolName` 与 `ctx.args`——这两个字段由 Mastra v1 在
 *     调用 Tool 之前传入，与 ToolDefinition / 策略行一并校验；
 *   - **不**信任 ctx 自报的"是哪个 agent / 哪个 user"——workspace
 *     必须由调用方在工厂里通过闭包注入；
 *   - forbidden Tool 不进入 activeTools（在 runtime.ts 解析阶段已
 *     过滤），这里只处理 requires-approval；
 *   - allowed Tool 走 fast-path，不需 approve。
 *
 * 输出契约：
 *   - `true`  = 该 Tool 调用需要被审批（写入 approval request + 挂起 Run）；
 *   - `false` = 该 Tool 调用不需要审批，正常执行。
 */
import { getToolDefinition } from '../tool/registry.js';
import {
  evaluateToolPolicy,
  type EvaluatorContext,
} from '../../modules/tool-policy/evaluator.js';
import { getPolicyRule } from '../../modules/tool-policy/repository.js';

export interface ApprovalGatewayContext {
  workspaceId: string;
}

export type RequireApprovalFn = (
  ctx: ApprovalGatewayContext,
) => (toolApproval: {
  toolName: string;
  args: Record<string, unknown>;
}) => boolean | Promise<boolean>;

function defaultResolverContext(): EvaluatorContext {
  return { getToolDefinition, getPolicyRule };
}

/**
 * 构造一个 per-workspace 的 requireToolApproval 函数。
 *
 * 用法：
 *   const requireApproval = buildRequireApproval({ workspaceId });
 *   await agent.stream(prompt, { requireToolApproval: requireApproval });
 *
 * 设计：每个 Run 构造一个新函数——避免在多 Workspace 并发场景里把
 * workspaceId 漏到共享对象上（与 agent streamOptions 的"per-request"
 * 边界对齐）。
 */
export function buildRequireApproval(
  ctx: ApprovalGatewayContext,
  evaluatorCtx: EvaluatorContext = defaultResolverContext(),
): (toolApproval: {
  toolName: string;
  args: Record<string, unknown>;
}) => Promise<boolean> {
  return async ({ toolName }) => {
    const decision = await evaluateToolPolicy(evaluatorCtx, {
      workspaceId: ctx.workspaceId,
      toolId: toolName,
    });
    // 仅 requires-approval 触发审批；allowed 走 fast-path，forbidden
    // 不应进入 activeTools（理论不应被 Mastra 调用）。
    return decision.kind === 'requires-approval';
  };
}