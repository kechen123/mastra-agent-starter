/**
 * Phase 3.2 — Policy-aware Tool Resolver（策略感知解析器）。
 *
 * 职责：把 `core/agent/runtime.ts` 解析 activeTools 的工作从"按
 * `toolMap.has(id)` 的存在性过滤"升级为"按 workspace 策略逐 Tool
 * 决策、只保留 `allowed`"：
 *
 *   - `forbidden` Tool 一定不进入 activeTools（Agent 看不到）；
 *   - `requires-approval` Tool **本阶段**也不进入 activeTools
 *     （fail-closed；等 PR-3.3 把 Mastra `requireToolApproval` +
 *     审批持久化 + resolve API 一次性接通）；
 *   - `allowed` Tool 才进入 activeTools。
 *
 * 输入 `toolIds` 通常来自 `AgentDefinition.toolIds`——这是 Agent 在
 * 注册时**声明**的可用子集，与"Workspace 策略是否放行"是两件事：
 * resolver 在二者交集内按策略过滤，避免 Skill / 调用方通过 inline
 * 传 ids 绕过 evaluator。
 *
 * 设计约束：
 *   - 纯数据访问：通过 `EvaluatorContext` 注入依赖；本文件**不**直接
 *     import `core/tool/registry.ts` 或 `tool-policy/repository.ts`，
 *     由 `createDefaultResolverContext()` 在生产路径装配，避免循环依赖
 *     与测试注入被生产覆盖；
 *   - 不调用 Mastra SDK、不修改 `agent_runs.status`、不写 SSE、
 *     不执行 Tool；这些是 PR-3.3 / 续 Run 阶段的事；
 *   - 输入可能为空 / 含未注册 id；本函数**不**抛错，调用方拿到的就是
 *     "按策略过滤后、可以放进 activeTools 的 id 列表"。
 */
import { getToolDefinition } from '../../core/tool/registry.js';
import { getPolicyRule } from './repository.js';
import { evaluateToolPolicy, type EvaluatorContext } from './evaluator.js';

export type ResolverContext = EvaluatorContext;

/**
 * 装配"生产路径默认"的 resolver context：把服务端 Tool 注册表与
 * tool_policy_rules repository 接起来。
 *
 * runtime.ts 在 streamAgent 内调用本工厂，注入到 `resolveAllowedToolIds`
 * 的隐式 ctx 参数；测试可通过 `_setPolicyResolverForTesting(...)` 把
 * 整套 ctx 替换为 fake，不影响本工厂。
 */
export function createDefaultResolverContext(): ResolverContext {
  return {
    getToolDefinition,
    getPolicyRule,
  };
}

/**
 * 对一组 toolIds 做策略过滤，返回 `allowed` + `requires-approval` 的 id。
 *
 * 行为契约（PR-3.3 起）：
 *   - 顺序保留输入顺序（便于 SSE / 审计对账）；
 *   - `allowed` 与 `requires-approval` 都进入返回数组：
 *       - allowed：执行时不需要审批（fast-path）；
 *       - requires-approval：执行时由 `requireToolApproval` 挂起 +
 *         持久化 approval request + 移 Run 到 `waiting_approval`；
 *   - `forbidden` 与未注册 全部静默跳过——它们进入 activeTools 会让
 *     攻击面"tool 看到但看不到源码"，违背 fail-closed；
 *   - 同一 id 重复出现在输入时按出现顺序处理；是否去重由调用方决定。
 *
 * 失败模式：evaluator 或 getPolicyRule 抛错时本函数**不**捕获，
 * 由上层决定降级策略（生产路径应让其冒泡成 500，由运行时的
 * try / catch 收尾，避免 silent fall-open）。
 */
export async function resolveAllowedToolIds(
  workspaceId: string,
  toolIds: readonly string[],
  ctx: ResolverContext,
): Promise<string[]> {
  const out: string[] = [];
  for (const toolId of toolIds) {
    const decision = await evaluateToolPolicy(ctx, { workspaceId, toolId });
    if (decision.kind === 'allowed' || decision.kind === 'requires-approval') {
      out.push(toolId);
    }
  }
  return out;
}