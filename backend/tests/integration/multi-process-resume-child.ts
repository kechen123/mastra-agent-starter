/**
 * PR-3.3.2 — 多进程 resume 竞争测试的子进程入口。
 *
 * 设计约束（避免被普通 unit runner 误执行）：
 *   - 必须设置 `RUN_PG_MULTI_PROCESS=1`；
 *   - 必须设置 `PG_SEARCH_PATH=<schema>`：父进程创建的临时 schema；
 *   - 必须设置 `CHILD_ID`：用于 sdk_call_log 区分；
 *   - 必须设置 `APPROVAL_ID` / `RUN_ID`：预先在临时 schema 写入的
 *     approved approval；
 *   - 必须通过 IPC 'START' 信号才开始驱动执行器；
 *   - 子进程**不**自启后台循环（只调 runResumeSchedulerOnce 一次）。
 *
 * 工作流程：
 *   1. 用 `search_path=<schema>` 创建一个本地 Pool；通过
 *      `__setTestPool` 替换全局池，让 executor 走临时 schema；
 *   2. 注入 `FakeAgentFacade`：
 *        - `approveToolCall`：每次调用向 `sdk_call_log` 表插一行
 *      （child_id, method, run_id, tool_call_id, workspace_id）；
 *          之后返回一个 AsyncIterable，yield `text-delta` + `done`；
 *        - `declineToolCall` / `listSuspendedRuns`：永不调用，调用即
 *      抛错（fail-closed）；
 *   3. 通过 `process.send('ready')` 通知父进程；
 *   4. 收到父进程 IPC 'START' → 同步调 `runResumeSchedulerOnce`；
 *   5. 轮询 agent_runs.status 直到非 running / waiting_approval 或
 *      截止；**到截止仍未收敛必须显式抛错并 exit 非零**（不允许
 *      静默 exit 0——否则父进程无法区分"成功"与"被 lease 抢占
 *      失败但仍等待"）；
 *   6. 清理 pool + exit 0。
 *
 * 不变量：
 *   - 子进程**不**修改公共数据库 / schema，只通过 `search_path` 操作临时
 *     schema；
 *   - 子进程只调一次 runResumeSchedulerOnce，不启后台循环；
 *   - 子进程遇到错误时显式 process.exit(非零)，无未处理 rejection；
 *   - 子进程**不**打印 DATABASE_URL 或其他秘密。
 */
import 'dotenv/config';
import { Pool } from 'pg';

const RUN = process.env.RUN_PG_MULTI_PROCESS === '1';
const SCHEMA = process.env.PG_SEARCH_PATH;
const CHILD_ID = process.env.CHILD_ID;
const DB_URL_PRESENT = Boolean(process.env.DATABASE_URL);
const APPROVAL_ID = process.env.APPROVAL_ID;
const RUN_ID = process.env.RUN_ID;
const POLL_TIMEOUT_MS = Number(process.env.MP_CHILD_POLL_TIMEOUT_MS ?? '10000');

if (!RUN || !SCHEMA || !CHILD_ID || !DB_URL_PRESENT || !APPROVAL_ID || !RUN_ID) {
  console.error(`[multi-process-resume-child ${CHILD_ID ?? '?'}] SKIP: missing env (RUN_PG_MULTI_PROCESS / PG_SEARCH_PATH / CHILD_ID / APPROVAL_ID / RUN_ID / DATABASE_URL present)`);
  process.exit(0);
}

// 不持有 DATABASE_URL 内容到日志中——只断言其存在。
const SCHEMA_NAME = SCHEMA;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  options: `-c search_path=${SCHEMA_NAME},public`,
});

async function failExit(reason: string, code: number): Promise<never> {
  console.error(`[multi-process-resume-child ${CHILD_ID}] error: ${reason}`);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(code);
}

try {
  // Override global pool: 让 run-executor 走我们的临时 schema。
  const poolModule = await import('../../src/infrastructure/database/pool.js');
  poolModule.__setTestPool(pool);

  // 引入 tools 让 calculator 已注册（reconciler 校验需要，但本测试不进
  // reconciler；保留与生产路径一致）。
  await import('../../src/tools/index.js');

  const stateMachine = await import(
    '../../src/modules/tool-policy/state-machine.js'
  );
  stateMachine._setMastraFacadeForTesting({
    approveToolCall: async (args) => {
      // 每次 SDK 调用向 sdk_call_log 写一行：父进程用这张表校验
      // "approveToolCall 是否恰好调用一次"。
      await pool.query(
        `INSERT INTO sdk_call_log (child_id, method, run_id, tool_call_id, workspace_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [CHILD_ID, 'approveToolCall', args.runId, args.toolCallId, args.workspaceId],
      );
      // 模拟 SDK 真实延迟，让另一个 worker 也有机会同时发起 claim。
      await new Promise((r) => setTimeout(r, 80));
      return (async function* () {
        yield { type: 'text-delta', payload: { text: `text-from-${CHILD_ID}` } };
        yield { type: 'done', payload: {} };
      })();
    },
    declineToolCall: async (): Promise<never> => {
      throw new Error('declineToolCall should not be called in this test');
    },
    listSuspendedRuns: async (): Promise<never> => {
      throw new Error('listSuspendedRuns should not be called in this test');
    },
  });

  // 通知父进程：已就绪，等 START。
  if (typeof process.send === 'function') process.send('ready');

  // 等待父进程 IPC 'START'；超时 10s 防卡死。
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`child ${CHILD_ID}: timeout waiting for START signal`));
    }, 10_000);
    process.on('message', (msg) => {
      if (msg === 'START') {
        clearTimeout(timer);
        resolve();
      }
    });
    process.on('disconnect', () => {
      clearTimeout(timer);
      reject(new Error(`child ${CHILD_ID}: parent disconnected before START`));
    });
  });

  // 驱动生产执行器。
  const executor = await import('../../src/core/execution/run-executor.js');
  await executor.runResumeSchedulerOnce();

  // 等异步 consumeResumeStream 收敛到非 running / waiting_approval
  // 终态。到达 POLL_TIMEOUT_MS 仍**未**收敛必须显式抛错——
  // 静默 exit 0 会让父进程把"被 lease 抢占失败"误判为成功。
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let reachedTerminal: 'completed' | 'stopped' | 'failed' | null = null;
  while (Date.now() < deadline) {
    const r = await pool.query<{ status: string }>(
      `SELECT status FROM agent_runs WHERE id = $1`,
      [RUN_ID],
    );
    const status = r.rows[0]?.status;
    if (status === 'completed' || status === 'failed' || status === 'stopped') {
      reachedTerminal = status;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (reachedTerminal === null) {
    await failExit(
      `Run did not converge to a terminal state within ${POLL_TIMEOUT_MS}ms`
      + ` (child=${CHILD_ID}, runId=${RUN_ID})`,
      3,
    );
  }
  if (reachedTerminal !== 'completed') {
    await failExit(
      `Run converged to unexpected terminal state '${reachedTerminal}' (expected 'completed')`,
      4,
    );
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  await failExit(`unhandled: ${msg}`, 2);
}

await pool.end();
process.exit(0);
