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

export async function getCapabilities(): Promise<Capabilities> {
  try {
    return await request<Capabilities>('/capabilities');
  } catch {
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
  chunkIndex?: number;
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
  return request(`/knowledge-bases/${knowledgeBaseId}/documents`, { method: 'POST', body: formData });
}

export async function deleteDocument(id: string): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/documents/${id}`, { method: 'DELETE' });
  if (!response.ok) await throwResponseError(response);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) await throwResponseError(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function throwResponseError(response: Response): Promise<never> {
  const data = (await response.json().catch(() => null)) as { message?: string } | null;
  throw new Error(data?.message ?? '请求失败。');
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