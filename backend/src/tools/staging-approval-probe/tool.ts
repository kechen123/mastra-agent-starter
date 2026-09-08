/**
 * PR-3.3.1 — Tool Approval e2e Probe（staging 唯一，零业务副作用）。
 *
 * 设计动机：
 *   - `tests/integration/tool-policy-pg.ts` 已用 fake Agent stream 在真实 PG 上
 *     验证 PR-3.3 协议闭环（107 passed）。本 Tool 提供"真实模型触发"
 *     路径下的端到端探针：仅当 ENABLE_STAGING_APPROVAL_PROBE=true 且
 *     部署档位 !== production 时才注册；
 *   - 探针本身必须**零业务副作用、确定性、幂等**，通过 nonce 字段确保
 *     重复调用结果一致（`idempotent=true`），并通过 `destructive=true` 让
 *     `evaluateToolPolicy` 在 default 路径上必返回 `requires-approval`；
 *   - 不读 DB / 不发请求 / 不修改任何状态；execute 直接返回 `{ echo: <nonce> }`
 *     作为占位输出，让 resume stream 后续 SSE 能拿到稳定、可断言的 payload。
 *
 * 安全契约：
 *   - 不允许在 production 注册——见 `tools/index.ts` 的守卫；
 *   - 不允许通过 `tool_policy_rules` 降级为 allowed —— `destructive=true`
 *     是服务端纵深防御，永远最低为 `requires-approval`；
 *   - nonce 必须满足 `^[a-zA-Z0-9_-]{8,128}$`，避免日志注入 / 超长入参
 *     把 JSONB 撑爆；与 `tests/unit/tool-policy-sanitize.ts` 的 truncate 行为
 *     保持一致的可观察面。
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ToolDefinition } from '../../core/tool/registry.js';

const NONCE_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

const stagingApprovalProbeTool = createTool({
  id: 'staging-approval-probe',
  description:
    '[STAGING-ONLY] 零副作用幂等探针：返回传入的 nonce，用于真实模型触发审批的端到端验证。' +
    '默认未注册；仅当 ENABLE_STAGING_APPROVAL_PROBE=true 且非 production 时启用。',
  inputSchema: z.object({
    nonce: z
      .string()
      .regex(
        NONCE_PATTERN,
        'nonce 必须匹配 ^[a-zA-Z0-9_-]{8,128}$（避免日志注入 / 超长入参）。',
      )
      .describe('唯一回声串，用于在 SSE 终态验证 resume stream 消费。'),
  }),
  outputSchema: z.object({
    echo: z.string(),
  }),
  execute: async ({ nonce }) => {
    // 只回显 nonce，确保重复调用结果一致；不读取时间或任何外部状态。
    return {
      echo: nonce,
    };
  },
});

export const stagingApprovalProbeDefinition: ToolDefinition = {
  id: 'staging-approval-probe',
  displayName: '[staging] Approval Probe',
  description:
    '零副作用探针，仅在 staging 启用，用于真实模型 + 真实 Mastra SDK 的审批 e2e。',
  tool: stagingApprovalProbeTool,
  metadata: {
    readOnly: true,
    destructive: true,
    idempotent: true,
    openWorld: false,
    requiresRuntime: false,
  },
};
