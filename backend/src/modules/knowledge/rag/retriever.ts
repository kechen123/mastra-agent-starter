import { DATABASE_EMBEDDING_DIM } from '../../../config.js';
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
 * 当前承载 `topK` 与 `queryEmbedding`；后续要扩展（如 `filter` / `minScore`）
 * 只需新增可选字段，保持向后兼容（调用方传 `{}` 即可拿到默认行为）。
 */
export interface SearchKnowledgeBaseOptions {
  topK?: number;
  /**
   * 可选：调用方已计算好的查询向量（pgvector literal 格式 `[v1,v2,...]`），
   * 长度必须为 `DATABASE_EMBEDDING_DIM`（默认 2048）。
   *
   * 提供后将**跳过**内部 `embedQuery(query)` 调用 —— 用于集成测试 / CI 注入
   * 哑 embedding 避免依赖外部 Embedding API。生产路径不传此字段。
   */
  queryEmbedding?: number[];
  // 后续可加 filter / minScore 等
}

/**
 * 校验 `queryEmbedding` 是否合法（PR-1.2 关闭审查整改）。
 *
 * 四项必须**全部**满足：
 *   1. 是数组（`Array.isArray` === true）；
 *   2. 长度严格等于 `DATABASE_EMBEDDING_DIM`（2048）；
 *   3. 每个元素都是 `number`（`typeof v === 'number'`，排除字符串 / 对象 / undefined）；
 *   4. 每个元素都是**有限数**（`Number.isFinite(v)` 排除 NaN / ±Infinity）。
 *
 * 校验失败时抛 `Error`，错误消息明确指出**哪条规则被违反** —— 让 CI 失败
 * 信号直接可读，避免 PG 端抛 "vector dimension mismatch" 后还得猜是
 * 长度不对还是 NaN。
 *
 * 设计：
 *   - 纯函数：把校验与 SQL 隔离开来，便于单测；
 *   - 不接受"长度合法就 OK"，必须显式 4 条规则全部通过；
 *   - 维度常量复用 `DATABASE_EMBEDDING_DIM`（config.ts 已经是 schema 的真值镜像）。
 */
export function assertQueryEmbeddingValid(embedding: unknown): asserts embedding is number[] {
  if (!Array.isArray(embedding)) {
    throw new Error(
      `queryEmbedding 必须是数组，实际: ${typeof embedding}`,
    );
  }
  if (embedding.length !== DATABASE_EMBEDDING_DIM) {
    throw new Error(
      `queryEmbedding 长度必须为 ${DATABASE_EMBEDDING_DIM}，实际: ${embedding.length}`,
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
 * @param query             用户查询文本（仅在 `queryEmbedding` 未提供时用于
 *                          调外部 Embedding API）。
 * @param options           调用选项；`topK` 默认 5；`queryEmbedding` 提供时
 *                          跳过外部 Embedding 调用。
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

  // 优先用调用方注入的 queryEmbedding；未注入时调外部 Embedding API。
  // 注入通道让集成测试 / case 23 不再依赖外部 Embedding 服务（PR-1.2 关
  // 闭审查整改：23 个隔离用例应一律可在本地 DB 环境自洽执行）。
  //
  // PR-1.2 关闭审查整改：注入向量必须先走 `assertQueryEmbeddingValid`，
  // 否则以下 SQL 把非数 / NaN / 错误维度直接喂给 pgvector，会得到"神秘
  // 错误"而不是清晰的契约错误。
  const embedding = options.queryEmbedding
    ? (assertQueryEmbeddingValid(options.queryEmbedding), options.queryEmbedding)
    : await embedQuery(query);
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