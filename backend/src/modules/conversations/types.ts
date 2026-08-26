import type { Citation } from '../citations/types.js';

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
  status: 'pending' | 'streaming' | 'completed' | 'stopped' | 'failed';
  createdAt: string;
}

export interface CreateConversationInput {
  title?: string;
  agentId: string;
  knowledgeBaseId?: string | null;
}

export interface UpdateConversationInput {
  title?: string;
  agentId?: string;
  knowledgeBaseId?: string | null;
}