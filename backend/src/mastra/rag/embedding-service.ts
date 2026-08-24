import { config } from '../../config.js';

type EmbeddingResponse = {
  data?: { embedding?: unknown } | Array<{ embedding?: unknown }>;
  error?: unknown;
};

function assertEmbeddingConfig(): void {
  if (!config.embeddingApiKey) throw new Error('EMBEDDING_API_KEY 未配置');
  if (!config.embeddingBaseUrl) throw new Error('EMBEDDING_BASE_URL 未配置');
}

function embeddingUrl(): string {
  const baseUrl = config.embeddingBaseUrl.replace(/\/$/, '');
  return baseUrl.endsWith('/embeddings/multimodal') ? baseUrl : `${baseUrl}/embeddings`;
}

function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'number')) {
    throw new Error('Embedding 接口返回了无法识别的向量格式');
  }
  if (value.length !== config.embeddingDim) {
    throw new Error(`Embedding 维度不匹配：期望 ${config.embeddingDim}，实际 ${value.length}`);
  }
  return value;
}

async function request(body: unknown): Promise<number[][]> {
  assertEmbeddingConfig();
  const response = await fetch(embeddingUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.embeddingApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload: EmbeddingResponse | undefined;
  try { payload = text ? JSON.parse(text) as EmbeddingResponse : undefined; } catch { /* 响应错误会在下方统一处理 */ }
  if (!response.ok) {
    const detail = payload?.error ? JSON.stringify(payload.error) : text || response.statusText;
    throw new Error(`Embedding 请求失败：${response.status} ${detail}`);
  }
  if (Array.isArray(payload?.data)) return payload.data.map((item) => normalizeEmbedding(item.embedding));
  if (payload?.data && typeof payload.data === 'object') return [normalizeEmbedding(payload.data.embedding)];
  throw new Error('Embedding 接口返回格式异常：缺少 data.embedding');
}

export async function embedQuery(text: string): Promise<number[]> {
  const vectors = await embedTexts([text]);
  if (!vectors[0]) throw new Error('Embedding 接口没有返回查询向量');
  return vectors[0];
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const isMultimodal = embeddingUrl().endsWith('/embeddings/multimodal');
  const vectors: number[][] = [];
  const batchSize = 20;
  for (let index = 0; index < texts.length; index += batchSize) {
    const batch = texts.slice(index, index + batchSize);
    const batchVectors = isMultimodal
      ? await Promise.all(batch.map(async (text) => {
        const response = await request({ model: config.embeddingModel, input: [{ type: 'text', text }] });
        if (!response[0]) throw new Error('Embedding 接口没有返回向量');
        return response[0];
      }))
      : await request({ model: config.embeddingModel, input: batch, dimensions: config.embeddingDim });
    if (batchVectors.length !== batch.length) {
      throw new Error(`Embedding 返回数量不匹配：期望 ${batch.length}，实际 ${batchVectors.length}`);
    }
    vectors.push(...batchVectors);
  }
  return vectors;
}
