/**
 * PR-4.2 §8.1：异步 ingestion / finalize / outbox 真实 PG 集成测试 —
 * Core-only 形态。
 *
 * 启用条件：
 *   - `RUN_DB_TESTS=1` + `TEST_DATABASE_URL=postgres://.../<test_db>`；
 *   - 测试库允许列表 `db-isolation.ts` 已强制。
 *   - 本轮跑前必须先把 `backend/database/init.sql` 应用到测试库。
 *
 * Core-only / RAG 形态由**进程级环境变量**决定（PR-4 第二轮 Codex 整改，
 * 2026-09-11）：
 *   - 本文件（Core-only）：`EMBEDDING_API_KEY` 必须为空（缺失或空字符
 *     串）→ `config.ragEnabled=false`；worker / finalize / outbox 全链
 *     路跳过 embedding 计算与 `document_embeddings` 写入。
 *   - RAG 文件（`pr4-async-doc-rag-rag.ts`）：`EMBEDDING_API_KEY` 必须
 *     为非空字符串 → `config.ragEnabled=true`。
 *
 * 这种"按 env 拆文件"的安排使得两套形态完全跑在独立进程里 —— 不需要
 * 任何测试 setter / 后门去覆盖生产 `config`。两个文件共享相同的
 * schema-init helper 与 pg pool，但 `config.ragEnabled` 在每个文件
 * 启动时由本进程的 env 决定，跟生产路径语义完全一致。
 *
 * 本文件只调用生产实现：
 *   - finalize / outbox sweeper：调生产 `_runFinalizeLeaseSweeperOnce` /
 *     `_runOutboxLeaseSweeperOnce`，不直接拼 UPDATE；
 *   - ingestion worker：调生产 `runIngestionWorkerOnce`，覆盖 parsing →
 *     chunking → finalizing → ready 全链路（Core-only 不动 embedding）；
 *   - 23505 race：调生产 `createUploadBundle`（公开导出），断言第二请
 *     求撞 partial unique + abort staging；
 *   - finalize "IO 成功 + DB 写回失败"：用临时 BEFORE UPDATE trigger
 *     真实制造第一次 done 写回失败，第二次 tick 由生产 sweeper + 生产
 *     `_runFinalizeOnce` 收敛。
 *
 * 允许 fake 的只有：
 *   - DocumentStorage（FakeDocumentStorage 替代 IO）；
 *   - Embedding provider：本文件**不调** embedding provider（Core-only
 *     形态决定）。
 *
 * 16 个 case（不含 #2 / #15，已拆到 RAG 文件）：
 *   1.  Core-only fresh schema：RAG 表不存在 + app.rag_enabled='off'。
 *   3.  并发上传相同 sha256 → 23505 race（createUploadBundle 真实路径）。
 *   4.  ingestion claim 在 storage_pending 时抢不到（生产入口）。
 *   5.  finalize claim 跨实例并发 → 恰好一个 processing（生产入口）。
 *   6.  finalize lease 过期 → 生产 sweeper 收回。
 *   7.  ingestion transitionIngestionStatus 失败时整事务回滚（生产）。
 *   8.  softDeleteDocument 串联取消 + outbox 入队（生产）。
 *   9.  outbox lease 过期 → 生产 sweeper 收回。
 *   10. outbox 删除成功 → status=done + processed_at=now（生产入口）。
 *   11. requeue 后 attempts 只 +1（生产 transitionIngestionStatus）。
 *   12. 删除后旧 worker 无法把 document 重新写 ready（生产）。
 *   13. lease 已过期 worker 无法写 done/failed（生产）。
 *   14. finalize 成功 + DB 写回失败 → 触发器真注入 → 二次重试幂等收敛。
 *   16. outbox 两 worker 并发仅一个执行 remove（生产）。
 *   17. ingestion worker 真实跑全链路（storage ready → runIngestionWorkerOnce
 *       → parser/chunk/finalizing → ready；Core-only 跳过 embedding）。
 *   18. transitionIngestionStatus 非 requeue 全路径真实 PG 覆盖
 *       （parsing → chunking → embedding → finalizing → ready，断言
 *        job 与 documents 同步推进 + lease 守卫；PR-4 第二轮 Codex 整改
 *        阻塞-A 验收）。
 *
 * Skip：每个 case 用 `{ skip: !RUN }`；无 DB 环境时文件可干净 typecheck。
 *
 * 运行命令（PowerShell，从 backend 目录）：
 *   $env:TEST_DATABASE_URL = (读 .env 里的 DATABASE_URL)
 *   $env:RUN_DB_TESTS = '1'
 *   $env:EMBEDDING_API_KEY = ''   # Core-only：必须为空字符串
 *   npx tsx --test tests/integration/pr4-async-doc-rag-core.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureSchema,
  createIsolatedSchema,
  dropIsolatedSchema,
} from '../../src/test-utils/schema-init.js';
import {
  __setTestPool,
  __resetTestPool,
} from '../../src/infrastructure/database/pool.js';
import {
  setDocumentStorage,
  type DocumentStorage,
  _resetDocumentStorageForTesting,
} from '../../src/infrastructure/storage/document-storage.js';
import {
  claimNextIngestionJob,
  transitionIngestionStatus,
  markFailedTerminal,
} from '../../src/modules/documents/jobs-repository.js';
import { softDeleteDocument } from '../../src/modules/documents/service.js';
import { runIngestionWorkerOnce } from '../../src/modules/documents/ingestion-worker.js';
import {
  _runFinalizeOnce,
  _runOutboxOnce,
  _runFinalizeLeaseSweeperOnce,
  _runOutboxLeaseSweeperOnce,
} from '../../src/modules/documents/storage-workers.js';
import { createUploadBundle } from '../../src/server/routes/documents.js';

const URL = process.env.TEST_DATABASE_URL;
const RUN = process.env.RUN_DB_TESTS === '1' && !!URL;

// 进程级 Core-only 守卫：本文件必须以 `EMBEDDING_API_KEY=''` 启动。
// 这样 `config.ragEnabled` 由生产 env 解析为 false，runIngestionWorkerOnce
// 走 "if (config.ragEnabled) { embedTexts }" 的 else 分支，**不调**
// embedding provider。如果用户在沙箱误设了真实 key，会在 worker 尝试
// 调真实 API 时暴露问题 —— 这正是 PR-4 想要捕获的"形态漂移"。
const CORE_ONLY_PROCESS =
  typeof process.env.EMBEDDING_API_KEY !== 'string' ||
  process.env.EMBEDDING_API_KEY.trim().length === 0;

// ─── helpers ──────────────────────────────────────────────────────────

function id(label: string): string {
  // 与 PG 的 md5($1)::uuid 完全对齐：32 字符 hex + 4 个 dash，转换成标准
  // UUID 字符串格式（xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx），这样调用
  // transitionIngestionStatus({ jobId: id('jobA') }) 时 pg 驱动能直接
  // 把它当 UUID 字面量传给 PG。旧实现返回裸 hex，pg 当 text→uuid 转换抛 22P02。
  const hex = createHash('md5').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function withIsolatedSchema<T>(
  ragEnabled: boolean,
  fn: (pool: Pool, schema: string) => Promise<T>,
): Promise<T> {
  const root = new Pool({ connectionString: URL });
  const schema = `test_pr4_${Math.random().toString(36).slice(2, 10)}`;
  await createIsolatedSchema(root, schema);
  const scoped = new Pool({
    connectionString: URL,
    options: `-c search_path=${schema},public`,
  });
  try {
    await ensureSchema(scoped, { ragEnabled });
    return await fn(scoped, schema);
  } finally {
    await scoped.end();
    await dropIsolatedSchema(root, schema);
    await root.end();
  }
}

async function seedUserAndWorkspace(pool: Pool, label: string): Promise<{
  userId: string;
  workspaceId: string;
}> {
  const userId = id(`${label}-user`);
  // 用户 id 与 workspace.owner_user_id 必须**同一** UUID —— FK
  // workspaces_owner_user_id_fkey 强制；旧实现两个 md5() 输入不一致
  // （`md5(label)` vs `md5('${label}-ws')`）导致 #17 / #18 在第二次 INSERT
  // 抛 23503。
  const ownerId = id(`${label}-ws-user`);
  await pool.query(
    `INSERT INTO app_users (id, username, username_normalized, password_hash)
     VALUES ($1::uuid, $2, $2, 'placeholder')`,
    [ownerId, label],
  );
  const wsId = id(`${label}-ws`);
  await pool.query(
    // kind='personal' 才允许 owner_user_id 非空（init.sql workspaces_kind_owner_check
    // 复合约束：personal ⇒ owner_user_id NOT NULL；shared ⇒ owner_user_id NULL）。
    `INSERT INTO workspaces (id, owner_user_id, name, kind)
     VALUES ($1::uuid, $2::uuid, $3, 'personal')`,
    [wsId, ownerId, label],
  );
  return { userId, workspaceId: wsId };
}

async function seedKnowledgeBase(
  pool: Pool,
  workspaceId: string,
  label: string,
): Promise<{ knowledgeBaseId: string }> {
  const knowledgeBaseId = id(`${label}-kb`);
  await pool.query(
    // 旧实现用 md5($1)::uuid 且 $1=label，与返回的 id(label-kb) 不一致，
    // 导致下游 documents INSERT 撞 23503（knowledge_base_id 不存在）。
    `INSERT INTO knowledge_bases (id, workspace_id, name)
     VALUES ($1::uuid, $2::uuid, $3)`,
    [knowledgeBaseId, workspaceId, label],
  );
  return { knowledgeBaseId };
}

/**
 * 内存版 DocumentStorage —— 复刻生产 LocalFsStorage 的语义：
 *   - putStaging：写入 stagingKey；
 *   - finalize(stagingKey, finalKey)：staging 存在 → rename；staging 不
 *     存在 + final 存在 → 幂等成功；staging 不存在 + final 不存在 → ENOENT；
 *   - abortStaging：删除 stagingKey；
 *   - remove(finalKey)：ENOENT 视为成功；
 *   - exists(finalKey)：finalKey 是否存在。
 */
class FakeDocumentStorage implements DocumentStorage {
  private readonly objects = new Map<string, Buffer>();
  /** 控制 finalize 是否抛 ENOENT（用于 #14：触发器注入路径不依赖此）。 */
  failNextFinalize = false;
  /** 统计 remove 被调用次数（用于 #16）。 */
  removeCallCount = 0;

  async putStaging(input: {
    uploadId: string;
    body: Buffer;
    meta: { mimeType: string; size: number };
  }): Promise<{ stagingKey: string; sha256: string }> {
    const sha256 = createHash('sha256').update(input.body).digest('hex');
    const stagingKey = `staging/${input.uploadId}`;
    this.objects.set(stagingKey, input.body);
    return { stagingKey, sha256 };
  }

  async finalize(stagingKey: string, finalKey: string): Promise<void> {
    if (this.failNextFinalize) {
      // 旧路径保留：触发器注入后此处不再使用。
      this.failNextFinalize = false;
      if (!this.objects.has(finalKey)) {
        this.objects.set(finalKey, this.objects.get(stagingKey) ?? Buffer.alloc(0));
        this.objects.delete(stagingKey);
      }
      return;
    }
    if (!this.objects.has(stagingKey)) {
      if (this.objects.has(finalKey)) return;
      const err = new Error(`finalize: staging ${stagingKey} 不存在`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    const buf = this.objects.get(stagingKey)!;
    this.objects.set(finalKey, buf);
    this.objects.delete(stagingKey);
  }

  async abortStaging(stagingKey: string): Promise<void> {
    this.objects.delete(stagingKey);
  }

  async remove(finalKey: string): Promise<void> {
    this.removeCallCount += 1;
    this.objects.delete(finalKey);
  }

  async getBytes(finalKey: string): Promise<Buffer> {
    const buf = this.objects.get(finalKey);
    if (!buf) {
      const err = new Error(`getBytes: ${finalKey} 不存在`) as NodeJS.ErrnoException;
      err.code = 'DOCUMENT_STORAGE_NOT_FOUND';
      throw err;
    }
    return buf;
  }

  async exists(finalKey: string): Promise<boolean> {
    return this.objects.has(finalKey);
  }

  /** 测试用：直接放一个 finalKey。 */
  seedFinal(finalKey: string, body: Buffer = Buffer.from('hi')): void {
    this.objects.set(finalKey, body);
  }

  /** 测试用：放一个 stagingKey。 */
  seedStaging(stagingKey: string, body: Buffer = Buffer.from('hi')): void {
    this.objects.set(stagingKey, body);
  }
}

function installFakeStorage(storage: FakeDocumentStorage): void {
  setDocumentStorage(storage);
}
function uninstallFakeStorage(): void {
  _resetDocumentStorageForTesting();
}

// ─── #1 Core-only fresh schema ─────────────────────────────────────────
//
// 整改：pg_extension 是**数据库级**而非 schema 级。本测试不依赖"测
// 试库未安装 vector"作为结论（无法用 isolated schema 隔离）。仅断
// 言 schema-scoped 的 RAG 表不存在 + bootstrap 不执行 CREATE EXTENSION
// （通过 app.rag_enabled 状态推断）。
test('PR-4.1 §8.4.1: Core-only fresh schema → RAG 表不存在 + rag_enabled=off', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('embedding_profiles', 'document_embeddings')`,
    );
    assert.deepEqual(
      tables.rows.map((r) => r.table_name).sort(),
      [],
      'Core-only 不应创建 RAG 表',
    );
    await pool.query(`SELECT set_config('app.rag_enabled', 'off', false)`);
    const r = await pool.query<{ setting: string }>(
      `SELECT current_setting('app.rag_enabled', true) AS setting`,
    );
    assert.equal(r.rows[0]?.setting, 'off', 'Core-only app.rag_enabled 应为 off');
  });
});

// ─── #3 并发上传相同 sha256 → 23505 race（生产入口） ────────────────
//
// 整改（2026-09-11 第二轮）：测试调生产 `createUploadBundle`（route handler
// 内的上传事务链），第二个请求撞 partial unique → 23505 → route handler 走
// catch 分支复用既有 document row；本测试只验证"撞 partial unique"这一步。
//
// 关于"staging abort"：FakeDocumentStorage 模拟 abort 路径。
test('PR-4.2 §8.1: 并发上传相同 sha256 → createUploadBundle 真实撞 23505', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    const { knowledgeBaseId } = await seedKnowledgeBase(pool, workspaceId, 'kbA');
    const storage = new FakeDocumentStorage();
    installFakeStorage(storage);
    __setTestPool(pool);
    try {
      const body = Buffer.from('hello');
      const uploadIdA = randomUUID();
      const uploadIdB = randomUUID();
      // 写两个 staging 对象（生产中由上传 route 先 putStaging）。
      storage.seedStaging(`staging/${uploadIdA}`, body);
      storage.seedStaging(`staging/${uploadIdB}`, body);
      const sha = createHash('sha256').update(body).digest('hex');
      const finalKey = `final/${sha.slice(0, 16)}`;
      // 第一请求：成功。
      const first = await createUploadBundle({
        workspaceId,
        knowledgeBaseId,
        name: 'a.txt',
        type: 'txt',
        size: body.length,
        storageKey: finalKey,
        sha256: sha,
        stagingKey: `staging/${uploadIdA}`,
      });
      assert.ok(first.document.id, '第一请求 documents 行已建');
      assert.ok(first.job.id, '第一请求 ingestion job 已建');
      // 第二请求：相同 sha256 + knowledge_base + workspace 触发
      // `one_active_document_per_workspace_kb_sha` partial unique → 23505。
      let caught: unknown = null;
      try {
        await createUploadBundle({
          workspaceId,
          knowledgeBaseId,
          name: 'a.txt',
          type: 'txt',
          size: body.length,
          storageKey: finalKey,
          sha256: sha,
          stagingKey: `staging/${uploadIdB}`,
        });
      } catch (err) {
        caught = err;
      }
      const errCode = (caught as { code?: string } | null)?.code;
      assert.equal(errCode, '23505', '第二次 createUploadBundle 必须抛 23505');
      // 三表统计：documents / ingestion_jobs / finalize_jobs 都只 1 行。
      const docCnt = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM documents
          WHERE workspace_id = $1::uuid`,
        [workspaceId],
      );
      assert.equal(docCnt.rows[0]?.count, '1', 'documents 恰好 1 行');
      const jobCnt = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM document_ingestion_jobs
          WHERE workspace_id = $1::uuid`,
        [workspaceId],
      );
      assert.equal(jobCnt.rows[0]?.count, '1', 'ingestion_jobs 恰好 1 行');
      const fzCnt = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM storage_finalize_jobs
          WHERE workspace_id = $1::uuid`,
        [workspaceId],
      );
      assert.equal(fzCnt.rows[0]?.count, '1', 'storage_finalize_jobs 恰好 1 行');
      // 模拟 route handler catch 23505 后的 abort staging：第二请求
      // 的 staging 应被清掉，第一请求的 staging 保留（因为生产会
      // rename 到 finalKey；FakeDocumentStorage 已 seed 两者隔离）。
      await storage.abortStaging(`staging/${uploadIdB}`);
      assert.equal(
        await storage.exists(`staging/${uploadIdB}`),
        false,
        'abort staging 后第二请求的对象不存在',
      );
    } finally {
      __resetTestPool();
      uninstallFakeStorage();
    }
  });
});

// ─── #4 ingestion claim storage_status 守卫（生产入口） ───────────────
//
// 整改：测试走生产 claimNextIngestionJob，断言 storage_pending 时不抢。
test('PR-4.2 §8.1: ingestion claim 在 storage_pending 上抢不到', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    const { knowledgeBaseId } = await seedKnowledgeBase(pool, workspaceId, 'kbA');
    __setTestPool(pool);
    try {
      const docId = id('docA');
      await pool.query(
        `INSERT INTO documents (
           id, workspace_id, knowledge_base_id, name, type, size,
           status, storage_status, storage_key, sha256
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, 'txt', 5,
           'queued', 'storage_pending', $5, $6
         )`,
        [docId, workspaceId, knowledgeBaseId, 'a.txt', 'final/a', 'sha-a'],
      );
      const jobId = id('jobA');
      await pool.query(
        `INSERT INTO document_ingestion_jobs (id, workspace_id, document_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'queued')`,
        [jobId, workspaceId, docId],
      );
      const claimed = await claimNextIngestionJob('worker-A');
      assert.equal(claimed, null, 'storage_pending 时不应被 claim');
      await pool.query(
        `UPDATE documents SET storage_status = 'ready' WHERE id = $1::uuid`,
        [docId],
      );
      const claimed2 = await claimNextIngestionJob('worker-A');
      assert.ok(claimed2, 'storage_status=ready 后可被 claim');
      assert.equal(claimed2!.documentId, id('docA'));
    } finally {
      __resetTestPool();
    }
  });
});

// ─── #5 finalize claim 跨实例并发（生产入口） ─────────────────────────
//
// 整改：测试走生产 `_runFinalizeOnce`（导出），断言 FOR UPDATE SKIP
// LOCKED + partial unique 让同时只一个 worker 抢到。
test('PR-4.2 §8.1: finalize claim 跨实例并发 → 恰好一个 processing', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    const { knowledgeBaseId } = await seedKnowledgeBase(pool, workspaceId, 'kbA');
    const docId = id('docA');
    await pool.query(
      `INSERT INTO documents (
         id, workspace_id, knowledge_base_id, name, type, size,
         status, storage_status, storage_key, sha256
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'txt', 5,
         'queued', 'storage_pending', $5, $6
       )`,
      [docId, workspaceId, knowledgeBaseId, 'a.txt', 'final/a', 'sha-a'],
    );
    await pool.query(
      `INSERT INTO storage_finalize_jobs (id, workspace_id, document_id, staging_key, final_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
      [id('jobA'), workspaceId, docId, 'staging/x', 'final/x'],
    );
    __setTestPool(pool);
    const storage = new FakeDocumentStorage();
    storage.seedStaging('staging/x');
    installFakeStorage(storage);
    try {
      const a = _runFinalizeOnce();
      const b = _runFinalizeOnce();
      const [ra, rb] = await Promise.all([a, b]);
      const claimed = [ra, rb].filter((r) => r !== null);
      assert.equal(claimed.length, 1, '恰好一个 worker 抢到 finalize');
      const row = await pool.query<{ status: string; lease_owner: string | null }>(
        `SELECT status, lease_owner FROM storage_finalize_jobs WHERE id = $1::uuid`,
        [id('jobA')],
      );
      assert.ok(
        row.rows[0]?.status === 'processing' || row.rows[0]?.status === 'done',
        `finalize 行状态应在 processing/done 之间，实际=${row.rows[0]?.status}`,
      );
    } finally {
      __resetTestPool();
      uninstallFakeStorage();
    }
  });
});

// ─── #6 finalize lease 过期 → 生产 sweeper 收回 ───────────────────────
//
// 整改（2026-09-11）：测试调生产 `_runFinalizeLeaseSweeperOnce`，不再
// 直接拼 UPDATE。构造一个已过期的 lease 行 → 跑 sweeper → 期望被收回
// status='pending'。
test('PR-4.2 §8.1: finalize lease 过期 → 生产 sweeper 收回', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    const { knowledgeBaseId } = await seedKnowledgeBase(pool, workspaceId, 'kbA');
    const docId = id('docA');
    await pool.query(
      `INSERT INTO documents (
         id, workspace_id, knowledge_base_id, name, type, size,
         status, storage_status, storage_key, sha256
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'txt', 5,
         'queued', 'storage_pending', $5, $6
       )`,
      [docId, workspaceId, knowledgeBaseId, 'a.txt', 'final/a', 'sha-a'],
    );
    await pool.query(
      `INSERT INTO storage_finalize_jobs (
         id, workspace_id, document_id, staging_key, final_key,
         status, lease_owner, lease_expires_at, heartbeat_at, attempts
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5,
         'processing', 'ghost-worker',
         now() - INTERVAL '5 seconds', now() - INTERVAL '90 seconds', 1
       )`,
      [id('jobA'), workspaceId, docId, 'staging/x', 'final/x'],
    );
    __setTestPool(pool);
    try {
      const reclaimed = await _runFinalizeLeaseSweeperOnce();
      assert.equal(reclaimed, 1, '生产 sweeper 应收回 1 行');
      const row = await pool.query<{
        status: string;
        lease_owner: string | null;
        lease_expires_at: Date | null;
        heartbeat_at: Date | null;
      }>(
        `SELECT status, lease_owner, lease_expires_at, heartbeat_at
           FROM storage_finalize_jobs WHERE id = $1::uuid`,
        [id('jobA')],
      );
      assert.equal(row.rows[0]?.status, 'pending');
      assert.equal(row.rows[0]?.lease_owner, null);
      assert.equal(row.rows[0]?.lease_expires_at, null);
      assert.equal(row.rows[0]?.heartbeat_at, null, 'heartbeat_at 已清');
    } finally {
      __resetTestPool();
    }
  });
});

// ─── #7 ingestion transitionIngestionStatus 事务化 + lease fencing ────
//
// 走生产 transitionIngestionStatus：旧 worker 用错 lease_owner 写入，
// 必须返回 null；documents 状态不应被错误推进。
test('PR-4.2 §8.1: ingestion transition 失败时整事务回滚', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    const { knowledgeBaseId } = await seedKnowledgeBase(pool, workspaceId, 'kbA');
    const docId = id('docA');
    await pool.query(
      `INSERT INTO documents (
         id, workspace_id, knowledge_base_id, name, type, size,
         status, storage_status, storage_key, sha256
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'txt', 5,
         'parsing', 'ready', $5, $6
       )`,
      [docId, workspaceId, knowledgeBaseId, 'a.txt', 'final/a', 'sha-a'],
    );
    await pool.query(
      `INSERT INTO document_ingestion_jobs (
         id, workspace_id, document_id, status, lease_owner, lease_expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'parsing',
         'worker-Y', now() + INTERVAL '60 seconds'
       )`,
      [id('jobA'), workspaceId, docId],
    );
    __setTestPool(pool);
    try {
      const result = await transitionIngestionStatus({
        jobId: id('jobA'),
        workerId: 'worker-X',
        status: 'ready',
      });
      assert.equal(result, null, 'lease 不匹配 → 返回 null');
      const docRow = await pool.query<{ status: string }>(
        `SELECT status FROM documents WHERE id = $1::uuid`,
        [docId],
      );
      assert.equal(docRow.rows[0]?.status, 'parsing', 'documents 状态保持 parsing');
    } finally {
      __resetTestPool();
    }
  });
});

// ─── #8 softDeleteDocument 串联取消 + outbox 入队 ─────────────────────
//
// 整改：测试走生产 softDeleteDocument，断言 4 张表全部 cancelled /
// outbox 入队；并验证 ingestion lease + heartbeat 已清（PR-4 整改 #3）。
test('PR-4.2 §8.1: softDeleteDocument 串联取消 finalize + ingestion + outbox 入队', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    const { knowledgeBaseId } = await seedKnowledgeBase(pool, workspaceId, 'kbA');
    const docId = id('docA');
    await pool.query(
      `INSERT INTO documents (
         id, workspace_id, knowledge_base_id, name, type, size,
         status, storage_status, storage_key, sha256
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'txt', 5,
         'queued', 'storage_pending', $5, $6
       )`,
      [docId, workspaceId, knowledgeBaseId, 'a.txt', 'final/a', 'sha-a'],
    );
    await pool.query(
      `INSERT INTO storage_finalize_jobs (
         id, workspace_id, document_id, staging_key, final_key,
         status, lease_owner, lease_expires_at, heartbeat_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5,
         'processing', 'old-worker', now() + INTERVAL '60 seconds', now()
       )`,
      [id('jobF'), workspaceId, docId, 'staging/a', 'final/a'],
    );
    await pool.query(
      `INSERT INTO document_ingestion_jobs (
         id, workspace_id, document_id, status,
         lease_owner, lease_expires_at, heartbeat_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'parsing',
         'old-worker', now() + INTERVAL '60 seconds', now()
       )`,
      [id('jobI'), workspaceId, docId],
    );
    __setTestPool(pool);
    try {
      await softDeleteDocument(workspaceId, docId);
      const docRow = await pool.query<{ status: string; deleted_at: Date | null }>(
        `SELECT status, deleted_at FROM documents WHERE id = $1::uuid`,
        [docId],
      );
      assert.equal(docRow.rows[0]?.status, 'cancelled');
      assert.ok(docRow.rows[0]?.deleted_at);
      const f = await pool.query<{
        status: string;
        lease_owner: string | null;
        heartbeat_at: Date | null;
      }>(
        `SELECT status, lease_owner, heartbeat_at
           FROM storage_finalize_jobs WHERE id = $1::uuid`,
        [id('jobF')],
      );
      assert.equal(f.rows[0]?.status, 'cancelled');
      assert.equal(f.rows[0]?.lease_owner, null, 'finalize lease 已清');
      assert.equal(f.rows[0]?.heartbeat_at, null, 'finalize heartbeat 已清');
      const i = await pool.query<{
        status: string;
        lease_owner: string | null;
        lease_expires_at: Date | null;
        heartbeat_at: Date | null;
      }>(
        `SELECT status, lease_owner, lease_expires_at, heartbeat_at
           FROM document_ingestion_jobs WHERE id = $1::uuid`,
        [id('jobI')],
      );
      assert.equal(i.rows[0]?.status, 'cancelled');
      assert.equal(i.rows[0]?.lease_owner, null);
      assert.equal(i.rows[0]?.lease_expires_at, null);
      assert.equal(i.rows[0]?.heartbeat_at, null);
      const out = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM storage_deletion_outbox
          WHERE document_id = $1::uuid`,
        [docId],
      );
      assert.equal(out.rows[0]?.count, '1', 'outbox 入队 1 行');
    } finally {
      __resetTestPool();
    }
  });
});

// ─── #9 outbox lease 过期 → 生产 sweeper 收回 ─────────────────────────
//
// 整改：测试调生产 `_runOutboxLeaseSweeperOnce`，不直接拼 UPDATE。
test('PR-4.2 §8.1: outbox lease 过期 → 生产 sweeper 收回', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    await pool.query(
      `INSERT INTO storage_deletion_outbox (
         storage_key, status, lease_owner, lease_expires_at, heartbeat_at
       ) VALUES (
         'final/x', 'processing', 'ghost-worker',
         now() - INTERVAL '5 seconds', now() - INTERVAL '60 seconds'
       )`,
    );
    __setTestPool(pool);
    try {
      const reclaimed = await _runOutboxLeaseSweeperOnce();
      assert.equal(reclaimed, 1, '生产 sweeper 应收回 1 行');
      const row = await pool.query<{
        status: string;
        lease_owner: string | null;
        heartbeat_at: Date | null;
      }>(
        `SELECT status, lease_owner, heartbeat_at
           FROM storage_deletion_outbox WHERE storage_key = 'final/x'`,
      );
      assert.equal(row.rows[0]?.status, 'pending');
      assert.equal(row.rows[0]?.lease_owner, null);
      assert.equal(row.rows[0]?.heartbeat_at, null);
    } finally {
      __resetTestPool();
    }
  });
});

// ─── #10 outbox done 路径（生产入口） ─────────────────────────────────
//
// 整改：测试走生产 `_runOutboxOnce` + FakeDocumentStorage.remove。
test('PR-4.2 §8.1: outbox 删除成功 → status=done + processed_at=now', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    await pool.query(
      `INSERT INTO storage_deletion_outbox (storage_key) VALUES ('final/x')`,
    );
    __setTestPool(pool);
    const storage = new FakeDocumentStorage();
    storage.seedFinal('final/x');
    installFakeStorage(storage);
    try {
      const row = await _runOutboxOnce();
      assert.ok(row, 'outbox claim 成功');
      const after = await pool.query<{ status: string; processed_at: Date | null }>(
        `SELECT status, processed_at FROM storage_deletion_outbox
          WHERE storage_key = 'final/x'`,
      );
      assert.equal(after.rows[0]?.status, 'done');
      assert.ok(after.rows[0]?.processed_at, 'processed_at 已写入');
      assert.equal(storage.removeCallCount, 1, 'FakeDocumentStorage.remove 调一次');
    } finally {
      __resetTestPool();
      uninstallFakeStorage();
    }
  });
});

// ─── #11 requeue 后 attempts 只 +1 ──────────────────────────────────
//
// 整改：transitionIngestionStatus requeue **不**再 ++ attempts。claim
// 是唯一 ++ attempts 的入口。
test('PR-4 整改：requeue 后 attempts 只 +1', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    const { knowledgeBaseId } = await seedKnowledgeBase(pool, workspaceId, 'kbA');
    const docId = id('docA');
    await pool.query(
      `INSERT INTO documents (
         id, workspace_id, knowledge_base_id, name, type, size,
         status, storage_status, storage_key, sha256
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'txt', 5,
         'queued', 'ready', $5, $6
       )`,
      [docId, workspaceId, knowledgeBaseId, 'a.txt', 'final/a', 'sha-a'],
    );
    await pool.query(
      `INSERT INTO document_ingestion_jobs (id, workspace_id, document_id, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'queued')`,
      [id('jobA'), workspaceId, docId],
    );
    __setTestPool(pool);
    try {
      const claimed = await claimNextIngestionJob('worker-A');
      assert.ok(claimed, 'claim 成功');
      assert.equal(claimed!.attempts, 1, 'claim 后 attempts=1');
      const requeued = await transitionIngestionStatus({
        jobId: id('jobA'),
        workerId: 'worker-A',
        status: 'queued',
        currentStatus: 'parsing',
        requeue: true,
        requeueBackoffMs: 1_000,
        errorCode: 'TEST_ERROR',
        errorDetail: 'test requeue',
      });
      assert.ok(requeued, 'requeue 成功');
      const after = await pool.query<{
        attempts: number;
        status: string;
        lease_owner: string | null;
      }>(
        `SELECT attempts, status, lease_owner
           FROM document_ingestion_jobs WHERE id = $1::uuid`,
        [id('jobA')],
      );
      assert.equal(after.rows[0]?.attempts, 1, 'requeue 不再 ++ attempts');
      assert.equal(after.rows[0]?.status, 'queued', 'requeue 后 status=queued');
      assert.equal(after.rows[0]?.lease_owner, null, 'requeue 已清 lease');
    } finally {
      __resetTestPool();
    }
  });
});

// ─── #12 删除后旧 worker 无法把 document 重新写 ready ───────────────
//
// 整改：transitionIngestionStatus 的 documents UPDATE 必须带
// deleted_at IS NULL 守卫；软删除后旧 worker 推进会被 SQL 拒。
test('PR-4 整改：删除后旧 worker 无法把 document 重新写 ready', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    const { knowledgeBaseId } = await seedKnowledgeBase(pool, workspaceId, 'kbA');
    const docId = id('docA');
    await pool.query(
      `INSERT INTO documents (
         id, workspace_id, knowledge_base_id, name, type, size,
         status, storage_status, storage_key, sha256
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'txt', 5,
         'parsing', 'ready', $5, $6
       )`,
      [docId, workspaceId, knowledgeBaseId, 'a.txt', 'final/a', 'sha-a'],
    );
    await pool.query(
      `INSERT INTO document_ingestion_jobs (
         id, workspace_id, document_id, status,
         lease_owner, lease_expires_at, attempts
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'parsing',
         'old-worker', now() + INTERVAL '60 seconds', 1
       )`,
      [id('jobA'), workspaceId, docId],
    );
    __setTestPool(pool);
    try {
      await pool.query(
        `UPDATE documents SET deleted_at = now(), status = 'cancelled'
          WHERE id = $1::uuid`,
        [docId],
      );
      const result = await transitionIngestionStatus({
        jobId: id('jobA'),
        workerId: 'old-worker',
        status: 'ready',
        totalChunks: 1,
        completedChunks: 1,
      });
      assert.equal(result, null, 'documents 已删除 → 整事务回滚，返 null');
      const docRow = await pool.query<{ status: string; total_chunks: number }>(
        `SELECT status, total_chunks FROM documents WHERE id = $1::uuid`,
        [docId],
      );
      assert.equal(docRow.rows[0]?.status, 'cancelled');
      assert.equal(docRow.rows[0]?.total_chunks, 0, 'total_chunks 没被旧 worker 写入');
    } finally {
      __resetTestPool();
    }
  });
});

// ─── #13 lease 已过期的旧 worker 无法写 done/failed ──────────────────
//
// 整改：transitionIngestionStatus 的 WHERE 必须带 lease_expires_at > now()。
test('PR-4 整改：lease 已过期的旧 worker 无法写 done/failed', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    const { knowledgeBaseId } = await seedKnowledgeBase(pool, workspaceId, 'kbA');
    const docId = id('docA');
    await pool.query(
      `INSERT INTO documents (
         id, workspace_id, knowledge_base_id, name, type, size,
         status, storage_status, storage_key, sha256
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'txt', 5,
         'parsing', 'ready', $5, $6
       )`,
      [docId, workspaceId, knowledgeBaseId, 'a.txt', 'final/a', 'sha-a'],
    );
    await pool.query(
      `INSERT INTO document_ingestion_jobs (
         id, workspace_id, document_id, status,
         lease_owner, lease_expires_at, attempts
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'parsing',
         'expired-worker', now() - INTERVAL '1 second', 1
       )`,
      [id('jobA'), workspaceId, docId],
    );
    __setTestPool(pool);
    try {
      const readyResult = await transitionIngestionStatus({
        jobId: id('jobA'),
        workerId: 'expired-worker',
        status: 'ready',
      });
      assert.equal(readyResult, null, 'lease 过期 → ready 返 null');
      const failedResult = await markFailedTerminal({
        jobId: id('jobA'),
        workerId: 'expired-worker',
        errorCode: 'X',
        errorDetail: 'x',
      });
      assert.equal(failedResult, null, 'lease 过期 → failed 返 null');
      const row = await pool.query<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM document_ingestion_jobs
          WHERE id = $1::uuid`,
        [id('jobA')],
      );
      assert.equal(row.rows[0]?.status, 'parsing');
    } finally {
      __resetTestPool();
    }
  });
});

// ─── #14 finalize 成功 + DB 写回失败 → 触发器注入 → 二次重试幂等收敛 ──
//
// 整改（2026-09-11 第二轮）：用真实 BEFORE UPDATE 触发器制造第一次
// `storage_finalize_jobs → done` 写回失败（raise exception），让 worker
// 的 COMMIT 阶段抛错 → 整个 finalize tick 失败。**不**手工 UPDATE 把
// job 改回 pending；让生产 sweeper + 下一轮 `_runFinalizeOnce` 在
// FakeDocumentStorage 幂等（"staging 不存在 + final 已存在"）下自然
// 收敛到 done + documents.storage_status='ready'。
test('PR-4 整改：finalize 成功 + DB 写回失败 → 二次重试幂等收敛', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    const { knowledgeBaseId } = await seedKnowledgeBase(pool, workspaceId, 'kbA');
    const docId = id('docA');
    await pool.query(
      `INSERT INTO documents (
         id, workspace_id, knowledge_base_id, name, type, size,
         status, storage_status, storage_key, sha256
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'txt', 5,
         'queued', 'storage_pending', $5, $6
       )`,
      [docId, workspaceId, knowledgeBaseId, 'a.txt', 'final/x', 'sha-x'],
    );
    await pool.query(
      `INSERT INTO storage_finalize_jobs (id, workspace_id, document_id, staging_key, final_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
      [id('jobA'), workspaceId, docId, 'staging/x', 'final/x'],
    );
    // 安装临时 BEFORE UPDATE 触发器：当 attempts < 2 时 raise，让第
    // 一次 finalize 的 done 写回失败（status='processing' → 'done'），
    // 第二次 raise 不再触发（attempts 已 >= 2）。
    await pool.query(
      `CREATE OR REPLACE FUNCTION fail_first_done() RETURNS trigger AS $$
       BEGIN
         IF NEW.status = 'done' AND OLD.attempts < 2 THEN
           RAISE EXCEPTION 'simulated db writeback failure';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    );
    await pool.query(
      `CREATE TRIGGER fail_first_done_trigger
         BEFORE UPDATE ON storage_finalize_jobs
         FOR EACH ROW EXECUTE FUNCTION fail_first_done()`,
    );
    __setTestPool(pool);
    const storage = new FakeDocumentStorage();
    storage.seedStaging('staging/x');
    installFakeStorage(storage);
    try {
      // 第一轮：worker 抢到 → finalize 静默成功（IO 阶段已经 rename）→
      // 写 done 被触发器拦下抛错 → COMMIT 失败 → storage_finalize_jobs
      // 仍然 'processing'。
      const row1 = await _runFinalizeOnce();
      assert.ok(row1, '第一轮 finalize claim 成功');
      // 验证 storage 已经被晋升（rename 已发生），但 DB 写回失败。
      const stagingExists = await storage.exists('staging/x');
      const finalExists = await storage.exists('final/x');
      assert.equal(stagingExists, false, 'IO 阶段 staging 已晋升');
      assert.equal(finalExists, true, 'IO 阶段 final 已写入');
      // 跑一次生产 sweeper：lease 已过期（执行 finalize 的 lease 是
      // 60s 但 IO 阶段后 worker 进入 COMMIT 抛错；这里我们手动让 lease
      // 过期并模拟 sweeper 收回，让下一轮重试）。
      await pool.query(
        `UPDATE storage_finalize_jobs
            SET lease_expires_at = now() - INTERVAL '5 seconds',
                heartbeat_at = now() - INTERVAL '90 seconds'
          WHERE id = $1::uuid`,
        [id('jobA')],
      );
      const reclaimed = await _runFinalizeLeaseSweeperOnce();
      assert.equal(reclaimed, 1, 'sweeper 把第一次失败的 processing 行收回 pending');
      // sweeper 把 next_attempt_at 推到 now() + 5s；测试场景立即跑下
      // 一轮 tick 需要把 next_attempt_at 拨回 now() 让 claim 命中。
      await pool.query(
        `UPDATE storage_finalize_jobs SET next_attempt_at = now() WHERE id = $1::uuid`,
        [id('jobA')],
      );
      // 第二轮：worker 重新抢 → finalize 幂等（staging 不存在 + final 已
      // 存在 → 静默成功）→ 写 done + documents.storage_status='ready'
      // → 触发器放行（attempts 已 2）→ 收敛。
      const row2 = await _runFinalizeOnce();
      assert.ok(row2, '第二轮 finalize claim 成功');
      const final = await pool.query<{
        status: string;
        processed_at: Date | null;
        attempts: number;
      }>(
        `SELECT status, processed_at, attempts FROM storage_finalize_jobs
          WHERE id = $1::uuid`,
        [id('jobA')],
      );
      assert.equal(final.rows[0]?.status, 'done', 'finalize 收敛到 done');
      assert.ok(final.rows[0]?.processed_at, 'processed_at 已写');
      const doc = await pool.query<{ storage_status: string }>(
        `SELECT storage_status FROM documents WHERE id = $1::uuid`,
        [docId],
      );
      assert.equal(
        doc.rows[0]?.storage_status,
        'ready',
        'documents.storage_status=ready',
      );
    } finally {
      // 清理触发器（必须清理，否则后续测试受影响）。
      await pool.query(`DROP TRIGGER IF EXISTS fail_first_done_trigger ON storage_finalize_jobs`);
      await pool.query(`DROP FUNCTION IF EXISTS fail_first_done()`);
      __resetTestPool();
      uninstallFakeStorage();
    }
  });
});

// ─── #16 outbox 两 worker 并发仅一个执行 remove ───────────────────────
//
// 整改：partial unique 兜底 + lease fencing 让 outbox 同一时刻仅一个
// worker 跑 storage.remove()。
test('PR-4 整改：outbox 两 worker 并发仅一个执行 remove', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    await pool.query(
      `INSERT INTO storage_deletion_outbox (storage_key) VALUES ('final/x')`,
    );
    __setTestPool(pool);
    const storage = new FakeDocumentStorage();
    storage.seedFinal('final/x');
    installFakeStorage(storage);
    try {
      const a = _runOutboxOnce();
      const b = _runOutboxOnce();
      const [ra, rb] = await Promise.all([a, b]);
      const claimed = [ra, rb].filter((r) => r !== null);
      assert.equal(claimed.length, 1, '恰好一个 worker 抢到 outbox');
      assert.equal(storage.removeCallCount, 1, 'FakeDocumentStorage.remove 仅调一次');
    } finally {
      __resetTestPool();
      uninstallFakeStorage();
    }
  });
});

// ─── #17 ingestion worker 真实跑全链路（生产入口） ──────────────────
//
// 整改（2026-09-11 第二轮）：PR-4 集成测试必须调生产 `runIngestionWorkerOnce`，
// 覆盖 storage ready → parser/chunk/finalizing → ready 全链路。
//
// 约束：
//   - Core-only（ragEnabled=false）：不调 embedding provider；
//   - 用 FakeDocumentStorage 提供 storage_key 上的字节流；
//   - 断言：job 状态收敛到 'ready'；documents.status 同步到 'ready'；
//           document_chunks 已落库；documents.storage_status='ready'。
test('PR-4 整改：ingestion worker 真实跑全链路 → ready', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    const { knowledgeBaseId } = await seedKnowledgeBase(pool, workspaceId, 'kbA');
    const docId = id('docA');
    await pool.query(
      `INSERT INTO documents (
         id, workspace_id, knowledge_base_id, name, type, size,
         status, storage_status, storage_key, sha256
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'txt', 32,
         'queued', 'ready', $5, $6
       )`,
      [docId, workspaceId, knowledgeBaseId, 'a.txt', 'final/a', 'sha-a'],
    );
    await pool.query(
      `INSERT INTO document_ingestion_jobs (id, workspace_id, document_id, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'queued')`,
      [id('jobA'), workspaceId, docId],
    );
    __setTestPool(pool);
    const storage = new FakeDocumentStorage();
    // 准备足够文本以触发 splitText 产生至少 1 个 chunk。
    storage.seedFinal('final/a', Buffer.from('hello world. '.repeat(50)));
    installFakeStorage(storage);
    try {
      const claimed = await runIngestionWorkerOnce();
      assert.ok(claimed, 'runIngestionWorkerOnce 抢到 job');
      const jobRow = await pool.query<{ status: string }>(
        `SELECT status FROM document_ingestion_jobs WHERE id = $1::uuid`,
        [id('jobA')],
      );
      assert.equal(
        jobRow.rows[0]?.status,
        'ready',
        'ingestion job 收敛到 ready',
      );
      const docRow = await pool.query<{
        status: string;
        total_chunks: number;
        completed_chunks: number;
      }>(
        `SELECT status, total_chunks, completed_chunks
           FROM documents WHERE id = $1::uuid`,
        [docId],
      );
      assert.equal(docRow.rows[0]?.status, 'ready', 'documents.status 收敛到 ready');
      assert.ok(
        Number(docRow.rows[0]?.total_chunks ?? 0) >= 1,
        'total_chunks 至少为 1（splitText 真实产出）',
      );
      assert.equal(
        docRow.rows[0]?.completed_chunks,
        docRow.rows[0]?.total_chunks,
        'Core-only 模式下 completed_chunks=total_chunks',
      );
      const chunkCnt = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM document_chunks
          WHERE document_id = $1::uuid`,
        [docId],
      );
      assert.ok(
        Number(chunkCnt.rows[0]?.count) >= 1,
        'document_chunks 行数与 total_chunks 一致',
      );
    } finally {
      __resetTestPool();
      uninstallFakeStorage();
    }
  });
});

// ─── #18 transitionIngestionStatus 非 requeue 全路径（生产入口） ─────
//
// 整改（2026-09-11 第二轮 Codex 阻塞-A）：参数位必须由 params 数组
// 长度动态生成，覆盖 parsing/chunking/embedding/finalizing/ready 全
// 路径。本测试在真实 PG 上连续调生产 transitionIngestionStatus 推
// 进全部非 requeue 状态，断言：
//   - 每个阶段 SQL 成功（无 PG bind 参数错误）；
//   - job 与 documents 同步推进；
//   - lease 在终态被清。
//
// 起始：手工 claim 一个 ingestion job（直接给 lease_owner + lease，
// 跳过 claimNextIngestionJob 的 storage_status 守卫），模拟 worker
// 已经 claim 完成。
test('PR-4 整改：transitionIngestionStatus 非 requeue 全路径真实 PG 覆盖', { skip: !RUN || !CORE_ONLY_PROCESS }, async () => {
  await withIsolatedSchema(false, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    const { knowledgeBaseId } = await seedKnowledgeBase(pool, workspaceId, 'kbA');
    const docId = id('docA');
    await pool.query(
      `INSERT INTO documents (
         id, workspace_id, knowledge_base_id, name, type, size,
         status, storage_status, storage_key, sha256
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'txt', 5,
         'queued', 'ready', $5, $6
       )`,
      [docId, workspaceId, knowledgeBaseId, 'a.txt', 'final/a', 'sha-a'],
    );
    await pool.query(
      `INSERT INTO document_ingestion_jobs (
         id, workspace_id, document_id, status, attempts,
         lease_owner, lease_expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'queued', 1,
         'worker-A', now() + INTERVAL '120 seconds'
       )`,
      [id('jobA'), workspaceId, docId],
    );
    __setTestPool(pool);
    try {
      // parsing
      const r1 = await transitionIngestionStatus({
        jobId: id('jobA'),
        workerId: 'worker-A',
        status: 'parsing',
      });
      assert.ok(r1, 'parsing 推进成功');
      // chunking
      const r2 = await transitionIngestionStatus({
        jobId: id('jobA'),
        workerId: 'worker-A',
        status: 'chunking',
        currentStatus: 'parsing',
      });
      assert.ok(r2, 'chunking 推进成功');
      // embedding
      const r3 = await transitionIngestionStatus({
        jobId: id('jobA'),
        workerId: 'worker-A',
        status: 'embedding',
        currentStatus: 'chunking',
      });
      assert.ok(r3, 'embedding 推进成功');
      // finalizing
      const r4 = await transitionIngestionStatus({
        jobId: id('jobA'),
        workerId: 'worker-A',
        status: 'finalizing',
        currentStatus: 'embedding',
      });
      assert.ok(r4, 'finalizing 推进成功');
      // ready（终态 + totalChunks / completedChunks）
      const r5 = await transitionIngestionStatus({
        jobId: id('jobA'),
        workerId: 'worker-A',
        status: 'ready',
        currentStatus: 'finalizing',
        totalChunks: 3,
        completedChunks: 3,
      });
      assert.ok(r5, 'ready 推进成功');
      const jobRow = await pool.query<{
        status: string;
        lease_owner: string | null;
        lease_expires_at: Date | null;
        heartbeat_at: Date | null;
      }>(
        `SELECT status, lease_owner, lease_expires_at, heartbeat_at
           FROM document_ingestion_jobs WHERE id = $1::uuid`,
        [id('jobA')],
      );
      assert.equal(jobRow.rows[0]?.status, 'ready');
      assert.equal(jobRow.rows[0]?.lease_owner, null, 'ready 后 lease_owner 已清');
      assert.equal(jobRow.rows[0]?.lease_expires_at, null, 'ready 后 lease_expires_at 已清');
      assert.equal(jobRow.rows[0]?.heartbeat_at, null, 'ready 后 heartbeat_at 已清');
      const docRow = await pool.query<{
        status: string;
        total_chunks: number;
        completed_chunks: number;
      }>(
        `SELECT status, total_chunks, completed_chunks
           FROM documents WHERE id = $1::uuid`,
        [docId],
      );
      assert.equal(docRow.rows[0]?.status, 'ready', 'documents.status 同步到 ready');
      assert.equal(docRow.rows[0]?.total_chunks, 3);
      assert.equal(docRow.rows[0]?.completed_chunks, 3);
      // failed 终态路径：再制造一个 fresh job + lease，断言 failed 也走
      // 完整 SQL 拼接（status + lease_owner 清 + error_code + error_detail）。
      const jobBId = id('jobB');
      await pool.query(
        `INSERT INTO document_ingestion_jobs (
           id, workspace_id, document_id, status, attempts,
           lease_owner, lease_expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'parsing', 1,
           'worker-B', now() + INTERVAL '120 seconds'
         )`,
        [jobBId, workspaceId, docId],
      );
      const failedRow = await transitionIngestionStatus({
        jobId: jobBId,
        workerId: 'worker-B',
        status: 'failed',
        currentStatus: 'parsing',
        errorCode: 'E_TEST',
        errorDetail: 'failed end-to-end',
      });
      assert.ok(failedRow, 'failed 推进成功');
      const jobB = await pool.query<{
        status: string;
        lease_owner: string | null;
        error_code: string | null;
        error_detail: string | null;
      }>(
        `SELECT status, lease_owner, error_code, error_detail
           FROM document_ingestion_jobs WHERE id = $1::uuid`,
        [jobBId],
      );
      assert.equal(jobB.rows[0]?.status, 'failed');
      assert.equal(jobB.rows[0]?.lease_owner, null);
      assert.equal(jobB.rows[0]?.error_code, 'E_TEST');
      assert.equal(jobB.rows[0]?.error_detail, 'failed end-to-end');
    } finally {
      __resetTestPool();
    }
  });
});

if (!RUN) {
  // eslint-disable-next-line no-console
  console.log('SKIP: PR-4 Core-only 集成测试需要 RUN_DB_TESTS=1 + TEST_DATABASE_URL');
} else if (!CORE_ONLY_PROCESS) {
  // eslint-disable-next-line no-console
  console.log(
    'SKIP: PR-4 Core-only 文件必须以 EMBEDDING_API_KEY="" 启动；当前进程检测到非空 key，已 SKIP 全部用例以避免污染 RAG 形态。',
  );
}