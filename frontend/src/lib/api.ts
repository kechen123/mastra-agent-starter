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

export async function askKnowledge(question: string): Promise<GroundedAnswer> {
  const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const data = await response.json() as GroundedAnswer | { message?: string };

  if (!response.ok) {
    throw new Error('message' in data ? data.message ?? '请求失败。' : '请求失败。');
  }
  return data as GroundedAnswer;
}
