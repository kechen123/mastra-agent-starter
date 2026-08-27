export interface Capabilities {
  app?: {
    name: string;
    shortName: string;
  };
  documentFormats: string[];
  mineruEnabled: boolean;
  chatAgents: ChatAgentInfo[];
  defaultChatModel: string;
  llm?: {
    provider: string;
    model: string;
    displayName: string;
  };
}

const DEFAULT_API_BASE_URL = '/api';

export function getApiBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
}

export interface ChatAgentInfo {
  id: string;
  name: string;
  requiresKnowledgeBase: boolean;
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  app: { name: 'Mastra Agent Starter', shortName: 'Mastra' },
  documentFormats: ['txt', 'md'],
  mineruEnabled: false,
  chatAgents: [
    { id: 'general-chat', name: '通用对话 Agent', requiresKnowledgeBase: false },
    { id: 'knowledge-base', name: '知识库问答 Agent', requiresKnowledgeBase: true },
  ],
  defaultChatModel: 'deepseek/deepseek-v4-flash',
  llm: { provider: 'deepseek', model: 'deepseek-v4-flash', displayName: 'DeepSeek' },
};

/**
 * HTTP 调用默认携带同源 Cookie。
 *
 * 后端会话认证只接受 `mastra_session` Cookie；不接收 Authorization header /
 * API Key。所有 fetch 都必须带 `credentials: 'same-origin'`。这条规则适用于
 * JSON 请求、SSE 长连接与 stop 请求。
 */
const DEFAULT_CREDENTIALS: RequestCredentials = 'same-origin';

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export interface SafeUser {
  id: string;
  username: string;
}

export async function getCapabilities(): Promise<Capabilities> {
  try {
    return await request<Capabilities>('/capabilities');
  } catch (error) {
    // 401 必须向上抛 UnauthenticatedError，让 App 退回登录页；其它错误
    // （网络/5xx/解析）才回退默认能力。
    if (error instanceof UnauthenticatedError) throw error;
    return DEFAULT_CAPABILITIES;
  }
}

export interface Citation {
  chunkId: string;
  title: string;
  chapter: string;
  content: string;
  score: number;
  author?: string;
  dynasty?: string;
  category: string;
  version?: string;
  type: string;
  originalWork?: string;
  commentator?: string;
  source: string;
  documentId?: string;
  documentName?: string;
  heading?: string;
  distance?: number;
}

export interface GroundedAnswer {
  answer: string;
  citations: Citation[];
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  chunkCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  knowledgeBaseId: string;
  name: string;
  type: string;
  size: number;
  status: 'uploaded' | 'parsing' | 'chunking' | 'embedding' | 'completed' | 'failed';
  errorMessage: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function askKnowledge(
  question: string,
  agentId: string,
  knowledgeBaseId?: string,
): Promise<GroundedAnswer> {
  const body: Record<string, unknown> = { question, agentId };
  if (knowledgeBaseId) {
    body.knowledgeBaseId = knowledgeBaseId;
  }
  return request<GroundedAnswer>('/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  return request('/knowledge-bases');
}

export function createKnowledgeBase(input: { name: string; description?: string }): Promise<KnowledgeBase> {
  return request('/knowledge-bases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deleteKnowledgeBase(id: string): Promise<void> {
  return request<void>(`/knowledge-bases/${id}`, { method: 'DELETE' });
}

export function listDocuments(knowledgeBaseId: string): Promise<KnowledgeDocument[]> {
  return request(`/knowledge-bases/${knowledgeBaseId}/documents`);
}

export function uploadDocument(knowledgeBaseId: string, file: File): Promise<KnowledgeDocument> {
  const formData = new FormData();
  formData.append('file', file);
  return request(`/knowledge-bases/${knowledgeBaseId}/documents`, {
    method: 'POST',
    body: formData,
    credentials: DEFAULT_CREDENTIALS,
  });
}

export async function deleteDocument(id: string): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/documents/${id}`, {
    method: 'DELETE',
    credentials: DEFAULT_CREDENTIALS,
  });
  if (!response.ok) await throwResponseError(response);
}

/**
 * 登录：成功由后端写 HttpOnly Cookie；失败抛 AuthError 或普通 Error。
 * 不会写入密码 / session token 到任何前端持久化 / 日志。
 */
export async function login(input: { username: string; password: string }): Promise<SafeUser> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: input.username, password: input.password }),
    credentials: DEFAULT_CREDENTIALS,
  });
  if (!response.ok) {
    await throwResponseError(response);
  }
  const data = (await response.json().catch(() => null)) as { user?: SafeUser } | null;
  if (!data?.user?.id || !data.user.username) {
    throw new Error('登录响应缺少用户信息。');
  }
  return data.user;
}

export async function logout(): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST',
    credentials: DEFAULT_CREDENTIALS,
  });
  if (!response.ok && response.status !== 401) {
    await throwResponseError(response);
  }
}

export class UnauthenticatedError extends Error {
  readonly status = 401;
  constructor(message = '未登录或会话已失效。') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/**
 * 读取当前登录用户：成功返回 SafeUser；后端返回 401 时抛 UnauthenticatedError；
 * 其它错误透传。绝不在前端持久化任何 session token。
 */
export async function getCurrentUser(): Promise<SafeUser> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/auth/me`, {
    method: 'GET',
    credentials: DEFAULT_CREDENTIALS,
  });
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    await throwResponseError(response);
  }
  const data = (await response.json().catch(() => null)) as { user?: SafeUser } | null;
  if (!data?.user?.id || !data.user.username) {
    throw new Error('认证响应缺少用户信息。');
  }
  return data.user;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getApiBaseUrl();
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has('Content-Type') && init?.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: DEFAULT_CREDENTIALS,
    headers,
  });
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) await throwResponseError(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function throwResponseError(response: Response): Promise<never> {
  const data = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
  const message = data?.message ?? data?.error ?? '请求失败。';
  if (response.status === 401) {
    throw new UnauthenticatedError(message);
  }
  throw new Error(message);
}

export interface ToolDefinition {
  id: string;
  displayName: string;
  description: string;
  metadata: {
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
    openWorld: boolean;
    requiresRuntime?: boolean;
  };
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'marketplace' | 'local';
  compatibility: 'compatible' | 'requires-runtime' | 'unsupported' | 'unknown';
  hasScripts: boolean;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
}

export function listTools(): Promise<ToolDefinition[]> {
  return request('/tools');
}

export function listSkills(): Promise<SkillSummary[]> {
  return request('/skills');
}

export function getSkill(id: string): Promise<SkillSummary> {
  return request(`/skills/${id}`);
}

export interface MarketSkillInfo {
  id: string;
  owner: string;
  repo: string;
  skillName: string;
  name: string;
  description: string;
  source: string;
  installs: number;
  compatibility: 'compatible' | 'requires-runtime' | 'unsupported' | 'unknown';
  hasScripts: boolean;
  installable: boolean;
}

export interface MarketSkillPreview {
  id: string;
  owner: string;
  repo: string;
  skillName: string;
  name: string;
  description: string;
  source: string;
  skillMd: string;
  compatibility: 'compatible' | 'requires-runtime' | 'unsupported' | 'unknown';
  files: string[];
  hasScripts: boolean;
}

export function searchMarketSkills(query: string, limit = 20): Promise<{ results: MarketSkillInfo[] }> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return request(`/skills/market/search?${params.toString()}`);
}

export function listPopularMarketSkills(): Promise<{ results: MarketSkillInfo[] }> {
  return request('/skills/market/popular');
}

export function previewMarketSkill(owner: string, repo: string, skillName: string): Promise<MarketSkillPreview> {
  return request('/skills/market/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner, repo, skillName }),
  });
}

export function installMarketSkill(owner: string, repo: string, skillName: string): Promise<MarketSkillPreview> {
  return request('/skills/market/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner, repo, skillName }),
  });
}

export function updateMarketSkill(id: string): Promise<SkillSummary> {
  return request(`/skills/${id}/update`, { method: 'POST' });
}

export function removeSkill(id: string): Promise<void> {
  return request<void>(`/skills/${id}`, { method: 'DELETE' });
}

export function bindSkillToAgent(skillId: string, agentId: string): Promise<void> {
  return request<void>(`/skills/${skillId}/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
}

export function unbindSkillFromAgent(skillId: string, agentId: string): Promise<void> {
  return request<void>(`/skills/${skillId}/unbind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
}

export { request, throwResponseError };
