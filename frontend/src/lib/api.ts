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
  type: 'scripture' | 'commentary' | 'historical' | 'research';
  originalWork?: string;
  commentator?: string;
  source: string;
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

export async function askKnowledge(question: string): Promise<GroundedAnswer> {
  return request<GroundedAnswer>('/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
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

export function listDocuments(knowledgeBaseId: string): Promise<KnowledgeDocument[]> {
  return request(`/knowledge-bases/${knowledgeBaseId}/documents`);
}

export function uploadDocument(knowledgeBaseId: string, file: File): Promise<KnowledgeDocument> {
  const formData = new FormData();
  formData.append('file', file);
  return request(`/knowledge-bases/${knowledgeBaseId}/documents`, { method: 'POST', body: formData });
}

export async function deleteDocument(id: string): Promise<void> {
  const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/documents/${id}`, { method: 'DELETE' });
  if (!response.ok) await throwResponseError(response);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) await throwResponseError(response);
  return response.json() as Promise<T>;
}

async function throwResponseError(response: Response): Promise<never> {
  const data = await response.json().catch(() => null) as { message?: string } | null;
  throw new Error(data?.message ?? '请求失败。');
}
