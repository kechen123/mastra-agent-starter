/**
 * Embedding provider mock —— 引用计数 acquire/release 生命周期。
 *
 * 设计动机：
 *   - 在同一 Node 进程内多个 manifest fixture 必须共享同一个 mock endpoint。
 *     config.ts / EmbeddingService / RAG 模块持有的 EMBEDDING_BASE_URL 必须
 *     始终指向**同一个**存活 server；如果中途 close → 再 start 换端口，
 *     已 import 的模块仍持有旧端口引用 + 已落库的 chunk embedding 维度
 *     不再匹配 → 行为分裂。
 *   - 所以 mock 必须**最多启动一次**，跨 fixture 共享；close 只在
 *     refcount=0 时发生一次。
 *
 * API：
 *   - `acquireMockEmbeddingProvider()`: refcount++，如未启动则启动 server
 *     并写 EMBEDDING_* / RAG_MIN_SIMILARITY 环境变量。返回 { url, port }。
 *     返回的 port 在进程内**恒定**（再次调用 acquire 不换端口）。
 *   - `releaseMockEmbeddingProvider()`: refcount--；refcount=0 时 close server
 *     并清掉环境变量。幂等：refcount 已为 0 再调直接返回。
 *
 * 两种使用模式：
 *   - **Runner 模式**（`process.env.DAYMIND_INTEGRATION_RUNNER === '1'`）：
 *     runner 在 fixture 循环开始前调一次 acquire，结束后 finally 调一次
 *     release。每个 fixture 不调 acquire/release（自动复用 runner 持有的
 *     server），但仍可调以维持对称（runner 模式下 acquire 是 no-op +1，
 *     release 是 -1，最终由 runner 的 release 触发 close）。
 *   - **Standalone 模式**（fixture 单独 `npx tsx` 运行）：
 *     fixture 在 finally 中配对调 acquire/release；refcount=0 时 close。
 *
 * 关键约束：
 *   - 模块顶层**不**启动 HTTP server；
 *   - 第一次 acquire 必须在 dynamic import `src/config.js` 之前（否则
 *     config 看到 .env 的旧 EMBEDDING_BASE_URL，mock 失效）；
 *   - 一旦 start 写入 env vars，后续 acquire 不重复 set（避免覆盖运行时
 *     config.js 已读到的值——尽管 config 是 module-load-time 单例，多次
 *     set 也不影响，但保持单一写入更安全）；
 *   - 不依赖 process.exit；refcount=0 时 close 即可让进程自然退出。
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 2048);

/**
 * 哈希生成 deterministic embedding。返回 L2-normalized 向量，
 * 维度 = EMBEDDING_DIM。
 */
export function hashEmbed(text: string): number[] {
  const tokens = text.toLowerCase().match(/[\p{Script=Han}\w]+/gu) ?? [];
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const tok of tokens) {
    const h = createHash('sha256').update(tok).digest();
    for (let i = 0; i < EMBEDDING_DIM; i += 1) {
      const byte = h[i % h.length]!;
      vec[i] += (byte - 128) / 128;
    }
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

interface MockState {
  server: Server;
  port: number;
}

let state: MockState | null = null;
let refCount = 0;

function handleRequest(server: Server): void {
  server.on('request', (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf-8'); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const input = parsed.input;
        const inputs: string[] = Array.isArray(input)
          ? input.map((it: { text?: string } | string) => typeof it === 'string' ? it : (it.text ?? ''))
          : [String(input)];
        const data = inputs.map((text: string) => ({ embedding: hashEmbed(text) }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data }));
      } catch (err) {
        res.writeHead(500);
        res.end(`mock embedding failed: ${(err as Error).message}`);
      }
    });
  });
}

function buildBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function writeEnvVars(port: number): void {
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_DIM;
  delete process.env.RAG_MIN_SIMILARITY;
  process.env.EMBEDDING_API_KEY = 'mock-e2e-key';
  process.env.EMBEDDING_BASE_URL = `${buildBaseUrl(port)}/v1/api/v3`;
  process.env.EMBEDDING_PROVIDER = 'mock-e2e';
  process.env.EMBEDDING_MODEL = 'mock-embedder';
  process.env.EMBEDDING_DIM = String(EMBEDDING_DIM);
  process.env.RAG_MIN_SIMILARITY = '0';
}

function clearEnvVars(): void {
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_DIM;
  delete process.env.RAG_MIN_SIMILARITY;
}

/**
 * 获取 mock 端点。refcount++；首次调用启动 server + 写 env vars。
 * 后续 acquire 不重启 server、不重新 set env vars —— 端口保持稳定。
 */
export async function acquireMockEmbeddingProvider(): Promise<{ url: string; port: number }> {
  refCount += 1;
  if (state) return { url: buildBaseUrl(state.port), port: state.port };
  const server = createServer();
  handleRequest(server);
  const port: number = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr !== 'object' || !addr) return reject(new Error('mock listen failed'));
      resolve(addr.port);
    });
  });
  writeEnvVars(port);
  state = { server, port };
  return { url: buildBaseUrl(port), port };
}

/**
 * 释放 mock。refcount--；refcount=0 时 close server + 清 env vars。
 * 幂等：refcount<=0 再调直接返回。
 */
export async function releaseMockEmbeddingProvider(): Promise<void> {
  if (refCount <= 0) return;
  refCount -= 1;
  if (refCount > 0) return;
  if (!state) return;
  const { server } = state;
  state = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Node server.close() 等所有 active socket 关闭后才回调；调用方如需
    // 超时控制可在外层加 Promise.race。
  });
  clearEnvVars();
}

/**
 * 当前 mock 是否存活（refcount > 0 且 state 存在）。
 * 仅供调试 / 断言；正常代码不应依赖此函数。
 */
export function isMockEmbeddingProviderActive(): boolean {
  return state !== null && refCount > 0;
}

/**
 * 返回当前 mock 端点（如果已启动）。fixture 在 runner 模式下可借此确认
 * runner 已经 acquire，避免重复 acquire（refcount 仍会 ++，依赖 release 对称）。
 */
export function getActiveMockEndpoint(): { url: string; port: number } | null {
  if (!state) return null;
  return { url: buildBaseUrl(state.port), port: state.port };
}