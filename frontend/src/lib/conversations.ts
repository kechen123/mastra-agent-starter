import { getApiBaseUrl, request, UnauthenticatedError } from './api';
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

/**
 * 区分 401 与 404 的会话读取错误：401 仍走 UnauthenticatedError；其它非 2xx
 * （包括跨 Workspace 的 404）以 ConversationAccessError 抛出，附带 HTTP 状态。
 * 前端用它把"会话不存在 / 无权访问"映射成"清理 URL + 友好提示"。
 */
export class ConversationAccessError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ConversationAccessError';
    this.status = status;
  }
}

export async function getConversation(id: string): Promise<{ conversation: ConversationDetail; messages: Message[] }> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/conversations/${id}`, {
    method: 'GET',
    credentials: 'same-origin',
  });
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    const message = data?.message ?? data?.error ?? '加载会话失败。';
    throw new ConversationAccessError(message, response.status);
  }
  return response.json() as Promise<{ conversation: ConversationDetail; messages: Message[] }>;
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
  status: 'pending' | 'streaming' | 'completed' | 'stopped' | 'failed';
  createdAt: string;
}

export interface ToolCallStart {
  toolCallId: string;
  toolName: string;
  status: 'running';
}

export interface ToolCallComplete {
  toolCallId: string;
  toolName: string;
  status: 'completed';
}

export interface ToolCallError {
  toolCallId: string;
  toolName: string;
  status: 'failed';
  errorCode: string;
}

export type SSEEvent =
  | { event: 'message-start'; data: { id: string; role: 'assistant'; status: string } }
  | { event: 'content-delta'; data: { messageId: string; text: string } }
  | { event: 'message-complete'; data: AskResult }
  | { event: 'message-error'; data: AskResult & { error: { message: string } } }
  | { event: 'tool-call-start'; data: ToolCallStart }
  | { event: 'tool-call-complete'; data: ToolCallComplete }
  | { event: 'tool-call-error'; data: ToolCallError };

export function streamAskMessage(
  conversationId: string,
  message: string,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return postSSE('/ask', { conversationId, message }, onEvent, signal);
}

export function regenerateMessage(
  assistantMessageId: string,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return postSSE(`/messages/${assistantMessageId}/regenerate`, {}, onEvent, signal);
}

export async function stopMessage(assistantMessageId: string): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/messages/${assistantMessageId}/stop`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (response.status === 401) {
    throw new (await import('./api')).UnauthenticatedError();
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(data?.message ?? data?.error ?? '停止失败。');
  }
}

async function postSSE(
  path: string,
  body: Record<string, unknown>,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
    credentials: 'same-origin',
  });
  if (response.status === 401) {
    const { UnauthenticatedError } = await import('./api');
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(data?.message ?? data?.error ?? '请求失败。');
  }
  if (!response.body) throw new Error('响应体为空。');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];

  function dispatch() {
    if (!eventName || dataLines.length === 0) {
      eventName = '';
      dataLines = [];
      return;
    }
    const data = dataLines.join('\n');
    if (
      eventName === 'message-start' ||
      eventName === 'content-delta' ||
      eventName === 'message-complete' ||
      eventName === 'message-error' ||
      eventName === 'tool-call-start' ||
      eventName === 'tool-call-complete' ||
      eventName === 'tool-call-error'
    ) {
      const parsed = JSON.parse(data);
      onEvent({ event: eventName as SSEEvent['event'], data: parsed });
    }
    eventName = '';
    dataLines = [];
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 处理缓冲区里所有完整行（单行可能跨多个 chunk）
      let eolIndex: number;
      while ((eolIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, eolIndex);
        buffer = buffer.slice(eolIndex + 1);
        const cleanLine = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (cleanLine === '') {
          dispatch();
        } else if (cleanLine.startsWith('event: ')) {
          eventName = cleanLine.slice(7);
        } else if (cleanLine.startsWith('data: ')) {
          dataLines.push(cleanLine.slice(6));
        }
      }
    }
    // 流结束时处理残留数据（可能不以空行结尾）
    if (buffer.length > 0) {
      const cleanLine = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      if (cleanLine === '') {
        dispatch();
      } else if (cleanLine.startsWith('event: ')) {
        eventName = cleanLine.slice(7);
      } else if (cleanLine.startsWith('data: ')) {
        dataLines.push(cleanLine.slice(6));
      }
    }
    dispatch();
  } finally {
    reader.releaseLock();
  }
}
