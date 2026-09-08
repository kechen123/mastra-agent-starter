/**
 * PR-3.3.2 — 多进程 resume SDK facade 竞争测试（父驱动）。
 *
 * 目标：验证两个独立 Node 进程同时尝试接管同一 approval 时：
 *   1. `approveToolCall` 在两个子进程内**总计**只调用 1 次（原子
 *      `UPDATE ... WHERE mastra_resume_started_at IS NULL` 兜底）；
 *   2. `run-resumed` 事件**只**被写 1 条；
 *   3. Run 收敛到 `completed`；
 *   4. `messages.content` 只写入一次正确结果（来自赢者 child 的
 *      `text-from-<child>` 文本），不会因另一 child 失败而错乱；
 *   5. 第二个进程不会重复消费 stream（输家 child 看到
 *      `mastra_resume_started_at IS NOT NULL` → UPDATE 0 行 → skip）；
 *   6. 两个子进程都正常 exit 0，无 unhandled rejection。
 *
 * 进程模型：
 *   - 父进程（本文件）创建临时 schema（`multi_process_<uuid>`）+ init.sql
 *     + `sdk_call_log` 测试表；预 seed 一个 `approved` approval；
 *   - 通过 IPC `fork` 启 2 个子进程（`multi-process-resume-child.ts`）；
 *   - 两个子进程各自拥有独立 pid → 独立 `WORKER_ID`；
 *   - 父进程等两边都 `ready` → 同时 `send('START')`；
 *   - 子进程同步调 `runResumeSchedulerOnce` → 等 Run 终态 → exit 0；
 *   - 父进程回收 sdk_call_log / agent_run_events / messages 状态断言。
 *
 * 资源生命周期（**最外层 try/finally**）：
 *   - 任一阶段失败（schema 创建 / seed / fork / 断言）都必须：
 *     1) 终止仍存活的两个测试子进程（SIGKILL）；
 *     2) 关闭所有 Pool/Client；
 *     3) DROP 本轮精确随机 schema；
 *     4) 保留原始失败作为测试退出原因；
 *   - watchdog 修正在第一子进程 exit 时不立即清除——必须等两个
 *     child 都结束；超时后强杀两个 child 并以失败退出；
 *   - 不打印 DATABASE_URL 或其他秘密；
 *   - fork .ts 子进程时使用显式可移植的 tsx loader（execArgv +
 *     TSX_TSCONFIG_PATH），不依赖偶然继承行为。
 *
 * 环境开关：
 *   - `RUN_PG_MULTI_PROCESS=1` 才执行；否则 SKIP。
 *   - 数据库限于本机 localhost / 127.0.0.1，库名 `xuanshu`；防止误连接。
 *
 * 不依赖 Docker；按项目既有流程 drop & init 临时 schema。
 *
 * 运行：`cd backend && RUN_PG_MULTI_PROCESS=1 \
 *        npx tsx tests/integration/multi-process-resume.ts`
 */
import 'dotenv/config';
import { fork, type ChildProcess } from 'node:child_process';
import { Client, Pool } from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const RUN = process.env.RUN_PG_MULTI_PROCESS === '1';
const DB_URL_PRESENT = Boolean(process.env.DATABASE_URL);
if (!RUN) {
  console.log('[multi-process-resume] SKIP（未设置 RUN_PG_MULTI_PROCESS=1）');
  process.exit(0);
}
if (!DB_URL_PRESENT) {
  console.error('[multi-process-resume] DATABASE_URL 未配置');
  process.exit(1);
}

const DB_URL = process.env.DATABASE_URL!;
const target = new URL(DB_URL);
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/xuanshu') {
  throw new Error('多进程 fixture 仅允许明确授权的本机 xuanshu 库。');
}

const here = dirname(fileURLToPath(import.meta.url));
const INIT_SQL_PATH = join(here, '..', '..', 'database', 'init.sql');
const CHILD_SCRIPT = join(here, 'multi-process-resume-child.ts');
if (!existsSync(CHILD_SCRIPT)) {
  console.error(`[multi-process-resume] 未找到子进程脚本：${CHILD_SCRIPT}`);
  process.exit(1);
}

// 显式 tsx loader 注入：使子进程在 fork 出去时**确定**能解析 .ts，
// 不依赖调用方父进程环境是否设置了 NODE_OPTIONS。
// PR-3.3.2.1 修复：本测试位于 `backend/tests/integration/`，因此
// backendRoot 是上溯 2 层（`here` → `tests/integration/` → `tests/`
// → `backend/`），不是上溯 3 层到仓库根。tsx 安装在
// `backend/node_modules/tsx/dist/loader.mjs`（pnpm / npm 默认布局），
// 不在仓库根。
// PR-3.3.2.1 第三轮修复：Node ESM `--import` 在 Windows 上要求 file URL；
// 直接传 `E:\...\loader.mjs` 会触发 ERR_UNSUPPORTED_ESM_URL_SCHEME。
// 用 `pathToFileURL(...).href` 把绝对路径包装成 `file:///E:/.../loader.mjs`。
const backendRoot = pathResolve(here, '..', '..');
const TSX_LOADER = pathResolve(backendRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
if (!existsSync(TSX_LOADER)) {
  console.error(`[multi-process-resume] 未找到 tsx loader：${TSX_LOADER}`);
  process.exit(1);
}
const childExecArgv = ['--import', pathToFileURL(TSX_LOADER).href];

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

// ─────── 资源容器（最外层 finally 统一清理） ───────────────────────
const schema = `multi_process_${randomUUID().replaceAll('-', '')}`;
const admin = new Client({ connectionString: DB_URL });
let adminConnected = false;
let setupPool: Pool | null = null;
let seedPool: Pool | null = null;
let verifyPool: Pool | null = null;
let childA: ChildProcess | null = null;
let childB: ChildProcess | null = null;
let schemaDropped = false;

let originalError: Error | null = null;

async function dropSchemaIfNeeded(): Promise<void> {
  if (schemaDropped) return;
  schemaDropped = true;
  if (!adminConnected) return;
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } catch (err) {
    console.error(`[multi-process-resume] drop schema ${schema} failed:`, err);
  }
}

async function killChild(child: ChildProcess | null, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(signal); } catch { /* ignore */ }
}

async function closePool(p: Pool | null): Promise<void> {
  if (!p) return;
  try { await p.end(); } catch { /* ignore */ }
}

async function cleanupAll(): Promise<void> {
  // 1) kill children
  await killChild(childA);
  await killChild(childB);
  // 2) close pools
  await closePool(verifyPool); verifyPool = null;
  await closePool(seedPool); seedPool = null;
  await closePool(setupPool); setupPool = null;
  // 3) drop schema
  await dropSchemaIfNeeded();
  // 4) close admin
  if (adminConnected) {
    try { await admin.end(); } catch { /* ignore */ }
    adminConnected = false;
  }
}

try {
  // ─────── 1. 临时 schema ───────────────────────────────────────────────
  await admin.connect();
  adminConnected = true;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  console.log(`[multi-process-resume] created schema ${schema}`);

  setupPool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema},public` });
  await setupPool.query(readFileSync(INIT_SQL_PATH, 'utf8'));
  // 额外加 sdk_call_log 窄表：子进程写、父子进程读，唯一可验证 SDK
  // 调用计数的共享介质。
  await setupPool.query(`
    CREATE TABLE sdk_call_log (
      id BIGSERIAL PRIMARY KEY,
      child_id TEXT NOT NULL,
      method TEXT NOT NULL,
      run_id TEXT,
      tool_call_id TEXT,
      workspace_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // ─────── 2. seed: workspace + user + conv + message + run + approval ─
  seedPool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema},public` });
  let seedWorkspaceId: string;
  let seedUserId: string;
  let seedRunId: string;
  let seedMsgId: string;
  let seedApprovalId: string;
  {
    const ws = await seedPool.query<{ id: string }>(
      `INSERT INTO workspaces(kind, name) VALUES ('shared', 'multi-process')
       RETURNING id`,
    );
    seedWorkspaceId = ws.rows[0]!.id;

    const u = await seedPool.query<{ id: string }>(
      `INSERT INTO app_users(username, username_normalized, password_hash)
       VALUES ($1, $1, '!disabled!') RETURNING id`,
      [`mp_${randomUUID()}`],
    );
    seedUserId = u.rows[0]!.id;

    const conv = await seedPool.query<{ id: string }>(
      `INSERT INTO conversations(workspace_id, agent_id, title)
       VALUES ($1, 'general-chat', 'multi-process') RETURNING id`,
      [seedWorkspaceId],
    );
    const convId = conv.rows[0]!.id;

    const msg = await seedPool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id, workspace_id, role, content, status)
       VALUES ($1, $2, 'assistant', '', 'pending') RETURNING id`,
      [convId, seedWorkspaceId],
    );
    seedMsgId = msg.rows[0]!.id;

    const run = await seedPool.query<{ id: string }>(
      `INSERT INTO agent_runs(
         workspace_id, conversation_id, assistant_message_id,
         agent_id, provider, model, status, request_id, created_by
       ) VALUES (
         $1, $2, $3,
         'general-chat', 'test-provider', 'test-model', 'waiting_approval',
         $4, $5
       ) RETURNING id`,
      [seedWorkspaceId, convId, seedMsgId, randomUUID(), seedUserId],
    );
    seedRunId = run.rows[0]!.id;

    // 关键修复：approval 必须填 resolver_id（NOT NULL FK）+ decision +
    // resolved_at。PR-3.3.0 起 init.sql 把 resolver_id 改为 NOT NULL，
    // 未填会 PG 23502 拒绝。这里 resolver_id 用当前 seedUserId
    // （=requester_id，PR-3.3.0 默认行为），与生产路径一致。
    const ap = await seedPool.query<{ id: string }>(
      `INSERT INTO tool_approval_requests(
         workspace_id, run_id, requester_id, resolver_id, tool_id, tool_call_id,
         inputs_hash, inputs_summary, expires_at, status, decision, resolved_at
       ) VALUES (
         $1, $2, $3, $3, 'calculator', 'tc-multi-process',
         'h', '{}'::jsonb, now() + interval '60 seconds',
         'approved', 'approved', now()
       ) RETURNING id`,
      [seedWorkspaceId, seedRunId, seedUserId],
    );
    seedApprovalId = ap.rows[0]!.id;
  }

  // ─────── 3. 启动两个独立 Node 子进程 ────────────────────────────────
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    RUN_PG_MULTI_PROCESS: '1',
    PG_SEARCH_PATH: schema,
    DATABASE_URL: DB_URL,
  };

  let childAReady = false;
  let childBReady = false;
  let started = false;

  function tryStart(): void {
    if (started || !(childAReady && childBReady)) return;
    if (!childA || !childB) return;
    started = true;
    // 同时 send 'START'：让两个子进程尽量在同一时刻调
    // runResumeSchedulerOnce，最大化竞争窗口。
    try { childA.send('START'); } catch (err) {
      console.error('[multi-process-resume] childA.send(START) failed:', err);
    }
    try { childB.send('START'); } catch (err) {
      console.error('[multi-process-resume] childB.send(START) failed:', err);
    }
  }

  childA = fork(CHILD_SCRIPT, [], {
    env: { ...childEnv, CHILD_ID: 'child-A', APPROVAL_ID: seedApprovalId, RUN_ID: seedRunId },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: childExecArgv,
  });
  childB = fork(CHILD_SCRIPT, [], {
    env: { ...childEnv, CHILD_ID: 'child-B', APPROVAL_ID: seedApprovalId, RUN_ID: seedRunId },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: childExecArgv,
  });

  // 抑制子进程 stderr（fail-closed 错误可让我们看到）；只保留主进程日志。
  // **不**打印任何包含 DATABASE_URL 的内容到 stderr——子进程自己的
  // 错误日志由其自己处理；父进程只转发不带凭据的标识。
  childA.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[child-A] ${chunk.toString()}`);
  });
  childB.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[child-B] ${chunk.toString()}`);
  });

  childA.on('message', (msg: unknown) => {
    if (msg === 'ready') {
      childAReady = true;
      tryStart();
    }
  });
  childB.on('message', (msg: unknown) => {
    if (msg === 'ready') {
      childBReady = true;
      tryStart();
    }
  });

  // PR-3.3.2.1 第三轮修复：若 child 在 ready 前 exit（典型：tsx loader
  // 启动失败 / 子进程立即报错 / DATABASE_URL 未传入），父进程必须
  // 立即记录明确失败原因，而不是只等 watchdog。每个 child 单独
  // 监听 exit；任一 child 在未发 'ready' 就 exit 时，标 failed +
  // 写入 originalError，让顶层 try/catch 走 cleanup 路径。
  function watchEarlyExit(label: string, child: ChildProcess): void {
    child.once('exit', (code, signal) => {
      const cid = label === 'A' ? 'child-A' : 'child-B';
      if (!started && (code !== 0 || signal !== null)) {
        const reason = `[multi-process-resume] ${cid} exited before ready: code=${code}, signal=${signal}`;
        console.error(reason);
        failed++;
        if (!originalError) {
          originalError = new Error(reason);
        }
      }
    });
  }
  watchEarlyExit('A', childA);
  watchEarlyExit('B', childB);

  // 容错：30s watchdog。**不**在第一个 child exit 时清除——
  // 必须两个 child 都结束后才 clearTimeout。任一 child 挂住
  // 超时则强杀两个 child 并以失败退出。
  const watchdogMs = 30_000;
  let watchdog: NodeJS.Timeout | null = setTimeout(() => {
    console.error(`[multi-process-resume] watchdog ${watchdogMs}ms timeout，强制 kill 子进程`);
    void (async () => {
      await killChild(childA);
      await killChild(childB);
    })();
    // 把测试结果标失败。
    failed++;
    originalError = new Error(`watchdog timeout after ${watchdogMs}ms`);
  }, watchdogMs);
  watchdog.unref?.();

  const [codeA, codeB] = await Promise.all([
    new Promise<number>((resolve) => {
      const child = childA!;
      child.on('exit', (code) => {
        resolve(code ?? 1);
      });
    }),
    new Promise<number>((resolve) => {
      const child = childB!;
      child.on('exit', (code) => {
        resolve(code ?? 1);
      });
    }),
  ]);
  // 两个 child 都结束才清 watchdog。
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }

  // ─────── 4. 断言 ─────────────────────────────────────────────────────
  verifyPool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema},public` });
  const sdkCalls = await verifyPool.query<{
    child_id: string;
    method: string;
    run_id: string;
    tool_call_id: string;
    workspace_id: string;
  }>(`SELECT child_id, method, run_id, tool_call_id, workspace_id
        FROM sdk_call_log ORDER BY id ASC`);

  const approveCalls = sdkCalls.rows.filter((r) => r.method === 'approveToolCall');
  const declineCalls = sdkCalls.rows.filter((r) => r.method === 'declineToolCall');

  check(
    `approveToolCall 总计恰好调用 1 次（实际 ${approveCalls.length}）`,
    approveCalls.length === 1,
    `calls=${JSON.stringify(approveCalls.map((c) => c.child_id))}`,
  );
  check(
    'declineToolCall 未被调用（只走 approved 路径）',
    declineCalls.length === 0,
  );
  check(
    'approveToolCall 调用的 run_id === seedRunId',
    approveCalls[0]?.run_id === seedRunId,
  );

  const runResumedEvts = await verifyPool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM agent_run_events
      WHERE run_id = $1 AND type = 'run-resumed'`,
    [seedRunId],
  );
  check(
    `run-resumed 事件恰好 1 条（实际 ${runResumedEvts.rows[0]?.c}）`,
    runResumedEvts.rows[0]?.c === 1,
  );

  const finalRun = await verifyPool.query<{ status: string; error_code: string | null }>(
    `SELECT status, error_code FROM agent_runs WHERE id = $1`,
    [seedRunId],
  );
  check(
    `Run 收敛到 completed（实际 ${finalRun.rows[0]?.status}）`,
    finalRun.rows[0]?.status === 'completed',
  );

  const finalMsg = await verifyPool.query<{ status: string; content: string }>(
    `SELECT status, content FROM messages WHERE id = $1`,
    [seedMsgId],
  );
  check(
    `messages.status === completed（实际 ${finalMsg.rows[0]?.status}）`,
    finalMsg.rows[0]?.status === 'completed',
  );
  check(
    `messages.content 由赢者 child 写入（实际 "${finalMsg.rows[0]?.content}"）`,
    /text-from-child-[AB]/.test(finalMsg.rows[0]?.content ?? ''),
  );

  check(`child-A exit code === 0（实际 ${codeA}）`, codeA === 0);
  check(`child-B exit code === 0（实际 ${codeB}）`, codeB === 0);

  console.log(
    `\n[multi-process-resume] Result: ${passed} passed, ${failed} failed`,
  );
  console.log(
    `[multi-process-resume] sdk_call_log entries = ${sdkCalls.rows.length}`,
  );
} catch (err) {
  originalError = err instanceof Error ? err : new Error(String(err));
  console.error('[multi-process-resume] FAILED:', originalError.message);
  failed++;
} finally {
  await cleanupAll();
}

if (originalError) {
  process.exitCode = 1;
  process.stderr.write(`${originalError.stack ?? originalError.message}\n`);
} else if (failed > 0) {
  process.exitCode = 1;
}
