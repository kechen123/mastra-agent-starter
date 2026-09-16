import type { Citation } from '../citations/types.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { searchWorkspaceSources } from '../knowledge/rag/retriever.js';
import { getDaymindKnowledgeBaseId } from './service.js';

export interface DaymindRetrievalResult {
  knowledgeBaseId: string | null;
  citations: Citation[];
}

/**
 * Daymind 长期资料的服务端入口。
 *
 * 调用方只需要 workspaceId 与 query；隐藏 Knowledge Base 仅是存储实现，
 * 不接受 Conversation 或前端传入的 knowledgeBaseId。
 */
export async function searchDaymindSources(
  workspaceId: string,
  query: string,
  options: { topK?: number; signal?: AbortSignal } = {},
): Promise<DaymindRetrievalResult> {
  const knowledgeBaseId = await getDaymindKnowledgeBaseId(workspaceId);
  if (!knowledgeBaseId) return { knowledgeBaseId: null, citations: [] };

  const vectorCitations = await searchWorkspaceSources(workspaceId, query, { ...options, minSimilarity: 0.45 });
  if (vectorCitations.length > 0) {
    return { knowledgeBaseId, citations: vectorCitations };
  }

  // 语义模型对短中文问句偶尔把“长期记忆”等原文关键短语压到阈值以下。
  // 仅在向量无可靠命中时，以 4-6 字连续短语回查 Source 原文；仍只返回
  // 同 workspace、可追溯到 Source 的 ready chunk，绝不依赖 Conversation。
  const phrases = sourceQueryPhrases(query);
  if (phrases.length === 0) return { knowledgeBaseId, citations: [] };
  const lexical = await getDatabasePool().query<{
    chunk_id: string; document_id: string; document_name: string; chunk_index: number;
    content: string; source_id: string; source_title: string; source_type: string;
    chunk_metadata: Record<string, unknown> | null;
    source_metadata: Record<string, unknown> | null;
  }>(
    `SELECT c.id AS chunk_id, d.id AS document_id, d.name AS document_name,
            c.chunk_index, c.content, s.id AS source_id, s.title AS source_title,
            s.type AS source_type, c.metadata AS chunk_metadata,
            s.metadata AS source_metadata
       FROM sources s
       JOIN documents d ON d.source_id = s.id
       JOIN document_chunks c ON c.document_id = d.id
      WHERE s.workspace_id = $1
        AND d.workspace_id = $1
        AND d.status = 'ready'
        AND s.normalized_content ILIKE ANY($2::text[])
      ORDER BY d.created_at DESC
      LIMIT $3`,
    [workspaceId, phrases.map((phrase) => `%${phrase}%`), options.topK ?? 5],
  );
  return {
    knowledgeBaseId,
    citations: lexical.rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      documentName: row.document_name,
      chunkIndex: row.chunk_index,
      title: row.document_name,
      chapter: `片段 ${row.chunk_index + 1}`,
      content: row.content,
      // 1 表示关键词精确命中，不是把 cosine similarity 伪装成高分。
      score: 1,
      category: 'Daymind Source（关键词命中）',
      type: 'document',
      source: row.document_name,
      sourceId: row.source_id,
      sourceTitle: row.source_title,
      sourceType: row.source_type,
      ...(typeof row.chunk_metadata?.page === 'number' ? { page: row.chunk_metadata.page } : {}),
      ...(typeof row.chunk_metadata?.heading === 'string' ? { heading: row.chunk_metadata.heading } : {}),
      ...(typeof row.source_metadata?.finalUrl === 'string' ? { url: row.source_metadata.finalUrl } : {}),
    })),
  };
}

function sourceQueryPhrases(query: string): string[] {
  const text = query.replace(/[^\p{Script=Han}]/gu, '');
  const phrases = new Set<string>();
  for (let size = 6; size >= 4; size--) {
    for (let index = 0; index + size <= text.length; index++) {
      phrases.add(text.slice(index, index + size));
    }
  }
  return [...phrases];
}
