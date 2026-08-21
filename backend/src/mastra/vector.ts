import { PgVector } from '@mastra/pg';
import { config } from '../config.js';

export const SCRIPTURE_INDEX = 'xuanshu_scripture_chunks';
export const EMBEDDING_DIMENSION = config.embeddingDim;

export const scriptureVector = new PgVector({
  id: 'xuanshu-pgvector',
  connectionString: process.env.DATABASE_URL!,
});

export async function ensureScriptureIndex(): Promise<void> {
  const indexes = await scriptureVector.listIndexes();
  if (!indexes.includes(SCRIPTURE_INDEX)) {
    await scriptureVector.createIndex({
      indexName: SCRIPTURE_INDEX,
      dimension: EMBEDDING_DIMENSION,
      metric: 'cosine',
      // 豆包模型输出 2048 维，超过 pgvector HNSW 的 2000 维上限；V0.1 使用精确检索。
      buildIndex: false,
    });
  }
}
