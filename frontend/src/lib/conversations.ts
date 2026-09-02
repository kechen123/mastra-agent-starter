/**
 * 会话/Run API 客户端（V2 阶段 2）。
 *
 * 协议分层：
 *   - 旧：POST /ask (SSE)、POST /conversations、POST /messages/:id/{regenerate,stop}
 *     — 保留至 2027-02-01，前端主流程不再使用；
 *   - 新：POST /v1/v2alpha/conversations（创建 draft）、POST .../messages（同步返回 runId）、
 *     GET /v1/v2alpha/runs/:runId/events（GET SSE + Last-Event-ID 重连）；
 *
 * V1 `/v1/*` 同形接口在阶段 3 之后切为前端主入口，阶段 2 暂时不调。
 */
import { getApiBaseUrl, request, UnauthenticatedError } from './api';
import type { ConversationDetail, ConversationSummary, Message, AgentDefinition } from '../types/conversation';

const V2_PREFIX = '/v1/v2alpha';
const LEGACY_PREFIX = '';

export function listAgents(): Promise<AgentDefinition[]> {
  return request<AgentDefinition[]>('/agents');
}

export function listConversations(): Promise<ConversationSummary[]> {
  return request<ConversationSummary[]>(`${LEGACY_PREFIX}/conversations`);
}

export interface CreateDraftResult {
  id: string;
  agentId: string;
  knowledgeBaseId: string | null;
  createdAt: string;
}

/**
 * 阶段 2：创建服务端 draft conversation。draft 不必含任何 message，
 * 前端拿到 id 后立即 replaceState 到 `/chat/:id`，供刷新恢复。
 */
export async function createDraftConversation(input: {
  agentId: string;
  knowledgeBaseId?: string | null;
}): Promise<CreateDraftResult> {
  const baseUrl = getApiBaseUrl();
  const idemKey = generateUuid();
  const response = await fetch(`${baseUrl}${V2_PREFIX}/conversations`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey,
    },
    body: JSON.stringify(input),
  });
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string; error_code?: string } | null;
    throw new Error(data?.message ?? '创建对话失败。');
  }
  return response.json() as Promise<CreateDraftResult>;
}

export class ConversationAccessError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ConversationAccessError';
    this.status = status;
  }
}

export interface V2ConversationDetail {
  conversation: ConversationDetail;
  messages: Array<Message & { currentRunId: string | null }>;
}

/**
 * 阶段 2：通过 GET /v1/v2alpha/conversations/:id 读历史。
 * 响应内每条 message 附带 currentRunId；非空说明该 message 当前有活跃 Run，
 * 前端应使用 GET /v1/v2alpha/runs/:runId/events 继续订阅。
 */
export async function getConversation(id: string): Promise<V2ConversationDetail> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}${V2_PREFIX}/conversations/${id}`, {
    method: 'GET',
    credentials: 'same-origin',
  });
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string; error_code?: string } | null;
    const message = data?.message ?? '加载会话失败。';
    if (response.status === 404) {
      throw new ConversationAccessError(message, 404);
    }
    throw new ConversationAccessError(message, response.status);
  }
  return response.json() as Promise<V2ConversationDetail>;
}

export function updateConversation(id: string, input: { title?: string; agentId?: string; knowledgeBaseId?: string | null }): Promise<ConversationDetail> {
  return request<ConversationDetail>(`${LEGACY_PREFIX}/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deleteConversation(id: string): Promise<void> {
  return request<void>(`${LEGACY_PREFIX}/conversations/${id}`, { method: 'DELETE' });
}

export interface PostMessageResult {
  userMessageId: string;
  assistantMessageId: string;
  runId: string;
  eventsUrl: string;
}

export async function postMessage(conversationId: string, content: string): Promise<PostMessageResult> {
  const baseUrl = getApiBaseUrl();
  const idemKey = generateUuid();
  const response = await fetch(`${baseUrl}${V2_PREFIX}/conversations/${conversationId}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey,
    },
    body: JSON.stringify({ content }),
  });
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string; error_code?: string } | null;
    if (response.status === 409 && data?.error_code === 'CONVERSATION_CONFLICT_ACTIVE_RUN') {
      throw new ConversationActiveRunError(data.message ?? '已有正在进行的生成。');
    }
    throw new Error(data?.message ?? '发送失败。');
  }
  return response.json() as Promise<PostMessageResult>;
}

export class ConversationActiveRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationActiveRunError';
  }
}

/**
 * 阶段 2：使用 EventSource 订阅 Run 事件。EventSource 不支持自定义头，
 * 因此 lastEventId 通过 query string 传递；服务端 SSE 模块接受二者之一。
 */
export interface RunStreamHandlers {
  onEvent: (event: V2RunEvent) => void;
  onLastEventId?: (id: number) => void;
  onError?: (err: unknown) => void;
  onOpen?: () => void;
}

export type V2RunEvent =
  | { id: number; type: 'run-queued'; payload: { assistantMessageId: string } }
  | { id: number; type: 'run-started'; payload: { agentId: string; model: string } }
  | { id: number; type: 'content-checkpoint'; payload: { text: string; accumulatedLength: number } }
  // 实时增量：SSE id 恒为 0（前端不应据此推进 lastEventId）；刷新 / 重连
  // 时不走此通道，仅靠 content-checkpoint 回放。
  | { id: number; type: 'content-delta'; payload: { runId: string; text: string } }
  | { id: number; type: 'tool-call-started'; payload: { toolCallId: string; toolName: string } }
  | { id: number; type: 'tool-call-completed'; payload: { toolCallId: string; toolName: string } }
  | { id: number; type: 'approval-requested'; payload: unknown }
  | { id: number; type: 'approval-resolved'; payload: unknown }
  | { id: number; type: 'run-completed'; payload: { contentLength: number } }
  | { id: number; type: 'run-stopped'; payload: { contentLength: number } }
  | { id: number; type: 'run-failed'; payload: { errorCode: string; message?: string } };

export interface RunStreamHandle {
  close: () => void;
  /** 由 streamSessionStorage key 提供；用于断线后重连。 */
  lastEventId: () => number;
}

export function streamRunEvents(
  eventsUrl: string,
  runId: string,
  handlers: RunStreamHandlers,
  initialLastEventId = 0,
): RunStreamHandle {
  let lastEventId = initialLastEventId;
  let stopped = false;
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // 字段名：同 runId 维度存储 lastEventId，浏览器关闭即失效。
  const lastEventIdKey = sessionStorageKey(runId);

  function open() {
    if (stopped) return;
    const url = new URL(eventsUrl, window.location.origin);
    if (lastEventId > 0) url.searchParams.set('lastEventId', String(lastEventId));
    source = new EventSource(url.toString(), { withCredentials: true });

    source.addEventListener('open', () => {
      handlers.onOpen?.();
    });

    // 通过 SSE `id` 行接收 lastEventId 持久化；统一监听任何事件名
    source.addEventListener('run-queued', dispatch);
    source.addEventListener('run-started', dispatch);
    source.addEventListener('content-checkpoint', dispatch);
    source.addEventListener('content-delta', dispatch);
    source.addEventListener('tool-call-started', dispatch);
    source.addEventListener('tool-call-completed', dispatch);
    source.addEventListener('approval-requested', dispatch);
    source.addEventListener('approval-resolved', dispatch);
    source.addEventListener('run-completed', dispatch);
    source.addEventListener('run-stopped', dispatch);
    source.addEventListener('run-failed', dispatch);

    source.addEventListener('error', (e) => {
      handlers.onError?.(e);
      // EventSource 自动重连，但我们仍记录最后一次成功 id 给 onmessage 用。
      if (source && source.readyState === EventSource.CLOSED) {
        scheduleReconnect();
      }
    });
  }

  function dispatch(this: EventSource, ev: MessageEvent) {
    // SSE 规范：事件 ID 由浏览器从 `id:` 行同步到 MessageEvent.lastEventId。
    // EventSource 自身没有 lastEventId 字段。
    const id = Number(ev.lastEventId ?? '0');
    if (!Number.isFinite(id) || id <= 0) {
      // 没有 id 时仍然分发（按事件原样）；但 lastEventId 不前进。
      // 实时增量 content-delta 永远走这条路径——刷新时不通过它回放。
      try {
        handlers.onEvent({ id: 0, type: ev.type as V2RunEvent['type'], payload: JSON.parse(ev.data) });
      } catch (err) {
        handlers.onError?.(err);
      }
      return;
    }
    lastEventId = id;
    persistLastEventId(lastEventIdKey, lastEventId);
    handlers.onLastEventId?.(lastEventId);
    try {
      handlers.onEvent({ id, type: ev.type as V2RunEvent['type'], payload: JSON.parse(ev.data) });
    } catch (err) {
      handlers.onError?.(err);
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      source?.close();
      source = null;
      open();
    }, 1500);
  }

  open();

  return {
    close() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      source?.close();
      source = null;
    },
    lastEventId: () => lastEventId,
  };
}

export function readPersistedLastEventId(runId: string): number {
  try {
    const raw = sessionStorage.getItem(sessionStorageKey(runId));
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function clearPersistedLastEventId(runId: string): void {
  try {
    sessionStorage.removeItem(sessionStorageKey(runId));
  } catch { /* ignore */ }
}

function sessionStorageKey(runId: string): string {
  return `mastra:lastEventId:${runId}`;
}

function persistLastEventId(key: string, value: number): void {
  try {
    sessionStorage.setItem(key, String(value));
  } catch { /* ignore */ }
}

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC 4122 fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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

/**
 * 旧 SSE 客户端（/ask, /messages/:id/regenerate）。仅保留供 V2 之前的
 * 历史兼容；主流程由 `streamRunEvents` 接管。
 */
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
