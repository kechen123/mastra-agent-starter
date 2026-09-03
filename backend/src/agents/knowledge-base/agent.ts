import { Agent } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core';
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
 *
 * Phase 3.0 修订：工具来源变更（详见 `agents/general-chat/agent.ts`
 * 的注释）。`mastraInstance` 透传给 `new Agent({...})`，让 Agent 通过
 * public Mastra 注册路径同时拿到 tools 与 storage。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createKnowledgeBaseAgent(
  _tools?: Record<string, unknown>,
  skills?: unknown[],
  mastraInstance?: Mastra,
): Agent {
  return new Agent({
    id: 'knowledge-base',
    name: `${config.appShortName} 知识库问答 Agent`,
    model: resolveDefaultChatModel(),
    instructions: knowledgeBaseInstructions,
    ...(skills && skills.length > 0 ? { skills: skills as any } : {}),
    ...(mastraInstance ? { mastra: mastraInstance } : {}),
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
