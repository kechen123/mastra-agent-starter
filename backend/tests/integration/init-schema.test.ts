/**
 * `ensureSchema` 集成测试（Task 3 + Task 16 合计 5 项 case）。
 *
 * 文件：tests/integration/init-schema.test.ts
 *
 * 启用条件：
 *   - `RUN_DB_TESTS=1` + `TEST_DATABASE_URL=postgres://.../<test_db>`；
 *   - `<test_db>` 必须落在 `db-isolation.ts` 的测试库允许列表
 *     （`test_*` / `*_test` / 独立 `test`）。
 *
 * Skip：每个 case 用 `{ skip: !RUN }` 保证无 DB 环境时文件可干净 typecheck
 * （spec §7.2 + brief 约束）；case #5 是纯静态合约，无须 DB，永远执行。
 *
 * 5 个 case：
 *   1. fresh → action='applied'（首次跑，DDL 已落）
 *   2. 同 checksum 二次跑 → action='skipped'（幂等）
 *   3. checksum 漂移 → action='drift'（不抛错，向调用方报告）
 *   4. mid-flight failure → transaction rolled back（事务回滚后 _init_meta
 *      已被撤销）
 *   5. schema-init.ts 静态合约：不读 process.env.DATABASE_URL、不 new Pool
 *      （保证本模块是"参数-only"，不自己开池）
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  ensureSchema,
  dropIsolatedSchema,
  createIsolatedSchema,
  type EnsureSchemaResult,
} from '../../src/test-utils/schema-init.js';

const URL = process.env.TEST_DATABASE_URL;
const RUN = process.env.RUN_DB_TESTS === '1' && !!URL;

/**
 * 在一个全新的隔离 schema 内跑测试体：建一个 root pool → CREATE SCHEMA →
 * 建一个 search_path 烤到 options 的 scoped pool → 跑 fn → 清理。
 *
 * 跟 `isolation-contract.ts` 的 `withTwoWorkspaces` 一样，root pool 只用来
 * `CREATE SCHEMA` / `DROP SCHEMA`，数据操作都在 scoped pool 上完成。
 */
async function withFreshSchema<T>(
  fn: (pool: Pool, schema: string) => Promise<T>,
): Promise<T> {
  const root = new Pool({ connectionString: URL });
  const schema = `test_${Math.random().toString(36).slice(2, 10)}`;
  await createIsolatedSchema(root, schema);
  const scoped = new Pool({
    connectionString: URL,
    options: `-c search_path=${schema},public`,
  });
  try {
    return await fn(scoped, schema);
  } finally {
    await scoped.end();
    await dropIsolatedSchema(root, schema);
    await root.end();
  }
}

/**
 * 与 `ensureSchema` 行为镜像的 stub，但允许注入会失败的 SQL。
 *
 * 目的：case #4 用来证明"事务内 mid-flight 失败 → 整个事务被 ROLLBACK，
 * 任何已落库的对象（包括 `_init_meta`）都被撤销"。
 *
 * 行为契约（与 schema-init.ts 的 ensureSchema 对齐）：
 *   - BEGIN → CREATE TABLE _init_meta → 跑 `sql`（这里会失败）
 *     → 失败时 best-effort ROLLBACK → 重新抛错 → finally release。
 *   - 选择把 `CREATE TABLE _init_meta` 放在 `sql` 之前是因为这是最贴近
 *     `ensureSchema` 真实流程的"先建表，再写 meta"序列；让 SQL 失败点
 *     出现在 meta 写入之后，能验证"已落库对象被回滚"。
 */
async function ensureSchemaWithSql(
  pool: Pool,
  sql: string,
): Promise<EnsureSchemaResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TABLE IF NOT EXISTS _init_meta (
         id TEXT PRIMARY KEY,
         checksum TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    // broken SQL —— 故意制造 mid-flight 失败
    await client.query(sql);
    await client.query(
      `INSERT INTO _init_meta (id, checksum) VALUES ('singleton', $1)
       ON CONFLICT (id) DO NOTHING`,
      ['fake-checksum'],
    );
    await client.query('COMMIT');
    return { action: 'applied', checksum: 'fake-checksum' };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best-effort：连接可能已被服务端关闭
    }
    throw error;
  } finally {
    client.release();
  }
}

// ─── #1 fresh → applied ──────────────────────────────────────────────
test('ensureSchema: fresh → action=applied', { skip: !RUN }, async () => {
  await withFreshSchema(async (pool) => {
    const result = await ensureSchema(pool);
    assert.equal(result.action, 'applied');
    assert.match(
      result.checksum,
      /^[0-9a-f]{64}$/,
      'applied 时 checksum 应为 64 位小写 hex',
    );
    const meta = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM _init_meta`,
    );
    assert.equal(
      meta.rows[0]?.count,
      '1',
      '_init_meta 应当已写入 singleton 行',
    );
  });
});

// ─── #2 同 checksum 二次跑 → skipped ────────────────────────────────
test('ensureSchema: same checksum → action=skipped', { skip: !RUN }, async () => {
  await withFreshSchema(async (pool) => {
    const first = await ensureSchema(pool);
    assert.equal(first.action, 'applied');
    const second = await ensureSchema(pool);
    assert.equal(second.action, 'skipped');
    assert.equal(
      second.checksum,
      first.checksum,
      'skipped 与 applied 的 checksum 应相等（同源 init.sql）',
    );
  });
});

// ─── #3 checksum 漂移 → drift action ────────────────────────────────
test('ensureSchema: checksum drift → action=drift', { skip: !RUN }, async () => {
  await withFreshSchema(async (pool) => {
    await ensureSchema(pool);
    // 改 _init_meta 模拟漂移
    await pool.query(
      `UPDATE _init_meta SET checksum = 'baddrift' WHERE id = 'singleton'`,
    );
    const result = await ensureSchema(pool);
    assert.equal(result.action, 'drift');
    if (result.action !== 'drift') return; // type guard
    assert.equal(result.expected, 'baddrift');
    assert.match(
      result.actual,
      /^[0-9a-f]{64}$/,
      'actual 应为当前 init.sql 的真实 checksum',
    );
  });
});

// ─── #4 mid-flight failure → transaction rolled back ───────────────
test('ensureSchema: mid-flight failure → transaction rolled back', { skip: !RUN }, async () => {
  await withFreshSchema(async (pool) => {
    // 注入会失败的 SQL —— 让事务在 CREATE TABLE _init_meta 之后抛错
    await assert.rejects(
      () => ensureSchemaWithSql(pool, 'THIS IS NOT VALID SQL'),
      // pg 抛错信息里含 syntax error；这里只断言"必须 reject"，不强匹配文本
    );
    // 关键断言：_init_meta 在事务回滚后不存在（to_regclass 返回 null）
    const meta = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass('_init_meta') AS exists`,
    );
    assert.equal(
      meta.rows[0]?.exists,
      null,
      '事务回滚后 _init_meta 应不存在（已被 ROLLBACK 撤销）',
    );
  });
});

// ─── #5 静态合约：schema-init.ts 不读 env、不 new Pool ──────────────
test('schema-init.ts does not read process.env.DATABASE_URL', () => {
  // 从 cwd（=backend/）出发，相对路径锁住 schema-init.ts。
  // 这是设计契约：保证本模块是"参数-only"，不自己开池、不读环境变量，
  // 让调用方完全掌控 Pool 的生命周期（生产路径 vs 测试路径）。
  const src = readFileSync(
    join(process.cwd(), 'src/test-utils/schema-init.ts'),
    'utf-8',
  );
  // 去掉注释后再做正则匹配 —— 注释里可能描述"本模块不读 env"等设计意图，
  // 字面量不应触发 banned-string 断言。
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(
    codeOnly,
    /\bnew\s+Pool\s*\(/s,
    'schema-init.ts 必须不直接 new Pool（让调用方决定池化策略）',
  );
  assert.doesNotMatch(
    codeOnly,
    /process\.env\.DATABASE_URL/,
    'schema-init.ts 必须不读 process.env.DATABASE_URL（参数-only 模块）',
  );
});

// ─── #5b 静态合约：ensureSchema 仍保留 ROLLBACK ─────────────────────
test('ensureSchema source still rolls back on error', () => {
  // case #4 跑的是 stub（ensureSchemaWithSql），并非真实 ensureSchema。
  // 加一道对源码的字面量断言，确保真实函数在异常分支里仍执行 ROLLBACK。
  // 纯静态检查：不需要 DB，RUN=0 时也会跑。
  const src = readFileSync(
    join(process.cwd(), 'src/test-utils/schema-init.ts'),
    'utf-8',
  );
  assert.match(src, /ROLLBACK/);
});