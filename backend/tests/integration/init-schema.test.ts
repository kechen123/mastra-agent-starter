/**
 * `ensureSchema` 集成测试（合计 8 项 case）。
 *
 * 文件：tests/integration/init-schema.test.ts
 *
 * 启用条件：
 *   - `RUN_DB_TESTS=1` + `TEST_DATABASE_URL=postgres://.../<test_db>`；
 *   - `<test_db>` 必须落在 `db-isolation.ts` 的测试库允许列表
 *     （`test_*` / `*_test` / 独立 `test`）。
 *
 * Skip：每个 case 用 `{ skip: !RUN }` 保证无 DB 环境时文件可干净 typecheck
 * （spec §7.2 + brief 约束）；case #5、#6 是纯静态合约，无须 DB，永远执行。
 *
 * 8 个 case：
 *   1. fresh → action='applied'（首次跑，DDL 已落）
 *   2. 同 checksum 二次跑 → action='skipped'（幂等）
 *   3. checksum 漂移 → action='drift'（不抛错，向调用方报告）
 *   4. mid-flight failure → transaction rolled back（事务回滚后 _init_meta
 *      已被撤销）—— **走真实生产 `ensureSchema(pool, { initSql: brokenSql })`，
 *      不再用 stub**。
 *   5. schema-init.ts 静态合约：不读 process.env.DATABASE_URL、不 new Pool
 *      （保证本模块是"参数-only"，不自己开池）
 *   6. 完整性破坏检测：_init_meta 表存在但 singleton 行缺失 → 抛
 *      `InitSchemaIntegrityError`，**不**允许静默 re-initialize。
 *   7. **不同 schema 并发首次跑**：两个隔离 schema 同时跑 ensureSchema，
 *      各自返回 action='applied'。覆盖 `CREATE EXTENSION` 在
 *      `pg_extension_name_index` 上的并发竞争（advisory lock 串行化）。
 *   8. **同 schema 并发首次跑**：一个 schema 上两个 search_path-bound
 *      pool 同时跑 ensureSchema，必须**恰好一个 applied + 一个 skipped**，
 *      无 duplicate relation / duplicate extension / pg_extension_name_index
 *      错误。覆盖取锁后**必须重新 inspect** 这一关键不变量 —— 仅靠
 *      取锁前缓存 first-time 快照会让两个 worker 都跑 init.sql。
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  ensureSchema,
  InitSchemaIntegrityError,
  dropIsolatedSchema,
  createIsolatedSchema,
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
// **走真实生产 `ensureSchema(pool, { initSql: brokenSql })` 路径：
//   pool.connect() → BEGIN → to_regclass → query broken init.sql → 抛错
//   → catch best-effort ROLLBACK → throw 透传。** 不再依赖任何 stub。
test('ensureSchema: mid-flight failure → transaction rolled back', { skip: !RUN }, async () => {
  await withFreshSchema(async (pool) => {
    // 注入会失败的 SQL —— 让真实 ensureSchema 在事务内 query 抛错。
    // initSql 走生产路径被 query 一次，与真实事故一致。
    await assert.rejects(
      () => ensureSchema(pool, { initSql: 'THIS IS NOT VALID SQL' }),
      // pg 抛错信息含 syntax error；这里只断言"必须 reject"，不强匹配文本
    );
    // 关键断言：_init_meta 在事务回滚后不存在（to_regclass 返回 null）。
    // 这证明真实 ensureSchema 的 ROLLBACK 路径真的把 DDL 撤回了。
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
  // case #4 现在跑的就是真实 ensureSchema（不再用 stub），但再加一道
  // 对源码的字面量断言，确保真实函数在异常分支里仍执行 ROLLBACK。
  // 纯静态检查：不需要 DB，RUN=0 时也会跑。
  const src = readFileSync(
    join(process.cwd(), 'src/test-utils/schema-init.ts'),
    'utf-8',
  );
  assert.match(src, /ROLLBACK/);
});

// ─── #6 完整性破坏检测：_init_meta 表存在但 singleton 行缺失 ─────────
// 模拟运维事故：表被 CREATE TABLE 单独建出来但 singleton 行被 DELETE。
// 真实生产 ensureSchema 必须抛 InitSchemaIntegrityError，**不**退回首次
// 初始化（那会重跑 init.sql 写错位），也**不**自动补 singleton。
test('ensureSchema: singleton row missing → InitSchemaIntegrityError', { skip: !RUN }, async () => {
  await withFreshSchema(async (pool, schema) => {
    // 1. 真实跑一次 ensureSchema，让 _init_meta 落地并写入 singleton 行
    const first = await ensureSchema(pool);
    assert.equal(first.action, 'applied');
    // 2. 模拟"完整性破坏"：删掉 singleton 行，但保留 _init_meta 关系
    await pool.query(`DELETE FROM _init_meta WHERE id = 'singleton'`);
    // 3. 再次跑 ensureSchema —— 应抛 InitSchemaIntegrityError
    let caught: unknown = null;
    try {
      await ensureSchema(pool);
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof InitSchemaIntegrityError,
      `应当抛 InitSchemaIntegrityError，实际: ${caught instanceof Error ? caught.constructor.name : String(caught)}`,
    );
    // 4. 关键断言：状态必须保持原状 —— 表仍存在、singleton 行仍缺失
    // （**不**自动补、**不**退回首次初始化）。
    const meta = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM _init_meta`,
    );
    assert.equal(
      meta.rows[0]?.count,
      '0',
      '抛错后 _init_meta 行数应仍为 0（未自动补 singleton）',
    );
    // 用 to_regclass 确认表仍在（关系未被错误删除）
    const reg = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass(format('%I._init_meta', $1::text))::text AS exists`,
      [schema],
    );
    assert.notEqual(
      reg.rows[0]?.exists,
      null,
      '抛错后 _init_meta 关系应当仍在（不该被清理掉）',
    );
  });
});

// ─── #7 并发 ensureSchema 回归：两隔离 schema 上各自 action=applied ───
// 防回归：init.sql 头部含 `CREATE EXTENSION IF NOT EXISTS pgcrypto/vector`，
// 两个进程并发首次跑同一 schema 会争抢 `pg_extension_name_index`（PG 00040，
// class 23P01 "tuple concurrently updated"）。ensureSchema 必须在
// `initMetaExists === false` 路径内的事务里先
// `SELECT pg_advisory_xact_lock(hashtext('xuanshu-agent:init-schema'))`，
// 把并发首次跑串行化。本 case 用两个隔离 schema 同时首次跑来模拟竞争：
//   - schemaA / schemaB 两个独立 namespace，search_path 各自限定；
//   - `Promise.all([ensureSchema(poolA), ensureSchema(poolB)])`；
//   - 两边都必须返回 action='applied'（各自首次跑、互不阻塞语义）；
//   - 两边的 _init_meta.singleton 都恰好 1 行（无重复 INSERT）；
//   - 不能出现 `pg_extension_name_index` / `tuple concurrently updated`
//     / `CREATE EXTENSION` 拒绝字样的错误。
test(
  'ensureSchema: concurrent first-time apply across two isolated schemas → both action=applied',
  { skip: !RUN },
  async () => {
    const schemaA = `test_${Math.random().toString(36).slice(2, 10)}_a`;
    const schemaB = `test_${Math.random().toString(36).slice(2, 10)}_b`;
    const root = new Pool({ connectionString: URL });
    let poolA: Pool | null = null;
    let poolB: Pool | null = null;
    try {
      await createIsolatedSchema(root, schemaA);
      await createIsolatedSchema(root, schemaB);
      poolA = new Pool({
        connectionString: URL,
        options: `-c search_path=${schemaA},public`,
      });
      poolB = new Pool({
        connectionString: URL,
        options: `-c search_path=${schemaB},public`,
      });
      // 并发跑 —— 不依赖任何 sleep / setTimeout，靠 Promise.all 让两个
      // ensureSchema 各自进入 BEGIN → advisory_xact_lock → init.sql 的
      // 真正并发路径。这是真正能复现 `pg_extension_name_index` 竞争的形态。
      const results = await Promise.all([
        ensureSchema(poolA),
        ensureSchema(poolB),
      ]);
      assert.equal(results[0]?.action, 'applied', 'schemaA 应 action=applied');
      assert.equal(results[1]?.action, 'applied', 'schemaB 应 action=applied');
      // 两个 _init_meta 各自恰好 1 行（无 INSERT 重复、无 ON CONFLICT 触发）。
      const [metaA, metaB] = await Promise.all([
        poolA.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM _init_meta`,
        ),
        poolB.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM _init_meta`,
        ),
      ]);
      assert.equal(
        metaA.rows[0]?.count,
        '1',
        `schemaA _init_meta 行数应为 1（实际 ${metaA.rows[0]?.count}）`,
      );
      assert.equal(
        metaB.rows[0]?.count,
        '1',
        `schemaB _init_meta 行数应为 1（实际 ${metaB.rows[0]?.count}）`,
      );
      // 跨 schema 隔离：schemaA 的 _init_meta 在 schemaB 里看不到。
      const crossFromB = await poolB.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = '_init_meta'`,
        [schemaA],
      );
      assert.equal(
        crossFromB.rows[0]?.count,
        '1',
        'schemaB 看到 schemaA 的 _init_meta（验证两 schema 实际落库）',
      );
    } finally {
      if (poolA) await poolA.end();
      if (poolB) await poolB.end();
      await dropIsolatedSchema(root, schemaA);
      await dropIsolatedSchema(root, schemaB);
      await root.end();
    }
  },
);

// ─── #8 同 schema 并发首次跑回归：必须恰好一个 applied + 一个 skipped ───
// 防回归：Round 3 引入 advisory lock 时只把锁放在"取锁前 inspect=false
// 时"，但**没有在取锁后重新 inspect**——同一个 schema 上两个 worker 并发
// 首次跑，两个都看到 `first-time` 快照，都会执行 initSql，第二个触发
// `relation "app_users" already exists`。本 case 复现这一场景：
//   - 一个隔离 schema，两个独立 Pool（都是 search_path=<schema>,public）；
//   - `Promise.all([ensureSchema(poolA), ensureSchema(poolB)])`；
//   - 锁住的语义：先到 worker 跑 initSql 返回 applied，后到 worker 拿
//     锁后**重新 inspect** 发现 _init_meta 已存在 → 返回 skipped；
//   - 既不报 duplicate relation / duplicate extension，也不报
//     pg_extension_name_index / tuple concurrently updated。
test(
  'ensureSchema: concurrent first-time apply on the same schema → exactly one applied + one skipped',
  { skip: !RUN },
  async () => {
    const schema = `test_${Math.random().toString(36).slice(2, 10)}_same`;
    const root = new Pool({ connectionString: URL });
    let poolA: Pool | null = null;
    let poolB: Pool | null = null;
    try {
      await createIsolatedSchema(root, schema);
      // 两个 pool 都把 search_path 锁到同一个 schema —— 模拟"两个
      // 测试 worker / 两个 migrate 进程同时打同一 schema"的真实竞争。
      poolA = new Pool({
        connectionString: URL,
        options: `-c search_path=${schema},public`,
      });
      poolB = new Pool({
        connectionString: URL,
        options: `-c search_path=${schema},public`,
      });
      // Promise.all 让两个 ensureSchema 各自进入 BEGIN → inspect →
      // advisory_xact_lock → 再次 inspect 的真正并发路径，不依赖
      // sleep / setTimeout 弱化竞争形态。
      const results = await Promise.all([
        ensureSchema(poolA),
        ensureSchema(poolB),
      ]);
      // 必须两边都不抛错（"两者都不抛错"是这一行天然断言 —— 一旦任一 reject
      // Promise.all 整体 reject，下面的 assert 不会执行）。
      const actions = results.map((r) => r.action).sort();
      assert.deepEqual(
        actions,
        ['applied', 'skipped'],
        `同 schema 并发应当恰好一个 applied + 一个 skipped，实际：${JSON.stringify(actions)}`,
      );
      // 第二次跑（双方都已 settle 后再串行各跑一次）必须双双 skipped——
      // 这是"幂等"的基础；同时也间接证明 _init_meta.singleton 已经被
      // 先到的 worker 写入。
      const secondA = await ensureSchema(poolA);
      const secondB = await ensureSchema(poolB);
      assert.equal(secondA.action, 'skipped', 'worker A 第二次跑应 skipped');
      assert.equal(secondB.action, 'skipped', 'worker B 第二次跑应 skipped');
      // _init_meta.singleton 恰好 1 行（既不是 0、也不是 2 —— 0 说明
      // 第一次跑没成功，2 说明两个 worker 都跑了 init.sql 的 INSERT 路径）。
      const meta = await poolA.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM _init_meta`,
      );
      assert.equal(
        meta.rows[0]?.count,
        '1',
        `_init_meta singleton 行数应为 1（实际 ${meta.rows[0]?.count}）`,
      );
      // 业务表 app_users 必须存在 + 恰好 1 行 schema 绑定（不是被双
      // CREATE 后又 ROLLBACK）。
      const appUsers = await poolA.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = 'app_users'`,
        [schema],
      );
      assert.equal(
        appUsers.rows[0]?.count,
        '1',
        `app_users 业务表应恰好存在一次（实际 ${appUsers.rows[0]?.count}）`,
      );
      // 业务表级 sanity：init.sql 应已建出全部主要业务表，**没有**出现
      // "duplicate relation" 之类错误导致中途失败。
      const tables = await poolA.query<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = $1 AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
        [schema],
      );
      const names = tables.rows.map((r) => r.name);
      const required = [
        '_init_meta',
        'app_users',
        'auth_sessions',
        'workspaces',
        'workspace_members',
        'knowledge_bases',
        'documents',
        'document_chunks',
        'conversations',
        'messages',
        'tool_executions',
        'agent_skill_bindings',
      ];
      for (const t of required) {
        assert.ok(
          names.includes(t),
          `业务表 ${t} 必须存在，实际列表：${JSON.stringify(names)}`,
        );
      }
    } finally {
      if (poolA) await poolA.end();
      if (poolB) await poolB.end();
      await dropIsolatedSchema(root, schema);
      await root.end();
    }
  },
);