/**
 * Phase 3.2 — Tool Policy Evaluator。
 *
 * 职责：对"某 Workspace 下、某个 Tool"做单点策略决策，输出三态结果
 *   - `allowed`：进入 per-request activeTools，可直接被 Agent 看到；
 *   - `requires-approval`：本阶段 fail-closed；**不**进入 activeTools；
 *     等 PR-3.3 把 Mastra `requireToolApproval` + 审批持久化 +
 *     resolve API 一次性接通后再放行；
 *   - `forbidden`：永远不进入 activeTools（未注册、requiresRuntime、
 *     deny 规则、openWorld 无显式 allow 等）。
 *
 * 信任模型：
 *   - 只信任**服务端** `ToolDefinition`（来自 `core/tool/registry.ts`）
 *     与服务端**数据库** `tool_policy_rules` 行（来自
 *     `modules/tool-policy/repository.ts`）；
 *   - **不**读取 Agent 声明、`ToolDefinition.metadata` 之外的 Tool
 *     输入参数、Skill 文本或模型提示词里任何"自报字段"；
 *   - Tool 风险标志位（`destructive` / `openWorld` / `requiresRuntime`）
 *     是服务端在 `tools/<id>/tool.ts` 内**手工**填写的元数据，本阶段
 *     不接受 Tool 在运行时改写自身风险等级。
 *
 * 与 Repository 的边界：本文件**不**直接调 SQL；它通过
 * `EvaluatorContext.getPolicyRule` 注入的回调读策略行（生产路径由
 * `resolver.ts` 装配真实 repository 调用）。
 *
 * 决策矩阵（顺序敏感；一旦命中即短路）：
 *
 * | 服务端注册 | 风险                | DB 策略       | 决策              |
 * |-----------|---------------------|--------------|-------------------|
 * | 未注册    | 任意                 | 任意          | forbidden          |
 * | 任意      | requiresRuntime=true | 任意          | forbidden          |
 * | 任意      | destructive=true     | 任意          | requires-approval  |
 * | 已注册    | openWorld=true       | 无 / 非 allow | forbidden          |
 * | 已注册    | openWorld=true       | allow         | allowed            |
 * | 已注册    | openWorld=true       | require_approval | requires-approval |
 * | 已注册    | 低风险               | 无 / allow    | allowed            |
 * | 已注册    | 低风险               | deny          | forbidden          |
 * | 已注册    | 低风险               | require_approval | requires-approval |
 *
 * 注解：
 *   - "低风险"= !requiresRuntime && !destructive && !openWorld。
 *   - "任意"在 destructive 行等于说：**destructive 的最低级别就是
 *     requires-approval**——即便 Workspace 显式 allow，也要走审批；
 *     这是服务端纵深防御，不可由 DB 策略降级。
 *   - openWorld 缺策略**不**回退到 allowed；缺策略与 deny 等价（fail-closed）。
 *   - 本 PR **不**信任 Tool 在 execute 入口或 Mastra toolCall 中自报
 *     的 metadata（架构-v2 §0 已明确：metadata 仅作 UI 提示）。
 */
import type { ToolDefinition } from '../../core/tool/registry.js';
import type { ToolPolicyEffect } from './types.js';

export type ToolPolicyDecision =
  | { kind: 'allowed'; reason: string }
  | { kind: 'requires-approval'; reason: string }
  | { kind: 'forbidden'; reason: string };

export interface EvaluatorContext {
  /**
   * 服务端 Tool 注册表查询。生产路径由 `core/tool/registry.ts` 提供。
   * 返回 undefined 即"该 id 未注册"——evaluator 把它视作 forbidden，
   * 不**抛错**，避免调用方在传错 id 时通过抛错泄漏注册表结构。
   */
  getToolDefinition(toolId: string): ToolDefinition | undefined;
  /**
   * 读取 workspaceId + toolId 的策略行。返回 null 表示"未声明"。
   * 生产路径由 `modules/tool-policy/repository.ts#getPolicyRule` 提供。
   */
  getPolicyRule(
    workspaceId: string,
    toolId: string,
  ): Promise<{ effect: ToolPolicyEffect } | null>;
}

export interface EvaluateArgs {
  workspaceId: string;
  toolId: string;
}

function isLowRisk(def: ToolDefinition): boolean {
  return (
    !def.metadata.requiresRuntime &&
    !def.metadata.destructive &&
    !def.metadata.openWorld
  );
}

function isHighRiskDestructive(def: ToolDefinition): boolean {
  // destructive 最低级别 = requires-approval；这一行永远先于 policy 检查。
  return def.metadata.destructive;
}

function isOpenWorld(def: ToolDefinition): boolean {
  return def.metadata.openWorld;
}

export async function evaluateToolPolicy(
  ctx: EvaluatorContext,
  args: EvaluateArgs,
): Promise<ToolPolicyDecision> {
  const def = ctx.getToolDefinition(args.toolId);
  if (!def) {
    return {
      kind: 'forbidden',
      reason: 'Tool 未在服务端注册表中登记。',
    };
  }

  // 1. requiresRuntime 永远是 forbidden——服务端纵深防御：缺外部运行时
  //    时即便 DB allow 也不能让 Agent 调用。
  if (def.metadata.requiresRuntime) {
    return {
      kind: 'forbidden',
      reason: 'Tool 依赖外部运行时（requiresRuntime=true），暂不向 Agent 暴露。',
    };
  }

  // 2. destructive 永远是 requires-approval——即便 DB allow 也不能降级。
  if (isHighRiskDestructive(def)) {
    const rule = await ctx.getPolicyRule(args.workspaceId, args.toolId);
    if (rule?.effect === 'deny') {
      return {
        kind: 'forbidden',
        reason: 'destructive Tool 被 Workspace 显式 deny 覆盖。',
      };
    }
    return {
      kind: 'requires-approval',
      reason: 'destructive Tool 必须经人工审批；本阶段 fail-closed 等 PR-3.3 接管。',
    };
  }

  // 3. openWorld：缺策略 / deny 视为 forbidden；allow → allowed；
  //    require_approval → requires-approval。
  if (isOpenWorld(def)) {
    const rule = await ctx.getPolicyRule(args.workspaceId, args.toolId);
    if (!rule || rule.effect === 'deny') {
      return {
        kind: 'forbidden',
        reason: rule
          ? 'openWorld Tool 被 Workspace 显式 deny。'
          : 'openWorld Tool 缺策略时默认 forbidden（fail-closed）。',
      };
    }
    if (rule.effect === 'allow') {
      return {
        kind: 'allowed',
        reason: 'openWorld Tool 被 Workspace 显式 allow。',
      };
    }
    return {
      kind: 'requires-approval',
      reason: 'openWorld Tool 被 Workspace 标记为 require_approval。',
    };
  }

  // 4. 低风险：deny → forbidden；allow / require_approval / 无规则 →
  //    allowed（缺策略默认 allow） / requires-approval。
  //    注：低风险 + 无规则默认 allowed 是 fail-open；架构约束要求
  //    "未声明"= 允许执行本地计算类 Tool（如 calculator /
  //    get-current-time）。后续 PR-3.3+ 若要求收紧为 fail-closed，
  //    由 V2 升版裁决后再调整本函数。
  if (isLowRisk(def)) {
    const rule = await ctx.getPolicyRule(args.workspaceId, args.toolId);
    if (rule?.effect === 'deny') {
      return {
        kind: 'forbidden',
        reason: 'Tool 被 Workspace 显式 deny。',
      };
    }
    if (rule?.effect === 'require_approval') {
      return {
        kind: 'requires-approval',
        reason: 'Tool 被 Workspace 标记为 require_approval。',
      };
    }
    return {
      kind: 'allowed',
      reason: rule
        ? '低风险 Tool 被 Workspace 显式 allow。'
        : '低风险 Tool 缺策略时默认 allowed（fail-open 仅限本地只读）。',
    };
  }

  // 理论上 unreachable：上面 3 个分支覆盖了所有风险组合；保留以防御
  // 未来 metadata 字段扩展时漏分支。
  return {
    kind: 'forbidden',
    reason: 'Tool 风险标志无法识别，默认 fail-closed。',
  };
}