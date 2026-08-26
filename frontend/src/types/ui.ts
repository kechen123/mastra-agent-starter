import type { Citation, KnowledgeBase } from '../lib/api';

/** 应用级 UI 状态类型；不承载后端领域模型。 */
export type Theme = 'light' | 'dark';
export type Module = '对话' | '知识库' | '能力';

export type ToolCallState =
  | { status: 'running'; toolCallId: string; toolName: string }
  | { status: 'completed'; toolCallId: string; toolName: string }
  | { status: 'failed'; toolCallId: string; toolName: string; errorCode: string };

export type ChatMessage =
  | { id: string; role: 'user'; content: string; status: 'completed' | 'failed' }
  | {
      id: string;
      role: 'assistant';
      content: string;
      citations: Citation[];
      status: 'pending' | 'streaming' | 'completed' | 'stopped' | 'failed';
      tools?: ToolCallState[];
    };

export type ConversationState =
  | { type: 'draft'; agentId: string; knowledgeBaseId: string | null }
  | { type: 'persisted'; id: string };

export type KnowledgeBaseChoice = Pick<KnowledgeBase, 'id' | 'name'>;
