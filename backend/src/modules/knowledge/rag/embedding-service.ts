import { config } from '../../../config.js';

type EmbeddingResponse = {
  data?: { embedding?: unknown } | Array<{ embedding?: unknown }>;
  error?: unknown;
};

/**
 * Embedding provider 错误分类（用于在 retriever / searchKnowledgeBase
 * 中以受控方式冒泡）。
 *
 * 设计目标：上游 provider 抛回的错误消息 / body / 状态码若直接抛给 agent
 * 层，会把供应商 API 细节（endpoint、API key 头、模型版本号、限制条款
 * 文本等）暴露给客户端，违反 "Provider HTTP 错误必须只 emit sanitized
 * classified internal errors" 契约。本模块把所有 provider 错误归一化为
 * 内部错误码 + 通用消息。
 */
export type EmbeddingErrorKind =
  | 'unauthorized'      // 401：key 失效 / 配置错
  | 'rate_limited'      // 429：上游限流
  | 'upstream_5xx'      // 5xx：上游故障
  | 'bad_request'       // 4xx（非 401/429）：参数错
  | 'network'           // fetch 失败（连接失败 / DNS / ECONNRESET / abort）
  | 'aborted'           // AbortSignal 主动中断（不算"错误"，上游应按未命中处理）
  | 'invalid_response'  // 上游返回非预期格式
  | 'config_missing';   // 启动期配置缺失（embedding api key / base url 未配）

export class EmbeddingError extends Error {
  readonly kind: EmbeddingErrorKind;
  readonly status?: number;
  constructor(kind: EmbeddingErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'EmbeddingError';
    this.kind = kind;
    this.status = status;
  }
}

function assertEmbeddingConfig(): void {
  if (!config.embeddingApiKey) throw new EmbeddingError('config_missing', 'EMBEDDING_API_KEY 未配置');
  if (!config.embeddingBaseUrl) throw new EmbeddingError('config_missing', 'EMBEDDING_BASE_URL 未配置');
}

function embeddingUrl(): string {
  const baseUrl = config.embeddingBaseUrl.replace(/\/$/, '');
  return baseUrl.endsWith('/embeddings/multimodal') ? baseUrl : `${baseUrl}/embeddings`;
}

function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'number')) {
    throw new EmbeddingError('invalid_response', 'Embedding 接口返回了无法识别的向量格式');
  }
  if (value.length !== config.embeddingDim) {
    throw new EmbeddingError(
      'invalid_response',
      `Embedding 维度不匹配：期望 ${config.embeddingDim}，实际 ${value.length}`,
    );
  }
  return value;
}

/**
 * Embedding provider HTTP 错误归一为分类内部错误，**不**透传原始 body /
 * 错误 JSON / endpoint 细节。
 */
function classifyHttpError(status: number): EmbeddingError {
  if (status === 401 || status === 403) {
    return new EmbeddingError('unauthorized', `Embedding 鉴权失败（HTTP ${status}）`, status);
  }
  if (status === 429) {
    return new EmbeddingError('rate_limited', 'Embedding 上游限流', status);
  }
  if (status >= 500 && status < 600) {
    return new EmbeddingError('upstream_5xx', `Embedding 上游服务异常（HTTP ${status}）`, status);
  }
  if (status >= 400 && status < 500) {
    return new EmbeddingError('bad_request', `Embedding 请求参数错误（HTTP ${status}）`, status);
  }
  return new EmbeddingError('upstream_5xx', `Embedding 上游异常（HTTP ${status}）`, status);
}

async function request(body: unknown, signal?: AbortSignal): Promise<number[][]> {
  assertEmbeddingConfig();
  let response: Response;
  try {
    response = await fetch(embeddingUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.embeddingApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // AbortSignal 主动中断：上游按"未命中"处理，不算 provider 错。
    if (signal?.aborted) {
      throw new EmbeddingError('aborted', 'Embedding 请求已中断');
    }
    // fetch 失败 / 网络错：不暴露底层错误文本，统一归类 network。
    throw new EmbeddingError('network', 'Embedding 网络请求失败');
  }

  if (!response.ok) {
    // **安全**要求：永远不抛出 raw response body / 错误 JSON / endpoint URL。
    // 仅返回 status 派生的分类错误，message 也不含原始 body 片段。
    throw classifyHttpError(response.status);
  }

  let payload: EmbeddingResponse | undefined;
  try {
    payload = (await response.json()) as EmbeddingResponse;
  } catch {
    throw new EmbeddingError('invalid_response', 'Embedding 接口返回了非 JSON');
  }
  if (Array.isArray(payload?.data)) return payload.data.map((item) => normalizeEmbedding(item.embedding));
  if (payload?.data && typeof payload.data === 'object') return [normalizeEmbedding(payload.data.embedding)];
  throw new EmbeddingError('invalid_response', 'Embedding 接口返回格式异常：缺少 data.embedding');
}

export async function embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
  const vectors = await embedTexts([text], signal);
  if (!vectors[0]) throw new EmbeddingError('invalid_response', 'Embedding 接口没有返回查询向量');
  return vectors[0];
}

export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];
  const isMultimodal = embeddingUrl().endsWith('/embeddings/multimodal');
  const vectors: number[][] = [];
  const batchSize = 20;
  for (let index = 0; index < texts.length; index += batchSize) {
    if (signal?.aborted) {
      throw new EmbeddingError('aborted', 'Embedding 请求已中断');
    }
    // 用 AbortSignal.any 合并上游传入 signal 与本地超时 signal：
    // 任一触发即中断 fetch，并归类为 EmbeddingError。
    const timeoutSignal = AbortSignal.timeout(config.embeddingTimeoutMs);
    const composedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const batch = texts.slice(index, index + batchSize);
    const batchVectors = isMultimodal
      ? await Promise.all(batch.map(async (text) => {
          const response = await request({ model: config.embeddingModel, input: [{ type: 'text', text }] }, composedSignal);
          if (!response[0]) throw new EmbeddingError('invalid_response', 'Embedding 接口没有返回向量');
          return response[0];
        }))
      : await request({ model: config.embeddingModel, input: batch, dimensions: config.embeddingDim }, composedSignal);
    if (batchVectors.length !== batch.length) {
      throw new EmbeddingError('invalid_response', `Embedding 返回数量不匹配：期望 ${batch.length}，实际 ${batchVectors.length}`);
    }
    vectors.push(...batchVectors);
  }
  return vectors;
}
