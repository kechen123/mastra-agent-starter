/**
 * PR-review Round 2 后端 stop / 引用 / Tool 收敛测试。
 *
 * 覆盖：
 *   - C1：citations dedup-by-chunkId（同 chunkId 不重复，incoming 优先）
 *   - C2：snapshots 空数组（[]）不覆写 DB 现有 citations
 *   - C3：snapshots undefined/null 不覆写 DB 现有 citations
 *   - C4：snapshots 非空且与 DB 重叠 → 取并集（DB 残留保留追加）
 *   - T1：tool backfill 缺失 start 行 → 保留 input.status（success/error），
 *         error 字段追加 ';finalized_without_start' 标记
 *   - S1：run-stopped/run-completed SSE payload 必须包含 citations（即便为空数组）
 *
 * 关键约束（PR-review Round 3 Item 3 修复）：
 *   本文件**不**再复制 mergeCitations / pickBackfillStatus /
 *   buildBackfillError / buildRunStoppedPayload 等逻辑；统一
 *   import 后端生产实现，确保任何实现漂移立即让本测试失败。
 *   DB 行为（UNIQUE / 部分索引 / backfill SQL）走
 *   `tests/integration/stop-tool-rag.ts` 并由 TEST_DATABASE_URL 闸门控制。
 *
 * 不连真实 DB；纯逻辑断言生产模块导出。
 * Run with: npx tsx tests/unit/round2-citations-tool-backfill.ts
 */

import {
  buildRunTerminalPayload,
  mergeCitationsByChunkId,
  type CitationLike,
} from '../../src/modules/runs/citation-merge.js';
import {
  buildBackfillError,
  pickBackfillStatus,
} from '../../src/modules/conversations/tool-executions.js';

let passed = 0;
let failed = 0;
function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ─────────────── Citation dedup（生产实现） ───────────────

console.log('[round2] C1 — 同 chunkId 去重（incoming 优先）');
{
  const existing: Array<CitationLike> = [
    { chunkId: 'c-1', score: 0.5 },
    { chunkId: 'c-2', score: 0.6 },
  ];
  const incoming: Array<CitationLike> = [
    { chunkId: 'c-1', score: 0.9 }, // 覆盖 c-1
    { chunkId: 'c-3', score: 0.7 },
  ];
  const r = mergeCitationsByChunkId(existing, incoming);
  assert('C1: write === true', r.write === true);
  assert('C1: merged 长度 === 3（去重）', r.merged.length === 3, `actual=${r.merged.length}`);
  const c1 = r.merged.find((c) => c.chunkId === 'c-1');
  assert('C1: c-1 取 incoming（score=0.9）', (c1?.score as number) === 0.9,
    `actual=${c1?.score}`);
  assert('C1: c-2 保留', r.merged.some((c) => c.chunkId === 'c-2'));
  assert('C1: c-3 新增', r.merged.some((c) => c.chunkId === 'c-3'));
}

console.log('\n[round2] C2 — incoming 为空数组 → 不覆写');
{
  const existing: Array<CitationLike> = [{ chunkId: 'c-1', score: 0.5 }];
  const r = mergeCitationsByChunkId(existing, []);
  assert('C2: write === false', r.write === false);
  assert('C2: 保留 DB 原值', r.merged.length === 1 && r.merged[0]?.chunkId === 'c-1');
  assert('C2: merged 是新数组（不与 existing 共享顶层引用）',
    r.merged !== existing, `actual same ref`);
}

console.log('\n[round2] C3 — incoming null/undefined → 不覆写');
{
  const existing: Array<CitationLike> = [{ chunkId: 'c-1', score: 0.5 }];
  const r1 = mergeCitationsByChunkId(existing, null);
  const r2 = mergeCitationsByChunkId(existing, undefined);
  assert('C3: null → write=false', r1.write === false);
  assert('C3: undefined → write=false', r2.write === false);
  assert('C3: null → 保留原值', r1.merged.length === 1);
  assert('C3: undefined → 保留原值', r2.merged.length === 1);
}

console.log('\n[round2] C4 — incoming 与 DB 重叠 → DB 残留保留追加');
{
  const existing: Array<CitationLike> = [
    { chunkId: 'c-1', score: 0.5 },
    { chunkId: 'c-2', score: 0.6 },
    { chunkId: 'c-4', score: 0.4 }, // DB 独有
  ];
  const incoming: Array<CitationLike> = [{ chunkId: 'c-1', score: 0.9 }];
  const r = mergeCitationsByChunkId(existing, incoming);
  assert('C4: merged 长度 === 3（c-1 覆盖，c-2/c-4 保留）', r.merged.length === 3,
    `actual=${r.merged.length}`);
  assert('C4: c-4（DB 独有）被保留',
    r.merged.some((c) => c.chunkId === 'c-4'));
}

// ─────────────── Tool backfill status preservation（生产实现） ───────────────

console.log('\n[round2] T1 — backfill 保留 input.status');
{
  assert('T1a: success → success', pickBackfillStatus('success') === 'success');
  assert('T1b: error → error', pickBackfillStatus('error') === 'error');
  assert('T1c: cancelled → cancelled', pickBackfillStatus('cancelled') === 'cancelled');
  assert('T1d: error 字段标记 finalized_without_start',
    buildBackfillError('tool_error') === 'tool_error;finalized_without_start');
  assert('T1e: 无 error 时仅标记',
    buildBackfillError(undefined) === 'finalized_without_start');
}

// ─────────────── Run-stopped / run-completed SSE payload（生产实现） ───────────────

console.log('\n[round2] S1 — run-terminal payload 包含 contentLength + citations');
{
  const p1 = buildRunTerminalPayload('hello world', [{ chunkId: 'c-1' }]);
  assert('S1: contentLength === 11', p1.contentLength === 11);
  assert('S1: citations 长度 === 1', p1.citations.length === 1);
  assert('S1: 空 citations 也保留字段',
    Array.isArray(buildRunTerminalPayload('', []).citations) === true);
  assert('S1: null citations 也归一为空数组',
    Array.isArray(buildRunTerminalPayload('x', null as unknown as ReadonlyArray<CitationLike>).citations) === true);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
