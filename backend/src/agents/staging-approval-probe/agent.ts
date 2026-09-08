/**
 * PR-3.3.1 — Staging Approval Probe Agent（staging 唯一，专用 e2e Agent）。
 *
 * 约束：
 *   - 不得混用 general-chat / knowledge-base；本 Agent 是 staging 端到端验收专用，
 *     不暴露在生产前端任何 Capabilty UI；
 *   - toolIds 锁定为单一探针；不允许额外 Tool，避免 e2e 阶段模型分散调
 *     用导致 approval-requested 漏发；
 *   - 指令**强制**模型"对每个 user message 都先调一次 Probe（nonce=整段
 *     用户原文）"——否则 e2e 脚本会因缺少 approval-requested 事件而 fail；
 *   - skills=false；knowledgeBase=false；citations=false。
 */
import { Agent } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core';
import type { AgentDefinition } from '../../core/agent/types.js';
import { resolveDefaultChatModel } from '../../infrastructure/llm/registry.js';

export const STAGING_APPROVAL_PROBE_AGENT_ID = 'staging-approval-probe';

export const stagingApprovalProbeInstructions = [
  '你是 staging 环境的审批探针 Agent，仅用于 PR-3.3.1 端到端验收。',
  '收到任何 user message 时，**第一步必须**调用工具 `staging-approval-probe`，',
  '入参 `{ nonce: <user message 原文> }`（原文限制 8–128 字符 [a-zA-Z0-9_-]）。',
  '调用完成后，根据工具 echo 结果写一行短回复，告知调用已成功。',
  '严禁：调用任何其他工具；不调工具直接给答案；省略工具调用。',
].join('');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createStagingApprovalProbeAgent(
  tools?: Record<string, unknown>,
  skills?: unknown[],
  mastraInstance?: Mastra,
): Agent {
  return new Agent({
    id: STAGING_APPROVAL_PROBE_AGENT_ID,
    name: '[staging] Approval Probe Agent',
    model: resolveDefaultChatModel(),
    tools: tools as ConstructorParameters<typeof Agent>[0]['tools'],
    instructions: stagingApprovalProbeInstructions,
    ...(skills && skills.length > 0 ? { skills: skills as any } : {}),
    ...(mastraInstance ? { mastra: mastraInstance } : {}),
  });
}

export const stagingApprovalProbeAgentDefinition: AgentDefinition = {
  id: STAGING_APPROVAL_PROBE_AGENT_ID,
  name: '[staging] Approval Probe Agent',
  description:
    '专用 e2e Agent：每次都先调用 staging-approval-probe 探针；staging 唯一、生产永不注册。',
  toolIds: ['staging-approval-probe'],
  capabilities: {
    knowledgeBase: false,
    citations: false,
    tools: true,
    skills: false,
  },
  factory: createStagingApprovalProbeAgent,
};
