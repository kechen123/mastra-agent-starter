/**
 * PR-3.3.2 — Hard-Crash Approval-Resume Lease 回收集成测试。
 *
 * 目标：覆盖"worker 在 SDK 调用前 / 中 / 终态落库前被直接杀死"后
 * lease sweeper 的恢复语义。该 crash window **不能** 被 JavaScript
 * catch 捕获（Node 进程死亡）；只能由后台 sweeper 巡检 + 写
 * 明确的 indeterminate / 人工介入状态。
 *
 * 覆盖 6 个验收点：
 *   (a) approved + started_at NOT NULL + running + lease expired +
 *       幂等 Tool → approval → approved_resume_indeterminate +
 *       Run → waiting_approval + 写 run-resume-reclaimed 事件 +
 *       清 Run lease + resume_attempts += 1；
 *   (b) approved + started_at NOT NULL + running + lease expired +
 *       非幂等 Tool → Run → failed + 明确错误码
 *       APPROVAL_RESUME_RECLAIMED_MANUAL_INTERVENTION_REQUIRED +
 *       写 run-failed 事件 + approval 留 indeterminate + 诊断错误；
 *   (c) attempts 达上限 → Run → failed + 错误码
 *       APPROVAL_RESUME_RECLAIMED_ATTEMPTS_EXHAUSTED + 不再
 *       走 reconciliation；
 *   (d) 普通 running Run（无 approval 上下文）仍走 LEASE_EXPIRED +
 *       走原 sweepExpiredLeases 路径，不被 hard-crash sweeper 错误
 *       接管；
 *   (e) 两个 sweeper 并发时同一 Run 只回收一次（SKIP LOCKED 单飞）；
 *   (f) 终态后不存在"approved + mastra_resume_started_at NOT NULL
 *       + failed LEASE_EXPIRED"孤儿组合。
 *
 * 设计约束：
 *   - 不依赖 Docker；用本机 xuanshu 库；
 *   - 在临时 schema 上运行，结束 DROP SCHEMA ... CASCADE；
 *   - 通过 `runHardCrashApprovalResumeSweeperOnce` 入口触发（不等
 *     setInterval tick）；
 *   - 临时 schema 生命周期由最外层 try/finally 兜底，任意阶段
 *     失败都强制清理；
 *   - 不打印 DATABASE_URL / 凭据；
 *   - 测试间隔离：每个子用例使用独立 seed 标识（不同 tool_call_id）。
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool, Client } from 'pg';
import { __resetTestPool, __setTestPool } from '../../src/infrastructure/database/pool.js';
import {
  _setMastraFacadeForTesting,
  _resetSystemResolverCacheForTesting,
} from '../../src/modules/tool-policy/state-machine.js';
import { runHardCrashApprovalResumeSweeperOnce } from '../../src/core/execution/run-executor.js';

const RUN = process.env.RUN_PG_HARD_CRASH_LEASE === '1';
const DB_URL = process.env.DATABASE_URL;
if (!RUN) {
  console.log('[hard-crash-lease-recovery] SKIP（未设置 RUN_PG_HARD_CRASH_LEASE=1）');
  process.exit(0);
}
if (!DB_URL) {
  console.error('[hard-crash-lease-recovery] DATABASE_URL 未配置');
  process.exit(1);
}

const target = new URL(DB_URL);
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/xuanshu') {
  throw new Error('hard-crash fixture 仅允许明确授权的本机 xuanshu 库。');
}

const here = dirname(fileURLToPath(import.meta.url));
const INIT_SQL_PATH = join(here, '..', '..', 'database', 'init.sql');

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const schema = `hard_crash_${randomUUID().replaceAll('-', '')}`;
const admin = new Client({ connectionString: DB_URL });
let adminConnected = false;
const pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema},public` });
let poolEnded = false;
let originalError: Error | null = null;

try {
  await admin.connect();
  adminConnected = true;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  console.log(`[hard-crash-lease-recovery] created schema ${schema}`);

  // 全量 init.sql（含 agent_runs / tool_approval_requests 等）。
  await pool.query(readFileSync(INIT_SQL_PATH, 'utf8'));
  // 临时 schema 已经通过 init.sql 的 INSERT ... ON CONFLICT DO NOTHING
  // 创建了 system-approval-worker 行（同一 PG 库连接，username_normalized
  // 唯一索引跨 schema 共享；写入 public.app_users 时即在临时 schema 的
  // search_path 下生效）。直接 SELECT 拿真实 UUID，**不要**重复 INSERT，
  // 否则违反 username_normalized UNIQUE → PG 23505。
  const su = await pool.query<{ id: string }>(
    `SELECT id FROM app_users WHERE username_normalized = 'system-approval-worker' LIMIT 1`,
  );
  const systemUserId = su.rows[0]!.id;
  // 显式覆盖全局池 + 清 system-resolver 缓存（state-machine 解析缓存
  // 默认走真实库；测试 schema 必须先注册 system-approval-worker 行，
  // 再清缓存让 state-machine 重查）。
  __setTestPool(pool);
  _resetSystemResolverCacheForTesting();
  // 工具注册：让 calculator（idempotent=true）已注册；其他 Tool 不
  // 注册以模拟"非幂等"路径。
  await import('../../src/tools/index.js');

  // 不需要 fake facade：本测试**不**走 SDK 路径——只验证 sweeper
  // 自身对 DB 状态的写入。注入抛错 facade 以防 worker 误触发。
  _setMastraFacadeForTesting({
    approveToolCall: async (): Promise<never> => { throw new Error('SDK should not be called in this test'); },
    declineToolCall: async (): Promise<never> => { throw new Error('SDK should not be called in this test'); },
    listSuspendedRuns: async (): Promise<never> => { throw new Error('SDK should not be called in this test'); },
  });

  // 通用 seed：workspace / user / conv / message / run（running + lease expired）/
  // approval（approved + mastra_resume_started_at NOT NULL）。
  async function seedHardCrashFixture(opts: {
    approvalStatus: 'approved' | 'declined' | 'expired';
    toolId: string;
    resolverId: string;
    resumeAttempts?: number;
  }): Promise<{
    workspaceId: string;
    userId: string;
    runId: string;
    approvalId: string;
  }> {
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces(kind, name) VALUES ('shared', 'hard-crash') RETURNING id`,
    );
    const workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO app_users(username, username_normalized, password_hash)
       VALUES ($1, $1, '!disabled!') RETURNING id`,
      [`hc_${randomUUID()}`],
    );
    const userId = u.rows[0]!.id;
    const conv = await pool.query<{ id: string }>(
      `INSERT INTO conversations(workspace_id, agent_id, title)
       VALUES ($1, 'general-chat', 'hard-crash') RETURNING id`,
      [workspaceId],
    );
    const convId = conv.rows[0]!.id;
    const msg = await pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id, workspace_id, role, content, status)
       VALUES ($1, $2, 'assistant', '', 'pending') RETURNING id`,
      [convId, workspaceId],
    );
    const msgId = msg.rows[0]!.id;
    const run = await pool.query<{ id: string }>(
      `INSERT INTO agent_runs(
         workspace_id, conversation_id, assistant_message_id,
         agent_id, provider, model, status, request_id, created_by,
         lease_owner, lease_expires_at, heartbeat_at
       ) VALUES (
         $1, $2, $3,
         'general-chat', 'test', 'test', 'running', $4, $5,
         'stale-dead-worker', now() - interval '120 seconds', now() - interval '120 seconds'
       ) RETURNING id`,
      [workspaceId, convId, msgId, randomUUID(), userId],
    );
    const runId = run.rows[0]!.id;
    const ap = await pool.query<{ id: string }>(
      `INSERT INTO tool_approval_requests(
         workspace_id, run_id, requester_id, resolver_id,
         tool_id, tool_call_id, inputs_hash, inputs_summary,
         status, decision, resolved_at,
         mastra_resume_started_at, resume_attempts,
         expires_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, 'h', '{}'::jsonb,
         $7, $8, now(),
         now() - interval '60 seconds', $9,
         now() + interval '5 minutes'
       ) RETURNING id`,
      [
        workspaceId, runId, userId, opts.resolverId,
        opts.toolId, `tc-hc-${randomUUID().slice(0, 8)}`,
        opts.approvalStatus,
        opts.approvalStatus === 'approved' ? 'approved'
          : (opts.approvalStatus === 'declined' ? 'declined' : null),
        opts.resumeAttempts ?? 0,
      ],
    );
    return { workspaceId, userId, runId, approvalId: ap.rows[0]!.id };
  }

  // ─────── (a) approved + 幂等 Tool → 重放到 waiting_approval ─────
  console.log('\n[a] approved + idempotent Tool → indeterminate + waiting_approval');
  {
    const seed = await seedHardCrashFixture({
      approvalStatus: 'approved',
      toolId: 'calculator',
      resolverId: systemUserId,
      resumeAttempts: 0,
    });
    await runHardCrashApprovalResumeSweeperOnce();
    const ap = (await pool.query<{ status: string; resume_attempts: number; resolver_error: string | null }>(
      `SELECT status, resume_attempts, resolver_error
         FROM tool_approval_requests WHERE id = $1`, [seed.approvalId])).rows[0]!;
    const r = (await pool.query<{ status: string; lease_owner: string | null; lease_expires_at: string | null; error_code: string | null }>(
      `SELECT status, lease_owner, lease_expires_at, error_code
         FROM agent_runs WHERE id = $1`, [seed.runId])).rows[0]!;
    const ev = await pool.query<{ type: string }>(
      `SELECT type FROM agent_run_events
        WHERE run_id = $1 AND type = 'run-resume-reclaimed'`,
      [seed.runId],
    );
    check('approval.status === approved_resume_indeterminate', ap.status === 'approved_resume_indeterminate', `actual=${ap.status}`);
    check('resume_attempts === 1', ap.resume_attempts === 1, `actual=${ap.resume_attempts}`);
    check('resolver_error starts with APPROVAL_RESUME_RECLAIMED_AFTER_HARD_CRASH', (ap.resolver_error ?? '').startsWith('APPROVAL_RESUME_RECLAIMED_AFTER_HARD_CRASH'), `actual=${ap.resolver_error}`);
    check('Run.status === waiting_approval', r.status === 'waiting_approval', `actual=${r.status}`);
    check('Run.lease_owner === NULL', r.lease_owner === null, `actual=${r.lease_owner}`);
    check('Run.lease_expires_at === NULL', r.lease_expires_at === null, `actual=${r.lease_expires_at}`);
    check('Run.error_code === NULL', r.error_code === null, `actual=${r.error_code}`);
    check('run-resume-reclaimed 事件存在', ev.rows.length === 1, `count=${ev.rows.length}`);
  }

  // ─────── (b) approved + 非幂等 Tool → 人工介入 + Run → failed ─────
  console.log('\n[b] approved + non-idempotent Tool → manual intervention');
  {
    const seed = await seedHardCrashFixture({
      approvalStatus: 'approved',
      // 故意选未注册的 toolId：等同于"非幂等"
      toolId: `non_idempotent_${randomUUID().slice(0, 8)}`,
      resolverId: systemUserId,
    });
    await runHardCrashApprovalResumeSweeperOnce();
    const ap = (await pool.query<{ status: string; resume_attempts: number; resolver_error: string | null }>(
      `SELECT status, resume_attempts, resolver_error
         FROM tool_approval_requests WHERE id = $1`, [seed.approvalId])).rows[0]!;
    const r = (await pool.query<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM agent_runs WHERE id = $1`, [seed.runId])).rows[0]!;
    const failedEv = await pool.query<{ type: string; payload: unknown }>(
      `SELECT type, payload FROM agent_run_events
        WHERE run_id = $1 AND type = 'run-failed'`,
      [seed.runId],
    );
    check('approval.status === approved_resume_indeterminate', ap.status === 'approved_resume_indeterminate', `actual=${ap.status}`);
    check('approval.resolver_error 包含 MANUAL_INTERVENTION_REQUIRED', (ap.resolver_error ?? '').includes('APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED'), `actual=${ap.resolver_error}`);
    check('Run.status === failed', r.status === 'failed', `actual=${r.status}`);
    check('Run.error_code === APPROVAL_RESUME_RECLAIMED_MANUAL_INTERVENTION_REQUIRED',
      r.error_code === 'APPROVAL_RESUME_RECLAIMED_MANUAL_INTERVENTION_REQUIRED', `actual=${r.error_code}`);
    check('run-failed 事件存在', failedEv.rows.length >= 1, `count=${failedEv.rows.length}`);
  }

  // ─────── (c) attempts 耗尽 → 直接人工介入 ─────
  console.log('\n[c] attempts exhausted → manual intervention + Run → failed');
  {
    const seed = await seedHardCrashFixture({
      approvalStatus: 'approved',
      toolId: 'calculator',
      resolverId: systemUserId,
      // maxAttempts=3，sweeper 会做 +1 后比 3 → 走 exhausted
      resumeAttempts: 2,
    });
    await runHardCrashApprovalResumeSweeperOnce();
    const r = (await pool.query<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM agent_runs WHERE id = $1`, [seed.runId])).rows[0]!;
    const ap = (await pool.query<{ status: string; resume_attempts: number; resolver_error: string | null }>(
      `SELECT status, resume_attempts, resolver_error
         FROM tool_approval_requests WHERE id = $1`, [seed.approvalId])).rows[0]!;
    check('Run.status === failed', r.status === 'failed', `actual=${r.status}`);
    check('Run.error_code === APPROVAL_RESUME_RECLAIMED_ATTEMPTS_EXHAUSTED',
      r.error_code === 'APPROVAL_RESUME_RECLAIMED_ATTEMPTS_EXHAUSTED', `actual=${r.error_code}`);
    check('approval.status === approved_resume_indeterminate（不进 reconciliation）',
      ap.status === 'approved_resume_indeterminate', `actual=${ap.status}`);
    check('approval.resolver_error 包含 ATTEMPTS_EXHAUSTED',
      (ap.resolver_error ?? '').includes('APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED'),
      `actual=${ap.resolver_error}`);
  }

  // ─────── (d) 普通 running Run（无 approval 上下文）走 LEASE_EXPIRED ─────
  console.log('\n[d] 普通 running Run + lease expired → 不被 hard-crash 接管（走 LEASE_EXPIRED）');
  {
    // 单独 seed 一个 running Run，**不**插入 approval 行——模拟"普通
    // 路径"孤儿。hard-crash sweeper 必须跳过；之后 sweepExpiredLeases
    // 把它写成 failed + LEASE_EXPIRED。
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces(kind, name) VALUES ('shared', 'plain-lease') RETURNING id`,
    );
    const workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO app_users(username, username_normalized, password_hash)
       VALUES ($1, $1, '!disabled!') RETURNING id`,
      [`plain_${randomUUID()}`],
    );
    const userId = u.rows[0]!.id;
    const conv = await pool.query<{ id: string }>(
      `INSERT INTO conversations(workspace_id, agent_id, title)
       VALUES ($1, 'general-chat', 'plain-lease') RETURNING id`,
      [workspaceId],
    );
    const msg = await pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id, workspace_id, role, content, status)
       VALUES ($1, $2, 'assistant', '', 'pending') RETURNING id`,
      [conv.rows[0]!.id, workspaceId],
    );
    const run = await pool.query<{ id: string }>(
      `INSERT INTO agent_runs(
         workspace_id, conversation_id, assistant_message_id,
         agent_id, provider, model, status, request_id, created_by,
         lease_owner, lease_expires_at
       ) VALUES (
         $1, $2, $3,
         'general-chat', 'test', 'test', 'running', $4, $5,
         'plain-stale-worker', now() - interval '120 seconds'
       ) RETURNING id`,
      [workspaceId, conv.rows[0]!.id, msg.rows[0]!.id, randomUUID(), userId],
    );
    const runId = run.rows[0]!.id;
    // 先跑 hard-crash sweeper：不应影响此 Run。
    await runHardCrashApprovalResumeSweeperOnce();
    const afterHc = (await pool.query<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM agent_runs WHERE id = $1`, [runId])).rows[0]!;
    check('普通 running Run 在 hard-crash sweeper 后仍为 running', afterHc.status === 'running', `actual=${afterHc.status}`);
    // 再跑普通 sweepExpiredLeases 一次。
    const { sweepExpiredLeases } = await import('../../src/modules/runs/repository.js');
    await sweepExpiredLeases(pool);
    const afterPlain = (await pool.query<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM agent_runs WHERE id = $1`, [runId])).rows[0]!;
    check('普通 sweepExpiredLeases 把它写成 failed', afterPlain.status === 'failed', `actual=${afterPlain.status}`);
    check('error_code === LEASE_EXPIRED', afterPlain.error_code === 'LEASE_EXPIRED', `actual=${afterPlain.error_code}`);
  }

  // ─────── (e) 两个 sweeper 并发：SKIP LOCKED 单飞 ─────
  console.log('\n[e] 两个 sweeper 并发 → 同一 Run 只回收一次');
  {
    const seed = await seedHardCrashFixture({
      approvalStatus: 'approved',
      toolId: 'calculator',
      resolverId: systemUserId,
    });
    const [r1, r2] = await Promise.all([
      runHardCrashApprovalResumeSweeperOnce(),
      runHardCrashApprovalResumeSweeperOnce(),
    ]);
    const reclaimSum = r1.reclaimed + r2.reclaimed;
    const ap = (await pool.query<{ resume_attempts: number; status: string }>(
      `SELECT resume_attempts, status FROM tool_approval_requests WHERE id = $1`,
      [seed.approvalId])).rows[0]!;
    const r = (await pool.query<{ status: string }>(
      `SELECT status FROM agent_runs WHERE id = $1`,
      [seed.runId])).rows[0]!;
    const ev = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM agent_run_events
        WHERE run_id = $1 AND type = 'run-resume-reclaimed'`,
      [seed.runId],
    );
    check('两个 sweeper 合计只 reclaim 1 次', reclaimSum === 1, `r1=${r1.reclaimed}, r2=${r2.reclaimed}`);
    check('approval.resume_attempts === 1', ap.resume_attempts === 1, `actual=${ap.resume_attempts}`);
    check('Run.status === waiting_approval', r.status === 'waiting_approval', `actual=${r.status}`);
    check('run-resume-reclaimed 事件恰好 1 条', ev.rows[0]?.c === 1, `actual=${ev.rows[0]?.c}`);
  }

  // ─────── (f) 终态后不存在孤儿组合 ─────
  console.log('\n[f] 终态后不存在 approved + started_at NOT NULL + failed LEASE_EXPIRED 孤儿');
  {
    const orphans = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c
         FROM tool_approval_requests a
         JOIN agent_runs r ON r.id = a.run_id AND r.workspace_id = a.workspace_id
        WHERE a.status = 'approved'
          AND a.mastra_resume_started_at IS NOT NULL
          AND r.status = 'failed'
          AND r.error_code = 'LEASE_EXPIRED'`,
    );
    check('approved + started_at + failed LEASE_EXPIRED 组合 = 0', (orphans.rows[0]?.c ?? -1) === 0, `count=${orphans.rows[0]?.c}`);
  }

  // ─────── (g) 跨实例并发：hard-crash sweeper 与普通 sweepExpiredLeases
  //              并发时，approval-resume Run **不**得变 failed + LEASE_EXPIRED。
  //   关键不变量：普通 sweepExpiredLeases 的 SQL 必须**排除**approval-resume
  //   Run（WHERE NOT EXISTS），不能依赖"先跑 hard-crash 后跑普通"的调用
  //   顺序——跨进程下两个 sweeper 真并行。验证：
  //     - 跨进程并发下：approval-resume Run → waiting_approval（硬崩溃）
  //     - 普通无审批 running Run → failed + LEASE_EXPIRED（普通 lease 路径）
  // ─────
  console.log('\n[g] hard-crash sweeper 与普通 sweepExpiredLeases 并发 → 互不串扰');
  {
    // 两个并发输入：
    //   1) approval-resume Run（idempotent tool, approved + started_at）
    //   2) 普通无审批 running Run（孤儿 lease）
    const seedHc = await seedHardCrashFixture({
      approvalStatus: 'approved',
      toolId: 'calculator',
      resolverId: systemUserId,
    });
    const plainWs = await pool.query<{ id: string }>(
      `INSERT INTO workspaces(kind, name) VALUES ('shared', 'plain-concurrent') RETURNING id`,
    );
    const plainWorkspaceId = plainWs.rows[0]!.id;
    const plainU = await pool.query<{ id: string }>(
      `INSERT INTO app_users(username, username_normalized, password_hash)
       VALUES ($1, $1, '!disabled!') RETURNING id`,
      [`plain_concurrent_${randomUUID()}`],
    );
    const plainUserId = plainU.rows[0]!.id;
    const plainConv = await pool.query<{ id: string }>(
      `INSERT INTO conversations(workspace_id, agent_id, title)
       VALUES ($1, 'general-chat', 'plain-concurrent') RETURNING id`,
      [plainWorkspaceId],
    );
    const plainMsg = await pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id, workspace_id, role, content, status)
       VALUES ($1, $2, 'assistant', '', 'pending') RETURNING id`,
      [plainConv.rows[0]!.id, plainWorkspaceId],
    );
    const plainRun = await pool.query<{ id: string }>(
      `INSERT INTO agent_runs(
         workspace_id, conversation_id, assistant_message_id,
         agent_id, provider, model, status, request_id, created_by,
         lease_owner, lease_expires_at
       ) VALUES (
         $1, $2, $3,
         'general-chat', 'test', 'test', 'running', $4, $5,
         'plain-conc-stale-worker', now() - interval '120 seconds'
       ) RETURNING id`,
      [plainWorkspaceId, plainConv.rows[0]!.id, plainMsg.rows[0]!.id, randomUUID(), plainUserId],
    );
    const plainRunId = plainRun.rows[0]!.id;

    // 真并行：两个 sweeper 在独立 Promise 中并发触发。
    const { sweepExpiredLeases } = await import('../../src/modules/runs/repository.js');
    const [hcResult, plainResult] = await Promise.all([
      runHardCrashApprovalResumeSweeperOnce(),
      sweepExpiredLeases(pool),
    ]);

    // 关键断言：approval-resume Run **不**能变成 failed + LEASE_EXPIRED。
    const hcRun = (await pool.query<{ status: string; error_code: string | null; lease_owner: string | null }>(
      `SELECT status, error_code, lease_owner FROM agent_runs WHERE id = $1`,
      [seedHc.runId])).rows[0]!;
    check('approval-resume Run 不被普通 sweeper 写成 failed',
      hcRun.status !== 'failed',
      `actual.status=${hcRun.status}, actual.error_code=${hcRun.error_code}`);
    check('approval-resume Run 不被普通 sweeper 写成 LEASE_EXPIRED',
      hcRun.error_code !== 'LEASE_EXPIRED',
      `actual.error_code=${hcRun.error_code}`);
    check('approval-resume Run 进入 waiting_approval（hard-crash 接管）',
      hcRun.status === 'waiting_approval',
      `actual.status=${hcRun.status}`);
    check('hard-crash sweeper 报告 reclaimed >= 1',
      hcResult.reclaimed >= 1,
      `actual=${hcResult.reclaimed}`);
    check('hard-crash sweeper 报告 manualIntervention === 0',
      hcResult.manualIntervention === 0,
      `actual=${hcResult.manualIntervention}`);

    // 普通 Run 应被普通 sweeper 正确清理为 failed + LEASE_EXPIRED。
    const plainRunAfter = (await pool.query<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM agent_runs WHERE id = $1`,
      [plainRunId])).rows[0]!;
    check('普通无审批 Run 被普通 sweeper 写成 failed + LEASE_EXPIRED',
      plainRunAfter.status === 'failed' && plainRunAfter.error_code === 'LEASE_EXPIRED',
      `actual.status=${plainRunAfter.status}, actual.error_code=${plainRunAfter.error_code}`);
    check('普通 sweepExpiredLeases 至少返回 1 行',
      Array.isArray(plainResult) && plainResult.length >= 1,
      `actual=${JSON.stringify(plainResult)}`);
  }

  console.log(`\n[hard-crash-lease-recovery] Result: ${passed} passed, ${failed} failed`);
} catch (err) {
  originalError = err instanceof Error ? err : new Error(String(err));
  console.error('[hard-crash-lease-recovery] FAILED:', originalError);
  failed++;
} finally {
  _setMastraFacadeForTesting(null);
  _resetSystemResolverCacheForTesting();
  __resetTestPool();
  if (!poolEnded) {
    try { await pool.end(); } catch { /* ignore */ }
    poolEnded = true;
  }
  if (adminConnected) {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch (err) {
      console.error(`[hard-crash-lease-recovery] drop schema ${schema} failed:`, err);
    }
    try { await admin.end(); } catch { /* ignore */ }
  }
}

if (originalError) {
  process.exitCode = 1;
  process.stderr.write(`${originalError.stack ?? originalError.message}\n`);
} else if (failed > 0) {
  process.exitCode = 1;
}
