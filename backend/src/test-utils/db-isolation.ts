/**
 * Per-test PG schema namespace + transaction rollback。
 *
 * 设计目标（implementation-plan §PR-0.3）：
 *   - 每个测试独享一个 PG schema（命名 `test_<random>`），避免测试间互相污染；
 *   - 测试体在 BEGIN ... ROLLBACK 事务里跑，setup/teardown 不留任何行；
 *   - 测试体内的 `pool.query` 自动把 `search_path` 切到该 schema，
 *     调用方可以无感地写 `INSERT INTO document_chunks ...`（不写前缀）。
 *
 * 何时启用：
 *   - 设置 `RUN_DB_TESTS=1` + `TEST_DATABASE_URL` 后才会真正连库；
 *   - 没启用时 `withIsolatedSchema` 抛清晰错误，避免 CI 在无 DB 环境下误通过。
 *
 * 使用：
 *   await withIsolatedSchema(async (schema, pool) => {
 *     // setup: 跑 init.sql 子集
 *     await runCoreBaseline(pool);
 *     await pool.query(`INSERT INTO conversations ...`);
 *     // 测试体：用普通 SQL 即可，事务自动回滚
 *   });
 */
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type IsolatedSchemaContext = {
  /** 测试独享 schema 名，例如 `test_a1b2c3d4` */
  schema: string;
  /** 已经把 `search_path` 切到 `{schema}, public` 的 pool */
  pool: Pool;
  /** 当前事务的 client（持有 BEGIN，直到 withIsolatedSchema 结束才 ROLLBACK） */
  client: PoolClient;
};

function isDbTestsEnabled(): boolean {
  return process.env.RUN_DB_TESTS === '1';
}

function requireTestDbUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL 未设置。db-isolation.ts 需要专用测试库的连接串；' +
        '如确实要跑，把 RUN_DB_TESTS=1 与 TEST_DATABASE_URL=postgres://... 一起设置。',
    );
  }
  return url;
}

/**
 * 测试库命名允许列表（按 current_database() 字符串匹配）。
 *
 * 原则：
 *   - 必须以 `test_` / `_test` / `test`（独立名）开头或结尾；
 *   - 必须显式包含 `test` 字样；
 *   - 拒绝 `postgres` / `template0` / `template1` / 生产业务库名等任何
 *     "看起来像真实库"的命名。
 *
 * 命名规范（小写比较）：
 *   - `test_<...>`            例如 `test_xuanshu`
 *   - `<...>_test`            例如 `xuanshu_test`
 *   - `test`                  单独的库名（不推荐，但允许）
 *
 * 此处只检查"是否形似测试库"，实际数据库身份由 `TEST_DATABASE_URL` 决定；
 * 二者一致才能让 `current_database()` 命中允许列表。
 */
const TEST_DB_ALLOWLIST: Array<{ name: string; predicate: (db: string) => boolean }> = [
  {
    name: 'test_ 前缀',
    predicate: (db) => db.startsWith('test_'),
  },
  {
    name: '_test 后缀',
    predicate: (db) => db.endsWith('_test'),
  },
  {
    name: 'test 独立名',
    predicate: (db) => db === 'test',
  },
];

function isAllowedTestDatabaseName(dbName: string): boolean {
  const lower = dbName.toLowerCase();
  // 显式拒绝几个高危库名（即便命名上"像"测试库）。
  const forbidden = ['postgres', 'template0', 'template1'];
  if (forbidden.includes(lower)) return false;
  return TEST_DB_ALLOWLIST.some((rule) => rule.predicate(lower));
}

/**
 * 强制：所有 DB 集成测试必须连接到"专用测试库"。
 *
 * 实现：
 *   1. 要求 `TEST_DATABASE_URL` 存在（独立连接串，**不**复用 `DATABASE_URL`，
 *      避免把生产 / 共享库的连接串错贴到测试环境）；
 *   2. 用该连接串开池 → 取一个 client → 跑 `SELECT current_database()`，
 *      校验返回值命中允许列表；
 *   3. 校验通过后立即关闭池（不缓存），后续 `createPool()` 会重新开启。
 *
 * 为什么必须真实连接并查 `current_database()`：
 *   - 仅靠 `XUANSHU_TEST_DB=1` 这种布尔标记无法证明连接串指向测试库：
 *     人可以"声明自己是测试"但 DATABASE_URL 仍指向预发库 / 共享 dev 库。
 *   - `current_database()` 是数据库侧的真相：连接串写错、库被改名、
 *     共享 dev 库被覆盖，全都会被这一行抓住。
 *
 * 启用方法（CI / 本地一致）：
 *   RUN_DB_TESTS=1 \
 *     TEST_DATABASE_URL=postgres://user:pwd@host:port/test_xuanshu \
 *     npx tsx ...
 */
export async function assertTestDatabase(): Promise<void> {
  if (!isDbTestsEnabled()) {
    throw new Error(
      'DB 集成测试拒绝执行：RUN_DB_TESTS 必须为 1。',
    );
  }
  const url = requireTestDbUrl();
  const pg = await import('pg');
  const verifyPool = new pg.Pool({ connectionString: url, max: 1 });
  let dbName: string | undefined;
  try {
    const client = await verifyPool.connect();
    try {
      const result = await client.query<{ db: string }>(
        `SELECT current_database() AS db`,
      );
      dbName = result.rows[0]?.db;
    } finally {
      client.release();
    }
  } catch (err) {
    throw new Error(
      `DB 集成测试拒绝执行：无法连接 TEST_DATABASE_URL（${err instanceof Error ? err.message : String(err)}）。`,
      { cause: err },
    );
  } finally {
    await verifyPool.end().catch(() => {});
  }
  if (!dbName) {
    throw new Error(
      'DB 集成测试拒绝执行：SELECT current_database() 返回空。',
    );
  }
  if (!isAllowedTestDatabaseName(dbName)) {
    throw new Error(
      `DB 集成测试拒绝执行：当前数据库 "${dbName}" 不在测试库允许列表。` +
        `允许的命名形式：${TEST_DB_ALLOWLIST.map((r) => r.name).join(' / ')}。` +
        `请把 TEST_DATABASE_URL 指向一个形如 test_xuanshu / xuanshu_test 的库。`,
    );
  }
}

/**
 * 创建一个 schema-bound pool：每个新连接自动带
 *   search_path = <schema>, public
 *
 * 实现方式：pg.Pool 的 `options` 字段会在每条新物理连接建立时执行
 *   SET key=value
 * 这里直接把 `search_path=<schema>,public` 烤进 `options`，这样无论后续
 * 调多少次 `pool.connect()`，拿到的 client 都已经在隔离 schema 里。
 *
 * 注意：`options` 不能替代"先 CREATE SCHEMA"。schema 必须先通过一次性连接
 * 建好，本函数返回的 pool 才能挂上去；否则新连接 `SET search_path=<x>,public`
 * 会因为 `<x>` 不存在而报错。
 *
 * 命名规则：传入的 `schema` 必须匹配 `ISOLATED_SCHEMA_PATTERN`
 * （`^test_[0-9a-f]{12}$`）。这是为了防止调用方传错 schema 名后被
 * 静默写入错误命名空间。
 */
async function createSchemaBoundPool(schema: string, max: number): Promise<Pool> {
  if (!ISOLATED_SCHEMA_PATTERN.test(schema)) {
    throw new Error(
      `createSchemaBoundPool 拒绝执行：schema 名 "${schema}" 不匹配 ${ISOLATED_SCHEMA_PATTERN}。`,
    );
  }
  const pg = await import('pg');
  return new pg.Pool({
    connectionString: requireTestDbUrl(),
    options: `-c search_path=${schema},public`,
    max,
  });
}

/**
 * 在一个独享 schema 内执行测试体。
 *
 * 两种模式：
 *   - `transaction: true`（默认）：测试体在 BEGIN ... ROLLBACK 里跑，
 *     setup/teardown 不留任何行。**不要**在 callback 里调用 `client.release()`
 *     / `pool.end()` / `COMMIT` / `ROLLBACK`。
 *   - `transaction: false`：测试体跑在 schema 自有命名空间内但不在事务里。
 *     适用 case 是"并发测试需要事务彼此看到对方提交"。
 *
 * 启用前会强制 `await assertTestDatabase()` —— 不设置 `TEST_DATABASE_URL`
 * 或连接到的库名不在允许列表里，直接抛错，避免把真实库当成测试库用。
 *
 * 隔离保证：
 *   - 本函数返回的 `pool` 中每个新连接都自带 `search_path=<schema>,public`，
 *     调用方在 body 里再 `pool.connect()` 拿到的 client 一定落在隔离 schema；
 *   - 测试体里若用 `client.query` 写 INSERT，行只会出现在该 schema 下；
 *     即便事务回滚或 drop schema，public schema 也不会被污染。
 */
export async function withIsolatedSchema(
  body: (ctx: IsolatedSchemaContext) => Promise<void>,
  options: { transaction?: boolean } = {},
): Promise<void> {
  await assertTestDatabase();
  const useTransaction = options.transaction !== false;
  const schema = `test_${randomBytes(6).toString('hex')}`;
  // schema-bound pool：每个新连接自动带 search_path=<schema>,public。
  // 创建 schema 必须用这个 pool 跑一次：CREATE SCHEMA 本身用不到 search_path，
  // 但能保证 CREATE 之后第一条 SET 命令的语义与后续连接一致。
  const pool = await createSchemaBoundPool(schema, 16);
  let client: PoolClient | null = null;
  let bodyError: unknown;
  try {
    client = await pool.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    if (useTransaction) await client.query('BEGIN');
    await body({ schema, pool, client });
    if (useTransaction) await client.query('ROLLBACK');
  } catch (err) {
    bodyError = err;
    throw err;
  } finally {
    if (client) client.release();
    // 显式 drop 之前先用 pool 内一条连接再确认 search_path：
    // 防御性兜底——若上游改了 pool 的 options，drop 仍能定位到正确 schema。
    try {
      const dropClient = await pool.connect();
      try {
        await dropClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        dropClient.release();
      }
    } catch {
      // best-effort；事务已 ROLLBACK，残留对象通常不会出现
    }
    await pool.end();
    // 让 linter 看到 bodyError 被消费（用来在 finally 里区分成功 / 失败）。
    void bodyError;
  }
}

/**
 * 在测试外侧临时申请一个独享 schema；测试结束由调用方负责 drop。
 *
 * 适用：
 *   - 需要"并发连接都看到同一 schema"的场景（partial unique 测试）；
 *   - 调用方必须持有 schema 名，调用 `dropIsolatedSchema(schema)` 释放。
 *
 * 与 `withIsolatedSchema` 的差别：本函数**不**包事务、不包 body、不自管
 * `pool.end()`。调用方用 `pool.connect()` 拿到的 client 仍受
 * `assertTestDatabase()` 校验。
 *
 * 隔离保证（与之前不同）：
 *   - 之前是"创建 schema 后对一个 client 设 search_path"，但返回的 pool
 *     再 `connect()` 时**新连接不继承 search_path**，会落到 public。
 *   - 现在改为：先用一个一次性连接 `CREATE SCHEMA <schema>`，再返回
 *     一个把 `search_path=<schema>,public` 烤进 `options` 的 pool。
 *     后续 `pool.connect()` 拿到的每条连接都默认在隔离 schema 内。
 *   - 调用方若仍要写默认 public，可显式 `SET search_path TO public`，
 *     但本 API 不再"误开"public 写入路径。
 *
 * 命名约定：返回的 schema 名形如 `test_<12 位 hex>`（randomBytes(6).toString('hex')）。
 * `dropIsolatedSchema()` 会用同一正则反向校验，避免有人误传 `public`
 * 或生产 schema 导致 `DROP SCHEMA public CASCADE` 这类事故。
 */
export async function createIsolatedSchema(): Promise<{
  schema: string;
  pool: Pool;
}> {
  await assertTestDatabase();
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const pg = await import('pg');
  // 一次性连接只用来 CREATE SCHEMA。完成后立即销毁，避免长生命周期连接
  // 干扰后续 schema-bound pool 的连接计数。
  const bootstrapPool = new pg.Pool({
    connectionString: requireTestDbUrl(),
    max: 1,
  });
  const bootstrapClient = await bootstrapPool.connect();
  try {
    await bootstrapClient.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    bootstrapClient.release();
    await bootstrapPool.end();
  }
  // 返回 schema-bound pool：每个新连接都自带 search_path=<schema>,public。
  const pool = await createSchemaBoundPool(schema, 16);
  return { schema, pool };
}

/**
 * `createIsolatedSchema` / `withIsolatedSchema` 生成的 schema 名格式：
 * `test_` 前缀 + 12 位小写 hex（randomBytes(6).toString('hex')）。
 * 任何不匹配此格式的输入一律拒绝。
 */
const ISOLATED_SCHEMA_PATTERN = /^test_[0-9a-f]{12}$/;

function assertIsolatedSchemaName(schema: string): void {
  if (!ISOLATED_SCHEMA_PATTERN.test(schema)) {
    throw new Error(
      `dropIsolatedSchema 拒绝执行：schema 名 "${schema}" 不匹配 ${ISOLATED_SCHEMA_PATTERN}。` +
        `只接受本文件 createIsolatedSchema/withIsolatedSchema 生成的独享 schema 名，` +
        `防止 DROP SCHEMA <production> CASCADE 这类事故。`,
    );
  }
}

/**
 * 回归守卫：断言 `client.current_setting('search_path')` 的第一项就是期望 schema。
 *
 * 用途：
 *   - tests/integration/workspace-context.ts 的 Handler 级集成测试
 *     （11 / 14）拿到 `setupClient` 后，先调本函数确认连接确实落在隔离 schema，
 *     再 `ensureSchema` / 插入 app_users；
 *   - 防止未来有人改坏 `createIsolatedSchema` 或 `installTestPool`（例如忘了
 *     把 `options: -c search_path=...` 传给 `pg.Pool`），导致行被悄悄写入
 *     公共 schema 而测试仍"通过"。
 *
 * 行为：
 *   - 不通过 → 抛 Error，描述 `实际 first entry ≠ 期望 schema`；
 *   - 通过 → 静默返回；
 *   - `expectedSchema` 不匹配 `ISOLATED_SCHEMA_PATTERN` → 抛错（防御）。
 *
 * 实现说明：
 *   - PostgreSQL `SHOW search_path` 返回形如 `"test_abcdef012345", public`，
 *     schema 名带双引号时表示大小写敏感；按 `,` 切分后取首项、剥引号。
 */
export async function assertSearchPathIsolated(
  client: PoolClient,
  expectedSchema: string,
): Promise<void> {
  if (!ISOLATED_SCHEMA_PATTERN.test(expectedSchema)) {
    throw new Error(
      `assertSearchPathIsolated: expectedSchema "${expectedSchema}" 不匹配 ${ISOLATED_SCHEMA_PATTERN}。`,
    );
  }
  const result = await client.query<{ search_path: string }>(
    `SHOW search_path`,
  );
  const raw = result.rows[0]?.search_path ?? '';
  const first = raw.split(',')[0]?.trim() ?? '';
  const normalized = first.replace(/^"(.*)"$/, '$1');
  if (normalized !== expectedSchema) {
    throw new Error(
      `search_path 隔离回归：setupClient 第一项 "${normalized}" ≠ 期望 "${expectedSchema}"。` +
        `这说明 createIsolatedSchema 或 installTestPool 漏挂 search_path，` +
        `测试可能误写到 public schema。raw search_path = "${raw}"`,
    );
  }
}

export async function dropIsolatedSchema(
  schema: string,
  pool: Pool,
): Promise<void> {
  assertIsolatedSchemaName(schema);
  const client = await pool.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * 在隔离 schema 内跑 Core 基线 DDL。
 *
 * 仅放 §5.1 之前所有阶段都依赖的对象：auth、conversations、messages、
 * tool_executions、agent_skill_bindings、skills_installed、knowledge_bases、
 * documents、document_chunks（无 embedding 列）、_migrations。
 *
 * 不放：
 *   - `vector` 扩展 / pgvector 相关（PR-4.1 之后才有）；
 *   - `workspace_id` / `workspaces`（PR-1.x 才有）。
 */
export async function runCoreBaseline(client: PoolClient): Promise<void> {
  await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await client.query(`
    CREATE TABLE knowledge_bases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
      type TEXT NOT NULL,
      size BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
      status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','parsing','chunking','embedding','completed','failed')),
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE document_chunks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (document_id, chunk_index)
    )
  `);
  await client.query(`
    CREATE TABLE conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL DEFAULT '新对话',
      agent_id TEXT NOT NULL,
      knowledge_base_id UUID NULL REFERENCES knowledge_bases(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      citations JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL CHECK (status IN ('pending','streaming','completed','stopped','failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE tool_executions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL,
      input JSONB NOT NULL DEFAULT '{}'::jsonb,
      output JSONB,
      status TEXT NOT NULL CHECK (status IN ('running','completed','failed','stopped')),
      error_code TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      duration_ms INTEGER
    )
  `);
  await client.query(`
    CREATE TABLE agent_skill_bindings (
      agent_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id, skill_id)
    )
  `);
  await client.query(`
    CREATE TABLE skills_installed (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('builtin','marketplace','local')),
      location TEXT NOT NULL,
      compatibility TEXT NOT NULL DEFAULT 'unknown',
      has_scripts BOOLEAN NOT NULL DEFAULT false,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      allowed_tools TEXT[],
      installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // _migrations 表存在即可：PR-0.1 后续会在迁移 runner 中维护
  await client.query(`
    CREATE TABLE _migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}
