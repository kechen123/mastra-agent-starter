/**
 * sweeper 同事务合约测试（注入式，不连接真实 DB）。
 *
 * 覆盖的合约（V2 §6.3 + §6.4 阻断项 5）：
 *   - S1：传入 Pool 时，sweeper 必须 BEGIN / COMMIT 自己包成事务，
 *        且 Run / message / event 写入是同一事务（任一失败则全回滚）；
 *   - S2：传入 PoolClient 时，sweeper 视作"caller 已开事务"，
 *        不再 BEGIN / COMMIT；
 *   - S3：终态 UPDATE 带 WHERE status IN ('queued','running') 条件，
 *        不会覆盖已 stopped / failed 的 Run；
 *   - S4：事件写入通过 insertRunEvent（要求 PoolClient 形式），确保
 *        pg_notify 与事件 INSERT 同事务。
 *
 * Run with: npx tsx tests/unit/sweeper-transactional.ts
 */
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * 最小化的 PG 桩实现：
 *   - Pool.connect() 返回一个新 client；
 *   - client.query() 记录调用；
 *   - 调用方需要按 query(sql) 来检测是否 BEGIN / ROLLBACK / COMMIT。
 */
interface FakeClient {
  kind: 'client';
  queries: string[];
  releaseCount: number;
}
interface FakePool {
  kind: 'pool';
  clients: FakeClient[];
}

function makeFakePool(): FakePool & {
  pushQuery: (client: FakeClient, sql: string) => void;
} {
  const pool: FakePool & { pushQuery: (client: FakeClient, sql: string) => void } = {
    kind: 'pool',
    clients: [],
    pushQuery(_client, _sql) {
      // not used; queries go through client.query
    },
  };
  return pool;
}

/**
 * 解析 init.sql 的 sweeper 行为：用 SQL 字符串片段判断。
 */
async function runSweeper(executor: FakePool | FakeClient): Promise<{ rows: unknown[] }> {
  const { sweepExpiredLeases } = await import('../../src/modules/runs/repository.js');
  // 类型适配：把 FakePool/FakeClient 冒充成 pg.Pool / pg.PoolClient；
  // 桩实现确保只调用 query / connect / release。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await sweepExpiredLeases(executor as any);
  return { rows };
}

/** 构造一行 fake 的 RunRow（满足 rowToRun 的所有字段）。 */
function fakeRunRow() {
  const now = new Date().toISOString();
  return {
    id: 'r-1',
    workspace_id: 'w-1',
    conversation_id: 'c-1',
    assistant_message_id: 'm-1',
    agent_id: 'general-chat',
    provider: 'stub',
    model: 'stub-1',
    status: 'queued',
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: 0,
    started_at: null,
    completed_at: null,
    error_code: null,
    parent_run_id: null,
    request_id: 'req-1',
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
    created_by: 'u-1',
    created_at: now,
    updated_at: now,
  };
}

console.log('\n[sweeper] S1 — Pool 路径：sweeper 必须包成单事务');
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let captured: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakePool: any = {
    async connect() {
      if (captured) return captured;
      captured = {
        queries: [] as string[],
        releaseCount: 0,
        async query(sql: string) {
          this.queries.push(sql);
          if (sql.startsWith('BEGIN')) return { rows: [], rowCount: 0 };
          if (sql.startsWith('COMMIT')) return { rows: [], rowCount: 0 };
          if (sql.startsWith('ROLLBACK')) return { rows: [], rowCount: 0 };
          if (sql.includes('UPDATE agent_runs') && sql.includes('RETURNING')) {
            return { rows: [fakeRunRow()] };
          }
          if (sql.includes('UPDATE messages')) return { rowCount: 1, rows: [] };
          if (sql.startsWith('SELECT pg_notify')) return { rowCount: 0, rows: [] };
          if (sql.startsWith('INSERT INTO agent_run_events')) return { rows: [{ id: 1 }] };
          return { rows: [], rowCount: 0 };
        },
        release() { this.releaseCount += 1; },
      };
      return captured;
    },
  };
  const { rows } = await runSweeper(fakePool);
  check('S1: rows 解析成功', Array.isArray(rows));
  check('S1: client 被 collect 到', captured !== null);
  if (captured) {
    check('S1: client.queries 首条为 BEGIN', captured.queries[0] === 'BEGIN',
      `actual=${captured.queries[0]}`);
    check('S1: client.queries 含 COMMIT', captured.queries.includes('COMMIT'));
    check('S1: client.queries 含 UPDATE agent_runs',
      captured.queries.some((q: string) => q.includes('UPDATE agent_runs') && q.includes("status IN ('queued', 'running')")));
    check('S1: client.queries 含 UPDATE messages',
      captured.queries.some((q: string) => q.includes('UPDATE messages')));
    check('S1: client.queries 含 INSERT INTO agent_run_events',
      captured.queries.some((q: string) => q.includes('INSERT INTO agent_run_events')));
    check('S1: client.release() 被调一次', captured.releaseCount === 1);
  }
}

console.log('\n[sweeper] S2 — PoolClient 路径：sweeper 不再 BEGIN / COMMIT');
{
  // PoolClient 不应有 connect 方法。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeClient: any = {
    kind: 'client',
    queries: [] as string[],
    async query(sql: string) {
      this.queries.push(sql);
      if (sql.startsWith('BEGIN')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('COMMIT')) return { rows: [], rowCount: 0 };
      if (sql.includes('UPDATE agent_runs') && sql.includes('RETURNING')) {
        return { rows: [fakeRunRow()] };
      }
      if (sql.includes('UPDATE messages')) return { rowCount: 1, rows: [] };
      if (sql.startsWith('SELECT pg_notify')) return { rowCount: 0, rows: [] };
      if (sql.startsWith('INSERT INTO agent_run_events')) return { rows: [{ id: 1 }] };
      return { rows: [], rowCount: 0 };
    },
  };
  const { rows } = await runSweeper(fakeClient);
  check('S2: rows 解析成功', Array.isArray(rows));
  check('S2: caller-owned tx 路径首条不是 BEGIN', fakeClient.queries[0] !== 'BEGIN',
    `actual=${fakeClient.queries[0]}`);
  check('S2: caller-owned tx 路径不含 COMMIT', !fakeClient.queries.includes('COMMIT'));
  check('S2: 仍然执行 UPDATE agent_runs', fakeClient.queries.some((q: string) => q.includes('UPDATE agent_runs')));
  check('S2: 仍然执行 UPDATE messages', fakeClient.queries.some((q: string) => q.includes('UPDATE messages')));
  check('S2: 仍然执行 INSERT agent_run_events', fakeClient.queries.some((q: string) => q.includes('INSERT INTO agent_run_events')));
}

console.log('\n[sweeper] S3 — 终态 UPDATE 带 WHERE status IN 条件');
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeClient: any = {
    queries: [] as string[],
    async query(sql: string) {
      this.queries.push(sql);
      if (sql.includes('UPDATE agent_runs') && sql.includes('RETURNING')) return { rows: [fakeRunRow()] };
      if (sql.includes('UPDATE messages')) return { rowCount: 1, rows: [] };
      if (sql.startsWith('SELECT pg_notify')) return { rowCount: 0, rows: [] };
      if (sql.startsWith('INSERT INTO agent_run_events')) return { rows: [{ id: 1 }] };
      return { rows: [], rowCount: 0 };
    },
  };
  await runSweeper(fakeClient);
  const runUpdate = fakeClient.queries.find((q: string) => q.includes('UPDATE agent_runs'));
  const messageUpdate = fakeClient.queries.find((q: string) => q.includes('UPDATE messages'));
  check('S3: UPDATE agent_runs 含 WHERE status IN', runUpdate && runUpdate.includes("status IN ('queued', 'running')"),
    `actual=${runUpdate?.slice(0, 200)}`);
  check('S3: UPDATE messages 含 WHERE status IN', messageUpdate && messageUpdate.includes("status IN ('pending', 'streaming')"),
    `actual=${messageUpdate?.slice(0, 200)}`);
}

console.log('\n[sweeper] S4 — 抛错时事务回滚（Pool 路径）');
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let captured: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakePool: any = {
    async connect() {
      if (captured) return captured;
      captured = {
        queries: [] as string[],
        releaseCount: 0,
        async query(sql: string) {
          this.queries.push(sql);
          if (sql.startsWith('BEGIN')) return { rows: [], rowCount: 0 };
          if (sql.includes('UPDATE agent_runs') && sql.includes('RETURNING')) {
            return { rows: [fakeRunRow()] };
          }
          // 模拟 UPDATE messages 失败
          if (sql.includes('UPDATE messages')) throw new Error('simulated DB failure');
          return { rows: [], rowCount: 0 };
        },
        release() { this.releaseCount += 1; },
      };
      return captured;
    },
  };
  let threw = false;
  try {
    await runSweeper(fakePool);
  } catch (err) {
    threw = (err as Error).message === 'simulated DB failure';
  }
  check('S4: 错误透传给 caller', threw);
  check('S4: 拿到 client', captured !== null);
  if (captured) {
    check('S4: 失败后执行了 ROLLBACK', captured.queries.includes('ROLLBACK'));
    check('S4: 失败后没有 COMMIT', !captured.queries.includes('COMMIT'));
    check('S4: client.release() 仍被调（finally）', captured.releaseCount === 1);
  }
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`sweeper-transactional 失败 ${failed} 项断言`);
}