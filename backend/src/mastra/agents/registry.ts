import type { Citation } from '../../types.js';

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  toolIds?: string[];
  defaultSkillIds?: string[];
  capabilities: {
    knowledgeBase: boolean;
    citations: boolean;
    tools: boolean;
    skills: boolean;
  };
}

const definitions: AgentDefinition[] = [
  {
    id: 'general-chat',
    name: '通用对话 Agent',
    description: '通用闲聊与问答',
    toolIds: ['calculator', 'get-current-time'],
    defaultSkillIds: ['structured-summary'],
    capabilities: { knowledgeBase: false, citations: false, tools: true, skills: true },
  },
  {
    id: 'knowledge-base',
    name: '知识库问答 Agent',
    description: '基于绑定知识库检索回答',
    toolIds: ['calculator', 'get-current-time'],
    defaultSkillIds: ['structured-summary'],
    capabilities: { knowledgeBase: true, citations: true, tools: true, skills: true },
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
