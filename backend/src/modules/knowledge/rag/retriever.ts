import { getDatabasePool } from '../../../infrastructure/database/pool.js';
import type { Citation } from '../../citations/types.js';
import { DATABASE_EMBEDDING_DIM, config } from '../../../config.js';
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
 * retriever 调用选项。
 *
 * `topK` 默认 5；`queryEmbedding` 提供时跳过外部 Embedding 调用（集成
 * 测试 / CI 注入哑向量通道）。
 *
 * `signal` 用于把上层 Run / agent 的 AbortSignal 透传到 Embedding API
 * fetch；用户点"停止生成"后 AbortController.abort() 会即时中断上游
 * 网络请求，不再继续等 Embedding 返回。
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
  /**
   * AbortSignal：用户停止 / 超时 / agent 取消时立即中断 Embedding API
   * 与 PG 查询。AbortSignal.timeout(ms) 也可由调用方提供。
   */
  signal?: AbortSignal;
}

/**
 * 校验 `queryEmbedding` 维度与 active profile 匹配。
 *
 * 规则：
 *   1. 必须是数组；
 *   2. 每个元素都是有限数（排除 NaN / ±Infinity / string / undefined）；
 *   3. 长度严格等于 `expectedDimensions`（不传时取
 *      `DATABASE_EMBEDDING_DIM`）。
 *
 * 单参回退路径仅用于纯函数 fixture；生产路径总是由 active profile 提供。
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
 * 把 pgvector cosine distance 转换成 similarity ∈ [-1, 1]（cosine
 * distance 定义为 1 - cosine_similarity）。
 *
 * pgvector 的 `<=>` 操作符对 cosine 距离输出 ∈ [0, 2]，对 unit-normalized
 * 向量输出 ∈ [0, 2]（最差 -1 类似度时 distance=2）。
 * 为保持下游使用"越大越相关"的一致语义，统一转成 1 - distance（clamp 到 [0, 1]）。
 */
function distanceToSimilarity(distance: number): number {
  const sim = 1 - distance;
  if (!Number.isFinite(sim)) return 0;
  if (sim < 0) return 0;
  if (sim > 1) return 1;
  return sim;
}

/**
 * 在指定工作区内检索知识库片段。
 *
 * 数据路径：
 *   - JOIN document_embeddings + document_chunks + documents；
 *   - 仅扫描 active profile + ready 状态文档的向量；
 *   - `documents.status='ready'` 过滤保证 RAG 不读 ingestion 中的中间态；
 *   - `embedding IS NOT NULL` 防御性过滤（profile 切换时短暂存在）。
 *
 * 相似度阈值（PR-4.3）：
 *   - Top K 先按 cosine distance 升序取回；
 *   - 然后用 similarity = 1 - distance 过滤掉低于
 *     `config.ragMinSimilarity` 的 chunk；
 *   - 全部低于阈值 → 视为"未命中可靠数据"，返回空数组（上层 agent 走
 *     "无可靠资料"语义，绝不注入不相关 chunk）。
 *
 * 隔离合约：
 *   - workspace_id 双重过滤（embedding / chunks / documents 三处都
 *     带 workspace_id）；
 *   - knowledge_base_id 限定到指定 KB；
 *   - 即使上游 search 入口被绕过，本函数不会越权读到其它 workspace
 *     的向量。
 *
 * AbortSignal 传播：
 *   - 透传到 `embedQuery` → Embedding API fetch；
 *   - 用户停止 / 超时立即中断上游 fetch 与 PG 查询；
 *   - signal 已 abort → 本函数立即抛 AbortError，上层需按"未命中"处理。
 */
export async function searchKnowledgeBase(
  workspaceId: string,
  knowledgeBaseId: string,
  query: string,
  options: SearchKnowledgeBaseOptions = {},
): Promise<Citation[]> {
  const topK = options.topK ?? 5;
  const minSimilarity = config.ragMinSimilarity;
  const signal = options.signal;
  if (signal?.aborted) {
    throw new DOMException('RAG retrieval aborted before start', 'AbortError');
  }
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

  // 3) 决定查询向量。注入通道走断言；未注入走外部 Embedding API（带 signal）。
  const embedding = options.queryEmbedding
    ? (assertQueryEmbeddingValid(options.queryEmbedding, profile.dimensions),
       options.queryEmbedding)
    : await embedQuery(query, signal);

  if (signal?.aborted) {
    throw new DOMException('RAG retrieval aborted after embedding', 'AbortError');
  }

  // 4) 主检索 SQL：先按 cosine distance 取 topK，再在内存里按 similarity 阈值过滤。
  //    SQL 内同时做 threshold 过滤更省内存，但 cosine distance 表达
  //    1 - similarity 在 SQL 中需要 (1 - distance) >= threshold → distance <= 1 - threshold，
  //    容易混淆；当前实现取回 topK 后在内存里明确按 similarity 过滤，
  //    便于测试与日志。
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

  return result.rows
    .map((row) => {
      const metadata = row.metadata ?? {};
      const heading = asOptionalString(metadata.heading);
      const rawDistance = Number(row.distance);
      const similarity = distanceToSimilarity(rawDistance);
      // 字段语义（PR-review Item 6 修复，必须保持两条独立含义）：
      //   - distance：原始 cosine distance，越小越相关（pgvector `<=>`
      //     输出 ∈ [0, 2]，unit-normalized 向量 ∈ [0, 2]）。
      //   - score：similarity = 1 - distance，已 clamp 到 [0, 1]，越大越相关。
      // 阈值比较只走 score。
      // 之前的实现把 similarity 写回 distance 字段，破坏了距离语义
      // （任何按 distance 排序的下游都会按"越大越相关"反向读）。
      return {
        chunkId: row.chunk_id,
        documentId: row.document_id,
        documentName: row.document_name,
        chunkIndex: row.chunk_index,
        heading,
        title: row.document_name,
        chapter: heading ?? `片段 ${row.chunk_index + 1}`,
        content: row.content,
        score: similarity,
        distance: rawDistance,
        category: '用户文档',
        type: 'document',
        source: row.document_name,
      };
    })
    .filter((c) => c.score >= minSimilarity);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
