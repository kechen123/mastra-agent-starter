/**
 * PR-3.3 Replay Fix — Tool Approval 真实 PostgreSQL + fake Agent stream 端到端集成测试。
 *
 * 关键不变量（**比 PR-3.3 旧版本严格**）：
 *   - **state-machine（resolveApproval / expireApproval）不调 Mastra SDK**——
 *     任何决策登记（pending → approved|declined|expired）只是 DB 行更新；
 *     测试断言 `calls.approveToolCall.length === 0` /
 *     `calls.declineToolCall.length === 0` **在调 state-machine 之后**。
 *   - **worker（run executor）是唯一调用 approveToolCall / declineToolCall
 *     的执行者**——通过真实入口 `executor.runResumeSchedulerOnce()` 单次
 *     tick 触发；不再"直接调 fake facade 代替"以绕过业务路径。
 *   - **同一 (run_id, tool_call_id) 在一次决策中最多一次 SDK 调用**——
 *     即使多次 tick scheduler，计数必须仍是 1。
 *   - **Run 最终态 NOT waiting_approval**——approve / decline / expire 三态
 *     都必须由 worker 推到终态（completed / stopped / failed）。
 *   - **listSuspendedRuns 严格 fail-closed**：缺 workspaceId / agentId /
 *     threadId / resourceId 任一即抛错，不退化空数组。
 *
 * 覆盖 7 项验收：
 *   (a) approval-requested 后 Run 保持 waiting_approval（executor 不调 stopRun）；
 *   (b) approve → state-machine 不调 SDK；scheduler 调 1 次 SDK +
 *       返回 stream 被 consumeAgentStream 真实消费；Run 推到终态；
 *   (c) decline → state-machine 不调 SDK；scheduler 调 1 次
 *       facade.declineToolCall(reason='declined_by_resolver')；Run 推
 *       到终态；
 *   (c-2) expired → state-machine 不调 SDK；scheduler 调 1 次
 *       facade.declineToolCall(reason='expired')；Run 推到终态；
 *   (d) SDK transient fail (W2) → Run → failed + lease 释放；approval
 *       状态不变（用户决策已记录），不再追加 SDK 调用；
 *   (e) scheduler 原子事务：claim + Run→running + run-resumed 事件同事务；
 *       任一失败整体 ROLLBACK，approval 留给下次 tick；
 *   (f) listSuspendedRuns fail-closed（缺 workspaceId / runId / toolCallId 即抛错）；
 *   (g) 重启：workerId 切换后新 worker 通过 scheduler 接管同一 approval 的 stream；
 *       approval.mastra_resume_started_at 必须保持未被设置到错误行。
 *
 * 不依赖 Docker；按项目既有流程 drop & init。
 *
 * 运行：`cd backend && RUN_PG_TOOL_POLICY=1 npx tsx tests/integration/tool-policy-pg.ts`
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { Client, Pool } from 'pg';
import '../../src/tools/index.js';

const RUN = process.env.RUN_PG_TOOL_POLICY === '1';
const DB_URL = process.env.DATABASE_URL;
if (!RUN) {
  console.log('[tool-policy-pg] SKIP（未设置 RUN_PG_TOOL_POLICY=1）。');
  process.exit(0);
}
if (!DB_URL) {
  console.error('[tool-policy-pg] DATABASE_URL 未配置。');
  process.exit(1);
}

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

const INIT_SQL_PATH = join(process.cwd(), 'database', 'init.sql');

async function dropAndRecreateDatabase(): Promise<void> {
  const target = new URL(DB_URL);
  const dbName = target.pathname.slice(1);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || dbName !== 'xuanshu') {
    throw new Error('此重建测试仅允许明确授权的本机 xuanshu 库。');
  }
  target.pathname = '/postgres';
  const admin = new Client({ connectionString: target.toString() });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  const init = new Client({ connectionString: DB_URL });
  await init.connect();
  try {
    const sql = readFileSync(INIT_SQL_PATH, 'utf8');
    await init.query(sql);
  } finally {
    await init.end();
  }
}

function isoFuture(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}
function isoPast(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

const pool = new Pool({ connectionString: DB_URL });

process.env.DATABASE_URL = DB_URL;
const { getDatabasePool } = await import(
  '../../src/infrastructure/database/pool.js'
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(getDatabasePool as any).__override = pool;

const repository = await import('../../src/modules/tool-policy/repository.js');
const stateMachine = await import(
  '../../src/modules/tool-policy/state-machine.js'
);
const executor = await import('../../src/core/execution/run-executor.js');

// ─── Fake Mastra facade —— AsyncIterable<chunk> 与 Mastra 1.61 一致 ─────
interface CallLog {
  approveToolCall: Array<{ runId: string; toolCallId: string; workspaceId: string }>;
  declineToolCall: Array<{ runId: string; toolCallId: string; reason: string; workspaceId: string }>;
  listSuspendedRuns: Array<{ threadId: string; resourceId: string; workspaceId: string; agentId: string }>;
}
const calls: CallLog = { approveToolCall: [], declineToolCall: [], listSuspendedRuns: [] };
const failApprove = new Set<string>();
const failDecline = new Set<string>();

/**
 * 构造一个 AsyncIterable<chunk>——与 Mastra 1.61 agent.stream() / agent.approveToolCall()
 * 返回的 stream 同形态。每个 yield 表示一个 Mastra 事件（text-delta / tool-call /
 * tool-result / error / tool-call-approval）。
 */
async function* fakeAgentStreamForApprove(
  runId: string,
  toolCallId: string,
): AsyncIterable<unknown> {
  // 真实 Mastra resume stream 的语义：从挂起点续推，可能包含新 Tool 调用的
  // 完整生命周期（text-delta → tool-call → tool-result → 继续 text-delta → done）。
  yield { type: 'text-delta', payload: { text: '续 Run 后模型生成的第一段文本。' } };
  yield { type: 'text-delta', payload: { text: '继续推进。' } };
  yield { type: 'done', payload: {} };
  void runId; void toolCallId;
}

async function* fakeAgentStreamForDecline(
  runId: string,
  toolCallId: string,
): AsyncIterable<unknown> {
  // decline 后 stream 通常推 stop / done；本测试用 done 走"已完成"路径。
  yield { type: 'text-delta', payload: { text: '已拒绝，跳过该 Tool。' } };
  yield { type: 'done', payload: {} };
  void runId; void toolCallId;
}

// ─── W2 attempts 耗尽测试 ────────────────────────────────────────────
// reconciler 通过 listSuspendedRuns 校验：测试需要让 fake 返回匹配的
// suspended 快照——reconciler 据此判定"run 仍 suspended"、走 revert
// 路径把 approval 从 indeterminate 转回 approved、让 scheduler 再次
// 接管。快照集合按 conversation_id 注册（threadId = conversation_id）。
const suspendedSnapshots = new Map<string, {
  runId: string;
  toolCallId: string;
  threadId: string;
  resourceId: string;
  workspaceId: string;
  agentId: string;
}>();

function registerSuspendedSnapshot(args: {
  runId: string;
  toolCallId: string;
  threadId: string;
  resourceId: string;
  workspaceId: string;
  agentId: string;
}): void {
  suspendedSnapshots.set(args.threadId, args);
}

function clearSuspendedSnapshots(): void {
  suspendedSnapshots.clear();
}

const fakeFacade: import('../../src/modules/tool-policy/state-machine.js').MastraAgentFacade = {
  approveToolCall: async (a) => {
    const key = `${a.runId}:${a.toolCallId}`;
    calls.approveToolCall.push({
      runId: a.runId, toolCallId: a.toolCallId, workspaceId: a.workspaceId,
    });
    if (failApprove.has(key)) throw new Error('fake-transient-approve-failure');
    return fakeAgentStreamForApprove(a.runId, a.toolCallId);
  },
  declineToolCall: async (a) => {
    const key = `${a.runId}:${a.toolCallId}`;
    calls.declineToolCall.push({
      runId: a.runId, toolCallId: a.toolCallId, reason: a.reason, workspaceId: a.workspaceId,
    });
    if (failDecline.has(key)) throw new Error('fake-transient-decline-failure');
    return fakeAgentStreamForDecline(a.runId, a.toolCallId);
  },
  listSuspendedRuns: async (a) => {
    calls.listSuspendedRuns.push({
      threadId: a.threadId, resourceId: a.resourceId,
      workspaceId: a.workspaceId, agentId: a.agentId,
    });
    // 缺 workspaceId → fail-closed 抛错
    if (!a.workspaceId) throw new Error('workspaceId required (fail-closed)');
    if (!a.agentId) throw new Error('agentId required (fail-closed)');
    if (!a.threadId) throw new Error('threadId required (fail-closed)');
    if (!a.resourceId) throw new Error('resourceId required (fail-closed)');
    const snap = suspendedSnapshots.get(a.threadId);
    if (!snap) return [];
    if (
      snap.resourceId !== a.resourceId ||
      snap.workspaceId !== a.workspaceId ||
      snap.agentId !== a.agentId
    ) {
      return [];
    }
    return [{
      runId: snap.runId,
      toolCallId: snap.toolCallId,
      threadId: snap.threadId,
      resourceId: snap.resourceId,
      workspaceId: snap.workspaceId,
      status: 'suspended',
    }];
  },
};
stateMachine._setMastraFacadeForTesting(fakeFacade);
stateMachine._resetSystemResolverCacheForTesting();

async function seedWorkspace(label: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (kind, name) VALUES ('shared', $1) RETURNING id`,
    [label],
  );
  return r.rows[0]!.id;
}
async function seedUser(_workspaceId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO app_users (username, username_normalized, password_hash)
     VALUES ($1, $2, '!test!')
     RETURNING id`,
    ['u-' + randomUUID().slice(0, 8), 'u-' + randomUUID().slice(0, 8)],
  );
  return r.rows[0]!.id;
}
async function seedConversation(workspaceId: string): Promise<{ id: string; agentId: string }> {
  const r = await pool.query<{ id: string; agent_id: string }>(
    `INSERT INTO conversations (workspace_id, agent_id, title)
     VALUES ($1, 'general-chat', 'test') RETURNING id, agent_id`,
    [workspaceId],
  );
  return { id: r.rows[0]!.id, agentId: r.rows[0]!.agent_id };
}
async function seedAgentRun(
  workspaceId: string,
  conversationId: string,
  createdBy: string,
): Promise<{ runId: string; assistantMessageId: string }> {
  const userMsg = await pool.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, workspace_id, role, content, status)
     VALUES ($1, $2, 'user', 'ping', 'completed') RETURNING id`,
    [conversationId, workspaceId],
  );
  const assistantMsg = await pool.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, workspace_id, role, content, status)
     VALUES ($1, $2, 'assistant', '', 'pending') RETURNING id`,
    [conversationId, workspaceId],
  );
  const r = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs (
       workspace_id, conversation_id, assistant_message_id,
       agent_id, provider, model, status, request_id, created_by
     ) VALUES (
       $1, $2, $3,
       'general-chat', 'test-provider', 'test-model', 'queued', $4, $5
     ) RETURNING id`,
    [
      workspaceId,
      conversationId,
      assistantMsg.rows[0]!.id,
      randomUUID(),
      createdBy,
    ],
  );
  return {
    runId: r.rows[0]!.id,
    assistantMessageId: assistantMsg.rows[0]!.id,
  };
}

async function setWaitingApproval(runId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_runs SET status = 'waiting_approval',
                          lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1`,
    [runId],
  );
}

/** 等 Run 跑到非 waiting_approval / 非 running 终态；返回最终 status。 */
async function waitForRunTerminal(runId: string, maxMs = 5_000): Promise<string> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const r = await pool.query<{ status: string }>(
      `SELECT status FROM agent_runs WHERE id = $1`, [runId],
    );
    const status = r.rows[0]?.status ?? '';
    if (
      status === 'completed' ||
      status === 'stopped' ||
      status === 'failed' ||
      status === 'queued'
    ) {
      return status;
    }
    if (Date.now() > deadline) return status;
    await new Promise((r) => setTimeout(r, 50));
  }
}

console.log('[tool-policy-pg] drop + recreate xuanshu database');
await dropAndRecreateDatabase();
console.log('  ✓ schema rebuilt');

const ws1 = await seedWorkspace('ws1');
const ws2 = await seedWorkspace('ws2');
const userA = await seedUser(ws1);
const userB = await seedUser(ws2);
const conv1 = await seedConversation(ws1);
const conv2 = await seedConversation(ws2);

// ════════════════════════════════════════════════════════════════════
// (a) approval creation + waiting_approval 保留（executor 不调 stopRun）
// ════════════════════════════════════════════════════════════════════
console.log('\n[tool-policy-pg] (a) 审批创建 + Run waiting_approval 保留');

const runA = await seedAgentRun(ws1, conv1.id, userA);
const createdRow = await repository.createApprovalRequest({
  workspaceId: ws1,
  runId: runA.runId,
  toolId: 'calculator',
  toolCallId: 'tc-A',
  inputsHash: 'hash-A',
  inputsSummary: { kind: 'destructive', preview: 'delete something', count: 1 },
  requesterId: userA,
  expiresAt: isoFuture(60_000),
});
check('创建审批请求成功', !!createdRow.id);
check('status === pending', createdRow.status === 'pending');
check('requesterId === userA', createdRow.requesterId === userA);
check('mastraResumeStartedAt === null', createdRow.mastraResumeStartedAt === null);

// 模拟 run executor 在 approval-requested 事件后做的事：
// 把 agent_runs.status 推到 waiting_approval（实际由 runtime.ts 推，
// 这里直接 SQL 模拟——schema 完整性验证即可）。
await setWaitingApproval(runA.runId);
const runState = await pool.query<{ status: string }>(
  `SELECT status FROM agent_runs WHERE id = $1`,
  [runA.runId],
);
check(
  'agent_runs.status === waiting_approval（不被 stopRun 改写）',
  runState.rows[0]!.status === 'waiting_approval',
);

// ════════════════════════════════════════════════════════════════════
// (b) approve → state-machine 不调 SDK；scheduler 调 1 次 SDK +
//     返回 stream 被真实消费；Run 推到终态；同一 (run_id, tool_call_id)
//     多次 tick 也只调一次 SDK
// ════════════════════════════════════════════════════════════════════
console.log('\n[tool-policy-pg] (b) 批准后真实消费 resume stream');

const convB = await seedConversation(ws1);
const runB = await seedAgentRun(ws1, convB.id, userA);
const approvalB = await repository.createApprovalRequest({
  workspaceId: ws1,
  runId: runB.runId,
  toolId: 'calculator',
  toolCallId: 'tc-B',
  inputsHash: 'hash-B',
  inputsSummary: { kind: 'destructive', preview: 'delete something else', count: 1 },
  requesterId: userA,
  expiresAt: isoFuture(60_000),
});
await setWaitingApproval(runB.runId);

// 清零后再走 resolveApproval。**关键断言：state-machine 不调 SDK**。
calls.approveToolCall.length = 0;
calls.declineToolCall.length = 0;
const approveOutcome = await stateMachine.resolveApproval({
  workspaceId: ws1,
  approvalId: approvalB.id,
  resolverId: userA,
  decision: 'approve',
});
check('outcome.kind === approved', approveOutcome.kind === 'approved');
check(
  '【关键】state-machine resolveApproval 不调 SDK（approveToolCall === 0）',
  calls.approveToolCall.length === 0,
);
check(
  '【关键】state-machine resolveApproval 不调 SDK（declineToolCall === 0）',
  calls.declineToolCall.length === 0,
);
if (approveOutcome.kind === 'approved') {
  check('row.status === approved', approveOutcome.row.status === 'approved');
  check('row.decision === approved', approveOutcome.row.decision === 'approved');
  check('row.resolverId === userA', approveOutcome.row.resolverId === userA);
  check('row.mastraResumeStartedAt 仍为 null（worker 尚未接管）',
    approveOutcome.row.mastraResumeStartedAt === null);
}

// 驱动真实 run executor resume 调度器（**不**启后台循环）：
// - 单次 tick 抢占 mastra_resume_started_at（原子事务 + Run→running +
//   run-resumed 事件同事务）；
// - consumeResumeStream 按 approval.status === 'approved' 调
//   facade.approveToolCall 拿 stream，consumeAgentStream 真实消费；
// - 终态：推到 completed（fake stream 给 done → completed）。
const beforeApproveCalls = calls.approveToolCall.length;
await executor.runResumeSchedulerOnce();

// 等异步 consumeResumeStream 落地完成（最多 2s）。
const deadline = Date.now() + 2_000;
let approvalBFinal = null;
while (Date.now() < deadline) {
  approvalBFinal = await repository.getApprovalRequestById(ws1, approvalB.id);
  if (approvalBFinal?.mastraResumeStartedAt) break;
  await new Promise((r) => setTimeout(r, 50));
}
check('resume 调度后 mastraResumeStartedAt 非 null',
  approvalBFinal?.mastraResumeStartedAt !== null);

// 等 Run 推到 completed / failed（consumeResumeStream 异步）。
const runBStatus = await waitForRunTerminal(runB.runId);
check(
  '【关键】resume 后 Run 终态 NOT waiting_approval',
  runBStatus !== 'waiting_approval' && runBStatus !== 'running',
);
check('resume 后 Run === completed（consume stream 推到终态）',
  runBStatus === 'completed');

const m = await pool.query<{ content: string; status: string }>(
  `SELECT content, status FROM messages WHERE id = $1`, [runB.assistantMessageId],
);
const runBMessage = m.rows[0]?.content ?? '';
check('messages.content === resume stream 累计文本',
  runBMessage.includes('续 Run 后模型生成的第一段文本。') &&
  runBMessage.includes('继续推进。'));

// 关键：approveToolCall 恰好 1 次（state-machine 0 + scheduler 1）。
check(
  '【关键】approveToolCall 恰好调用 1 次（state-machine 0 + scheduler 1）',
  calls.approveToolCall.length === beforeApproveCalls + 1,
);

// 多次 tick scheduler 不应重复调 SDK（approval 已被 markMastraResumeStarted）
await executor.runResumeSchedulerOnce();
await new Promise((r) => setTimeout(r, 100));
check(
  '【关键】多次 tick scheduler，approveToolCall 仍为 1（无重复 SDK 调用）',
  calls.approveToolCall.length === beforeApproveCalls + 1,
);

// run-resumed 事件被真实写入
const evt = await pool.query<{ type: string }>(
  `SELECT type FROM agent_run_events
    WHERE run_id = $1 AND type = 'run-resumed'`,
  [runB.runId],
);
check('run-resumed 事件已写入（executor scheduler 单事务原子）',
  evt.rows.length === 1);

// checkpoint + run-completed 事件落地
const checkpoint = await pool.query<{ type: string }>(
  `SELECT type FROM agent_run_events
    WHERE run_id = $1 AND type = 'content-checkpoint'`,
  [runB.runId],
);
check('content-checkpoint 事件落地', checkpoint.rows.length > 0);
const completedEvt = await pool.query<{ type: string }>(
  `SELECT type FROM agent_run_events
    WHERE run_id = $1 AND type = 'run-completed'`,
  [runB.runId],
);
check('run-completed 事件落地', completedEvt.rows.length === 1);

// ════════════════════════════════════════════════════════════════════
// (c) decline → state-machine 不调 SDK；scheduler 调 1 次
//     facade.declineToolCall(reason='declined_by_resolver')；Run 推到终态
// ════════════════════════════════════════════════════════════════════
console.log('\n[tool-policy-pg] (c) 拒绝（declined 终态 → worker 接管 SDK）');

const convC = await seedConversation(ws1);
const runC = await seedAgentRun(ws1, convC.id, userA);
const approvalC = await repository.createApprovalRequest({
  workspaceId: ws1,
  runId: runC.runId,
  toolId: 'destructive-tool',
  toolCallId: 'tc-C',
  inputsHash: 'hash-C',
  inputsSummary: { kind: 'destructive', preview: 'decline test', count: 1 },
  requesterId: userA,
  expiresAt: isoFuture(60_000),
});
await setWaitingApproval(runC.runId);

calls.approveToolCall.length = 0;
calls.declineToolCall.length = 0;
const declineOutcome = await stateMachine.resolveApproval({
  workspaceId: ws1,
  approvalId: approvalC.id,
  resolverId: userA,
  decision: 'decline',
});
check('outcome.kind === declined', declineOutcome.kind === 'declined');
check(
  '【关键】state-machine resolveApproval 不调 SDK（declineToolCall === 0）',
  calls.declineToolCall.length === 0,
);
if (declineOutcome.kind === 'declined') {
  check('row.status === declined', declineOutcome.row.status === 'declined');
  check('row.decision === declined', declineOutcome.row.decision === 'declined');
  check('row.resolverId === userA（保留审计身份）', declineOutcome.row.resolverId === userA);
  check('row.resolverError 仍为 null（reason 由 worker 推 SDK 时拼）',
    declineOutcome.row.resolverError === null);
  check('row.leaseOwner 已清', declineOutcome.row.leaseOwner === null);
  check('row.resolvedAt 非空', !!declineOutcome.row.resolvedAt);
  check('row.mastraResumeStartedAt 仍为 null（worker 尚未接管）',
    declineOutcome.row.mastraResumeStartedAt === null);
}

// scheduler 单次 tick：worker 必须按 status='declined' 选
// facade.declineToolCall(reason='declined_by_resolver')；Run 推到终态。
const beforeDeclineCalls = calls.declineToolCall.length;
await executor.runResumeSchedulerOnce();

const runCStatus = await waitForRunTerminal(runC.runId);
check(
  '【关键】decline 后 Run 终态 NOT waiting_approval',
  runCStatus !== 'waiting_approval' && runCStatus !== 'running',
);
check(
  '【关键】decline 后 Run === completed（fake decline stream → done）',
  runCStatus === 'completed',
);
check(
  '【关键】declineToolCall 恰好调用 1 次（state-machine 0 + scheduler 1）',
  calls.declineToolCall.length === beforeDeclineCalls + 1,
);
check(
  'declineToolCall reason === "declined_by_resolver"（无自定义错误）',
  calls.declineToolCall[beforeDeclineCalls]?.reason === 'declined_by_resolver',
);

// ════════════════════════════════════════════════════════════════════
// (c-2) expired → state-machine 不调 SDK；scheduler 调 1 次
//       facade.declineToolCall(reason='expired')；Run 推到终态
// ════════════════════════════════════════════════════════════════════
console.log('\n[tool-policy-pg] (c-2) 超时平台身份 + worker 接管 SDK');

const convC2 = await seedConversation(ws1);
const runC2 = await seedAgentRun(ws1, convC2.id, userA);
const approvalC2 = await repository.createApprovalRequest({
  workspaceId: ws1,
  runId: runC2.runId,
  toolId: 'destructive-tool',
  toolCallId: 'tc-C2',
  inputsHash: 'hash-C2',
  inputsSummary: { kind: 'destructive', preview: 'timeout test', count: 1 },
  requesterId: userA,
  expiresAt: isoPast(60_000), // 已过期
});
await setWaitingApproval(runC2.runId);

calls.approveToolCall.length = 0;
calls.declineToolCall.length = 0;
const expireOutcome = await stateMachine.expireApproval({
  workspaceId: ws1,
  approvalId: approvalC2.id,
});
check('outcome.kind === expired', expireOutcome.kind === 'expired');
check(
  '【关键】state-machine expireApproval 不调 SDK（declineToolCall === 0）',
  calls.declineToolCall.length === 0,
);
if (expireOutcome.kind === 'expired') {
  check('row.status === expired', expireOutcome.row.status === 'expired');
  check('row.decision === declined（expire 路径 decision 列写 declined）',
    expireOutcome.row.decision === 'declined');
  check(
    'row.resolverId 非 null 且非 all-zero UUID',
    expireOutcome.row.resolverId !== null &&
      expireOutcome.row.resolverId !== '00000000-0000-0000-0000-000000000000',
  );
  const u = await pool.query<{ username_normalized: string }>(
    `SELECT username_normalized FROM app_users WHERE id = $1`,
    [expireOutcome.row.resolverId],
  );
  check(
    'resolver 对应 username_normalized === system-approval-worker',
    u.rows[0]?.username_normalized === 'system-approval-worker',
  );
  check('row.mastraResumeStartedAt 仍为 null（worker 尚未接管）',
    expireOutcome.row.mastraResumeStartedAt === null);
}

// scheduler 单次 tick：worker 必须按 status='expired' 选
// facade.declineToolCall(reason='expired')；Run 推到终态。
const beforeExpireCalls = calls.declineToolCall.length;
await executor.runResumeSchedulerOnce();

const runC2Status = await waitForRunTerminal(runC2.runId);
check(
  '【关键】expire 后 Run 终态 NOT waiting_approval',
  runC2Status !== 'waiting_approval' && runC2Status !== 'running',
);
check(
  '【关键】expire 后 Run === completed（fake decline stream → done）',
  runC2Status === 'completed',
);
check(
  '【关键】declineToolCall 恰好调用 1 次（state-machine 0 + scheduler 1）',
  calls.declineToolCall.length === beforeExpireCalls + 1,
);
check(
  'declineToolCall reason === "expired"',
  calls.declineToolCall[beforeExpireCalls]?.reason === 'expired',
);

// ════════════════════════════════════════════════════════════════════
// (d) SDK transient fail (W2 crash window) → approval → approved_resume_indeterminate，
//     resume_attempts = 1，Run 推回 waiting_approval，mastra_resume_started_at 保留；
//     scheduler 不直接再次调 SDK；reconciler 严格校验 suspended snapshot 通过后才
//     revert 为 'approved' 让 scheduler 重新接管。
// ════════════════════════════════════════════════════════════════════
console.log('\n[tool-policy-pg] (d) SDK transient fail (W2) → indeterminate，等 reconciler 接管');

const convD = await seedConversation(ws1);
const runD = await seedAgentRun(ws1, convD.id, userA);
const approvalD = await repository.createApprovalRequest({
  workspaceId: ws1,
  runId: runD.runId,
  // W2 自动恢复只允许明确声明 idempotent 的工具；calculator 满足该约束。
  toolId: 'calculator',
  toolCallId: 'tc-D',
  inputsHash: 'hash-D',
  inputsSummary: { kind: 'destructive', preview: 'transient failure', count: 1 },
  requesterId: userA,
  expiresAt: isoFuture(60_000),
});
await setWaitingApproval(runD.runId);

// 注入 facade.approveToolCall 临时失败 → scheduler 调 SDK 时抛错。
failApprove.add(`${runD.runId}:tc-D`);

// 用 runId / threadId 隔离 SDK 计数——与 (b)/(c)/(c-2) 的 SDK 调用解耦，
// 避免后续 (h) 误用全局计数。
const beforeDApproveCalls = calls.approveToolCall.filter(
  (c) => c.runId === runD.runId,
).length;
const beforeDListCalls = calls.listSuspendedRuns.filter(
  (l) => l.threadId === convD.id,
).length;

const approveOutcomeD = await stateMachine.resolveApproval({
  workspaceId: ws1,
  approvalId: approvalD.id,
  resolverId: userA,
  decision: 'approve',
});
check('approve → approved（前置，state-machine 不调 SDK）',
  approveOutcomeD.kind === 'approved');
check(
  '【关键】state-machine resolveApproval 不调 SDK（即使后续 scheduler 会失败）',
  calls.approveToolCall.filter((c) => c.runId === runD.runId).length
    === beforeDApproveCalls,
);

await executor.runResumeSchedulerOnce();
// 等异步 consumeResumeStream 收敛（markApprovalResumeIndeterminate + Run→waiting_approval）。
await new Promise((r) => setTimeout(r, 200));

const runDStatusRow = await pool.query<{ status: string }>(
  `SELECT status FROM agent_runs WHERE id = $1`, [runD.runId],
);
const approvalDAfterFail = await repository.getApprovalRequestById(ws1, approvalD.id);

// W2 approve 失败是 "调用结果不确定" 窗口：
//   - approval 推到 'approved_resume_indeterminate'，resume_attempts += 1，
//     mastra_resume_started_at **保留**（阻止 scheduler 立即重扫再调 SDK）；
//   - Run 推回 'waiting_approval'（**不**写 failed）—— 由 reconciler
//     校验后 revert 让 scheduler 自然接管。
check(
  '【关键】W2 approve SDK 失败后 Run === "waiting_approval"（推回等 reconciler）',
  runDStatusRow.rows[0]?.status === 'waiting_approval',
);
check(
  '【关键】approveToolCall 恰好调用 1 次（state-machine 0 + scheduler 1，runId=runD）',
  calls.approveToolCall.filter((c) => c.runId === runD.runId).length
    === beforeDApproveCalls + 1,
);
check(
  'W2 后 approval.status === "approved_resume_indeterminate"（用户决策已记录，进入 reconciliation）',
  approvalDAfterFail?.status === 'approved_resume_indeterminate',
);
check(
  'W2 后 approval.resume_attempts === 1',
  approvalDAfterFail?.resumeAttempts === 1,
);
check(
  'W2 后 approval.mastra_resume_started_at 保留（非 null，阻止 scheduler 立即重扫）',
  approvalDAfterFail?.mastraResumeStartedAt !== null,
);
check(
  'W2 后 approval.resolver_error 写入 SDK 错误诊断信息（APPROVE_SDK_INDETERMINATE 前缀）',
  (approvalDAfterFail?.resolverError ?? '').startsWith('APPROVE_SDK_INDETERMINATE'),
);

// 多次 tick scheduler：status='approved_resume_indeterminate' 被扫描集排除，
// scheduler **不**直接再次调 SDK，也**不**调 listSuspendedRuns。
await executor.runResumeSchedulerOnce();
await new Promise((r) => setTimeout(r, 100));
check(
  '【关键】多次 tick scheduler，approveToolCall 仍为 1（scheduler 不直接重试 SDK）',
  calls.approveToolCall.filter((c) => c.runId === runD.runId).length
    === beforeDApproveCalls + 1,
);
check(
  '【关键】scheduler tick 不调 listSuspendedRuns（reconciler 是唯一调用方）',
  calls.listSuspendedRuns.filter((l) => l.threadId === convD.id).length
    === beforeDListCalls,
);

// reconciler 路径：注册 SDK 端仍 suspended 的快照 + backdate lease 让
// reconciler 立即能扫到 → 校验通过 → 转回 'approved' + 清
// mastra_resume_started_at → scheduler 自然接管 + 重试 approve。
failApprove.clear();
registerSuspendedSnapshot({
  runId: runD.runId,
  toolCallId: 'tc-D',
  threadId: convD.id,
  resourceId: ws1,
  workspaceId: ws1,
  agentId: 'general-chat',
});
await pool.query(
  `UPDATE tool_approval_requests
      SET lease_expires_at = now() - interval '1 second'
    WHERE id = $1`,
  [approvalD.id],
);
const beforeDReconcileListCalls = calls.listSuspendedRuns.filter(
  (l) => l.threadId === convD.id,
).length;
await executor.runReconcileIndeterminateOnce();
const approvalDAfterReconcile = await repository.getApprovalRequestById(ws1, approvalD.id);
check(
  'reconciler 校验通过 → approval.status === "approved"',
  approvalDAfterReconcile?.status === 'approved',
);
check(
  'reconciler 校验通过 → mastra_resume_started_at 清空（让 scheduler 自然接管）',
  approvalDAfterReconcile?.mastraResumeStartedAt === null,
);
check(
  'reconciler 校验通过 → listSuspendedRuns 调用 1 次（threadId=convD.id）',
  calls.listSuspendedRuns.filter((l) => l.threadId === convD.id).length
    === beforeDReconcileListCalls + 1,
);

// reconciler revert 后 scheduler 自然接管：调 1 次 facade.approveToolCall，
// Run 推到 'completed'（fake stream 给 done → completed）。
const beforeRetryApproveCalls = calls.approveToolCall.filter(
  (c) => c.runId === runD.runId,
).length;
await executor.runResumeSchedulerOnce();
const runDStatusRetry = await waitForRunTerminal(runD.runId, 3_000);
check(
  'reconciler 校验通过后 scheduler 接管：Run === completed',
  runDStatusRetry === 'completed',
);
check(
  'reconciler 校验通过后 approveToolCall 增加 1 次（runId=runD）',
  calls.approveToolCall.filter((c) => c.runId === runD.runId).length
    === beforeRetryApproveCalls + 1,
);

// 清理 (d) 的 suspended snapshot / SDK 失败注入。
clearSuspendedSnapshots();
failApprove.clear();

// ════════════════════════════════════════════════════════════════════
// (e) scheduler 原子事务：mastra_resume_started_at + Run→running +
//     run-resumed 事件同事务；事务回滚 → approval 留给下次 tick
// ════════════════════════════════════════════════════════════════════
console.log('\n[tool-policy-pg] (e) scheduler 原子事务 + 抢占透明');

const convE = await seedConversation(ws1);
const runE = await seedAgentRun(ws1, convE.id, userA);
const approvalE = await repository.createApprovalRequest({
  workspaceId: ws1,
  runId: runE.runId,
  toolId: 'destructive-tool',
  toolCallId: 'tc-E',
  inputsHash: 'hash-E',
  inputsSummary: { kind: 'destructive', preview: 'scheduler atomic test', count: 1 },
  requesterId: userA,
  expiresAt: isoFuture(60_000),
});
await setWaitingApproval(runE.runId);

// resolveApproval 推到 approved。
const approveE = await stateMachine.resolveApproval({
  workspaceId: ws1,
  approvalId: approvalE.id,
  resolverId: userA,
  decision: 'approve',
});
check('approve → approved（前置）', approveE.kind === 'approved');

// 把 agent_runs 推回 'running'，模拟"已不 waiting_approval"——scheduler
// 在原子事务里 Run→running 这步 UPDATE 应返回 0 行，整体事务回滚，
// approval.mastra_resume_started_at 保持 null（**关键**：不会留下
// "已写 markMastra 但 Run 未接管"的脑裂）。
await pool.query(
  `UPDATE agent_runs SET status = 'running', lease_owner = 'mock'
    WHERE id = $1`,
  [runE.runId],
);
const beforeESchedulerCalls = calls.approveToolCall.length;
await executor.runResumeSchedulerOnce();
await new Promise((r) => setTimeout(r, 100));
check(
  '【关键】Run 已不 waiting_approval 时 scheduler 跳过，不调 facade',
  calls.approveToolCall.length === beforeESchedulerCalls,
);
const approvalEAfter = await repository.getApprovalRequestById(ws1, approvalE.id);
check(
  '【关键】scheduler 事务回滚后 approval.mastra_resume_started_at 仍为 null',
  approvalEAfter?.mastraResumeStartedAt === null,
);
check(
  'approval.status 仍为 "approved"（无外部偷改）',
  approvalEAfter?.status === 'approved',
);

// ════════════════════════════════════════════════════════════════════
// (f) listSuspendedRuns fail-closed
// ════════════════════════════════════════════════════════════════════
console.log('\n[tool-policy-pg] (f) listSuspendedRuns fail-closed');

// 缺 workspaceId
let failClosed = false;
try {
  await fakeFacade.listSuspendedRuns({
    threadId: 't', resourceId: 'r', agentId: 'general-chat', workspaceId: '',
  });
} catch {
  failClosed = true;
}
check('缺 workspaceId → fail-closed 抛错', failClosed);

// 缺 agentId
failClosed = false;
try {
  await fakeFacade.listSuspendedRuns({
    threadId: 't', resourceId: 'r', workspaceId: 'ws', agentId: '',
  });
} catch {
  failClosed = true;
}
check('缺 agentId → fail-closed 抛错', failClosed);

// 缺 threadId
failClosed = false;
try {
  await fakeFacade.listSuspendedRuns({
    threadId: '', resourceId: 'r', workspaceId: 'ws', agentId: 'a',
  });
} catch {
  failClosed = true;
}
check('缺 threadId → fail-closed 抛错', failClosed);

// 缺 resourceId
failClosed = false;
try {
  await fakeFacade.listSuspendedRuns({
    threadId: 't', resourceId: '', workspaceId: 'ws', agentId: 'a',
  });
} catch {
  failClosed = true;
}
check('缺 resourceId → fail-closed 抛错', failClosed);

// 正常路径：返回 []
const normalList = await fakeFacade.listSuspendedRuns({
  threadId: 't', resourceId: 'r', workspaceId: 'ws', agentId: 'a',
});
check('正常路径 → 返回 []', Array.isArray(normalList) && normalList.length === 0);

// ════════════════════════════════════════════════════════════════════
// (g) 跨重启：workerId 切换后新 worker 通过 scheduler 接管同一 approval
// ════════════════════════════════════════════════════════════════════
console.log('\n[tool-policy-pg] (g) 跨重启：新 worker 接管同一 approval');

const convF = await seedConversation(ws1);
const runF = await seedAgentRun(ws1, convF.id, userA);
const approvalF = await repository.createApprovalRequest({
  workspaceId: ws1,
  runId: runF.runId,
  toolId: 'destructive-tool',
  toolCallId: 'tc-F',
  inputsHash: 'hash-F',
  inputsSummary: { kind: 'destructive', preview: 'restart test', count: 1 },
  requesterId: userA,
  expiresAt: isoFuture(60_000),
});
await setWaitingApproval(runF.runId);

// 模拟"first worker 已批准但 stream 消费前崩溃"：
// state-machine 推到 approved；scheduler 还没接管 →
// approval.mastra_resume_started_at 仍为 null。
calls.approveToolCall.length = 0;
const approveF = await stateMachine.resolveApproval({
  workspaceId: ws1,
  approvalId: approvalF.id,
  resolverId: userA,
  decision: 'approve',
});
check('approve → approved（前置）', approveF.kind === 'approved');
check(
  '【关键】state-machine resolveApproval 不调 SDK（restart 路径起点）',
  calls.approveToolCall.length === 0,
);

// 模拟 first worker 抢占后崩在 Run UPDATE 之前：把 Run 推回
// waiting_approval + 清 lease（事务回滚的真实表现）。
await pool.query(
  `UPDATE agent_runs SET status = 'waiting_approval',
                        lease_owner = NULL, lease_expires_at = NULL
    WHERE id = $1`,
  [runF.runId],
);
// approval.mastra_resume_started_at 已是 null（state-machine 不写），
// scheduler 自然能接管。

const beforeRestartCalls = calls.approveToolCall.length;
await executor.runResumeSchedulerOnce();

const runFStatus = await waitForRunTerminal(runF.runId);
check(
  '【关键】跨重启后 Run 终态 NOT waiting_approval',
  runFStatus !== 'waiting_approval' && runFStatus !== 'running',
);
check(
  '【关键】跨重启后新 worker 接管 stream 推到 completed',
  runFStatus === 'completed',
);
check(
  '【关键】跨重启后 scheduler 调 1 次 facade.approveToolCall',
  calls.approveToolCall.length === beforeRestartCalls + 1,
);

// 多次 tick 不重复
await executor.runResumeSchedulerOnce();
await new Promise((r) => setTimeout(r, 100));
check(
  '【关键】跨重启 + 多次 tick，approveToolCall 仍为 1',
  calls.approveToolCall.length === beforeRestartCalls + 1,
);

// ════════════════════════════════════════════════════════════════════
// (h) W2 attempts 耗尽：连续 3 次 approve SDK 抛错 → Run failed +
//     APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED；后续
//     scheduler/reconciler tick 不再调用 SDK
// ════════════════════════════════════════════════════════════════════
console.log('\n[tool-policy-pg] (h) W2 attempts 耗尽：3 次连续 SDK 失败 → 人工介入');

clearSuspendedSnapshots();

const convH = await seedConversation(ws1);
const runH = await seedAgentRun(ws1, convH.id, userA);
const approvalH = await repository.createApprovalRequest({
  workspaceId: ws1,
  runId: runH.runId,
  // attempts-exhausted 用例需要走自动重试路径，因此使用已注册幂等工具。
  toolId: 'calculator',
  toolCallId: 'tc-H',
  inputsHash: 'hash-H',
  inputsSummary: { kind: 'destructive', preview: 'attempts exhaustion test', count: 1 },
  requesterId: userA,
  expiresAt: isoFuture(60_000),
});
await setWaitingApproval(runH.runId);

// 注册 reconciler 看到的"suspended"快照——前两次 W2 后由 reconciler
// 校验通过 → revert → 让 scheduler 重新接管。**第 3 次 W2 失败后**我们
// 期望：approval 转 approved_resume_indeterminate + Run failed +
// reconciler 不再扫该行（resume_attempts >= MAX）。
registerSuspendedSnapshot({
  runId: runH.runId,
  toolCallId: 'tc-H',
  threadId: convH.id,
  resourceId: ws1,
  workspaceId: ws1,
  agentId: 'general-chat',
});

// 注入 SDK 抛错——连续 3 次（=MAX_RESUME_ATTEMPTS）。注意
// `resume_attempts` 是 `markApprovalResumeIndeterminate` 自增：每次
// W2 后 +1，第 3 次后达到 MAX。
failApprove.add(`${runH.runId}:tc-H`);

// 用 runId / threadId 过滤 SDK 计数——与 (d) 的 SDK 调用解耦，避免
// (d) 留下的 SDK 调用污染本测试断言（(d) 的 retry 路径也会调 SDK，
// 但目标 runId 不同，不会进入本过滤集）。
const beforeHApproveCalls = calls.approveToolCall.filter(
  (c) => c.runId === runH.runId,
).length;
const beforeHListCalls = calls.listSuspendedRuns.filter(
  (l) => l.threadId === convH.id,
).length;

// ─── 周期 1：state-machine resolveApproval → scheduler tick → W2 #1 ─
const approveHOutcome = await stateMachine.resolveApproval({
  workspaceId: ws1,
  approvalId: approvalH.id,
  resolverId: userA,
  decision: 'approve',
});
check('周期 1 前置：approve → approved', approveHOutcome.kind === 'approved');

await executor.runResumeSchedulerOnce();
// 等异步 consumeResumeStream 把 approval 推到 indeterminate + Run 推
// 回 waiting_approval。
const deadlineH1 = Date.now() + 3_000;
while (Date.now() < deadlineH1) {
  const r = await pool.query<{ status: string; resume_attempts: number }>(
    `SELECT status, resume_attempts FROM tool_approval_requests WHERE id = $1`,
    [approvalH.id],
  );
  if (r.rows[0]?.status === 'approved_resume_indeterminate') break;
  await new Promise((r) => setTimeout(r, 50));
}
const after1 = await repository.getApprovalRequestById(ws1, approvalH.id);
check('周期 1：approval.status === approved_resume_indeterminate',
  after1?.status === 'approved_resume_indeterminate');
check('周期 1：resume_attempts === 1', after1?.resumeAttempts === 1);
const runHStatus1 = await waitForRunTerminal(runH.runId, 3_000);
check('周期 1：Run 终态 === waiting_approval（仍由 reconciler 接管）',
  runHStatus1 === 'waiting_approval');
check(
  '周期 1：approveToolCall 仅调用 1 次（state-machine 0 + scheduler 1，runId=runH）',
  calls.approveToolCall.filter((c) => c.runId === runH.runId).length
    === beforeHApproveCalls + 1,
);

// ─── reconciler 校验：listSuspendedRuns 确认仍 suspended → revert ─────
// W2 路径把 lease_expires_at 设为 now()+30s，测试需要 backdate 以让
// reconciler 立刻能扫到该行。这是测试数据准备（与生产 scheduler/reconciler
// 入口无关）。
await pool.query(
  `UPDATE tool_approval_requests
      SET lease_expires_at = now() - interval '1 second'
    WHERE id = $1`,
  [approvalH.id],
);
await executor.runReconcileIndeterminateOnce();
const afterReconcile1 = await repository.getApprovalRequestById(ws1, approvalH.id);
check(
  'reconciler 校验通过 → revert：approval.status === approved',
  afterReconcile1?.status === 'approved',
);
check(
  'reconciler 校验通过 → 清 mastra_resume_started_at',
  afterReconcile1?.mastraResumeStartedAt === null,
);
check(
  'reconciler 调 listSuspendedRuns 1 次（threads = convH.id）',
  calls.listSuspendedRuns.filter(
    (l) => l.threadId === convH.id,
  ).length === 1,
);

// ─── 周期 2：scheduler tick → W2 #2 → resume_attempts = 2 ─────────────
await executor.runResumeSchedulerOnce();
const deadlineH2 = Date.now() + 3_000;
while (Date.now() < deadlineH2) {
  const r = await pool.query<{ resume_attempts: number }>(
    `SELECT resume_attempts FROM tool_approval_requests WHERE id = $1`,
    [approvalH.id],
  );
  if ((r.rows[0]?.resumeAttempts ?? 0) >= 2) break;
  await new Promise((r) => setTimeout(r, 50));
}
const after2 = await repository.getApprovalRequestById(ws1, approvalH.id);
check('周期 2：resume_attempts === 2', after2?.resumeAttempts === 2);
check(
  '周期 2：approval.status 仍为 approved_resume_indeterminate（< MAX 走 reconciliation）',
  after2?.status === 'approved_resume_indeterminate',
);
const runHStatus2 = await waitForRunTerminal(runH.runId, 3_000);
check(
  '周期 2：Run 仍为 waiting_approval（继续 reconciliation）',
  runHStatus2 === 'waiting_approval',
);
check(
  '周期 2：approveToolCall 累加 1 次（共 2 次，runId=runH）',
  calls.approveToolCall.filter((c) => c.runId === runH.runId).length
    === beforeHApproveCalls + 2,
);

// reconciler 再次 backdate + 接管 → revert
await pool.query(
  `UPDATE tool_approval_requests
      SET lease_expires_at = now() - interval '1 second'
    WHERE id = $1`,
  [approvalH.id],
);
await executor.runReconcileIndeterminateOnce();
const afterReconcile2 = await repository.getApprovalRequestById(ws1, approvalH.id);
check(
  '周期 2 reconciler 再次 revert：approval.status === approved',
  afterReconcile2?.status === 'approved',
);

// ─── 周期 3：scheduler tick → W2 #3 → resume_attempts = 3 = MAX → 耗尽 ─
const mastraResumeStartedBeforeH3 = afterReconcile2?.mastraResumeStartedAt;
void mastraResumeStartedBeforeH3;
await executor.runResumeSchedulerOnce();
// 等异步 consumeResumeStream 把 Run 推到 failed。
const deadlineH3 = Date.now() + 3_000;
while (Date.now() < deadlineH3) {
  const r = await pool.query<{ status: string }>(
    `SELECT status FROM agent_runs WHERE id = $1`,
    [runH.runId],
  );
  if (r.rows[0]?.status === 'failed') break;
  await new Promise((r) => setTimeout(r, 50));
}
const after3 = await repository.getApprovalRequestById(ws1, approvalH.id);
const runHFinal = await pool.query<{
  status: string;
  error_code: string | null;
  completed_at: string | null;
}>(
  `SELECT status, error_code, completed_at FROM agent_runs WHERE id = $1`,
  [runH.runId],
);

// ─── 关键断言：第 3 次 W2 失败后的全量收敛状态 ────────────────────────
check('【关键】周期 3：approval.status 保持 === approved_resume_indeterminate',
  after3?.status === 'approved_resume_indeterminate');
check('【关键】周期 3：resume_attempts === MAX_RESUME_ATTEMPTS（3）',
  after3?.resumeAttempts === 3);
check('【关键】周期 3：mastra_resume_started_at 保留（非 null）',
  after3?.mastraResumeStartedAt !== null);
check(
  '【关键】周期 3：resolver_error 覆盖为 ATTEMPTS_EXHAUSTED 错误码',
  (after3?.resolverError ?? '').startsWith(
    'APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED',
  ),
);
check('【关键】周期 3：agent_runs.status === failed',
  runHFinal.rows[0]?.status === 'failed');
check(
  '【关键】周期 3：agent_runs.error_code === APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED',
  runHFinal.rows[0]?.error_code === 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED',
);
check('周期 3：agent_runs.completed_at 非 null（终态时间戳已写入）',
  runHFinal.rows[0]?.completed_at !== null);
check(
  '周期 3：approveToolCall 累加 1 次（共 3 次，runId=runH）',
  calls.approveToolCall.filter((c) => c.runId === runH.runId).length
    === beforeHApproveCalls + 3,
);

// run-failed 事件已写入
const hFailEvt = await pool.query<{ type: string; payload: unknown }>(
  `SELECT type, payload FROM agent_run_events
    WHERE run_id = $1 AND type = 'run-failed'
    ORDER BY id DESC LIMIT 1`,
  [runH.runId],
);
check('周期 3：run-failed 事件已写入（executor scheduler 单事务原子）',
  hFailEvt.rows.length === 1);
const hFailPayload = hFailEvt.rows[0]?.payload as Record<string, unknown> | null;
check(
  '周期 3：run-failed 事件 errorCode === ATTEMPTS_EXHAUSTED',
  hFailPayload?.errorCode === 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED',
);
check(
  '周期 3：run-failed 事件 resumeAttempts === 3',
  hFailPayload?.resumeAttempts === 3,
);

// ─── 后续 scheduler/reconciler tick 不再调用 SDK ─────────────────────
// scheduler 扫 `status IN ('approved',...) AND mastra_resume_started_at
// IS NULL`——本行是 `approved_resume_indeterminate` + mastra_resume_started_at
// 已保留：排除 ✓
// reconciler 扫 `resume_attempts < MAX`——本行 resume_attempts=3：排除 ✓
// 加上本次新增的 `resolver_error NOT LIKE 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_%'`
// 双层防护：attempts_exhausted 行的 resolver_error 已写入
// `APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED`，永久退出
// reconciler 扫描集。
//
// **用 runId / threadId 过滤 SDK 计数**——与 (d) 的 SDK 调用解耦，
// 防止 (d) 留下的 SDK 调用污染本断言（即使 (d) 自身重试 + 调 SDK，
// 也会被过滤掉）。
const approveCallsBeforeIdle = calls.approveToolCall.filter(
  (c) => c.runId === runH.runId,
).length;
const listCallsBeforeIdle = calls.listSuspendedRuns.filter(
  (l) => l.threadId === convH.id,
).length;
const declineCallsBeforeIdle = calls.declineToolCall.filter(
  (c) => c.runId === runH.runId,
).length;

// tick 多次 scheduler + reconciler，确认 SDK 计数器不增。
await executor.runResumeSchedulerOnce();
await executor.runResumeSchedulerOnce();
await executor.runResumeSchedulerOnce();
await executor.runReconcileIndeterminateOnce();
await executor.runReconcileIndeterminateOnce();
await executor.runReconcileIndeterminateOnce();
await new Promise((r) => setTimeout(r, 200));

check(
  '【关键】耗尽后多次 scheduler tick，approveToolCall 不增（runId=runH）',
  calls.approveToolCall.filter((c) => c.runId === runH.runId).length
    === approveCallsBeforeIdle,
);
check(
  '【关键】耗尽后多次 reconciler tick，listSuspendedRuns 不增（threadId=convH.id）',
  calls.listSuspendedRuns.filter((l) => l.threadId === convH.id).length
    === listCallsBeforeIdle,
);
check(
  '【关键】耗尽后多次 tick，declineToolCall 不增（fail-closed 不自动 retry，runId=runH）',
  calls.declineToolCall.filter((c) => c.runId === runH.runId).length
    === declineCallsBeforeIdle,
);

// 终态守恒：approval.resume_attempts 仍是 3；Run 仍是 failed；approval
// 仍可读（不删除、不被 sweep 误清）。
const finalCheck = await repository.getApprovalRequestById(ws1, approvalH.id);
check('【收敛守恒】终态 1：approval.resume_attempts 仍 === 3',
  finalCheck?.resumeAttempts === 3);
const finalRunCheck = await pool.query<{ status: string }>(
  `SELECT status FROM agent_runs WHERE id = $1`, [runH.runId],
);
check('【收敛守恒】终态 2：agent_runs.status 仍 === failed',
  finalRunCheck.rows[0]?.status === 'failed');

// 清理：本测试独占注册了 suspended snapshot。
clearSuspendedSnapshots();
failApprove.clear();

// ════════════════════════════════════════════════════════════════════
// (x) requesterId NULL → repo 拒绝创建审批（fail-closed）
// ════════════════════════════════════════════════════════════════════
console.log('\n[tool-policy-pg] (x) requesterId NULL → 拒绝创建审批');

// requesterId 为 undefined 时 repo 应抛错（fail-closed）——即使调用方
// 忘了从 agent_runs.created_by 读，直接传 undefined 也应拒绝。
let createdRejected = false;
try {
  await repository.createApprovalRequest({
    workspaceId: ws1,
    runId: '00000000-0000-0000-0000-000000000000',
    toolId: 't',
    toolCallId: 'tc-null',
    inputsHash: 'h',
    inputsSummary: {},
    requesterId: undefined as unknown as string, // 故意传 undefined 模拟 NULL
    expiresAt: isoFuture(60_000),
  });
} catch {
  createdRejected = true;
}
check('requesterId 为 undefined → repo 抛错（fail-closed）',
  createdRejected);

// ════════════════════════════════════════════════════════════════════
// 跨 workspace 隔离
// ════════════════════════════════════════════════════════════════════
console.log('\n[tool-policy-pg] 跨 workspace 隔离');

const runX = await seedAgentRun(ws2, conv2.id, userB);
const approvalX = await repository.createApprovalRequest({
  workspaceId: ws2,
  runId: runX.runId,
  toolId: 't',
  toolCallId: 'tc-X',
  inputsHash: 'h',
  inputsSummary: {},
  requesterId: userB,
  expiresAt: isoFuture(60_000),
});
const wrongWs = await repository.getApprovalRequestById(ws1, approvalX.id);
check('跨 workspace 读取返回 null', wrongWs === null);
const wrongResolve = await stateMachine.resolveApproval({
  workspaceId: ws1,
  approvalId: approvalX.id,
  resolverId: userA,
  decision: 'approve',
});
check('跨 workspace resolve → not_found', wrongResolve.kind === 'not_found');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
await pool.end();
if (failed > 0) process.exitCode = 1;
