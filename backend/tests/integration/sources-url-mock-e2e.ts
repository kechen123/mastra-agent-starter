/**
 * 【测试替身 / Test Double】本地 URL mock 解析路径 E2E。
 *
 * 重要：这不是生产 URL E2E。生产 URL 验收见
 * `tests/integration/sources-url-public-e2e.ts` —— 它走**生产 UrlFetcher**，
 * 不注入任何替身，gated by DAYMIND_URL_E2E_ENABLE / TARGET / KEYWORDS。
 *
 * 本 fixture 用途：
 *   - 验证 URL 解析/重定向/限速/Content-Type 路径在隔离环境下能跑通；
 *   - 验证 recordUrlSource 接到 5xx / 4xx / 网络错误时**正确抛错**——
 *     不允许"网络失败后仍算通过"；
 *   - 验证 Source.metadata.finalUrl 在 recordUrlSource 完成后被正确写入。
 *
 * 为什么可以注入本地 mock：
 *   - 生产 UrlFetcher 拒绝 127.0.0.1 / localhost（SSRF 防护）；
 *   - 本测试需要让 fetcher 命中一个真实 HTTP server（确认真实 socket / 解析
 *     / response body 链路），所以 SSRF 闸门在测试 seam 里被显式旁路；
 *   - SSRF 单元测试（tests/unit/sources-url-safety.ts）**不**走这条 seam，
 *     仍跑生产 UrlFetcher，本测试不会削弱生产 SSRF 防护。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse, request as httpRequest } from 'node:http';
import { Pool } from 'pg';

import { normalizeTestDbUrl } from './_helpers/db-url.js';
import { acquireMockEmbeddingProvider, releaseMockEmbeddingProvider } from './_helpers/embedding-mock.js';

// 闸门
function gateOrThrow(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`✗ ${message}`);
    throw new Error(message);
  }
}
gateOrThrow(
  process.env.RUN_DB_TESTS === '1' && !!process.env.TEST_DATABASE_URL,
  'sources-url-mock-e2e 拒绝执行：未启用 RUN_DB_TESTS=1 + TEST_DATABASE_URL。',
);

// recordUrlSource 在 RAG 启用下走 embedTexts → 必须有真实 embedding provider。
const mockInfo = await acquireMockEmbeddingProvider();
if (process.env.DAYMIND_INTEGRATION_RUNNER === '1') {
  console.log(`  · embedding mock port=${mockInfo.port} (runner-owned, refcount+=1)`);
} else {
  console.log(`  · embedding mock listening on ${mockInfo.url}`);
}

// dynamic import 所有 src 模块（顺序：mock → src）
const poolModule = await import('../../src/infrastructure/database/pool.js');
const { __setTestPool, __resetTestPool } = poolModule;
const storageModule = await import('../../src/infrastructure/storage/document-storage.js');
const { setDocumentStorage } = storageModule;
const { LocalFsStorage } = await import('../../src/infrastructure/storage/local-storage.js');
const sourcesServiceModule = await import('../../src/modules/sources/service.js');
const { recordUrlSource, __setUrlFetcherForTesting, __resetUrlFetcherForTesting } = sourcesServiceModule;
const urlFetcherModule = await import('../../src/modules/sources/parsers/url-fetcher.js');
const FetchedUrl = urlFetcherModule.FetchedUrl;

let failed = 0;
function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${label}`);
  else { failed += 1; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

interface UrlMock {
  url: string;
  close: () => Promise<void>;
  requests: Array<{ path: string; at: number }>;
}

async function startUrlMock(handler: (path: string) => { status: number; contentType: string; body: string }): Promise<UrlMock> {
  return new Promise((resolve, reject) => {
    const requests: Array<{ path: string; at: number }> = [];
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url ?? '/';
      requests.push({ path, at: Date.now() });
      const out = handler(path);
      res.writeHead(out.status, { 'Content-Type': out.contentType });
      res.end(out.body);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr !== 'object' || !addr) return reject(new Error('url mock listen failed'));
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        requests,
      });
    });
  });
}

/**
 * Test-only fetcher：跳过 SSRF guard 让 mock 可达，但仍走生产 fetcher 的
 * 接口形状（finalUrl / body / contentType / fetchedAt），确保 recordUrlSource
 * 走 parser 路径与生产一致。
 */
class LocalMockUrlFetcher {
  constructor(private readonly baseUrl: string) {}
  async fetch(input: { url: string }): Promise<FetchedUrl> {
    return new Promise<FetchedUrl>((resolve, reject) => {
      const u = new URL(input.url);
      if (!u.href.startsWith(this.baseUrl)) {
        reject(new Error(`LocalMockUrlFetcher 拒绝越界请求：${u.href}`));
        return;
      }
      const req = httpRequest({
        host: u.hostname,
        port: Number(u.port),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { 'User-Agent': 'Daymind-Test-Double/1.0', Accept: 'text/html' },
      }, (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            reject(new Error(`URL mock 返回 ${status}`));
            return;
          }
          const contentType = String(res.headers['content-type'] ?? 'text/html; charset=utf-8').toLowerCase();
          resolve({
            finalUrl: u.toString(),
            body: Buffer.concat(chunks).toString('utf-8'),
            fetchedAt: new Date().toISOString(),
            contentType,
          });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }
}

// ─── 主流程 ───────────────────────────────────────────────────────────
const INIT_SQL = readFileSync(new URL('../../database/init.sql', import.meta.url), 'utf8');
const dbUrl = normalizeTestDbUrl(process.env.TEST_DATABASE_URL ?? '');
const schema = `url_mock_${randomUUID().replaceAll('-', '')}`;
const storageRoot = mkdtempSync(join(tmpdir(), 'url-mock-'));

const urlMock = await startUrlMock((path) => {
  if (path.startsWith('/article')) {
    return {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><title>Quartz Pine Notes</title></head><body><h1>Quartz Pine</h1><p>parser test double content</p></body></html>`,
    };
  }
  if (path === '/broken') {
    return { status: 503, contentType: 'text/plain', body: 'service unavailable' };
  }
  return { status: 404, contentType: 'text/plain', body: 'not found' };
});

const fetcherToUse = new LocalMockUrlFetcher(urlMock.url);
__setUrlFetcherForTesting(fetcherToUse);

let originalError: unknown = null;
try {
  const admin = new Pool({ connectionString: dbUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await admin.end();

  const pool = new Pool({
    connectionString: dbUrl,
    options: `-c search_path=${schema},public`,
  });
  try {
    await pool.query(`SET app.rag_enabled = 'on'`);
    await pool.query(INIT_SQL);

    __setTestPool(pool);
    setDocumentStorage(new LocalFsStorage({ root: storageRoot }));

    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces(kind, name) VALUES ('shared', 'url-mock-e2e') RETURNING id`,
    );
    const workspaceId = ws.rows[0]!.id;

    // 1. 5xx / 网络失败必须抛错
    let caught: unknown = null;
    try {
      await recordUrlSource(workspaceId, `${urlMock.url}broken`);
    } catch (e) {
      caught = e;
    }
    assert('URL 503 path: recordUrlSource throws (no false pass)',
      caught instanceof Error,
      `caught=${caught === null ? 'null' : (caught as Error).constructor.name}`);

    // 2. 正常路径：200 → recordUrlSource → Source / Document / Chunk 落库
    const finalUrl = `${urlMock.url}article`;
    const recorded = await recordUrlSource(workspaceId, finalUrl);
    assert('URL mock recordUrlSource returns sourceId', typeof recorded.id === 'string' && recorded.id.length > 0);

    const sourceRow = await pool.query<{ metadata: { finalUrl?: string } }>(
      `SELECT metadata FROM sources WHERE id = $1`, [recorded.id],
    );
    assert('URL mock Source.metadata.finalUrl captured',
      sourceRow.rows[0]?.metadata.finalUrl === finalUrl,
      `got=${sourceRow.rows[0]?.metadata.finalUrl} expected=${finalUrl}`);

    const docRows = await pool.query<{ id: string }>(
      `SELECT id FROM documents WHERE source_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [recorded.id],
    );
    assert('URL mock document row exists', docRows.rows.length >= 1);

    const articleHits = urlMock.requests.filter((r) => r.path.startsWith('/article'));
    assert('URL mock server actually served >=1 GET /article', articleHits.length >= 1, `count=${articleHits.length}`);
    const brokenHits = urlMock.requests.filter((r) => r.path === '/broken');
    assert('URL mock server actually served >=1 GET /broken', brokenHits.length >= 1, `count=${brokenHits.length}`);
  } finally {
    __resetUrlFetcherForTesting();
    __resetTestPool();
    await pool.end().catch(() => undefined);
    try {
      const admin = new Pool({ connectionString: dbUrl, max: 1 });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    } catch { /* best-effort */ }
    if (existsSync(storageRoot)) rmSync(storageRoot, { recursive: true, force: true });
    await urlMock.close();
  }
} catch (err) {
  originalError = err;
  console.error('  ✗ unexpected failure:', err);
  failed += 1;
} finally {
  void originalError;
  await releaseMockEmbeddingProvider().catch(() => undefined);
}

if (failed > 0) process.exitCode = 1;