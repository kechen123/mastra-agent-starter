/**
 * 真实公网 URL E2E：生产 UrlFetcher（**不**注入测试替身）→ recordUrlSource
 * → 真实 Daymind Runtime（streamAgent）→ done 事件携带 URL Citation。
 *
 * 这是 URL 通道的**唯一**生产-路径验收。
 * tests/integration/sources-url-mock-e2e.ts 里的本地 mock 仅用于解析/重定向
 * 单元回路，**不**是 URL E2E 验收。
 *
 * 关于 finalUrl：
 *   - 真实公网 URL 经常带 30x 重定向；`UrlFetcher.fetch` 跟随最多 MAX_REDIRECTS
 *     跳，最后一跳的 URL 写入 `Source.metadata.finalUrl`。
 *   - Citation.url 必须等于 `Source.metadata.finalUrl`（不是用户输入的
 *     `publicUrl`）。如果重定向链导致 finalUrl !== publicUrl，是**合法**
 *     行为，不是错误——本 fixture 不要求 finalUrl === publicUrl。
 *   - 唯一要求：**Citation.url === DB 里 Source.metadata.finalUrl 的实际值**。
 *
 * 闸门（全部 throw，不 SKIPPED）：
 *   - RUN_DB_TESTS=1
 *   - TEST_DATABASE_URL（含 safety-identifier，runner 顶层闸门已校验）
 *   - EMBEDDING_BASE_URL + EMBEDDING_API_KEY（mock provider；只是向量生成器）
 *   - DAYMIND_URL_E2E_TARGET：必须显式提供（http(s) 公网 URL）
 *   - DAYMIND_URL_E2E_KEYWORDS：检索时使用的关键词（CSV），命中 Source
 *   - DAYMIND_URL_E2E_ENABLE=1：必须显式开启；缺省 → fail-closed（不在
 *     普通 CI 跑公网，避免误连 / 误用）
 *
 * 失败策略：
 *   - 任一环境变量缺失：throw（runner 后续 fixture 继续）。
 *   - 网络/DNS/HTTP 失败：throw（**不** SKIPPED）。
 *   - recordUrlSource 抛错：原样上抛。
 *   - streamAgent 没在 done 事件里带 URL Citation：fail。
 *
 * 不调 process.exit；runner 自己统一汇总退出码。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

import { normalizeTestDbUrl } from './_helpers/db-url.js';
import { acquireMockEmbeddingProvider, releaseMockEmbeddingProvider } from './_helpers/embedding-mock.js';

// ─── 闸门（throw，不调 process.exit） ─────────────────────────────────
function gateOrThrow(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`✗ ${message}`);
    throw new Error(message);
  }
}
gateOrThrow(
  process.env.RUN_DB_TESTS === '1' && !!process.env.TEST_DATABASE_URL,
  'sources-url-public-e2e 拒绝执行：未启用 RUN_DB_TESTS=1 + TEST_DATABASE_URL。',
);
gateOrThrow(
  process.env.DAYMIND_URL_E2E_ENABLE === '1',
  'sources-url-public-e2e 未启用：必须显式设置 DAYMIND_URL_E2E_ENABLE=1 才执行。' +
    '这是 fail-closed 设计——公网 URL 不能在普通 CI 跑，必须人工开启。',
);
const publicUrl = process.env.DAYMIND_URL_E2E_TARGET ?? '';
const publicKeywordsRaw = process.env.DAYMIND_URL_E2E_KEYWORDS ?? '';
gateOrThrow(
  !!publicUrl && /^https?:\/\//.test(publicUrl),
  'sources-url-public-e2e 拒绝执行：DAYMIND_URL_E2E_TARGET 必须是非空 http(s) URL。',
);
gateOrThrow(
  !!publicKeywordsRaw && publicKeywordsRaw.length > 0,
  'sources-url-public-e2e 拒绝执行：DAYMIND_URL_E2E_KEYWORDS 必须是非空 CSV（用作检索 query 与 Source 命中关键词）。',
);
const publicKeywords = publicKeywordsRaw.split(',').map((s) => s.trim()).filter(Boolean);
gateOrThrow(
  publicKeywords.length > 0,
  'sources-url-public-e2e 拒绝执行：DAYMIND_URL_E2E_KEYWORDS 不能全部为空。',
);

// 闸门通过后再 acquire mock（runner 模式下复用 runner 持有的 server）
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
const { recordUrlSource } = sourcesServiceModule;
const conversationsServiceModule = await import('../../src/modules/conversations/service.js');
const { createConversation } = conversationsServiceModule;
const runtimeModule = await import('../../src/core/agent/runtime.js');
const {
  streamAgent,
  _setPolicyResolverForTesting,
  _setRequireApprovalForTesting,
  _setMastraInstanceForTesting,
  _resetMastraInstanceCacheForTesting,
} = runtimeModule;
const registryModule = await import('../../src/core/agent/registry.js');
const { _setPerRequestFactoryOverrideForTesting } = registryModule;
await import('../../src/agents/index.js');

let failed = 0;
function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${label}`);
  else { failed += 1; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function noHistory(pool: Pool, conversationId: string): Promise<boolean> {
  const r = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1`,
    [conversationId],
  );
  return Number(r.rows[0]!.count) === 0;
}

// ─── stub Agent（与 runtime E2E 同思路；production UrlFetcher 不被替换） ───
let streamCalls = 0;
const stubAgent = {
  stream(_prompt: string, _options: Record<string, unknown>): {
    fullStream: AsyncIterable<unknown>;
  } {
    streamCalls += 1;
    return {
      fullStream: (async function* (): AsyncGenerator<unknown, void, unknown> {
        // no chunks → consumeAgentStream 立刻 yield done, citations 来自 runtime 收集
      })(),
    };
  },
};
_setPerRequestFactoryOverrideForTesting((agentId: string) => {
  if (agentId === 'daymind') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return stubAgent as any;
  }
  return null;
});
_setPolicyResolverForTesting(async (_ws: string, toolIds: string[]) => toolIds);
_setRequireApprovalForTesting(() => false);
_setMastraInstanceForTesting({});

// ─── 主流程 ───────────────────────────────────────────────────────────
const INIT_SQL = readFileSync(new URL('../../database/init.sql', import.meta.url), 'utf8');
const dbUrl = normalizeTestDbUrl(process.env.TEST_DATABASE_URL ?? '');
const schema = `url_pub_${randomUUID().replaceAll('-', '')}`;
const storageRoot = mkdtempSync(join(tmpdir(), 'url-pub-'));

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
      `INSERT INTO workspaces(kind, name) VALUES ('shared', 'url-public-e2e') RETURNING id`,
    );
    const workspaceId = ws.rows[0]!.id;

    console.log(`  · target URL = ${publicUrl}`);
    console.log(`  · keywords   = ${publicKeywords.join(' | ')}`);

    // 关键：recordUrlSource 走生产 UrlFetcher.fetch ——**不**注入任何替身。
    // 网络失败 → recordUrlSource 抛错 → 本 fixture 抛错 → 失败。
    const recorded = await recordUrlSource(workspaceId, publicUrl);
    assert('URL recordUrlSource returns sourceId', typeof recorded.id === 'string' && recorded.id.length > 0);
    const sourceRow = await pool.query<{ metadata: { finalUrl?: string } }>(
      `SELECT metadata FROM sources WHERE id = $1`, [recorded.id],
    );
    const recordedFinalUrl = sourceRow.rows[0]?.metadata.finalUrl;
    assert('URL Source.metadata.finalUrl captured',
      typeof recordedFinalUrl === 'string' && recordedFinalUrl.length > 0,
      `got=${recordedFinalUrl}`);
    // 公网 URL 经常合法重定向到不同主机 / 路径；finalUrl 可以不等于 publicUrl。
    // 唯一约束：recordedFinalUrl 是合法 http(s) URL。
    if (typeof recordedFinalUrl === 'string') {
      assert('URL Source.metadata.finalUrl is http(s) URL',
        /^https?:\/\//.test(recordedFinalUrl),
        `got=${recordedFinalUrl}`);
    }

    // 验证 document / chunk 落库
    const docRow = await pool.query<{ id: string }>(
      `SELECT id FROM documents WHERE source_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [recorded.id],
    );
    const documentId = docRow.rows[0]?.id;
    assert('URL document row exists', !!documentId, `count=${docRow.rows.length}`);
    if (!documentId) throw new Error('URL document row missing');
    const chunkRow = await pool.query<{ id: string }>(
      `SELECT id FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index ASC LIMIT 1`,
      [documentId],
    );
    const chunkId = chunkRow.rows[0]?.id;
    assert('URL document_chunks has >=1 row', !!chunkId);
    if (!chunkId) throw new Error('URL chunk missing');

    // 真实 streamAgent：runtime 内部 searchDaymindSources → 把 citations 注入 done 事件
    const conversation = await createConversation(workspaceId, {
      title: 'URL public runtime retrieval',
      agentId: 'daymind',
      knowledgeBaseId: null,
    });
    assert('URL conversation has agentId=daymind', conversation.agentId === 'daymind');
    assert('URL conversation has no history', await noHistory(pool, conversation.id));

    let allEvents: import('../../src/core/execution/stream-events.js').StreamEvent[] = [];
    for (const kw of publicKeywords) {
      const events: import('../../src/core/execution/stream-events.js').StreamEvent[] = [];
      for await (const evt of streamAgent({
        workspaceId,
        agentId: 'daymind',
        prompt: kw,
        conversationId: conversation.id,
        knowledgeBaseId: null,
        history: [],
        abortSignal: new AbortController().signal,
        runId: randomUUID(),
        threadId: conversation.id,
        resourceId: workspaceId,
        requesterId: randomUUID(),
      })) {
        events.push(evt);
      }
      allEvents = events;
      const done = events.find((e) => e.type === 'done') as
        | import('../../src/core/execution/stream-events.js').StreamResult
        | undefined;
      assert(`URL runtime done event present for keyword="${kw}"`, !!done);
      if (!done) continue;
      assert(`URL stub Agent invoked (>=1 stream call) for keyword="${kw}"`, streamCalls >= 1, `streamCalls=${streamCalls}`);
      const hit = (done.citations ?? []).find((c) => c.sourceId === recorded.id) ?? (done.citations ?? [])[0];
      // 公网 URL 的最终命中可能依赖 embedding mock 的非关键词命中——
      // 因为真实 fetch 回来的页面文本不在我们掌控之内，URL Citation 命中主要看
      // sourceId/documentId/chunkId/url 链路是否完整，关键词命中是 or 关系。
      assert(`URL runtime emitted Citation with sourceId===recorded.id for keyword="${kw}"`,
        hit?.sourceId === recorded.id,
        `got=${hit?.sourceId} expected=${recorded.id}`);
      if (hit) {
        assert(`URL citation.documentId matches DB`, hit.documentId === documentId, `got=${hit.documentId} expected=${documentId}`);
        assert(`URL citation.chunkId matches DB`, hit.chunkId === chunkId, `got=${hit.chunkId} expected=${chunkId}`);
        // 关键：Citation.url 必须 === Source.metadata.finalUrl（DB 真实值），
        // 允许与用户输入 publicUrl 不同（合法重定向）。
        assert(`URL citation.url === Source.metadata.finalUrl`,
          hit.url === recordedFinalUrl,
          `hit.url=${hit.url} recordedFinalUrl=${recordedFinalUrl} input=${publicUrl}`);
        assert(`URL citation.sourceType=url`, hit.sourceType === 'url', `got=${hit.sourceType}`);
      }
    }
  } finally {
    __resetTestPool();
    await pool.end().catch(() => undefined);
    try {
      const admin = new Pool({ connectionString: dbUrl, max: 1 });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    } catch { /* best-effort */ }
    if (existsSync(storageRoot)) rmSync(storageRoot, { recursive: true, force: true });
  }
} catch (err) {
  originalError = err;
  console.error('  ✗ unexpected failure:', err);
  failed += 1;
} finally {
  _setPerRequestFactoryOverrideForTesting(null);
  _setPolicyResolverForTesting(null);
  _setRequireApprovalForTesting(null);
  _setMastraInstanceForTesting(null);
  _resetMastraInstanceCacheForTesting();
  await releaseMockEmbeddingProvider().catch(() => undefined);
  void originalError;
}

if (failed > 0) process.exitCode = 1;