/**
 * PR-3.3.2.1 — 终态 lease fencing 集成测试（done / stopped / error 三场景）。
 *
 * 目的：在真实 PostgreSQL 临时 schema fixture 上驱动生产执行器路径
 * (`runResumeSchedulerOnce` → `consumeResumeStream` →
 * `completeRun / stopRun / failRun`)，验证当 `agent_runs.lease_owner`
 * 在 stream 落地前被替换为外部 owner 时，迟到 worker 的终态写入被
 * `lease_owner` fence 阻断——`messages.status` 与
 * `agent_run_events.run-*` 不会被错误终态覆盖。
 *
 * 覆盖三个独立场景（每个场景独立 seed，避免互相污染）：
 *   (i)   stream yield 'done'    → 触发 completeRun → 期望 Run NOT
 *         in (completed, stopped, failed)；
 *   (ii)  用户通过 `abortRunByMessage(assistantMessageId)` 中止 →
 *         触发 stopRun → 期望同上。
 *         **不能用**fake stream 直接 yield `{type:'stopped'}` —
 *         `consumeAgentStream` 不识别该 raw chunk。必须用真实生产
 *         的 `abortRunByMessage` 入口（POST /messages/:id/stop 路由
 *         走的就是它）。
 *   (iii) stream throw Error    → 触发 failRun → 期望同上 + Run
 *         也没被迟到 worker 写为 failed。
 *
 * 同步时序（**核心**：第二轮修复，避免在 resume stream 真启动前替换 lease）：
 *
 *   1) 等 scheduler claim（lease_owner === WORKER_ID + run-resumed 事件）。
 *   2) 等 facadeCalledPromise（facade.approveToolCall 已被调用）。
 *   3) 等 streamAtGatePromise（AsyncIterable 已 yield 第一个 text-delta 并
 *      停在测试控制的 deferred gate 上）。
 *   4) 断言 `listActiveExecutions()` 包含目标 runId（ActiveExecution 已建）。
 *   5) 替换 lease_owner 为外部 owner。
 *   6) 触发场景动作：
 *        - done   → 释放 deferred，generator yield 'done' chunk；
 *        - error  → 释放 deferred，generator throw Error；
 *        - stopped → 先 `abortRunByMessage(assistantMessageId)`，再
 *          **推进 generator 一次**（yield 或 return），让
 *          `consumeAgentStream` 在下一轮迭代开头检查 abortSignal 并
 *          走 stopRun 分支。不能让 generator 永远 await Promise<never>，
 *          因为 abort 不会中断一个永挂的 Promise。
 *   7) 等 generatorFinishedPromise（generator 自身已 return/throw）。
 *   8) 轮询 `listActiveExecutions()` 直到目标 runId 被移除。
 *   9) 断言 DB + 事件 + lease 状态。
 *
 * 不变量：
 *   - `approveToolCall` 仍只调用 1 次——lease fence 只阻止终态写入，
 *     SDK 调用本身不受影响（resume scheduler 早已在事务内完成 claim）；
 *   - 测试不修改生产代码——fence 语义已存在于
 *     `core/execution/run-executor.ts::completeRun / stopRun / failRun`；
 *   - 不直接调私有 `completeRun / stopRun / failRun`——通过真实生产
 *     入口 `runResumeSchedulerOnce` + 注入式 `FakeAgentFacade` 驱动；
 *   - 每场景断言对应日志路径（done → "completeRun 跳过"；
 *     stopped → "stopRun 跳过"；error → "failRun 跳过"），证明走的是
 *     `lease_owner != WORKER_ID` 的 fence 而非其他原因。
 *
 * 运行：`cd backend && RUN_PG_TOOL_POLICY=1 RUN_PG_LEASE_FENCE=1 \
 *        npx tsx tests/integration/executor-terminal-lease-fence.ts`
 *
 * **必须**同时设置 `RUN_PG_TOOL_POLICY=1`（fixture gate）与
 * `RUN_PG_LEASE_FENCE=1`（本测试 gate）。
 */
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { withApprovalFixture, seedApprovalRun } from '../helpers/approval-fixture.js';
import * as repo from '../../src/modules/tool-policy/repository.js';
import {
  _setMastraFacadeForTesting,
} from '../../src/modules/tool-policy/state-machine.js';
import {
  abortRunByMessage,
  listActiveExecutions,
  runResumeSchedulerOnce,
  _executorWorkerId,
} from '../../src/core/execution/run-executor.js';
import { logger } from '../../src/infrastructure/logging/logger.js';
import '../../src/tools/index.js';

if (process.env.RUN_PG_LEASE_FENCE !== '1') {
  console.log('SKIP: executor-terminal-lease-fence requires RUN_PG_LEASE_FENCE=1');
  process.exit(0);
}

type TerminalEventType = 'run-completed' | 'run-stopped' | 'run-failed';

interface StreamSpec {
  /** 场景描述（done / stopped / error）。 */
  kind: 'done' | 'stopped' | 'error';
  /** 该场景下应被 fencing 阻挡的 Run 终态事件类型。 */
  expectedTerminal: TerminalEventType;
  /**
   * 与生产日志路径对应的"跳过"短语；用于在截获 logger.warn 后断言。
   * done → "completeRun 跳过"；stopped → "stopRun 跳过"；error → "failRun 跳过"。
   */
  expectedLogSkip: 'completeRun 跳过' | 'stopRun 跳过' | 'failRun 跳过';
}

const STREAM_SPECS: StreamSpec[] = [
  { kind: 'done', expectedTerminal: 'run-completed', expectedLogSkip: 'completeRun 跳过' },
  { kind: 'stopped', expectedTerminal: 'run-stopped', expectedLogSkip: 'stopRun 跳过' },
  { kind: 'error', expectedTerminal: 'run-failed', expectedLogSkip: 'failRun 跳过' },
];

await withApprovalFixture(async (pool: Pool) => {
  /**
   * PR-3.3.2.1 第四轮：临时拦截 `logger.warn` 以断言生产路径上的
   * "XxxRun 跳过"日志被实际写出。
   *
   * 关键时序：completeRun / stopRun / failRun 的 `Run 已终态或当前 worker
   * 已丢失 lease` warn 发生在 worker 的 lease-fence 路径上，写入时机是
   * `try { client.query('BEGIN') ... RETURNING id }` 返回 0 行后立刻写——
   * **早于** ActiveExecution 从 `activeExecutions` Map 里被删除，也
   * **早于** `listActiveExecutions()` 轮询看到 runId 消失。因此捕获
   * 窗口必须**晚于** lease 替换、**早于** 卸载——`start()` 紧跟在 lease
   * 替换后；`stop()` 在 settle 之后调用。
   *
   * 双阶段 API：
   *   const capture = startSkipLogCapture(runId, 'completeRun 跳过');
   *   // ... 触发 done/error/stopped ...
   *   await settle(...);
   *   capture.stop();
   *   assert(capture.matched);
   */
  function startSkipLogCapture(
    runId: string,
    expectedSubstr: string,
  ): {
    matched: boolean;
    lines: string[];
    stop: () => void;
  } {
    const lines: string[] = [];
    let matched = false;
    // logger 模块顶层 import；同一 pino 实例引用。
    const originalWarn = (logger as unknown as {
      warn: (obj: Record<string, unknown> | string, msg?: string) => void;
    }).warn.bind(logger);
    (logger as unknown as { warn: typeof originalWarn }).warn = (
      obj: Record<string, unknown> | string,
      msg?: string,
    ) => {
      const record = typeof obj === 'string'
        ? { msg: obj }
        : obj;
      const text = record.msg ?? msg ?? '';
      // 过滤目标 runId 范围内的"跳过"日志，避免其他 Run 干扰。
      if (text.includes(expectedSubstr) && record.runId === runId) {
        lines.push(text);
        if (text.includes('Run 已终态或当前 worker 已丢失 lease')) {
          matched = true;
        }
      }
      // 不真正输出，避免测试日志污染。
    };
    return {
      get matched(): boolean { return matched; },
      lines,
      stop(): void {
        (logger as unknown as { warn: typeof originalWarn }).warn = originalWarn;
      },
    };
  }

  // ─────── 准备工具：单个场景的完整驱动 ─────────────────────────────
  async function runScenario(spec: StreamSpec): Promise<{
    runId: string;
    workspaceId: string;
    approvalId: string;
    assistantMessageId: string;
    approveCalls: number;
    logMatched: boolean;
  }> {
    // 1) seed Run + approved approval（独立 seed，与其他场景隔离）。
    const seed = await seedApprovalRun(pool);
    const row = await repo.createApprovalRequest({
      workspaceId: seed.workspaceId,
      runId: seed.runId,
      requesterId: seed.userId,
      toolId: 'calculator',
      toolCallId: `tc-fence-${spec.kind}-${Date.now()}`,
      inputsHash: 'h',
      inputsSummary: { kind: 'destructive', preview: `lease fence ${spec.kind}`, count: 1 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await pool.query(
      `UPDATE tool_approval_requests SET status='approved' WHERE id=$1`,
      [row.id],
    );
    await pool.query(
      `UPDATE agent_runs SET status='waiting_approval',
                            lease_owner = NULL,
                            lease_expires_at = NULL
         WHERE id = $1`,
      [seed.runId],
    );
    // 查 assistant_message_id：stopped 场景需要它来调真实生产
    // `abortRunByMessage(assistantMessageId)` 入口。
    const msgLookup = await pool.query<{ assistant_message_id: string }>(
      `SELECT assistant_message_id FROM agent_runs WHERE id = $1`,
      [seed.runId],
    );
    const assistantMessageId = msgLookup.rows[0]!.assistant_message_id;

    // 2) 三个测试同步信号：
    //    - facadeCalledPromise：resolve 时 facade.approveToolCall 已被调用；
    //    - streamAtGatePromise：resolve 时 AsyncIterable 已 yield 第一段
    //      text-delta 并停在测试控制的 deferred gate；
    //    - generatorFinishedPromise：resolve 时 generator 已 return 或 throw。
    let resolveFacadeCalled: (() => void) | null = null;
    const facadeCalledPromise = new Promise<void>((r) => { resolveFacadeCalled = r; });
    let releaseGate: (() => void) | null = null;
    const streamAtGatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let resolveGeneratorFinished: (() => void) | null = null;
    const generatorFinishedPromise = new Promise<void>((r) => { resolveGeneratorFinished = r; });

    // stopped 场景专用：abort 后要让 generator 继续推进（yield 或 return），
    // 让 consumeAgentStream 在下一轮迭代开头检查 abortSignal。
    let resolveAbortAdvance: (() => void) | null = null;
    const abortAdvancePromise = new Promise<void>((r) => { resolveAbortAdvance = r; });

    let approveCalls = 0;

    _setMastraFacadeForTesting({
      approveToolCall: async () => {
        approveCalls++;
        resolveFacadeCalled!();
        return (async function* (): AsyncIterable<unknown> {
          try {
            yield { type: 'text-delta', payload: { text: `partial-${spec.kind}` } };
            // 告诉测试："我已经 yield 第一段，进入 gate。"
            releaseGate!();
            // 等测试替换 lease_owner。
            await new Promise<void>((r) => { releaseGate = r; });
            // 这里 resume 的 gate 等价于："lease 已替换，测试告诉你
            // 可以继续"。done / error 走原路径；stopped 在 abort 后
            // 通过 abortAdvancePromise 推进。
            if (spec.kind === 'done') {
              yield { type: 'done', payload: { content: `text-from-${spec.kind}` } };
            } else if (spec.kind === 'error') {
              // 错误场景：让 stream 抛错触发 failRun。
              throw new Error(`stream failure for ${spec.kind} scenario`);
            } else {
              // stopped 场景：等 abort 信号到来后，测试会 resolve
              // abortAdvancePromise，让我们 yield 一个无害 chunk 让
              // consumeAgentStream 在下一轮迭代开头检查 abortSignal
              // 并走 stopRun 分支。
              await abortAdvancePromise;
              yield { type: 'text-delta', payload: { text: 'post-abort-tick' } };
              // yield 后下一轮迭代会检测 abort → 走 stopRun → 后续
              // 逻辑会被 fence 阻断。generator 自身会自然结束（因
              // abortSignal 触发 consumeAgentStream 的 for await 中
              // try/catch）。
            }
          } finally {
            // 无论 return / throw，generator 结束都通知测试。
            resolveGeneratorFinished!();
          }
        })();
      },
      declineToolCall: async (): Promise<never> => {
        throw new Error('declineToolCall not expected in this test');
      },
      listSuspendedRuns: async (): Promise<never> => {
        throw new Error('listSuspendedRuns not expected in this test');
      },
    });

    // 3) 驱动 runResumeSchedulerOnce。
    await runResumeSchedulerOnce();

    // 4) 等 scheduler claim：lease_owner === WORKER_ID + run-resumed 事件。
    const claimDeadline = Date.now() + 5_000;
    while (Date.now() < claimDeadline) {
      const r = await pool.query<{ lease_owner: string | null }>(
        `SELECT lease_owner FROM agent_runs WHERE id=$1`,
        [seed.runId],
      );
      if (r.rows[0]?.lease_owner === _executorWorkerId) {
        const evt = await pool.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM agent_run_events
            WHERE run_id=$1 AND type='run-resumed'`,
          [seed.runId],
        );
        if ((evt.rows[0]?.c ?? 0) > 0) break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    const claimed = (
      await pool.query<{ lease_owner: string | null }>(
        `SELECT lease_owner FROM agent_runs WHERE id=$1`,
        [seed.runId],
      )
    ).rows[0]?.lease_owner;
    assert.equal(
      claimed,
      _executorWorkerId,
      `[${spec.kind}] executor must claim lease before test swaps lease_owner`,
    );

    // 5) 等 facade.approveToolCall 真正被调用。
    await Promise.race([
      facadeCalledPromise,
      new Promise<void>((_, reject) => setTimeout(
        () => reject(new Error(`[${spec.kind}] facade.approveToolCall not called within 5s`)),
        5_000,
      )),
    ]);

    // 6) 等 stream 进入 gate（已 yield 第一段 text-delta，停住等测试）。
    await Promise.race([
      streamAtGatePromise,
      new Promise<void>((_, reject) => setTimeout(
        () => reject(new Error(`[${spec.kind}] stream did not enter gate within 5s`)),
        5_000,
      )),
    ]);

    // 7) 断言 ActiveExecution 已建：listActiveExecutions() 包含目标 runId。
    const activeBeforeSwap = listActiveExecutions();
    assert.ok(
      activeBeforeSwap.some((e) => e.runId === seed.runId),
      `[${spec.kind}] ActiveExecution must be present before lease swap; got=${JSON.stringify(activeBeforeSwap)}`,
    );

    // 8) 替换 lease_owner 为外部 owner。
    await pool.query(
      `UPDATE agent_runs
          SET lease_owner = $2,
              lease_expires_at = now() + interval '60 seconds',
              heartbeat_at = now()
        WHERE id = $1`,
      [seed.runId, 'late-stale-worker-B'],
    );

    // 9) **PR-3.3.2.1 第四轮**：在 lease 替换后**立即**装载日志捕获，
    //    覆盖 completeRun / stopRun / failRun 写入
    //    "XxxRun 跳过：Run 已终态或当前 worker 已丢失 lease" warn 的整个
    //    时窗——这些 warn 写入时机是 BEGIN...RETURNING 返回 0 行之后，
    //    远早于 ActiveExecution 从 activeExecutions Map 删除。
    //    捕获窗口必须跨越：释放 gate → 触发场景动作 → generatorFinished
    //    → listActiveExecutions settle → 卸载。
    const capture = startSkipLogCapture(seed.runId, spec.expectedLogSkip);

    // 10) 释放 generator 的 gate，让它推进到终态事件 / 抛错 / abort 触发。
    assert.ok(releaseGate, `[${spec.kind}] gate release must be installed`);
    releaseGate!();

    // 11) 触发场景动作（对 stopped 场景：先 abort 再推进）。
    if (spec.kind === 'stopped') {
      // 真实生产入口；POST /messages/:id/stop 路由走的就是它。
      const aborted = abortRunByMessage(assistantMessageId);
      assert.equal(
        aborted, true,
        `[${spec.kind}] abortRunByMessage must return true (executor owns the active execution)`,
      );
      // abort 触发后让 generator 继续 yield 一次，让 consumeAgentStream
      // 在下一轮迭代开头检查 abortSignal 走 stopRun 分支。
      assert.ok(resolveAbortAdvance, `[${spec.kind}] abort advance resolver must be installed`);
      resolveAbortAdvance!();
    }

    // 12) 等 generator 自身结束。
    await Promise.race([
      generatorFinishedPromise,
      new Promise<void>((_, reject) => setTimeout(
        () => reject(new Error(`[${spec.kind}] generator did not finish within 5s after gate release`)),
        5_000,
      )),
    ]);

    // 13) 显式等 execution settle：轮询 `listActiveExecutions()` 直到
    //     runId 从活跃集里被移除——这是真实生产路径下"执行已结束"
    //     的最可靠信号，与 DB 列状态解耦。
    const settleDeadline = Date.now() + 10_000;
    let settled = false;
    while (Date.now() < settleDeadline) {
      const active = listActiveExecutions();
      if (!active.some((e) => e.runId === seed.runId)) {
        settled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(
      settled,
      `[${spec.kind}] execution must settle (runId removed from listActiveExecutions) within 10s`,
    );

    // 14) 在 settle 之后才卸载日志捕获——确保 worker 退出前最后一句
    //     warn 也被收集（已经过 capture 累积到 lines/matched）。
    capture.stop();
    const logMatched = capture.matched;

    return {
      runId: seed.runId,
      workspaceId: seed.workspaceId,
      approvalId: row.id,
      assistantMessageId,
      approveCalls,
      logMatched,
    };
  }

  async function assertScenarioFenced(spec: StreamSpec, ctx: {
    runId: string;
    workspaceId: string;
    approvalId: string;
    approveCalls: number;
    logMatched: boolean;
  }): Promise<void> {
    // (a) SDK 调用次数：仍只 1 次。
    assert.equal(
      ctx.approveCalls, 1,
      `[${spec.kind}] approveToolCall must have been invoked exactly once`,
    );
    // (b) Run.status NOT in 终态 + lease_owner 保持被替换的值。
    const runRow = (
      await pool.query<{
        status: string;
        lease_owner: string | null;
        lease_expires_at: string | null;
        error_code: string | null;
      }>(
        `SELECT status, lease_owner, lease_expires_at, error_code
           FROM agent_runs WHERE id=$1`,
        [ctx.runId],
      )
    ).rows[0]!;
    assert.notEqual(runRow.status, 'completed',
      `[${spec.kind}] late worker must not write completed; lease fence blocked completeRun`);
    assert.notEqual(runRow.status, 'stopped',
      `[${spec.kind}] late worker must not write stopped; lease fence blocked stopRun`);
    assert.notEqual(runRow.status, 'failed',
      `[${spec.kind}] late worker must not write failed; lease fence blocked failRun`);
    assert.equal(runRow.lease_owner, 'late-stale-worker-B',
      `[${spec.kind}] lease_owner stays at the swapped-in owner after worker A failed terminal write`);
    // (c) agent_run_events 不应出现本场景对应的终态事件类型。
    const terminalEvts = await pool.query<{ type: string }>(
      `SELECT type FROM agent_run_events
        WHERE run_id=$1 AND type = $2`,
      [ctx.runId, spec.expectedTerminal],
    );
    assert.equal(
      terminalEvts.rows.length,
      0,
      `[${spec.kind}] stale worker must not write ${spec.expectedTerminal}; saw: ${terminalEvts.rows.map((r) => r.type).join(',')}`,
    );
    // (d) 同时检查**全部**三种终态事件都没出现（防御性）。
    const allTerminalEvts = await pool.query<{ type: string }>(
      `SELECT type FROM agent_run_events
        WHERE run_id=$1
          AND type IN ('run-completed', 'run-stopped', 'run-failed')`,
      [ctx.runId],
    );
    assert.equal(
      allTerminalEvts.rows.length,
      0,
      `[${spec.kind}] no terminal event must exist; saw: ${allTerminalEvts.rows.map((r) => r.type).join(',')}`,
    );
    // (e) messages.status NOT in 终态。
    const msgRow = (
      await pool.query<{ status: string; content: string }>(
        `SELECT status, content FROM messages
          WHERE id = (SELECT assistant_message_id FROM agent_runs WHERE id=$1)
            AND workspace_id=$2`,
        [ctx.runId, ctx.workspaceId],
      )
    ).rows[0]!;
    assert.notEqual(msgRow.status, 'completed',
      `[${spec.kind}] messages.status must not be completed`);
    assert.notEqual(msgRow.status, 'stopped',
      `[${spec.kind}] messages.status must not be stopped`);
    assert.notEqual(msgRow.status, 'failed',
      `[${spec.kind}] messages.status must not be failed`);
    // (f) approval 的 mastra_resume_started_at 不应被 worker A 清掉。
    const approvalAfter = await repo.getApprovalRequestById(ctx.workspaceId, ctx.approvalId);
    assert.ok(approvalAfter?.mastraResumeStartedAt !== null,
      `[${spec.kind}] mastra_resume_started_at must remain after stale worker fails terminal write`);
    // (g) 走的是 "XxxRun 跳过：Run 已终态或当前 worker 已丢失 lease" 日志
    //     路径——证明本场景确实是 lease fence 阻断，而非其他原因。
    assert.ok(
      ctx.logMatched,
      `[${spec.kind}] expected log "${spec.expectedLogSkip}：Run 已终态或当前 worker 已丢失 lease" must have been emitted`,
    );
  }

  // ─────── 三场景独立驱动 + 独立断言 ────────────────────────────────
  for (const spec of STREAM_SPECS) {
    console.log(`\n[executor-terminal-lease-fence] scenario: ${spec.kind}`);
    const ctx = await runScenario(spec);
    await assertScenarioFenced(spec, ctx);
    console.log(`  ✓ ${spec.kind} fenced`);
  }

  console.log(
    `\n[executor-terminal-lease-fence] all three scenarios fenced`
    + ` (done | stopped | error)`,
  );
});
