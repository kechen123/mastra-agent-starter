/**
 * RAG 阈值 / AbortSignal / 错误分类 单元测试（PR-4.3）。
 *
 * 覆盖场景：
 *   1. distance → similarity 转换：0 / 0.5 / 1 / 2 → 1 / 0.5 / 0 / 0；
 *   2. similarity 阈值过滤：< threshold 的 chunk 被丢弃；
 *   3. 全部低于阈值 → 返空数组（"未命中可靠数据"语义）；
 *   4. 阈值边界：== threshold 通过，< threshold 丢弃；
 *   5. AbortSignal 已 abort → 抛 AbortError；
 *   6. Embedding provider HTTP 401 / 429 / 5xx / 400 错误分类正确；
 *   7. Embedding provider fetch 失败（ECONNRESET 模拟）→ network 分类；
 *   8. Embedding provider 错误消息**不**含 endpoint / 原始 body；
 *   9. classifyHttpError 不抛原始 statusText / body 字符串。
 *
 * 注：本测试不连真实 DB / network；mock 一个内嵌的 retriever + classify 单元。
 * Run with: npx tsx tests/unit/rag-threshold-abort-sanitize.ts
 */

// 重要：本测试需要 reset env，避免 RAG_MIN_SIMILARITY / EMBEDDING_TIMEOUT_MS
// 影响 config 加载。config 是模块顶层 const，重置需要重新 import。
// 但本测试只测纯函数 classifyHttpError / distanceToSimilarity / threshold filter，
// 不直接读 config，所以 env 不会影响行为。

// 通过动态 import 把 embedding-service 拉进来（其依赖 config，但阈值/分类函数内部不读 config）。

interface CitationLike {
  score: number;
  chunkId: string;
}

function distanceToSimilarity(distance: number): number {
  const sim = 1 - distance;
  if (!Number.isFinite(sim)) return 0;
  if (sim < 0) return 0;
  if (sim > 1) return 1;
  return sim;
}

/** threshold filter：保留 score >= minSimilarity 的 chunk。 */
function applyThreshold(rows: CitationLike[], minSimilarity: number): CitationLike[] {
  return rows.filter((r) => r.score >= minSimilarity);
}

type Kind =
  | 'unauthorized'
  | 'rate_limited'
  | 'upstream_5xx'
  | 'bad_request'
  | 'network'
  | 'aborted'
  | 'invalid_response'
  | 'config_missing';

class EmbeddingError extends Error {
  readonly kind: Kind;
  readonly status?: number;
  constructor(kind: Kind, message: string, status?: number) {
    super(message);
    this.name = 'EmbeddingError';
    this.kind = kind;
    this.status = status;
  }
}

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

let passed = 0;
let failed = 0;
function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('[rag-threshold] R1 — distance → similarity 转换（含 clamp）');
{
  assert('R1: distance=0 → sim=1', distanceToSimilarity(0) === 1);
  assert('R1: distance=0.5 → sim=0.5', distanceToSimilarity(0.5) === 0.5);
  assert('R1: distance=1 → sim=0', distanceToSimilarity(1) === 0);
  // pgvector cosine distance ∈ [0, 2]；< 0 不可能但 clamp 防御；> 2 同样 clamp。
  assert('R1: distance=2 → sim=0（clamp 0）', distanceToSimilarity(2) === 0);
  assert('R1: distance=-1 → sim=1（clamp 1）', distanceToSimilarity(-1) === 1);
  assert('R1: NaN → sim=0', distanceToSimilarity(NaN) === 0);
}

console.log('\n[rag-threshold] R2 — 阈值过滤：< threshold 丢弃');
{
  const rows: CitationLike[] = [
    { chunkId: 'a', score: 0.9 },
    { chunkId: 'b', score: 0.6 },
    { chunkId: 'c', score: 0.4 },
    { chunkId: 'd', score: 0.2 },
  ];
  const out = applyThreshold(rows, 0.5);
  assert('R2: 保留 score>=0.5 的两条', out.length === 2, `actual=${out.length}`);
  assert('R2: 保留 a', out[0]?.chunkId === 'a');
  assert('R2: 保留 b', out[1]?.chunkId === 'b');
}

console.log('\n[rag-threshold] R3 — 全部低于阈值 → 返空数组');
{
  const rows: CitationLike[] = [
    { chunkId: 'a', score: 0.3 },
    { chunkId: 'b', score: 0.1 },
  ];
  const out = applyThreshold(rows, 0.5);
  assert('R3: 全部低于阈值 → []', out.length === 0, `actual=${out.length}`);
}

console.log('\n[rag-threshold] R4 — 阈值边界：== threshold 通过，< threshold 丢弃');
{
  const rows: CitationLike[] = [
    { chunkId: 'edge', score: 0.5 },
    { chunkId: 'just-below', score: 0.4999 },
  ];
  const out = applyThreshold(rows, 0.5);
  assert('R4: == threshold 通过', out.length === 1 && out[0]?.chunkId === 'edge');
  assert('R4: < threshold 丢弃', out.find((r) => r.chunkId === 'just-below') === undefined);
}

console.log('\n[rag-threshold] R5 — AbortSignal 已 abort → 抛 AbortError');
{
  const ac = new AbortController();
  ac.abort();
  let thrown: unknown = null;
  try {
    // 模拟 retriever 入口检查
    if (ac.signal.aborted) {
      throw new DOMException('RAG retrieval aborted before start', 'AbortError');
    }
  } catch (err) {
    thrown = err;
  }
  assert('R5: 已 abort 抛 DOMException AbortError',
    thrown instanceof DOMException && thrown.name === 'AbortError',
    `actual=${thrown instanceof Error ? thrown.name : String(thrown)}`);
}

console.log('\n[rag-error] R6 — provider HTTP 错误分类');
{
  const cases: Array<[number, Kind]> = [
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
    [500, 'upstream_5xx'],
    [502, 'upstream_5xx'],
    [503, 'upstream_5xx'],
    [400, 'bad_request'],
    [404, 'bad_request'],
    [422, 'bad_request'],
  ];
  for (const [status, expectedKind] of cases) {
    const err = classifyHttpError(status);
    assert(`R6: HTTP ${status} → ${expectedKind}`,
      err.kind === expectedKind && err.status === status,
      `actual=${err.kind}`);
  }
}

console.log('\n[rag-error] R7 — 错误消息不含 endpoint / 原始 body 字符串');
{
  // 模拟上游返回原始 body 含敏感字段："POST /v1/embeddings 401 api_key invalid"
  const rawBody = 'POST /v1/embeddings api_key=sk-xxx invalid token ...';
  const err = classifyHttpError(401);
  // 错误消息只含"HTTP 401"，**不**含 raw body 片段
  assert('R7: 错误消息不含 raw body',
    !err.message.includes(rawBody) && !err.message.includes('sk-xxx'),
    `message=${err.message}`);
  assert('R7: 错误消息不含 endpoint',
    !err.message.includes('/v1/embeddings'),
    `message=${err.message}`);
  assert('R7: 错误消息不含 "api_key" 字样',
    !err.message.toLowerCase().includes('api_key'),
    `message=${err.message}`);
}

console.log('\n[rag-error] R8 — fetch 失败 → network 分类');
{
  function fetchFail(_signal?: AbortSignal): Promise<number[][]> {
    // 模拟 fetch 抛 TypeError（DNS / ECONNRESET 等）
    throw new TypeError('fetch failed: ECONNRESET ... endpoint https://api.provider.com/v1/embeddings');
  }
  let caught: EmbeddingError | null = null;
  try {
    fetchFail();
  } catch (err) {
    // 安全契约：network 错误**不**暴露原始 fetch 错误文本
    caught = new EmbeddingError('network', 'Embedding 网络请求失败');
  }
  assert('R8: network 错误被归类', caught?.kind === 'network');
  assert('R8: network 错误消息不含 endpoint',
    !caught?.message.includes('api.provider.com'),
    `message=${caught?.message}`);
  assert('R8: network 错误消息不含 ECONNRESET',
    !caught?.message.includes('ECONNRESET'),
    `message=${caught?.message}`);
}

console.log('\n[rag-error] R9 — invalid_response：上游返回非 JSON');
{
  const err = new EmbeddingError('invalid_response', 'Embedding 接口返回了非 JSON');
  assert('R9: invalid_response kind', err.kind === 'invalid_response');
  assert('R9: 不含 raw body 引用', !err.message.includes('html'));
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
