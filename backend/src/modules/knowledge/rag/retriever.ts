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
 * retriever 调用选项（Spec §retriever）。
 *
 * 当前仅承载 `topK`；后续要扩展（如 `filter` / `minScore`）只需新增可选字段，
 * 保持向后兼容（调用方传 `{}` 即可拿到默认行为）。
 */
export interface SearchKnowledgeBaseOptions {
  topK?: number;
  // 后续可加 filter / minScore 等
}

/**
 * 在指定工作区内检索知识库片段（防御深度 —— Spec §retriever）。
 *
 * 隔离合约：
 *   - 两个 SQL 查询（has-chunks 预检 + chunk 主查询）都按
 *     `workspace_id = $N AND knowledge_base_id = $N` 双重过滤；
 *   - 即使上游 `core/knowledge/search.ts` 预检被绕过，本函数也不会
 *     越权读到其它 workspace 的 chunk。
 *
 * 推荐调用：通过 `core/knowledge/search.ts` 入口（会先校验 KB 归属本工作区，
 * 跨 workspace 抛 `CrossWorkspaceAccessError` —— 404）。
 *
 * @param workspaceId       当前会话所属工作区（来自 `authCtx.workspaceId`）。
 * @param knowledgeBaseId   待检索知识库 ID。
 * @param query             用户查询文本。
 * @param options           调用选项；`topK` 默认 5。
 */
export async function searchKnowledgeBase(
  workspaceId: string,
  knowledgeBaseId: string,
  query: string,
  options: SearchKnowledgeBaseOptions = {},
): Promise<Citation[]> {
  const topK = options.topK ?? 5;
  const pool = getDatabasePool();
  const hasChunks = await pool.query<{ has_chunks: boolean }>(`
    SELECT EXISTS(
      SELECT 1 FROM document_chunks
      WHERE workspace_id = $1 AND knowledge_base_id = $2 AND embedding IS NOT NULL
    ) AS has_chunks
  `, [workspaceId, knowledgeBaseId]);
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
    WHERE c.workspace_id = $2 AND c.knowledge_base_id = $3
      AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> $1::vector
    LIMIT $4
  `, [`[${embedding.join(',')}]`, workspaceId, knowledgeBaseId, topK]);

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
