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
 * 与现有 `src/test-utils/migrations.ts` 的差别：
 *   - migrations.ts 接受 `PoolClient`（让调用方决定事务边界）；
 *   - 本模块 self-manage BEGIN/COMMIT/ROLLBACK：调用方只传 `Pool`，由 ensureSchema
 *     内部 `pool.connect()` 拿 client、跑事务、释放。
 *   - 本模块不读 `process.env.DATABASE_URL`，不自己 new Pool —— 由 Global
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
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';

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
 */
export async function computeInitChecksum(): Promise<string> {
  const sql = readFileSync(INIT_SQL_PATH, 'utf-8');
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * 在 `pool` 上跑一次 init.sql（若未跑过），返回三态结果。
 *
 * 事务策略：
 *   - 内部 `pool.connect()` 拿 client → BEGIN；
 *   - 若 _init_meta.singleton 已存在：
 *     - checksum 一致 → COMMIT 空事务，return 'skipped'
 *     - checksum 不一致 → ROLLBACK，return 'drift'
 *   - 若不存在：跑 init.sql + CREATE TABLE IF NOT EXISTS _init_meta + INSERT，
 *     COMMIT，return 'applied'。
 *   - 任何异常：ROLLBACK 后原样向上抛。
 *
 * 调用方注意：
 *   - 不要在事务里调用本函数（要求 pool 在 autocommit 状态）。
 *   - 返回 `drift` 时，调用方应拒绝继续（不抛 InitSchemaDriftError 的策略由调用方决定；
 *     本模块自身只返回 drift，不抛错，让"自动化脚本"也能拿到结构化结果）。
 */
export async function ensureSchema(pool: Pool): Promise<EnsureSchemaResult> {
  const current = await computeInitChecksum();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{ checksum: string }>(
      `SELECT checksum FROM _init_meta WHERE id = 'singleton'`,
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== current) {
        await client.query('ROLLBACK');
        return {
          action: 'drift',
          expected: existing.rows[0].checksum,
          actual: current,
        };
      }
      await client.query('COMMIT');
      return { action: 'skipped', checksum: current };
    }
    const sql = readFileSync(INIT_SQL_PATH, 'utf-8');
    await client.query(sql);
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
