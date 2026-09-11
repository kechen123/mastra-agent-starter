/**
 * PR-4.2 §8.1：异步 ingestion / finalize / outbox 真实 PG 集成测试 —
 * RAG 形态。
 *
 * 启用条件：
 *   - `RUN_DB_TESTS=1` + `TEST_DATABASE_URL=postgres://.../<test_db>`；
 *   - 测试库允许列表 `db-isolation.ts` 已强制。
 *   - 本轮跑前必须先把 `backend/database/init.sql` 应用到测试库。本
 *     文件 fixture 用 `withIsolatedSchema(true, ...)`，要求测试库已
 *     `CREATE EXTENSION vector`。
 *
 * Core-only / RAG 形态由**进程级环境变量**决定（PR-4 第二轮 Codex 整改，
 * 2026-09-11）：
 *   - Core-only 文件（`pr4-async-doc-rag-core.ts`）：`EMBEDDING_API_KEY`
 *     必须为空（缺失或空字符串）→ `config.ragEnabled=false`。
 *   - 本文件（RAG）：`EMBEDDING_API_KEY` 必须为**非空**字符串 →
 *     `config.ragEnabled=true`。
 *
 * 这种"按 env 拆文件"的安排使得两套形态完全跑在独立进程里 —— 不需要
 * 任何测试 setter / 后门去覆盖生产 `config`。两个文件共享相同的
 * schema-init helper 与 pg pool，但 `config.ragEnabled` 在每个文件
 * 启动时由本进程的 env 决定，跟生产路径语义完全一致。
 *
 * **不调用真实 embedding API**：
 *   - 测试 #2 只查 information_schema / pg_indexes（DB-only）。
 *   - 测试 #15 调生产 `getOrCreateActiveEmbeddingProfile`，它只读
 *     `embedding_profiles` 表 + 原子 INSERT，**不**走 `embedTexts`
 *     HTTP 路径。所以 EMBEDDING_BASE_URL 即使指向真实服务也不会被
 *     触发。`EMBEDDING_API_KEY` 必须非空才能让 `config.ragEnabled`
 *     为 true，但具体值只是字符串字面量，不会被发出请求。
 *
 * 本文件只调用生产实现：
 *   - `getOrCreateActiveEmbeddingProfile`（PR-4 §8.4 整改入口）。
 *
 * 允许 fake 的只有：
 *   - DocumentStorage：本文件**不**调用任何 DocumentStorage 接口。
 *   - Embedding provider：本文件**不**调用任何 embedding 接口。
 *
 * 2 个 case：
 *   2.  RAG fresh schema：RAG 表存在 + 无全局 HNSW。
 *   15. RAG 自动 active profile + 并发收敛（生产）。
 *
 * Skip：每个 case 用 `{ skip: !RUN }`；无 DB 环境时文件可干净 typecheck。
 *
 * 运行命令（PowerShell，从 backend 目录）：
 *   $env:TEST_DATABASE_URL = (读 .env 里的 DATABASE_URL)
 *   $env:RUN_DB_TESTS = '1'
 *   $env:EMBEDDING_API_KEY = 'placeholder-non-sensitive-rag-key'  # 非空即可
 *   $env:EMBEDDING_PROVIDER = 'test'                              # profile.provider
 *   $env:EMBEDDING_MODEL = 'test-model'                           # profile.model
 *   npx tsx --test tests/integration/pr4-async-doc-rag-rag.ts
 */
import { createHash } from 'node:crypto';
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
import { getOrCreateActiveEmbeddingProfile } from '../../src/modules/knowledge/rag/embedding-profile-repository.js';

const URL = process.env.TEST_DATABASE_URL;
const RUN = process.env.RUN_DB_TESTS === '1' && !!URL;

// 进程级 RAG 守卫：本文件必须以非空 `EMBEDDING_API_KEY` 启动，让
// `config.ragEnabled=true` 走生产 RAG 路径。该值**只是字符串**——
// 本文件不调任何 embedTexts HTTP 接口，不会真正命中外部服务。
const RAG_PROCESS =
  typeof process.env.EMBEDDING_API_KEY === 'string' &&
  process.env.EMBEDDING_API_KEY.trim().length > 0;

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
  // （`md5(label)` vs `md5('${label}-ws')`）导致 #15 在第二个 workspace
  // INSERT 抛 23503。
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

// ─── #2 RAG fresh schema ──────────────────────────────────────────────
//
// 整改：HNSW 不再作为全局索引在 init.sql 创建。断言 RAG 表存在 + 不存
// 在以 _embeddings 命名的 hnsw 索引。
test('PR-4.1 §8.4.1: RAG fresh schema → RAG 表存在 + 无全局 HNSW', { skip: !RUN || !RAG_PROCESS }, async () => {
  await withIsolatedSchema(true, async (pool) => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('embedding_profiles', 'document_embeddings')`,
    );
    const names = tables.rows.map((r) => r.table_name).sort();
    assert.deepEqual(names, ['document_embeddings', 'embedding_profiles']);
    const hnsw = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'document_embeddings'
          AND indexdef ILIKE '%hnsw%'`,
    );
    assert.equal(
      hnsw.rows.length,
      0,
      'RAG 应**不**再有 HNSW 全局索引（HNSW 必须按固定 dimensions partial 建，本轮不做）',
    );
    const btree = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'document_embeddings'
          AND indexdef NOT ILIKE '%hnsw%'`,
    );
    assert.ok(btree.rows.length >= 1, 'RAG 应至少有 1 个非 HNSW 索引');
  });
});

// ─── #15 RAG enabled 自动创建并使用 active profile ────────────────────
//
// 整改：RAG 启用后，第一次 ingest 必须原子获得唯一 active profile；
// 并发创建只能得到一个 active。本测试在 ragEnabled=true schema 下跑
// 生产 getOrCreateActiveEmbeddingProfile，**不**复刻 SQL。
//
// 进程级边界：本文件以非空 `EMBEDDING_API_KEY` 启动 → `config.ragEnabled=true`，
// `getOrCreateActiveEmbeddingProfile` 的"RAG 禁用"守卫自然放行；不再
// 需要测试 setter / 后门。
test('PR-4 整改：RAG 自动创建 active profile + 并发创建唯一', { skip: !RUN || !RAG_PROCESS }, async () => {
  await withIsolatedSchema(true, async (pool) => {
    const { workspaceId } = await seedUserAndWorkspace(pool, 'wsA');
    __setTestPool(pool);
    try {
      const a = await getOrCreateActiveEmbeddingProfile({ workspaceId });
      assert.ok(a.id, '首次创建 active profile 成功');
      assert.equal(a.isActive, true);
      assert.equal(a.workspaceId, workspaceId);
      const b = await getOrCreateActiveEmbeddingProfile({ workspaceId });
      assert.equal(a.id, b.id, '复用既有 active profile');
      // 并发创建路径：另一个 workspace 同时创建多个 active，应只有一个成功。
      // owner_user_id 必须指向已存在的 app_users.id；FK 在第二个 workspace 之前
      // 先创建一个同名 user 行。
      const ws2 = id('wsB');
      const ws2Owner = id('wsB-ws-user');
      await pool.query(
        `INSERT INTO app_users (id, username, username_normalized, password_hash)
         VALUES ($1::uuid, 'wsB', 'wsB', 'placeholder')`,
        [ws2Owner],
      );
      await pool.query(
        `INSERT INTO workspaces (id, owner_user_id, name, kind)
         VALUES ($1::uuid, $2::uuid, 'wsB', 'personal')`,
        [ws2, ws2Owner],
      );
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () =>
          getOrCreateActiveEmbeddingProfile({ workspaceId: ws2 }),
        ),
      );
      const ids = new Set(concurrent.map((r) => r.id));
      assert.equal(ids.size, 1, '并发创建收敛到唯一一个 active profile');
    } finally {
      __resetTestPool();
    }
  });
});

if (!RUN) {
  // eslint-disable-next-line no-console
  console.log('SKIP: PR-4 RAG 集成测试需要 RUN_DB_TESTS=1 + TEST_DATABASE_URL');
} else if (!RAG_PROCESS) {
  // eslint-disable-next-line no-console
  console.log(
    'SKIP: PR-4 RAG 文件必须以非空 EMBEDDING_API_KEY 启动；当前进程未检测到 key，已 SKIP 全部用例。',
  );
}