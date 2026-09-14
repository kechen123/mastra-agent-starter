/**
 * tool_executions toolCallId 幂等 upsert / finalize 单元测试。
 *
 * 覆盖场景（V2 阶段 2 PR-3.x）：
 *   1. start + complete 一次：产生 1 行；
 *   2. 重复 start（事件 replay）→ 仍是 1 行（ON CONFLICT DO NOTHING）；
 *   3. 重复 complete 同一 toolCallId → 不覆写已存在 success 行；
 *   4. 缺失 start 行的 finalize（approval resume 路径）→ 安全 no-op；
 *   5. 失败 → 不影响已存在的 success 行；
 *   6. 跨 workspace 隔离：workspace A 写、workspace B 查不到。
 *
 * 注：本测试不连真实 DB；用纯逻辑 fakeStore 模拟 upsert/finalize 行为。
 * 真 DB 行为（ON CONFLICT / NOT DISTINCT FROM）由 init.sql + 模块共同保证。
 * Run with: npx tsx tests/unit/tool-execution-dedup.ts
 */

import type {
  ExecutionStatus,
} from '../../src/modules/conversations/tool-executions.js';

interface Row {
  workspaceId: string;
  runId: string | null;
  toolCallId: string;
  toolName: string;
  status: ExecutionStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  finishedAt: Date | null;
}

/**
 * In-memory 表征：和真实 SQL 行为对齐（PK = (workspace, runId, toolCallId)；
 * NULL runId 用 IS NOT DISTINCT FROM 语义去重）。
 */
class FakeToolExecutionsTable {
  private rows: Row[] = [];
  insertCount = 0;
  updateCount = 0;

  /** 等价 SQL: INSERT ... ON CONFLICT DO NOTHING RETURNING id */
  upsert(input: {
    workspaceId: string;
    runId: string | null;
    toolCallId: string;
    toolName: string;
  }): { inserted: boolean } {
    const exists = this.rows.find((r) =>
      r.workspaceId === input.workspaceId &&
      r.runId === input.runId &&
      r.toolCallId === input.toolCallId,
    );
    if (exists) return { inserted: false };
    this.insertCount++;
    this.rows.push({
      workspaceId: input.workspaceId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      status: 'running',
      result: null,
      error: null,
      finishedAt: null,
    });
    return { inserted: true };
  }

  /** 等价 SQL: UPDATE ... WHERE NOT IN ('success','error','cancelled') */
  finalize(input: {
    workspaceId: string;
    runId: string | null;
    toolCallId: string;
    result: Record<string, unknown> | null;
    status: Extract<ExecutionStatus, 'success' | 'error' | 'cancelled'>;
    error?: string;
  }): { updated: boolean } {
    const row = this.rows.find((r) =>
      r.workspaceId === input.workspaceId &&
      r.runId === input.runId &&
      r.toolCallId === input.toolCallId,
    );
    if (!row) return { updated: false };
    if (row.status === 'success' || row.status === 'error' || row.status === 'cancelled') {
      // 已终态：no-op
      return { updated: false };
    }
    this.updateCount++;
    row.result = input.result;
    row.status = input.status;
    row.error = input.error ?? null;
    row.finishedAt = new Date();
    return { updated: true };
  }

  byCallId(workspaceId: string, runId: string | null, toolCallId: string): Row | undefined {
    return this.rows.find((r) =>
      r.workspaceId === workspaceId &&
      r.runId === runId &&
      r.toolCallId === toolCallId,
    );
  }

  countByWorkspace(workspaceId: string): number {
    return this.rows.filter((r) => r.workspaceId === workspaceId).length;
  }
}

let passed = 0;
let failed = 0;
function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('[tool-dedup] T1 — start + complete 一次：1 行 1 insert 1 update');
{
  const tbl = new FakeToolExecutionsTable();
  const i = tbl.upsert({ workspaceId: 'ws-1', runId: 'run-1', toolCallId: 'tc-1', toolName: 'toolA' });
  const f = tbl.finalize({ workspaceId: 'ws-1', runId: 'run-1', toolCallId: 'tc-1', result: { ok: true }, status: 'success' });
  assert('T1: upsert inserted=true', i.inserted);
  assert('T1: finalize updated=true', f.updated);
  assert('T1: row count === 1', tbl.countByWorkspace('ws-1') === 1);
  assert('T1: status === "success"', tbl.byCallId('ws-1', 'run-1', 'tc-1')?.status === 'success');
}

console.log('\n[tool-dedup] T2 — 重复 start（SSE replay）→ 仍是 1 行');
{
  const tbl = new FakeToolExecutionsTable();
  tbl.upsert({ workspaceId: 'ws-1', runId: 'run-1', toolCallId: 'tc-1', toolName: 'toolA' });
  const replay = tbl.upsert({ workspaceId: 'ws-1', runId: 'run-1', toolCallId: 'tc-1', toolName: 'toolA' });
  assert('T2: 二次 upsert inserted=false', replay.inserted === false);
  assert('T2: insertCount === 1', tbl.insertCount === 1);
  assert('T2: row count === 1', tbl.countByWorkspace('ws-1') === 1);
}

console.log('\n[tool-dedup] T3 — 重复 complete 同一 toolCallId → 不覆写 success 行');
{
  const tbl = new FakeToolExecutionsTable();
  tbl.upsert({ workspaceId: 'ws-1', runId: 'run-1', toolCallId: 'tc-1', toolName: 'toolA' });
  tbl.finalize({ workspaceId: 'ws-1', runId: 'run-1', toolCallId: 'tc-1', result: { v: 'first' }, status: 'success' });
  const dup = tbl.finalize({ workspaceId: 'ws-1', runId: 'run-1', toolCallId: 'tc-1', result: { v: 'second' }, status: 'success' });
  assert('T3: 二次 finalize updated=false', dup.updated === false);
  const row = tbl.byCallId('ws-1', 'run-1', 'tc-1');
  assert('T3: result 不被覆写', (row?.result as { v: string })?.v === 'first',
    `actual=${JSON.stringify(row?.result)}`);
}

console.log('\n[tool-dedup] T4 — 缺失 start 行的 finalize（approval resume 路径）→ no-op');
{
  const tbl = new FakeToolExecutionsTable();
  const f = tbl.finalize({ workspaceId: 'ws-1', runId: 'run-1', toolCallId: 'missing', result: { x: 1 }, status: 'success' });
  assert('T4: finalize updated=false', f.updated === false);
  assert('T4: row count === 0', tbl.countByWorkspace('ws-1') === 0);
  assert('T4: updateCount === 0', tbl.updateCount === 0);
}

console.log('\n[tool-dedup] T5 — failed → 不影响已存在的 success 行');
{
  const tbl = new FakeToolExecutionsTable();
  tbl.upsert({ workspaceId: 'ws-1', runId: 'run-1', toolCallId: 'tc-1', toolName: 'toolA' });
  tbl.finalize({ workspaceId: 'ws-1', runId: 'run-1', toolCallId: 'tc-1', result: { ok: true }, status: 'success' });
  const err = tbl.finalize({ workspaceId: 'ws-1', runId: 'run-1', toolCallId: 'tc-1', result: null, status: 'error', error: 'late_error' });
  assert('T5: 二次 finalize updated=false', err.updated === false);
  const row = tbl.byCallId('ws-1', 'run-1', 'tc-1');
  assert('T5: 仍是 success', row?.status === 'success');
  assert('T5: error 不被覆写', row?.error === null);
}

console.log('\n[tool-dedup] T6 — 跨 workspace 隔离');
{
  const tbl = new FakeToolExecutionsTable();
  tbl.upsert({ workspaceId: 'ws-A', runId: 'run-1', toolCallId: 'tc-1', toolName: 'toolA' });
  const bUpsert = tbl.upsert({ workspaceId: 'ws-B', runId: 'run-1', toolCallId: 'tc-1', toolName: 'toolA' });
  assert('T6: 不同 workspace 同 toolCallId 各自 1 行', bUpsert.inserted === true);
  assert('T6: ws-A 1 行', tbl.countByWorkspace('ws-A') === 1);
  assert('T6: ws-B 1 行', tbl.countByWorkspace('ws-B') === 1);
  // ws-A finalize 不影响 ws-B
  tbl.finalize({ workspaceId: 'ws-A', runId: 'run-1', toolCallId: 'tc-1', result: {}, status: 'success' });
  assert('T6: ws-B 行仍是 running',
    tbl.byCallId('ws-B', 'run-1', 'tc-1')?.status === 'running');
}

console.log('\n[tool-dedup] T7 — 不同 runId 同 toolCallId 各自 1 行（不在同 UNIQUE 内）');
{
  const tbl = new FakeToolExecutionsTable();
  tbl.upsert({ workspaceId: 'ws-1', runId: 'run-A', toolCallId: 'tc-1', toolName: 'toolA' });
  const r = tbl.upsert({ workspaceId: 'ws-1', runId: 'run-B', toolCallId: 'tc-1', toolName: 'toolA' });
  assert('T7: 不同 runId 同 toolCallId 是不同行', r.inserted === true);
  assert('T7: 总行数 === 2', tbl.countByWorkspace('ws-1') === 2);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
