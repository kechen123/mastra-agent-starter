import { Agent } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core';
import type { AgentDefinition } from '../../core/agent/types.js';
import { config } from '../../config.js';
import { resolveDefaultChatModel } from '../../infrastructure/llm/registry.js';
import { daymindInstructions } from './instructions.js';

export function createDaymindAgent(
  tools?: Record<string, unknown>,
  skills?: unknown[],
  mastraInstance?: Mastra,
): Agent {
  return new Agent({
    id: 'daymind',
    name: `${config.appShortName} Agent`,
    model: resolveDefaultChatModel(),
    tools: tools as ConstructorParameters<typeof Agent>[0]['tools'],
    instructions: daymindInstructions,
    ...(skills && skills.length > 0 ? { skills: skills as any } : {}),
    ...(mastraInstance ? { mastra: mastraInstance } : {}),
  });
}

export const daymindAgent: AgentDefinition = {
  id: 'daymind',
  name: 'Daymind Agent',
  description: '默认个人生活与工作助手，可跨会话检索长期资料',
  toolIds: ['calculator', 'get-current-time'],
  capabilities: { knowledgeBase: false, daymindSources: true, citations: true, tools: true, skills: true },
  factory: createDaymindAgent,
};
