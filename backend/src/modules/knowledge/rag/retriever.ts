import { getDatabasePool } from '../../../infrastructure/database/pool.js';
import type { Citation } from '../../citations/types.js';
import { embedQuery } from './embedding-service.js';

interface DocumentChunkRow {
  id: string;
  document_id: string;
  document_name: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  distance: string | number;
}

/**
 * 查询指定通用知识库；score 与 distance 均为 pgvector cosine distance，数值越小越相近。
 */
export async function searchKnowledgeBase(
  knowledgeBaseId: string,
  query: string,
  topK = 5,
): Promise<Citation[]> {
  const pool = getDatabasePool();
  const hasChunks = await pool.query<{ has_chunks: boolean }>(`
    SELECT EXISTS(
      SELECT 1 FROM document_chunks
      WHERE knowledge_base_id = $1 AND embedding IS NOT NULL
    ) AS has_chunks
  `, [knowledgeBaseId]);
  if (!hasChunks.rows[0]?.has_chunks) return [];

  const embedding = await embedQuery(query);
  const result = await pool.query<DocumentChunkRow>(`
    SELECT
      c.id,
      c.document_id,
      d.name AS document_name,
      c.chunk_index,
      c.content,
      c.metadata,
      c.embedding <=> $1::vector AS distance
    FROM document_chunks c
    INNER JOIN documents d ON d.id = c.document_id
    WHERE c.knowledge_base_id = $2
      AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> $1::vector
    LIMIT $3
  `, [`[${embedding.join(',')}]`, knowledgeBaseId, topK]);

  return result.rows.map((row) => {
    const metadata = row.metadata ?? {};
    const heading = asOptionalString(metadata.heading);
    const distance = Number(row.distance);
    return {
      chunkId: row.id,
      documentId: row.document_id,
      documentName: row.document_name,
      chunkIndex: row.chunk_index,
      heading,
      title: row.document_name,
      chapter: heading ?? `片段 ${row.chunk_index + 1}`,
      content: row.content,
      score: distance,
      distance,
      category: '用户文档',
      type: 'document',
      source: row.document_name,
    };
  });
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}