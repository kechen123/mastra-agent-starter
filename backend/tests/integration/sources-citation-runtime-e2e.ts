/**
 * 真实 Daymind Runtime E2E：
 *   recordSource → 新 Conversation(agentId=daymind, knowledgeBaseId=null,
 *   无历史消息) → 真实 streamAgent（runtime.ts）→ done 事件携带 Citation。
 *
 * 覆盖格式：TXT / DOCX / PDF。每个格式独立 isolated schema + workspace + pool
 * （互不污染），使用独立 keyword（不与其他格式重复）。
 *
 * 关键约束：
 *   - **必须**走 runtime.ts 的真实 streamAgent 代码路径：
 *     `searchDaymindSources` 是 runtime 在 per-request 阶段调用的真实检索；
 *   - **不**在 fixture 内直接调 `searchDaymindSources` 当作最终验收——
 *     测试必须消费 streamAgent 的 done 事件并校验其中的 citations；
 *   - LLM 是不可控因素，本 fixture 用 `_setPerRequestFactoryOverrideForTesting`
 *     注入一个 no-op stub Agent：它的 `.stream()` 返回空 AsyncIterable，
 *     让 runtime 立刻走完 `consumeAgentStream` 循环、发出 done 事件。
 *     这保证：
 *       1. runtime 真实调用了 `searchDaymindSources`（未 mock）；
 *       2. runtime 把检索结果作为 citations 注入 done 事件（未绕开）；
 *       3. fixture 仍断言 done 事件的 citations 字段就是 DB 真实 chunk 的
 *          sourceId/documentId/chunkId/score/distance/sourceTitle/sourceType/snippet。
 *
 *   - DB 闸门：必须 RUN_DB_TESTS=1 + TEST_DATABASE_URL；
 *   - 不调 process.exit；环境缺失时直接 throw（runner 继续 import 后续 fixture）；
 *   - 没有 SKIPPED 分支。
 */
import './_helpers/embedding-mock.js'; // 必须在其它 src import 之前
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import PDFKit from 'pdfkit';

import { normalizeTestDbUrl } from './_helpers/db-url.js';
import { acquireMockEmbeddingProvider, releaseMockEmbeddingProvider } from './_helpers/embedding-mock.js';

// ─── 闸门（抛错，不调 process.exit —— runner 需要继续 import 后续 fixture） ──
function gateOrThrow(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`✗ ${message}`);
    throw new Error(message);
  }
}
gateOrThrow(
  process.env.RUN_DB_TESTS === '1' && !!process.env.TEST_DATABASE_URL,
  'sources-citation-runtime-e2e 拒绝执行：未启用 RUN_DB_TESTS=1 + TEST_DATABASE_URL。该测试需要真实 DB（隔离 schema）+ 真实 Embedding provider mock，不能在普通开发环境跑。',
);

// 闸门通过后再 acquire mock：首次 acquire 启动 server + 写 EMBEDDING_* /
// RAG_MIN_SIMILARITY 并 DELETE 掉 .env 可能注入的同名变量。这样随后 dynamic
// import 的 src/config.js 才看到 mock URL。runner 模式下：refcount++ 后端口
// 与 runner 持有的 server 一致；standalone 模式下：refcount=1，本 fixture
// 在 finally release 后真正关闭。
const mockInfo = await acquireMockEmbeddingProvider();
if (process.env.DAYMIND_INTEGRATION_RUNNER === '1') {
  console.log(`  · embedding mock port=${mockInfo.port} (runner-owned, refcount+=1)`);
} else {
  console.log(`  · embedding mock listening on ${mockInfo.url}`);
}

// 关键：所有 src import 必须用 dynamic import（await import(...)）。
// ESM 静态 import 会被 hoist 把 src/config.js 提前到 startMock 之前
// evaluate，导致 config 仍读到 .env 的旧值。dynamic import 保证顺序：
// mock 启动 → src 加载。
const poolModule = await import('../../src/infrastructure/database/pool.js');
const { __setTestPool, __resetTestPool } = poolModule;
const storageModule = await import('../../src/infrastructure/storage/document-storage.js');
const { setDocumentStorage } = storageModule;
const { LocalFsStorage } = await import('../../src/infrastructure/storage/local-storage.js');
const sourcesServiceModule = await import('../../src/modules/sources/service.js');
const { recordTextSource, recordFileSource } = sourcesServiceModule;
const conversationsServiceModule = await import('../../src/modules/conversations/service.js');
const { createConversation } = conversationsServiceModule;
const runtimeModule = await import('../../src/core/agent/runtime.js');
const { streamAgent, _setPolicyResolverForTesting, _setRequireApprovalForTesting, _setMastraInstanceForTesting, _resetMastraInstanceCacheForTesting } = runtimeModule;
const registryModule = await import('../../src/core/agent/registry.js');
const { _setPerRequestFactoryOverrideForTesting } = registryModule;
const { config: appConfig } = await import('../../src/config.js');
// 注册 daymind Agent（与 src/scripts/verify-daymind-cross-conversation.ts 同源）
await import('../../src/agents/index.js');

if (!Number.isInteger(appConfig.embeddingDim) || appConfig.embeddingDim !== appConfig.databaseEmbeddingDim) {
  throw new Error(
    `✗ EMBEDDING_DIM (${appConfig.embeddingDim}) 必须等于 DATABASE_EMBEDDING_DIM (${appConfig.databaseEmbeddingDim})。`,
  );
}

let failed = 0;
function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${label}`);
  else { failed += 1; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ─── 真实 PDF 生成 ────────────────────────────────────────────────────
async function generateTwoPagePdf(seedKeyword: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const doc = new PDFKit({ size: 'A4' });
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', reject);
  });
  doc.fontSize(14).text(`Reference ${seedKeyword} ${seedKeyword} ${seedKeyword}`, 50, 50);
  doc.addPage();
  doc.fontSize(14).text(`Page two ${seedKeyword} ${seedKeyword} ${seedKeyword}`, 50, 50);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

// ─── 真实 DOCX（带 H1 标题 + 段落）─────────────────────────────────────
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function buildDocx(heading: string, body: string): Buffer {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pStyle w:val="Heading1"/><w:r><w:t>${escapeXml(heading)}</w:t></w:r></w:p>
    <w:p><w:r><w:t>${escapeXml(body)}</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
  </w:style>
</w:styles>`;
  const files = [
    { name: '[Content_Types].xml', content: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.styles+xml"/>
</Types>`) },
    { name: '_rels/.rels', content: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`) },
    { name: 'word/_rels/document.xml.rels', content: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`) },
    { name: 'word/document.xml', content: Buffer.from(xml) },
    { name: 'word/styles.xml', content: Buffer.from(stylesXml) },
  ];
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const crc = crc32(f.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.content.length, 18);
    local.writeUInt32LE(f.content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, f.content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.content.length, 20);
    central.writeUInt32LE(f.content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + f.content.length;
  }
  const localAll = Buffer.concat(localParts);
  const centralAll = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralAll.length, 12);
  eocd.writeUInt32LE(localAll.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localAll, centralAll, eocd]);
}

// ─── 工具 ────────────────────────────────────────────────────────────
async function selectFirstChunk(pool: Pool, sourceId: string): Promise<{
  documentId: string;
  chunkId: string;
  page: number | undefined;
  heading: string | undefined;
  content: string;
}> {
  const doc = await pool.query<{ id: string }>(
    `SELECT id FROM documents WHERE source_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [sourceId],
  );
  const documentId = doc.rows[0]?.id;
  if (!documentId) throw new Error(`no document for source ${sourceId}`);
  const chunks = await pool.query<{ id: string; content: string; metadata: { page?: number; heading?: string } }>(
    `SELECT id, content, metadata FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index ASC LIMIT 1`,
    [documentId],
  );
  const first = chunks.rows[0];
  if (!first) throw new Error(`no chunks for document ${documentId}`);
  return {
    documentId,
    chunkId: first.id,
    page: first.metadata?.page,
    heading: first.metadata?.heading,
    content: first.content,
  };
}

async function noHistory(pool: Pool, conversationId: string): Promise<boolean> {
  const r = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1`,
    [conversationId],
  );
  return Number(r.rows[0]!.count) === 0;
}

/**
 * 在指定 pool 上创建隔离 schema 并装载 init.sql + RAG 扩展。
 * 返回一个新 Pool（带 search_path=schema,public）。
 */
async function createIsolatedPool(dbUrl: string, schema: string): Promise<{
  pool: Pool;
  adminEnd: () => Promise<void>;
}> {
  const admin = new Pool({ connectionString: dbUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  const adminEnd = async (): Promise<void> => { await admin.end().catch(() => undefined); };
  const pool = new Pool({
    connectionString: dbUrl,
    options: `-c search_path=${schema},public`,
  });
  await pool.query(`SET app.rag_enabled = 'on'`);
  return { pool, adminEnd };
}

async function dropSchema(dbUrl: string, schema: string): Promise<void> {
  try {
    const admin = new Pool({ connectionString: dbUrl, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  } catch { /* best-effort */ }
}

// ─── 主流程 ───────────────────────────────────────────────────────────
const INIT_SQL = readFileSync(new URL('../../database/init.sql', import.meta.url), 'utf8');
const dbUrl = normalizeTestDbUrl(process.env.TEST_DATABASE_URL ?? '');
const storageRoot = mkdtempSync(join(tmpdir(), 'cites-rt-'));

// 关键：注入 stub Agent + stub policy resolver + stub mastra，避免触发
// 真 LLM 推理 / 真 tool 注册表查询 / 真 bootstrap 副作用。
// streamAgent 内部仍会真实调 searchDaymindSources 并把检索结果注入 done 事件。
let streamCalls = 0;
const stubAgent = {
  stream(_prompt: string, _options: Record<string, unknown>): {
    fullStream: AsyncIterable<unknown>;
  } {
    streamCalls += 1;
    // 空 stream → consumeAgentStream 立刻 yield done 事件，citations 来自
    // runtime 在调 agent.stream() 之前已收集的 execution.citations。
    return {
      fullStream: (async function* (): AsyncGenerator<unknown, void, unknown> {
        // no chunks
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

let originalError: unknown = null;
try {
  setDocumentStorage(new LocalFsStorage({ root: storageRoot }));

  // 每个格式：独立 schema + workspace + pool + keyword
  const formats: Array<{
    label: string;
    keyword: string;
    title: string;
    run: (workspaceId: string) => Promise<{
      recordedId: string;
      extra?: { page?: number; heading?: string };
    }>;
  }> = [
    {
      label: 'TXT',
      keyword: 'lavender-mist-9913',
      title: 'TXT Runtime E2E',
      run: async (workspaceId: string) => {
        const r = await recordTextSource(
          workspaceId,
          `${'lavender-mist-9913'} ${'lavender-mist-9913'} ${'lavender-mist-9913'}`,
          'TXT Runtime E2E',
        );
        return { recordedId: r.id };
      },
    },
    {
      label: 'DOCX',
      keyword: 'amber-ridge-2744',
      title: 'DOCX Runtime E2E',
      run: async (workspaceId: string) => {
        const buf = buildDocx('Quartz Pine 章节', `${'amber-ridge-2744'} ${'amber-ridge-2744'} ${'amber-ridge-2744'}`);
        const r = await recordFileSource(workspaceId, {
          filename: 'docx-rt.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          buffer: buf,
        });
        return { recordedId: r.id, extra: { heading: 'Quartz Pine 章节' } };
      },
    },
    {
      label: 'PDF',
      keyword: 'cobalt-shard-8821',
      title: 'PDF Runtime E2E',
      run: async (workspaceId: string) => {
        const buf = await generateTwoPagePdf('cobalt-shard-8821');
        const r = await recordFileSource(workspaceId, {
          filename: 'pdf-rt.pdf',
          mimeType: 'application/pdf',
          buffer: buf,
        });
        return { recordedId: r.id };
      },
    },
  ];

  for (const fmt of formats) {
    console.log(`\n── ${fmt.label} ──`);
    const schema = `rt_${fmt.label.toLowerCase()}_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | undefined;
    let adminEnd: (() => Promise<void>) | undefined;
    try {
      const iso = await createIsolatedPool(dbUrl, schema);
      pool = iso.pool;
      adminEnd = iso.adminEnd;
      await pool.query(INIT_SQL);
      __setTestPool(pool);

      const ws = await pool.query<{ id: string }>(
        `INSERT INTO workspaces(kind, name) VALUES ('shared', $1) RETURNING id`,
        [`runtime-e2e-${fmt.label.toLowerCase()}`],
      );
      const workspaceId = ws.rows[0]!.id;

      const recorded = await fmt.run(workspaceId);
      console.log(`  · ${fmt.label} sourceId=${recorded.recordedId}`);
      assert(`${fmt.label} recordSource returns sourceId`, typeof recorded.recordedId === 'string' && recorded.recordedId.length > 0);

      const sel = await selectFirstChunk(pool, recorded.recordedId);

      if (fmt.label === 'DOCX') {
        assert('DOCX chunk.metadata.heading captured from H1',
          sel.heading === 'Quartz Pine 章节',
          `got=${sel.heading ?? 'undefined'}`);
      }
      if (fmt.label === 'PDF') {
        assert('PDF chunk.metadata.page captured', typeof sel.page === 'number' && sel.page >= 1, `page=${sel.page}`);
      }

      const conversation = await createConversation(workspaceId, {
        title: `${fmt.label} runtime retrieval`,
        agentId: 'daymind',
        knowledgeBaseId: null,
      });
      assert(`${fmt.label} conversation has agentId=daymind`, conversation.agentId === 'daymind');
      assert(`${fmt.label} conversation has no history`, await noHistory(pool, conversation.id));

      // 真实 streamAgent：runtime 内部会调 searchDaymindSources → 把 citations
      // 注入 done 事件。我们读 done 事件而非 console.assert 直接调 searchDaymindSources。
      const events: import('../../src/core/execution/stream-events.js').StreamEvent[] = [];
      for await (const evt of streamAgent({
        workspaceId,
        agentId: 'daymind',
        prompt: fmt.keyword,
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

      const done = events.find((e) => e.type === 'done') as
        | import('../../src/core/execution/stream-events.js').StreamResult
        | undefined;
      assert(`${fmt.label} runtime emits >=1 done event`, !!done);
      if (!done) continue;
      assert(`${fmt.label} runtime's stub Agent was actually invoked (>=1 stream call)`, streamCalls >= 1, `streamCalls=${streamCalls}`);

      const citations = done.citations ?? [];
      assert(`${fmt.label} runtime done.citations has >=1 entry`, citations.length >= 1, `got=${citations.length}`);
      const hit = citations.find((c) => c.sourceId === recorded.recordedId) ?? citations[0]!;
      assert(`${fmt.label} citation.sourceId === recorded.id`, hit.sourceId === recorded.recordedId, `got=${hit.sourceId}`);
      assert(`${fmt.label} citation.documentId matches DB`, hit.documentId === sel.documentId, `got=${hit.documentId} expected=${sel.documentId}`);
      assert(`${fmt.label} citation.chunkId matches DB`, hit.chunkId === sel.chunkId, `got=${hit.chunkId} expected=${sel.chunkId}`);
      assert(`${fmt.label} citation has score in [0,1]`, hit.score >= 0 && hit.score <= 1, `got=${hit.score}`);
      assert(`${fmt.label} citation has distance`, typeof hit.distance === 'number' && hit.distance >= 0, `got=${hit.distance}`);
      assert(`${fmt.label} citation has snippet (content)`, typeof hit.content === 'string' && hit.content.length > 0);
      assert(`${fmt.label} citation has sourceTitle=${fmt.title}`, hit.sourceTitle === fmt.title, `got=${hit.sourceTitle}`);
      if (fmt.label === 'TXT') {
        assert(`${fmt.label} citation.sourceType=text`, hit.sourceType === 'text', `got=${hit.sourceType}`);
      } else {
        assert(`${fmt.label} citation.sourceType=file`, hit.sourceType === 'file', `got=${hit.sourceType}`);
        if (fmt.label === 'DOCX') {
          assert(`${fmt.label} citation.heading === chunk.metadata.heading`,
            hit.heading === sel.heading,
            `hit.heading=${hit.heading ?? 'undefined'} sel.heading=${sel.heading ?? 'undefined'}`);
        }
        if (fmt.label === 'PDF') {
          assert(`${fmt.label} citation.page === chunk.metadata.page`,
            hit.page === sel.page,
            `hit.page=${hit.page} sel.page=${sel.page}`);
        }
      }
    } finally {
      __resetTestPool();
      if (pool) await pool.end().catch(() => undefined);
      if (adminEnd) await adminEnd();
      await dropSchema(dbUrl, schema);
    }
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
  if (existsSync(storageRoot)) rmSync(storageRoot, { recursive: true, force: true });
  // 释放 mock —— refcount--，refcount=0 时 close server。
  // runner 模式下此调用不触发 close（runner 仍持有），由 runner 在循环结束后释放。
  await releaseMockEmbeddingProvider().catch(() => undefined);
  void originalError;
}

if (failed > 0) process.exitCode = 1;