import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PgVector } from '@mastra/pg';

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} \u5FC5\u987B\u662F\u6B63\u6574\u6570`);
  }
  return value;
}
const config = {
  embeddingApiKey: process.env.EMBEDDING_API_KEY ?? "",
  embeddingBaseUrl: process.env.EMBEDDING_BASE_URL ?? "",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "doubao-embedding-vision-251215",
  embeddingDim: positiveInteger("EMBEDDING_DIM", 2048)
};

function assertEmbeddingConfig() {
  if (!config.embeddingApiKey) throw new Error("EMBEDDING_API_KEY \u672A\u914D\u7F6E");
  if (!config.embeddingBaseUrl) throw new Error("EMBEDDING_BASE_URL \u672A\u914D\u7F6E");
}
function embeddingUrl() {
  const baseUrl = config.embeddingBaseUrl.replace(/\/$/, "");
  return baseUrl.endsWith("/embeddings/multimodal") ? baseUrl : `${baseUrl}/embeddings`;
}
function normalizeEmbedding(value) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number")) {
    throw new Error("Embedding \u63A5\u53E3\u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u5411\u91CF\u683C\u5F0F");
  }
  if (value.length !== config.embeddingDim) {
    throw new Error(`Embedding \u7EF4\u5EA6\u4E0D\u5339\u914D\uFF1A\u671F\u671B ${config.embeddingDim}\uFF0C\u5B9E\u9645 ${value.length}`);
  }
  return value;
}
async function request(body) {
  assertEmbeddingConfig();
  const response = await fetch(embeddingUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.embeddingApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : void 0;
  } catch {
  }
  if (!response.ok) {
    const detail = payload?.error ? JSON.stringify(payload.error) : text || response.statusText;
    throw new Error(`Embedding \u8BF7\u6C42\u5931\u8D25\uFF1A${response.status} ${detail}`);
  }
  if (Array.isArray(payload?.data)) return payload.data.map((item) => normalizeEmbedding(item.embedding));
  if (payload?.data && typeof payload.data === "object") return [normalizeEmbedding(payload.data.embedding)];
  throw new Error("Embedding \u63A5\u53E3\u8FD4\u56DE\u683C\u5F0F\u5F02\u5E38\uFF1A\u7F3A\u5C11 data.embedding");
}
async function embedQuery(text) {
  const vectors = await embedTexts([text]);
  if (!vectors[0]) throw new Error("Embedding \u63A5\u53E3\u6CA1\u6709\u8FD4\u56DE\u67E5\u8BE2\u5411\u91CF");
  return vectors[0];
}
async function embedTexts(texts) {
  if (texts.length === 0) return [];
  const isMultimodal = embeddingUrl().endsWith("/embeddings/multimodal");
  if (!isMultimodal) return request({ model: config.embeddingModel, input: texts, dimensions: config.embeddingDim });
  return Promise.all(texts.map(async (text) => {
    const vectors = await request({ model: config.embeddingModel, input: [{ type: "text", text }] });
    if (!vectors[0]) throw new Error("Embedding \u63A5\u53E3\u6CA1\u6709\u8FD4\u56DE\u5411\u91CF");
    return vectors[0];
  }));
}

const SCRIPTURE_INDEX = "xuanshu_scripture_chunks";
const EMBEDDING_DIMENSION = config.embeddingDim;
const scriptureVector = new PgVector({
  id: "xuanshu-pgvector",
  connectionString: process.env.DATABASE_URL
});
async function ensureScriptureIndex() {
  const indexes = await scriptureVector.listIndexes();
  if (!indexes.includes(SCRIPTURE_INDEX)) {
    await scriptureVector.createIndex({
      indexName: SCRIPTURE_INDEX,
      dimension: EMBEDDING_DIMENSION,
      metric: "cosine",
      // 豆包模型输出 2048 维，超过 pgvector HNSW 的 2000 维上限；V0.1 使用精确检索。
      buildIndex: false
    });
  }
}

async function searchScripture(query, topK = 5) {
  await ensureScriptureIndex();
  const embedding = await embedQuery(query);
  const results = await scriptureVector.query({
    indexName: SCRIPTURE_INDEX,
    queryVector: embedding,
    topK
  });
  return results.map((result) => {
    const metadata = result.metadata;
    return {
      chunkId: result.id,
      content: String(metadata.content ?? ""),
      title: String(metadata.title ?? ""),
      chapter: String(metadata.chapter ?? ""),
      author: asOptionalString(metadata.author),
      dynasty: asOptionalString(metadata.dynasty),
      category: String(metadata.category ?? ""),
      version: asOptionalString(metadata.version),
      type: String(metadata.type ?? "scripture"),
      originalWork: asOptionalString(metadata.originalWork),
      commentator: asOptionalString(metadata.commentator),
      source: String(metadata.source ?? ""),
      score: result.score
    };
  });
}
function asOptionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}

const searchScriptureTool = createTool({
  id: "search-scripture",
  description: "\u68C0\u7D22\u7384\u67A2\u9053\u6559\u77E5\u8BC6\u5E93\u4E2D\u7684\u539F\u5178\u6216\u6CE8\u758F\uFF0C\u8FD4\u56DE\u539F\u6587\u7247\u6BB5\u53CA\u53EF\u8FFD\u6EAF\u51FA\u5904\u3002",
  inputSchema: z.object({
    query: z.string().min(1).describe("\u8981\u68C0\u7D22\u7684\u9053\u6559\u95EE\u9898\u3001\u672F\u8BED\u6216\u539F\u6587\u5173\u952E\u8BCD"),
    topK: z.number().int().min(1).max(10).optional()
  }),
  execute: async ({ query, topK }) => searchScripture(query, topK)
});

export { scriptureVector as a, searchScriptureTool as s };
