import type { Citation } from '../../types.js';

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  capabilities: {
    knowledgeBase: boolean;
    citations: boolean;
  };
}

const definitions: AgentDefinition[] = [
  {
    id: 'general-chat',
    name: '通用对话 Agent',
    description: '通用闲聊与问答',
    capabilities: { knowledgeBase: false, citations: false },
  },
  {
    id: 'knowledge-base',
    name: '知识库问答 Agent',
    description: '基于绑定知识库检索回答',
    capabilities: { knowledgeBase: true, citations: true },
  },
];

export function listAgentDefinitions(): AgentDefinition[] {
  return definitions.map((d) => ({ ...d }));
}

export function getAgentDefinition(agentId: string): AgentDefinition | undefined {
  return definitions.find((d) => d.id === agentId);
}

export function isValidAgentId(agentId: string): boolean {
  return definitions.some((d) => d.id === agentId);
}
