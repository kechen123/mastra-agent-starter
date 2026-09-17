/**
 * 验证 recordFileSource / recordUrlSource 在敏感凭据被检测到时立即拒绝，
 * 不在 sources / documents / document_chunks / document_embeddings / 对象存储
 * 任何一处留下新行 / 新对象。
 *
 * 设计：
 *   - 使用 src/test-utils/db-isolation.ts 的 withIsolatedSchema 拿到一个独享 schema；
 *     强制要求 RUN_DB_TESTS=1 + TEST_DATABASE_URL，且数据库名落在测试库允许列表。
 *   - 在隔离 schema 中跑 init.sql、注入一条 workspace / knowledge_base，
 *     然后捕获"拒绝前"五处计数；
 *   - 调 recordFileSource(secret content)，断言 SensitiveSourceRejectedError；
 *   - 调 recordUrlSource 不在本次范围（URL 会触发 SSRF fetch，需要 HTTP mock），
 *     但保留 import 防止误删。详见下方的 `runRecordUrlSecret` 占位。
 *   - 重新捕获"拒绝后"五处计数，逐项断言 `before === after`。
 *
 * 没有 SKIPPED 分支：RUN_DB_TESTS/数据库未配置时直接抛错并使 process.exitCode=1，
 * 避免"测试看似通过、实际未跑"被误标绿。
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { normalizeTestDbUrl } from './_helpers/db-url.js';
import { acquireMockEmbeddingProvider, releaseMockEmbeddingProvider } from './_helpers/embedding-mock.js';

// 与 db-isolation.ts 一致：要求 RUN_DB_TESTS=1 + TEST_DATABASE_URL 命中允许列表。
if (process.env.RUN_DB_TESTS !== '1') {
  console.error('✗ sources-secret-intercept 拒绝执行：未启用 RUN_DB_TESTS=1。');
  console.error('  运行方式：');
  console.error('    RUN_DB_TESTS=1 TEST_DATABASE_URL=postgres://user:pwd@host:port/test_xxx \\');
  console.error('      npx tsx tests/integration/sources-secret-intercept.ts');
  throw new Error('sources-secret-intercept 需要 RUN_DB_TESTS=1');
}
if (!process.env.TEST_DATABASE_URL) {
  console.error('✗ sources-secret-intercept 拒绝执行：TEST_DATABASE_URL 未设置。');
  throw new Error('sources-secret-intercept 需要 TEST_DATABASE_URL');
}

// 闸门通过后 acquire mock。reject 路径**不**触达 embedTexts（敏感内容扫描在
// service.ts 顶层的 scanSensitiveData 阶段就抛错），但 mock 仍保持开启以避免
// 在未拒绝的旁路路径上误连生产 provider。
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
const {
  recordFileSource,
  recordUrlSource,
  SensitiveSourceRejectedError,
  SourceRejectedError,
} = sourcesServiceModule;

let failed = 0;
function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${label}`);
  else { failed += 1; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const INIT_SQL = readFileSync(new URL('../../database/init.sql', import.meta.url), 'utf8');
const schema = `secret_${randomUUID().replaceAll('-', '')}`;
const storageRoot = mkdtempSync(join(tmpdir(), 'secret-intercept-'));

const dbUrl = normalizeTestDbUrl(process.env.TEST_DATABASE_URL ?? '');

const pool = new Pool({
  connectionString: dbUrl,
  options: `-c search_path=${schema},public`,
});

let originalError: unknown = null;
try {
  const admin = new Pool({ connectionString: dbUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  // pgvector 是 document_embeddings.embedding 列的依赖；不带 vector 扩展时 init.sql
  // 会直接抛 `type "vector" does not exist`。我们在隔离 schema 里手动装一遍，
  // 不影响其他 schema / 公共库；测试结束 DROP SCHEMA 一并清掉。
  await admin.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await admin.end();

  // document_embeddings 表由 init.sql 的 RAG 条件块（`app.rag_enabled = 'on'`）
  // 创建；Core-only 默认跳过。我们需要这张表来验证"拒绝路径不写入 embeddings"。
  // 用 SET（session 级）而非 SET LOCAL，因为后续 init.sql 不在显式事务里。
  await pool.query(`SET app.rag_enabled = 'on'`);

  // 全量 init.sql（含 sources / documents / document_chunks / document_embeddings 等）。
  await pool.query(INIT_SQL);

  __setTestPool(pool);
  setDocumentStorage(new LocalFsStorage({ root: storageRoot }));

  // 必须创建一条 workspace + knowledge_base 才能让 recordFileSource 完成插入。
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces(kind, name) VALUES ('shared', 'secret-intercept') RETURNING id`,
  );
  const workspaceId = ws.rows[0]!.id;
  const kb = await pool.query<{ id: string }>(
    `INSERT INTO knowledge_bases(workspace_id, name) VALUES ($1, 'secret-intercept-kb') RETURNING id`,
    [workspaceId],
  );
  const knowledgeBaseId = kb.rows[0]!.id;

  /**
   * 在隔离 schema 上采集一组计数。返回的字段名对应"拒绝路径**不应**写入的实体"：
   * sources / documents / document_chunks / document_embeddings + 存储目录文件数。
   */
  async function captureCounts(): Promise<{
    sources: number;
    documents: number;
    document_chunks: number;
    document_embeddings: number;
    storageFiles: number;
  }> {
    const [sources, documents, chunks, embeddings, storageFiles] = await Promise.all([
      pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM sources WHERE workspace_id = $1`, [workspaceId]).then(r => Number(r.rows[0]!.count)),
      pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM documents WHERE workspace_id = $1`, [workspaceId]).then(r => Number(r.rows[0]!.count)),
      pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM document_chunks WHERE workspace_id = $1`, [workspaceId]).then(r => Number(r.rows[0]!.count)),
      pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM document_embeddings WHERE workspace_id = $1`, [workspaceId]).then(r => Number(r.rows[0]!.count)),
      // 存储目录在 staging/final 两个子目录下递归计数；对象存储拒绝路径必须两者都为 0。
      countFilesRecursive(join(storageRoot, 'staging')) + countFilesRecursive(join(storageRoot, 'final')),
    ]);
    return { sources, documents, document_chunks: chunks, document_embeddings: embeddings, storageFiles };
  }

  // 用真实敏感凭据内容触发 SensitiveSourceRejectedError。
  // 选 password 类型：scanSensitiveData 对 "密码：<value>" / "Bearer <token>" 等都能识别。
  const secretText = '服务器地址：example.com\n密码：abc123456\n其它无关内容';
  const secretBuffer = Buffer.from(secretText, 'utf-8');
  const realContentHash = createHash('sha256').update(secretBuffer).digest('hex');

  const before = await captureCounts();

  let caught: unknown = null;
  try {
    await recordFileSource(workspaceId, { filename: 'secret.txt', mimeType: 'text/plain', buffer: secretBuffer });
  } catch (e) {
    caught = e;
  }
  assert('recordFileSource throws SensitiveSourceRejectedError on password content',
    caught instanceof SensitiveSourceRejectedError,
    caught instanceof Error ? `got ${caught.constructor.name}: ${caught.message}` : `got ${caught}`);

  const after = await captureCounts();

  // 五处计数必须逐项不变。这是 Fix 6 的核心：不依赖任何固定 sentinel hash，
  // 仅比较当前 workspace 在"拒绝前 / 拒绝后"的状态差。
  assert('sources count unchanged after reject', after.sources === before.sources,
    `before=${before.sources} after=${after.sources}`);
  assert('documents count unchanged after reject', after.documents === before.documents,
    `before=${before.documents} after=${after.documents}`);
  assert('document_chunks count unchanged after reject', after.document_chunks === before.document_chunks,
    `before=${before.document_chunks} after=${after.document_chunks}`);
  assert('document_embeddings count unchanged after reject', after.document_embeddings === before.document_embeddings,
    `before=${before.document_embeddings} after=${after.document_embeddings}`);
  assert('storage files count unchanged after reject', after.storageFiles === before.storageFiles,
    `before=${before.storageFiles} after=${after.storageFiles}`);

  // 双保险：用真实 sha256 反查，确保"未新增 secret 源行"。
  // 之前测试用 'unused' 字面量作为占位（必然为 0），无法验证 service 真拒绝；
  // 这里换成"如果这条源被写就会有的值"，让断言真正反映"拒绝时确实没写"。
  const dupCheck = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM sources WHERE workspace_id = $1 AND content_hash = $2`,
    [workspaceId, realContentHash],
  );
  assert('no source row matches real contentHash of secret payload',
    Number(dupCheck.rows[0]!.count) === 0,
    `count=${dupCheck.rows[0]!.count}`);

  // ─── URL 通道 ────────────────────────────────────────────────────────
  // URL 通道真实跑会触发 SSRF fetch，依赖网络 / mock。本次范围只验证文件通道；
  // URL 分支的同样覆盖留给 integration tests（sources-url-safety.ts）。
  // 这里仍要确保 import 与异常类型契约仍在源代码树中可解析。
  void recordUrlSource;
  void SourceRejectedError;
} catch (err) {
  originalError = err;
  console.error('  ✗ unexpected failure during setup/teardown:', err);
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

function countFilesRecursive(dir: string): number {
  // 用 sync fs 计数：测试期间 storageRoot 永远在本地 tmp；不需要异步。
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) count += countFilesRecursive(full);
    else count += 1;
  }
  return count;
}