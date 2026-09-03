import { Agent } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core';
import type { AgentDefinition } from '../../core/agent/types.js';
import { config } from '../../config.js';
import { resolveDefaultChatModel } from '../../infrastructure/llm/registry.js';
import { generalChatInstructions } from './instructions.js';

/**
 * `general-chat` Agent 的具体工厂。
 * 接收本次请求已解析好的 skills（参数 `tools` 在 Phase 3.0 修订后
 * 被忽略——见下文），返回一个可运行的 Mastra Agent。Core Runtime 通过
 * AgentDefinition.factory 调用此工厂——通用驱动逻辑见
 * `core/agent/runtime.ts`。
 *
 * 模型通过 `infrastructure/llm/registry.ts:resolveDefaultChatModel()` 解析：
 * 本工厂不直接读取 Provider 环境变量、不拼接 `provider/model` 字符串；
 * 这些细节全部收敛在 Provider Adapter 内部。
 *
 * Phase 3.0 修订：工具来源变更。
 *   - 不再 inline 持有 `tools`：全部 Tool 由 `Mastra({ tools })` 在
 *     `infrastructure/mastra/instance.ts` 装配时统一注册
 *     （`buildGlobalToolMap()`），Agent 通过 `mastraInstance.tools` 拿
 *     同一份注册表；
 *   - per-request 可用子集由 Runtime 在 `agent.stream({ activeTools })`
 *     上过滤，避免每个 per-request Agent 临时持有一份 tool 字典；
 *   - 该参数保留是为了与 `AgentFactory` 签名兼容（不破坏现有调用方），
 *     但本工厂不再读取其值。
 *
 * `mastraInstance` 仍然透传给 `new Agent({...})`，让 per-request Agent
 * 通过 public Mastra 注册路径访问 storage。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createGeneralAgent(
  _tools?: Record<string, unknown>,
  skills?: unknown[],
  mastraInstance?: Mastra,
): Agent {
  return new Agent({
    id: 'general-chat',
    name: `${config.appShortName} 通用对话 Agent`,
    model: resolveDefaultChatModel(),
    instructions: generalChatInstructions,
    ...(skills && skills.length > 0 ? { skills: skills as any } : {}),
    ...(mastraInstance ? { mastra: mastraInstance } : {}),
  });
}

/**
 * `general-chat` 的 AgentDefinition。
 * id、capabilities、toolIds 是该 Agent 的权威描述；factory 是 Core 注册表
 * 在每次请求时调用的运行时钩子。
 */
export const generalChatAgent: AgentDefinition = {
  id: 'general-chat',
  name: '通用对话 Agent',
  description: '通用闲聊与问答',
  toolIds: ['calculator', 'get-current-time'],
  capabilities: { knowledgeBase: false, citations: false, tools: true, skills: true },
  factory: createGeneralAgent,
};
