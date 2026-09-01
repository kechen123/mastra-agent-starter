/**
 * Schema bootstrap runner (PR-1.2/1.3/1.5).
 *
 * 设计目标：
 *   - 单一来源 = `backend/database/init.sql`；不维护迁移链、不读迁移目录。
 *   - 幂等性靠「对 init.sql 全文取 sha256 → 写入 `_init_meta.singleton`」实现：
 *     - 首次跑：apply init.sql + 写 _init_meta，action='applied'
 *     - 后续跑：checksum 一致 → action='skipped'，不再 DDL
 *     - 文件被改、checksum 变了 → action='drift'，**不**抛错，但调用方应据此失败
 *
 * 与已删除的 `src/test-utils/migrations.ts` 的差别：
 *   - migrations.ts 接受 `PoolClient`（让调用方决定事务边界）；
 *   - 本模块 self-manage BEGIN/COMMIT/ROLLBACK：调用方只传 `Pool`，由 ensureSchema
 *     内部 `pool.connect()` 拿 client、跑事务、释放。
 *   - 本模块不读环境变量、不自行构建连接池 —— 由 Global
 *     Constraint 要求；调用方负责把"测试专用 pool"传进来。
 *
 * checksum 必须独立于 Pool（Task 16 的静态契约测试会锁这一点）：
 *   - `computeInitChecksum` 只读文件 + sha256，不 import pg、不读 env。
 *
 * 关于 `_init_meta` 表在 init.sql 内的存在性：
 *   - 截至本任务，init.sql 不含 `_init_meta`；
 *   - `ensureSchema` 跑完 init.sql 后再做一次 `CREATE TABLE IF NOT EXISTS _init_meta`
 *     + `INSERT ... ON CONFLICT DO NOTHING`，把 checksum 落库。
 *   - 这样首次跑和后续跑共享同一张事实表，重复运行不会被 IF NOT EXISTS 跳过
 *     也不会重复插入。
 *
 * 三态语义：
 *   - `applied`：首次跑（_init_meta 在 current_schema 内不存在），init.sql 已执行。
 *   - `skipped`：再次跑，checksum 一致，未执行任何 DDL。
 *   - `drift`  ：再次跑，checksum 不一致；DDL **未**执行，等待调用方决策。
 *
 * `_init_meta` singleton 行缺失 → 抛 `InitSchemaIntegrityError`：
 *   关系存在但单例行不见，说明状态被人手工改坏；不允许自动恢复（避免掩盖
 *   运维事故），也不允许退回首次初始化（那会重新执行 init.sql，可能
 *   写入错位的 metadata）。调用方必须手动 DROP SCHEMA 或修复元数据表。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const INIT_SQL_PATH = join(REPO_ROOT, 'backend', 'database', 'init.sql');

/**
 * init.sql 与 _init_meta 中记录的 checksum 不一致时抛错。
 *
 * 触发条件：
 *   - 数据库里 _init_meta.singleton.checksum ≠ 当前 init.sql 的 sha256。
 *
 * 字段：
 *   - `expected`：库里存的老 checksum（init.sql 历史上的某个版本）
 *   - `actual`  ：当前 init.sql 的 sha256
 *
 * 调用方（通常是 migrate.ts main）应据此决定是 abort、备份还是覆盖——本模块
 * 默认**不**自动覆盖，避免静默吞掉"运营改了表结构没通知开发"这种事。
 */
export class InitSchemaDriftError extends Error {
  constructor(
    public expected: string,
    public actual: string,
  ) {
    super(`init.sql checksum drift: stored=${expected} current=${actual}`);
    this.name = 'InitSchemaDriftError';
  }
}

/**
 * _init_meta 关系存在但 singleton 行缺失时抛错。
 *
 * 触发条件：
 *   - 当前 schema 中已存在 `_init_meta` 表（schema-bound 元数据一致）；
 *   - 但 singleton 行不在 —— 既不是首次初始化，也不是稳定态。
 *
 * 设计：
 *   - **不**退回首次初始化（那会重跑 init.sql，可能写错位）；
 *   - **不**自动重写 singleton（运维事故应当由人工决定）；
 *   - 调用方应据此 DROP SCHEMA / 重新 migrate，而非绕过本检查。
 */
export class InitSchemaIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitSchemaIntegrityError';
  }
}

/**
 * ensureSchema 的返回值：三种状态机之一。
 *
 * - `applied`：首次跑（_init_meta 之前不存在），init.sql 已执行。
 * - `skipped`：再次跑，checksum 一致，未执行任何 DDL。
 * - `drift`  ：再次跑，checksum 不一致；DDL **未**执行，等待调用方决策。
 */
export type EnsureSchemaResult =
  | { action: 'applied'; checksum: string }
  | { action: 'skipped'; checksum: string }
  | { action: 'drift'; expected: string; actual: string };

/**
 * 计算 init.sql 的 sha256 hex（64 位小写）。
 *
 * 纯函数：只读 `backend/database/init.sql`，不连库、不读 env。
 * 同一文件 → 同一输出；调用方可以安全缓存。
 *
 * 测试注入：`options.initSql` 可覆盖磁盘读路径，但生产路径不传该字段。
 */
export async function computeInitChecksum(
  options: { initSql?: string } = {},
): Promise<string> {
  const sql = options.initSql ?? readFileSync(INIT_SQL_PATH, 'utf-8');
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * `inspectInitMetaState` 的返回值：当前 schema 在当前事务内的 _init_meta 状态机。
 *
 * 设计要点：
 *   - **不**写库、不持锁；纯读取。
 *   - 由 `ensureSchema` 在两处调用：
 *       1) BEGIN 之后、未取锁之前（fast-path：常态热路径直接走
 *          skipped/drift/integrity，跳过 advisory lock 与 DDL）；
 *       2) 取到 advisory lock 之后、commit/rollback 之前（同 schema 并发
 *          首次跑：另一个 worker 可能在等锁期间已经把 init.sql 跑完，
 *          因此**必须**重新读 _init_meta 与 singleton 行，不能复用
 *          取锁前的快照——否则两个 worker 都会执行 initSql，触发
 *          "relation already exists"）。
 *   - 返回 `first-time` 时 caller 必须按需决定是否走"取锁 → 再检一次"
 *     路径；返回 `skipped`/`drift`/`integrity-broken` 时不再需要取锁。
 *
 * 两处 inspect 共享同一份实现，避免状态判断逻辑漂移。
 */
type InitMetaInspection =
  | { kind: 'first-time' }
  | { kind: 'skipped'; checksum: string }
  | { kind: 'drift'; expected: string; actual: string }
  | { kind: 'integrity-broken'; schemaName: string };

/**
 * 在 `client` 当前事务内读取 _init_meta 的状态。
 *
 * 关键约束：
 *   - 必须用同一个 PoolClient、同一个事务内调用 —— caller 的 BEGIN/COMMIT
 *     与 SERIALIZABLE 边界必须保持一致；否则 PG 元读到的可能不是 caller
 *     期望的视图。
 *   - 用 `format('%I._init_meta', current_schema())` 把搜索锁到当前
 *     search_path（pg.Pool options 在测试场景下会用 `-c search_path=<s>`，
 *     因此 current_schema() 是 caller 设定的 schema），避免误读其它 schema
 *     的 _init_meta。
 *   - 不捕获、不重抛错误 —— 把异常留给 ensureSchema 的 catch 做统一
 *     ROLLBACK 处理。
 */
async function inspectInitMetaState(
  client: PoolClient,
  current: string,
): Promise<InitMetaInspection> {
  // PR-1.2 关闭审查整改：原实现直接 `SELECT FROM _init_meta`，首次跑会因
  // 表不存在抛 "relation does not exist"。改为：用 schema 限定的 pg_catalog
  // 元查询判断当前 schema 是否已有 `_init_meta`（不依赖表存在性，no-op）。
  //
  // **不能用 `to_regclass(format('%I._init_meta', current_schema()))`**：
  // PG18 的 catalog snapshot 缓存在跨语句时**不会**因 advisory lock 解锁
  // 而刷新 —— worker B 在取锁后用 to_regclass 查 `_init_meta` 是否存在，
  // 仍返回 NULL（看不到 worker A 刚 commit 的 _init_meta 表），导致 B
  // 误判并发首跑、走 initSql → `relation "app_users" already exists`。
  // 这里改用 `pg_class` + `pg_namespace` 的常规 SELECT —— 它走 MVCC 快照，
  // 每次语句都重新取快照，能看到刚刚 commit 的 catalog 行。
  const existsResult = await client.query<{ relname: string | null }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = '_init_meta'
      LIMIT 1`,
  );
  const initMetaExists =
    existsResult.rows[0]?.relname !== null &&
    existsResult.rows[0]?.relname !== undefined;
  if (!initMetaExists) {
    return { kind: 'first-time' };
  }
  const existing = await client.query<{ checksum: string }>(
    `SELECT checksum FROM _init_meta WHERE id = 'singleton'`,
  );
  if (existing.rows[0]) {
    if (existing.rows[0].checksum !== current) {
      return {
        kind: 'drift',
        expected: existing.rows[0].checksum,
        actual: current,
      };
    }
    return { kind: 'skipped', checksum: current };
  }
  // _init_meta 关系存在但 singleton 行缺失 —— 视为完整性破坏。
  const schemaName = await currentSchemaName(client);
  return { kind: 'integrity-broken', schemaName };
}

/**
 * 在 `pool` 上跑一次 init.sql（若未跑过），返回三态结果。
 *
 * 事务策略：
 *   - 内部 `pool.connect()` 拿 client → BEGIN；
 *   - 第一次 `inspectInitMetaState`（fast-path，未持锁）：
 *       - skipped / drift / integrity → 立即 COMMIT / ROLLBACK / 抛错；
 *       - first-time → 走"取锁 → 再 inspect 一次"分支。
 *   - 取 `pg_advisory_xact_lock(hashtext('xuanshu-agent:init-schema'))`：
 *       - hashtext 把文本 key 落到 int4（pg_advisory_xact_lock 第一参是
 *         bigint，取 hashtext 结果作低 32 位、高 32 位为 0）；同一文本 key
 *         → 同一锁槽，所有进程对齐到同一把锁。
 *       - 锁随 COMMIT/ROLLBACK 自动释放，无需 unlock。
 *       - 仅 `first-time` 路径取锁；常态热路径（skipped / drift /
 *         integrity）**不**取锁，避免多 worker 复用同一 Pool 时相互
 *         阻塞 —— 这些路径只读 _init_meta，不会争抢 `pg_extension_name_index`。
 *   - 第二次 `inspectInitMetaState`（持锁后）：
 *       - 这是"我是这一轮 init.sql 的执行者，还是被前面的 worker 抢先
 *         了"的**唯一**可信判断来源。两个 worker 并发首次跑同一 schema：
 *           worker A: BEGIN → inspect→first-time → 取锁（先到先得）→
 *                     inspect→first-time → 跑 initSql → 写 singleton →
 *                     COMMIT 释放锁。
 *           worker B: BEGIN → inspect→first-time → 等锁 → 取锁 →
 *                     **inspect→skipped** → COMMIT 空事务 → return 'skipped'。
 *         如果不重新 inspect，worker B 会沿用"取锁前"的 first-time 快照
 *         再次执行 initSql，触发 `relation "app_users" already exists`。
 *       - 第二次 inspect 的分支处理与第一次**完全一致**（同一份状态机
 *         inspectInitMetaState，避免两份漂移逻辑）。
 *   - 任何异常：catch 内 best-effort ROLLBACK 后原样向上抛。
 *
 * 调用方注意：
 *   - 不要在事务里调用本函数（要求 pool 在 autocommit 状态）。
 *   - 返回 `drift` 时，调用方应拒绝继续（不抛 InitSchemaDriftError 的策略由调用方决定；
 *     本模块自身只返回 drift，不抛错，让"自动化脚本"也能拿到结构化结果）。
 *
 * 选项 `initSql`：仅供测试用例注入（让"事务中途失败"用例构造一个故意失败
 * 的 DDL），让真实生产代码路径完整走一遍 BEGIN / SQL / ROLLBACK。
 */
export async function ensureSchema(
  pool: Pool,
  options: { initSql?: string } = {},
): Promise<EnsureSchemaResult> {
  const initSql = options.initSql ?? readFileSync(INIT_SQL_PATH, 'utf-8');
  const current = createHash('sha256').update(initSql).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 第一次 inspect —— 不持锁，fast-path。
    let state = await inspectInitMetaState(client, current);
    if (state.kind === 'first-time') {
      // PR-1.2/1.3/1.5 收尾整改 — 同 schema 并发首次跑保护：
      //   取锁前我们看到 `_init_meta` 不存在，但**不能**据此直接执行
      //   initSql —— 另一个 worker 可能也在同一 schema 上持有锁 / 正在
      //   等待。取 `pg_advisory_xact_lock` 把"同时首次跑"串行化。
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('xuanshu-agent:init-schema'))`,
      );
      // 取锁后**必须重新** inspect —— 这才是"我是这一轮 init.sql 的执行
      // 者，还是被前面的 worker 抢先了"的唯一可信判断来源。
      state = await inspectInitMetaState(client, current);
    }
    switch (state.kind) {
      case 'skipped':
        await client.query('COMMIT');
        return { action: 'skipped', checksum: state.checksum };
      case 'drift':
        await client.query('ROLLBACK');
        return {
          action: 'drift',
          expected: state.expected,
          actual: state.actual,
        };
      case 'integrity-broken':
        // 完整性破坏 —— 不允许退回首次初始化（那会重跑 init.sql，掩盖
        // 运维事故），也不允许自动重写 singleton。必须 ROLLBACK + 抛错，
        // 由调用方决定 DROP SCHEMA / 修复元数据表。
        await client.query('ROLLBACK');
        throw new InitSchemaIntegrityError(
          `_init_meta table exists in schema "${state.schemaName}" but singleton row is missing; ` +
            'refusing to silently re-initialize. Drop the schema and re-run migrate.',
        );
      case 'first-time':
        // 两次 inspect 都返回 first-time —— 这一轮我们就是 init.sql 的
        // 执行者。跑 DDL + 写 singleton 行 + COMMIT。
        await client.query(initSql);
        await client.query(
          `CREATE TABLE IF NOT EXISTS _init_meta (
             id TEXT PRIMARY KEY,
             checksum TEXT NOT NULL,
             applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
           )`,
        );
        await client.query(
          `INSERT INTO _init_meta (id, checksum) VALUES ('singleton', $1)
            ON CONFLICT (id) DO NOTHING`,
          [current],
        );
        await client.query('COMMIT');
        return { action: 'applied', checksum: current };
    }
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

/**
 * 读取 current_schema() —— 仅供错误信息使用。生产代码不在事务内调此函数，
 * 但在 throw 路径上额外取一次 schema 名只为错误信息可读。
 */
async function currentSchemaName(
  client: {
    query: (sql: string) => Promise<{ rows: Array<{ schema: string }> }>;
  },
): Promise<string> {
  try {
    const r = await client.query(`SELECT current_schema() AS schema`);
    return r.rows[0]?.schema ?? '<unknown>';
  } catch {
    return '<unknown>';
  }
}

/**
 * 删除一个 PG schema 及其全部对象。
 *
 * 设计：仅给"测试隔离"用 —— 由 `withIsolatedSchema` / `createIsolatedSchema`
 * 生成的 schema 名形如 `test_<12hex>`（详见 db-isolation.ts）。
 *
 * 安全：
 *   - schema 名拼进 SQL 时已转义引号，但 schema 名是来自调用方，所以**调用方必须
 *     校验**传入字符串只包含允许字符（db-isolation.ts 已强制正则匹配）。
 *   - 本函数不连接 pool 事务；调用方应保证没有 active transaction。
 */
export async function dropIsolatedSchema(
  pool: Pool,
  schema: string,
): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

/**
 * 在默认 pool 上创建一个独立 schema，并把后续连接的 search_path 切到该 schema。
 *
 * 实际"切 search_path"的工作由 pool 的 `options` 配置完成 —— 但 pg.Pool 不接受
 * 在创建 schema 之后才注入 options，所以本函数只负责 CREATE SCHEMA；
 * 调用方拿到 schema 名后应该用 `db-isolation.ts` 的 createSchemaBoundPool
 * 来创建一个把 `options: -c search_path=<schema>,public` 烤进去的 pool。
 *
 * 适用场景：
 *   - 集成测试里"先建 schema → 在该 schema 里跑 init.sql → 验证 workspace_id
 *     隔离合同"。
 *
 * 注意：search_path 的设置**不在**本函数里做（pg.Pool 构造期就需要 options）；
 * 这里仅做 CREATE SCHEMA 这一步。
 */
export async function createIsolatedSchema(
  pool: Pool,
  schema: string,
): Promise<void> {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`SET search_path TO "${schema}", public`);
}