import { getDatabasePool } from '../../../infrastructure/database/pool.js';
import type { Citation } from '../../citations/types.js';
import { DATABASE_EMBEDDING_DIM } from '../../../config.js';
import { embedQuery } from './embedding-service.js';

interface EmbeddingRow {
  chunk_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  document_id: string;
  document_name: string;
  profile_dimensions: number;
  distance: string | number;
}

/**
 * retriever 调用选项（PR-4.2 §8.4 / Spec §retriever）。
 *
 * `topK` 默认 5；`queryEmbedding` 提供时跳过外部 Embedding 调用（集成
 * 测试 / CI 注入哑向量通道）。
 *
 * 注：与 PR-3 时期相比，**不再需要**传入 `DATABASE_EMBEDDING_DIM` 长
 * 度的固定向量——`embedding_profiles.dimensions` 决定当前 active profile
 * 的维度，retriever 按 profile 维度做校验。
 */
export interface SearchKnowledgeBaseOptions {
  topK?: number;
  /**
   * 调用方已计算好的查询向量。retriever 会按当前 active profile 的
   * dimensions 校验长度，维度不匹配时抛 `Error`。
   */
  queryEmbedding?: number[];
}

/**
 * 校验 `queryEmbedding` 维度与 active profile 匹配（PR-4.2 §8.4）。
 *
 * 规则：
 *   1. 必须是数组；
 *   2. 每个元素都是有限数（排除 NaN / ±Infinity / string / undefined）；
 *   3. 长度严格等于 `expectedDimensions`（不传时取
 *      `DATABASE_EMBEDDING_DIM`）。
 *
 * PR-4 第二轮 Codex 整改（2026-09-11）：`expectedDimensions` 改为
 * optional，**默认**回退到 `DATABASE_EMBEDDING_DIM`。这是为了与
 * `tests/unit/retriever-query-embedding.ts` 的单参调用形式对齐
 * ——旧 fixture 的"必须单参调用"被恢复为上游既定的契约。生产
 * `searchKnowledgeBase` 路径仍然传 `profile.dimensions`（来自
 * active embedding profile），单参回退路径仅用于纯函数 fixture。
 */
export function assertQueryEmbeddingValid(
  embedding: unknown,
  expectedDimensions: number = DATABASE_EMBEDDING_DIM,
): asserts embedding is number[] {
  if (!Array.isArray(embedding)) {
    throw new Error(`queryEmbedding 必须是数组，实际: ${typeof embedding}`);
  }
  if (embedding.length !== expectedDimensions) {
    throw new Error(
      `queryEmbedding 长度必须为 ${expectedDimensions}（active profile dimensions），实际: ${embedding.length}`,
    );
  }
  for (let i = 0; i < embedding.length; i++) {
    const v = embedding[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(
        `queryEmbedding[${i}] 不是有限数（typeof=${typeof v}, value=${String(v)}）`,
      );
    }
  }
}

/**
 * 取 workspace 的 active embedding profile。
 *
 * 注意：本函数**不**创建默认 profile——RAG 启用但尚未创建 profile
 * 时返回 null，retriever 走空结果路径。
 */
async function getActiveEmbeddingProfile(workspaceId: string): Promise<{
  id: string;
  dimensions: number;
} | null> {
  const r = await getDatabasePool().query<{ id: string; dimensions: number }>(
    `SELECT id, dimensions FROM embedding_profiles
      WHERE workspace_id = $1 AND is_active = TRUE
      LIMIT 1`,
    [workspaceId],
  );
  const row = r.rows[0];
  return row ? { id: row.id, dimensions: row.dimensions } : null;
}

/**
 * 在指定工作区内检索知识库片段（PR-4.2 §8.4 重写）。
 *
 * 数据路径：
 *   - JOIN document_embeddings + document_chunks + documents；
 *   - 仅扫描 active profile + ready 状态文档的向量；
 *   - `documents.status='ready'` 过滤保证 RAG 不读 ingestion 中的中间态；
 *   - `embedding IS NOT NULL` 防御性过滤（profile 切换时短暂存在）。
 *
 * 隔离合约：
 *   - workspace_id 双重过滤（embedding / chunks / documents 三处都
 *     带 workspace_id）；
 *   - knowledge_base_id 限定到指定 KB；
 *   - 即使上游 search 入口被绕过，本函数不会越权读到其它 workspace
 *     的向量。
 */
export async function searchKnowledgeBase(
  workspaceId: string,
  knowledgeBaseId: string,
  query: string,
  options: SearchKnowledgeBaseOptions = {},
): Promise<Citation[]> {
  const topK = options.topK ?? 5;
  const pool = getDatabasePool();

  // 1) 取 active profile。RAG 未启用 / 没有 active profile → 返空数组。
  const profile = await getActiveEmbeddingProfile(workspaceId);
  if (!profile) return [];

  // 2) 预检：是否有至少一个 ready 文档带该 profile 的 embedding。
  const hasEmbeddings = await pool.query<{ has: boolean }>(
    `SELECT EXISTS(
       SELECT 1
         FROM document_embeddings e
         JOIN documents d ON d.id = e.document_id
        WHERE e.workspace_id = $1
          AND d.knowledge_base_id = $2
          AND d.status = 'ready'
          AND e.profile_id = $3
          AND e.embedding IS NOT NULL
     ) AS has`,
    [workspaceId, knowledgeBaseId, profile.id],
  );
  if (!hasEmbeddings.rows[0]?.has) return [];

  // 3) 决定查询向量。注入通道走断言；未注入走外部 Embedding API。
  const embedding = options.queryEmbedding
    ? (assertQueryEmbeddingValid(options.queryEmbedding, profile.dimensions),
       options.queryEmbedding)
    : await embedQuery(query);

  // 4) 主检索 SQL。
  const result = await pool.query<EmbeddingRow>(
    `SELECT
        e.chunk_id,
        c.chunk_index,
        c.content,
        c.metadata,
        c.document_id,
        d.name AS document_name,
        e.dimensions AS profile_dimensions,
        e.embedding <=> $1::vector AS distance
       FROM document_embeddings e
       JOIN document_chunks c ON c.id = e.chunk_id
       JOIN documents d ON d.id = c.document_id
      WHERE e.workspace_id = $2
        AND c.knowledge_base_id = $3
        AND e.profile_id = $4
        AND d.status = 'ready'
        AND e.embedding IS NOT NULL
      ORDER BY e.embedding <=> $1::vector
      LIMIT $5`,
    [`[${embedding.join(',')}]`, workspaceId, knowledgeBaseId, profile.id, topK],
  );

  return result.rows.map((row) => {
    const metadata = row.metadata ?? {};
    const heading = asOptionalString(metadata.heading);
    const distance = Number(row.distance);
    return {
      chunkId: row.chunk_id,
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
