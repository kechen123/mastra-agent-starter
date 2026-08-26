import { Agent } from '@mastra/core/agent';
import type { AgentDefinition } from '../../core/agent/types.js';
import { config } from '../../config.js';
import { resolveDefaultChatModel } from '../../infrastructure/llm/registry.js';
import { generalChatInstructions } from './instructions.js';

/**
 * `general-chat` Agent 的具体工厂。
 * 接收本次请求已解析好的 tools / skills，返回一个可运行的 Mastra Agent。
 * Core Runtime 通过 AgentDefinition.factory 调用此工厂——通用驱动逻辑
 * 见 `core/agent/runtime.ts`。
 *
 * 模型通过 `infrastructure/llm/registry.ts:resolveDefaultChatModel()` 解析：
 * 本工厂不直接读取 Provider 环境变量、不拼接 `provider/model` 字符串；
 * 这些细节全部收敛在 Provider Adapter 内部。
 */
export function createGeneralAgent(tools?: Record<string, unknown>, skills?: unknown[]): Agent {
  return new Agent({
    id: 'general-chat',
    name: `${config.appShortName} 通用对话 Agent`,
    model: resolveDefaultChatModel(),
    instructions: generalChatInstructions,
    ...(tools && Object.keys(tools).length > 0 ? { tools: tools as any } : {}),
    ...(skills && skills.length > 0 ? { skills: skills as any } : {}),
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