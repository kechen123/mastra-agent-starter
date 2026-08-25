import type { Citation } from '../lib/api';

export interface ConversationSummary {
  id: string;
  title: string;
  agentId: string;
  knowledgeBaseId: string | null;
  knowledgeBaseName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail {
  id: string;
  title: string;
  agentId: string;
  knowledgeBaseId: string | null;
  knowledgeBaseName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  status: 'completed' | 'failed';
  createdAt: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  capabilities: {
    knowledgeBase: boolean;
    citations: boolean;
  };
}
