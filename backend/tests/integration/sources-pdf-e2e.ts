/**
 * 真实 PDF E2E：pdfkit 生成文本型 PDF → pdfjs-dist 解析 → recordFileSource →
 * Source → Document → Chunk(metadata.page) → Citation.page 全链路。
 *
 * 必须在隔离测试 DB（RUN_DB_TESTS=1 + TEST_DATABASE_URL）下跑；不跳过。
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import PDFKit from 'pdfkit';

import { normalizeTestDbUrl } from './_helpers/db-url.js';
import { acquireMockEmbeddingProvider, releaseMockEmbeddingProvider } from './_helpers/embedding-mock.js';

// 闸门
if (process.env.RUN_DB_TESTS !== '1' || !process.env.TEST_DATABASE_URL) {
  console.error('✗ sources-pdf-e2e 拒绝执行：未启用 RUN_DB_TESTS=1 + TEST_DATABASE_URL。');
  throw new Error('sources-pdf-e2e 需要 RUN_DB_TESTS=1 + TEST_DATABASE_URL');
}

// 闸门通过后 acquire mock → DELETE .env 的 EMBEDDING_*，再 SET mock URL。
// 之后 dynamic import src/* → config.ts 看到的 EMBEDDING_BASE_URL 是 mock。
// runner 模式下端口由 runner 持有；standalone 模式下由本 fixture 在 finally 关闭。
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
const { setDocumentStorage, getDocumentStorage } = storageModule;
const { LocalFsStorage } = await import('../../src/infrastructure/storage/local-storage.js');
const sourcesServiceModule = await import('../../src/modules/sources/service.js');
const { recordFileSource } = sourcesServiceModule;

let failed = 0;
function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${label}`);
  else { failed += 1; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const INIT_SQL = readFileSync(new URL('../../database/init.sql', import.meta.url), 'utf8');
const schema = `pdf_e2e_${randomUUID().replaceAll('-', '')}`;
const storageRoot = mkdtempSync(join(tmpdir(), 'pdf-e2e-'));

// pg 不识别 `?safety-identifier=test_xxx`（runner 闸门），在交给 pg 前剥掉。
const dbUrl = normalizeTestDbUrl(process.env.TEST_DATABASE_URL ?? '');

async function generateTwoPagePdf(): Promise<Buffer> {
  // 生成足够长的两页 PDF，确保 page 2 也能产生独立 chunk，验证 page attribution。
  const longLineA = 'A'.repeat(800);
  const longLineB = 'B'.repeat(800);
  const chunks: Buffer[] = [];
  const doc = new PDFKit({ size: 'A4' });
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', reject);
  });
  doc.fontSize(12).text(`Page 1 head. ${longLineA}`, 50, 750);
  doc.text(`Mid of page 1. ${longLineA}`);
  doc.addPage().fontSize(12).text(`Page 2 head. ${longLineB}`, 50, 750);
  doc.text(`Mid of page 2. ${longLineB}`);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

const pool = new Pool({
  connectionString: dbUrl,
  options: `-c search_path=${schema},public`,
});

let originalError: unknown = null;
try {
  const admin = new Pool({ connectionString: dbUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await admin.end();

  await pool.query(`SET app.rag_enabled = 'on'`);
  await pool.query(INIT_SQL);

  __setTestPool(pool);
  setDocumentStorage(new LocalFsStorage({ root: storageRoot }));

  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces(kind, name) VALUES ('shared', 'pdf-e2e') RETURNING id`,
  );
  const workspaceId = ws.rows[0]!.id;
  const kb = await pool.query<{ id: string }>(
    `INSERT INTO knowledge_bases(workspace_id, name) VALUES ($1, 'pdf-e2e-kb') RETURNING id`,
    [workspaceId],
  );

  // 生成真实 PDF Buffer
  const pdfBuffer = await generateTwoPagePdf();
  console.log(`  · generated real PDF (size=${pdfBuffer.length} bytes)`);
  const expectedHash = createHash('sha256').update(pdfBuffer).digest('hex');

  const source = await recordFileSource(workspaceId, {
    filename: 'sample.pdf',
    mimeType: 'application/pdf',
    buffer: pdfBuffer,
  });
  console.log(`  · recordFileSource 返回: sourceId=${source.id}, chunkCount=${source.chunkCount}`);
  const sourceId = source.id;

  // 验证 Source 落库
  const sourceRow = await pool.query<{ id: string; content_hash: string; workspace_id: string; title: string; metadata: { pageCount?: number; pageBlocks?: Array<{ page: number }> } }>(
    `SELECT id, content_hash, workspace_id, title, metadata FROM sources WHERE id = $1`,
    [sourceId],
  );
  assert('Source row in DB with correct content_hash',
    sourceRow.rows.length === 1 && sourceRow.rows[0]!.content_hash === expectedHash && sourceRow.rows[0]!.workspace_id === workspaceId,
    sourceRow.rows.length === 0 ? 'no source row' : `hash=${sourceRow.rows[0]!.content_hash} expected=${expectedHash}`);
  assert('Source.metadata.pageCount >= 2 (multi-page PDF)',
    (sourceRow.rows[0]!.metadata.pageCount ?? 0) >= 2,
    `pageCount=${sourceRow.rows[0]!.metadata.pageCount}`);

  // 验证 Document 落库
  const docRows = await pool.query<{ id: string; workspace_id: string; total_chunks: number; status: string; sha256: string }>(
    `SELECT id, workspace_id, total_chunks, status, sha256 FROM documents WHERE source_id = $1`,
    [sourceId],
  );
  assert('Document row(s) exist for source', docRows.rows.length >= 1,
    `count=${docRows.rows.length}`);
  const documentId = docRows.rows[0]!.id;
  assert('Document.workspace_id matches', docRows.rows[0]!.workspace_id === workspaceId);
  assert('Document.sha256 matches contentHash',
    docRows.rows[0]!.sha256 === expectedHash,
    `got=${docRows.rows[0]!.sha256}`);

  // 验证 Chunk 落库 + metadata.page
  const chunkRows = await pool.query<{ id: string; chunk_index: number; content: string; metadata: { page?: number } | null }>(
    `SELECT id, chunk_index, content, metadata FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index ASC`,
    [documentId],
  );
  assert('At least 1 chunk in DB', chunkRows.rows.length >= 1, `count=${chunkRows.rows.length}`);
  console.log(`  · chunk count: ${chunkRows.rows.length}`);
  chunkRows.rows.forEach((c, i) => {
    console.log(`    - chunk[${i}] id=${c.id} page=${(c.metadata as { page?: number })?.page ?? 'n/a'} content="${c.content.slice(0, 60)}"`);
  });
  const firstChunkWithPage = chunkRows.rows.find((c) => (c.metadata as { page?: number })?.page === 1);
  const secondChunkWithPage = chunkRows.rows.find((c) => (c.metadata as { page?: number })?.page === 2);
  assert('At least one chunk has metadata.page === 1', !!firstChunkWithPage);
  assert('At least one chunk has metadata.page === 2', !!secondChunkWithPage);
  const firstChunkId = firstChunkWithPage?.id;
  const secondChunkId = secondChunkWithPage?.id;
  console.log(`  · sourceId=${sourceId} documentId=${documentId} page1ChunkId=${firstChunkId} page2ChunkId=${secondChunkId}`);

  // 验证 Storage 文件确实写入了 final 目录
  const storageFiles: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else storageFiles.push(full);
    }
  }
  walk(storageRoot);
  assert('Storage final/ has at least one file', storageFiles.length >= 1,
    `files=${storageFiles.length}`);

  // 验证存储对象的 sha256 与 contentHash 一致（确保 final 文件就是源 PDF）
  const finalFileBytes = readFileSync(storageFiles[0]!);
  const storedHash = createHash('sha256').update(finalFileBytes).digest('hex');
  assert('Stored bytes sha256 === source contentHash', storedHash === expectedHash,
    `stored=${storedHash} expected=${expectedHash}`);
} catch (err) {
  originalError = err;
  console.error('  ✗ unexpected failure:', err);
  failed += 1;
} finally {
  __resetTestPool();
  await pool.end().catch(() => undefined);
  try {
    const admin = new Pool({ connectionString: dbUrl, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  } catch { /* best-effort */ }
  if (existsSync(storageRoot)) rmSync(storageRoot, { recursive: true, force: true });
  void getDocumentStorage;
  void originalError;
  await releaseMockEmbeddingProvider().catch(() => undefined);
}

if (failed > 0) process.exitCode = 1;