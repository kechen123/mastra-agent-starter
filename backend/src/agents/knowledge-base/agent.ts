import { Agent } from '@mastra/core/agent';
import type { AgentDefinition } from '../../core/agent/types.js';
import { config } from '../../config.js';
import { resolveDefaultChatModel } from '../../infrastructure/llm/registry.js';
import { knowledgeBaseInstructions } from './instructions.js';

/**
 * `knowledge-base` Agent 的具体工厂。
 *
 * Runtime 会在调用本工厂之前把引文上下文注入 prompt，因此本 Agent 只需要
 * 按 `knowledge-base/instructions.ts` 中声明的契约回答：仅基于提供的
 * 上下文作答，不杜撰引文。
 *
 * 模型通过 `infrastructure/llm/registry.ts:resolveDefaultChatModel()` 解析，
 * 本工厂不直接读取 Provider 环境变量、不拼接 `provider/model` 字符串。
 */
export function createKnowledgeBaseAgent(tools?: Record<string, unknown>, skills?: unknown[]): Agent {
  return new Agent({
    id: 'knowledge-base',
    name: `${config.appShortName} 知识库问答 Agent`,
    model: resolveDefaultChatModel(),
    instructions: knowledgeBaseInstructions,
    ...(tools && Object.keys(tools).length > 0 ? { tools: tools as any } : {}),
    ...(skills && skills.length > 0 ? { skills: skills as any } : {}),
  });
}

export const knowledgeBaseAgent: AgentDefinition = {
  id: 'knowledge-base',
  name: '知识库问答 Agent',
  description: '基于绑定知识库检索回答',
  toolIds: ['calculator', 'get-current-time'],
  capabilities: { knowledgeBase: true, citations: true, tools: true, skills: true },
  factory: createKnowledgeBaseAgent,
};