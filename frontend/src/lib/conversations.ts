import { request } from './api';
import type { ConversationDetail, ConversationSummary, Message, AgentDefinition } from '../types/conversation';

export function listAgents(): Promise<AgentDefinition[]> {
  return request<AgentDefinition[]>('/agents');
}

export function listConversations(): Promise<ConversationSummary[]> {
  return request<ConversationSummary[]>('/conversations');
}

export function createConversation(input: { agentId: string; knowledgeBaseId?: string | null; title?: string }): Promise<ConversationDetail> {
  return request<ConversationDetail>('/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function getConversation(id: string): Promise<{ conversation: ConversationDetail; messages: Message[] }> {
  return request<{ conversation: ConversationDetail; messages: Message[] }>(`/conversations/${id}`);
}

export function updateConversation(id: string, input: { title?: string; agentId?: string; knowledgeBaseId?: string | null }): Promise<ConversationDetail> {
  return request<ConversationDetail>(`/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deleteConversation(id: string): Promise<void> {
  return request<void>(`/conversations/${id}`, { method: 'DELETE' });
}

export interface AskResult {
  id: string;
  role: 'assistant';
  content: string;
  citations: import('./api').Citation[];
  status: 'completed' | 'failed';
  createdAt: string;
}

export function askMessage(conversationId: string, message: string): Promise<AskResult> {
  return request<AskResult>('/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, message }),
  });
}
