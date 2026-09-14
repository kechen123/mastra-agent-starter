/**
 * V2 停止 / 终态收敛状态机单元测试。
 *
 * 覆盖场景（PR-review Item 2 5-state 模型 + Round 4 SSE/HTTP 竞态修复）：
 *   1. HTTP stop 200 先到 → finalize 后 status=stopped，SSE run-stopped
 *      后到 → duplicate no-op；
 *   2. SSE run-stopped 先到 → finalize 后 status=stopped，HTTP 200 后到
 *      → duplicate no-op（**关键竞态**：SSE handler 不能 null 化 state，
 *      HTTP 恢复路径必须走 applyTerminalSnapshot 的 null-safe 分支）；
 *   3. HTTP 失败 → finalize('http_stop_fail') 不翻 finalized（保留 SSE 兜底）；
 *   4. 用户点"停止" 但 HTTP 还在路上 → stop_requested 翻 isStopRequested，
 *      status 不变，finalized 不变；
 *   5. session_switch 在 queued 阶段 / 无 streamingAssistantIdRef → 仍
 *      应仅关流（不调后端 stop），由 shouldCloseStreamOnly 返回 false；
 *   6. session_leave → finalized=true 但 status 不变。
 *   7. applyTerminalSnapshot null-safe：state=null 时返回 applied=false，
 *      避免 SSE-first-then-HTTP 顺序的 null 解引用和重复副作用。
 *
 * Run with: npx tsx src/lib/stop-state-machine.test.ts
 */
import {
  applyTerminalSnapshot,
  awaitingRunStoppedOnPage,
  createAssistantStopState,
  finalizeAssistantStop,
  shouldCloseStreamOnly,
  type AssistantStopState,
} from './stop-state-machine';

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function makeState(overrides?: Partial<AssistantStopState>): AssistantStopState {
  return createAssistantStopState({
    assistantId: 'msg-1',
    runId: 'run-1',
    initialStatus: 'streaming',
    initialContent: 'partial content',
    ...overrides,
  });
}

const SNAP_HTTP = { content: 'http content', contentLength: 12, citations: [] as ReadonlyArray<unknown> };
const SNAP_SSE_WITH_CITES = {
  content: 'sse content',
  contentLength: 11,
  citations: [{ chunkId: 'c-1' }] as ReadonlyArray<unknown>,
};
const SNAP_SSE_NO_CITES = { content: 'sse content', contentLength: 11, citations: [] as ReadonlyArray<unknown> };

console.log('[stop-state] S1 — HTTP stop 200 先到 → finalize；SSE 后到 duplicate no-op');
{
  const s0 = makeState();
  // 用户点"停止"
  const s0Req = finalizeAssistantStop(s0, 'stop_requested');
  // HTTP 200：applyTerminalSnapshot 直接 finalize（不再 await SSE）。
  const r1 = applyTerminalSnapshot(s0Req, { kind: 'http_stop_ok', snapshot: SNAP_HTTP });
  assert('S1: HTTP 200 applied === true', r1.applied === true, `actual=${r1.applied}`);
  assert('S1: HTTP 200 state.finalized === true', r1.state?.finalized === true);
  assert('S1: HTTP 200 state.status === "stopped"', r1.state?.status === 'stopped');
  assert('S1: HTTP 200 state.finalizedBy === "http_stop_ok"',
    r1.state?.finalizedBy === 'http_stop_ok');
  // SSE run-stopped 后到：幂等 no-op
  const r2 = applyTerminalSnapshot(r1.state, { kind: 'sse_stopped', snapshot: SNAP_SSE_NO_CITES });
  assert('S1: SSE 后到 applied === false', r2.applied === false, `actual=${r2.applied}`);
  assert('S1: SSE 后到 state 引用稳定（同对象）', r2.state === r1.state);
  // SSE 后到但带了新 citations → citationsChanged=true 但 applied=false
  // （保留首次来源；调用方只触发 citations 应用）
  const r3 = applyTerminalSnapshot(r1.state, { kind: 'sse_stopped', snapshot: SNAP_SSE_WITH_CITES });
  assert('S1: SSE 带新 citations 后到 citationsChanged === true',
    r3.citationsChanged === true, `actual=${r3.citationsChanged}`);
  assert('S1: SSE 带新 citations 后到 applied === false（保留首次来源）',
    r3.applied === false);
}

console.log('\n[stop-state] S2 — SSE run-stopped 先到 → finalize；HTTP 后到 duplicate no-op（关键竞态）');
{
  const s0 = makeState();
  const s0Req = finalizeAssistantStop(s0, 'stop_requested');
  // SSE 先 finalize
  const r1 = applyTerminalSnapshot(s0Req, { kind: 'sse_stopped', snapshot: SNAP_SSE_NO_CITES });
  assert('S2: SSE 先到 applied === true', r1.applied === true, `actual=${r1.applied}`);
  assert('S2: SSE 先到 state.finalized === true', r1.state?.finalized === true);
  assert('S2: SSE 先到 state.status === "stopped"', r1.state?.status === 'stopped');
  assert('S2: SSE 先到 state.finalizedBy === "sse_stopped"',
    r1.state?.finalizedBy === 'sse_stopped');
  // PR-review Round 4 关键：HTTP 200 后到 → 必须 applied=false + 副作用 no-op
  const r2 = applyTerminalSnapshot(r1.state, { kind: 'http_stop_ok', snapshot: SNAP_HTTP });
  assert('S2: HTTP 后到 applied === false（**关键** SSE-first 不再触发 HTTP 副作用）',
    r2.applied === false, `actual=${r2.applied}`);
  assert('S2: HTTP 后到 state 引用稳定（同对象）', r2.state === r1.state);
  // 即便 HTTP 带了新 citations 也不重置 finalized 来源
  const r3 = applyTerminalSnapshot(r1.state, {
    kind: 'http_stop_ok',
    snapshot: SNAP_SSE_WITH_CITES,
  });
  assert('S2: HTTP 后到即便带 citations applied 仍 === false',
    r3.applied === false, `actual=${r3.applied}`);
}

console.log('\n[stop-state] S3 — SSE 先 finalize 然后 state 被外部清空 → HTTP 恢复 null-safe');
{
  // 模拟 SSE 已 finalize 后，SSE handler 把 stopStateRef.current 设为 null
  // 的最坏情况（即便我们的契约不允许，applyTerminalSnapshot 也必须
  // 不抛错、返回 applied=false、调用方不进入失败路径）。
  const r = applyTerminalSnapshot(null, { kind: 'http_stop_ok', snapshot: SNAP_HTTP });
  assert('S3: state=null → applied === false', r.applied === false, `actual=${r.applied}`);
  assert('S3: state=null → state 仍为 null（不臆造 state）', r.state === null);
  assert('S3: state=null → citationsChanged === false', r.citationsChanged === false);
}

console.log('\n[stop-state] S4 — HTTP stop 失败路径 → SSE 兜底');
{
  const s0 = makeState();
  const s0Req = finalizeAssistantStop(s0, 'stop_requested');
  // 模拟 HTTP 抛错：调用方走 http_stop_fail 路径
  const sFail = finalizeAssistantStop(s0Req, 'http_stop_fail');
  assert('S4: HTTP 失败 → status 仍 streaming', sFail.status === 'streaming',
    `actual=${sFail.status}`);
  assert('S4: HTTP 失败 → finalized=false（让 SSE 仍能兜底）',
    sFail.finalized === false);
  assert('S4: HTTP 失败 → hasReportedHttpFailure=true',
    sFail.hasReportedHttpFailure === true);
  assert('S4: HTTP 失败 → isStopRequested=true',
    sFail.isStopRequested === true);
  // 之后 SSE run-stopped 到达，仍可走 sse_stopped 收敛
  const r = applyTerminalSnapshot(sFail, { kind: 'sse_stopped', snapshot: SNAP_SSE_NO_CITES });
  assert('S4: 失败后 SSE run-stopped 仍能 finalize applied=true',
    r.applied === true, `actual=${r.applied}`);
  assert('S4: SSE 兜底后 state.status === "stopped"', r.state?.status === 'stopped');
}

console.log('\n[stop-state] S5 — 用户点"停止" 后立即多次触发 stop_requested → 幂等');
{
  const s0 = makeState();
  const s1 = finalizeAssistantStop(s0, 'stop_requested');
  const s2 = finalizeAssistantStop(s1, 'stop_requested');
  const s3 = finalizeAssistantStop(s2, 'stop_requested');
  assert('S5: 多次 stop_requested → finalized=false', s3.finalized === false);
  assert('S5: 多次 stop_requested → status 仍 streaming', s3.status === 'streaming');
  assert('S5: 多次 stop_requested → isStopRequested=true',
    s3.isStopRequested === true);
}

console.log('\n[stop-state] S6 — session_leave → finalized=true 但 status 不变');
{
  const s0 = makeState({ initialStatus: 'streaming' });
  const s1 = finalizeAssistantStop(s0, 'session_leave');
  assert('S6: status === "streaming"（未变）', s1.status === 'streaming',
    `actual=${s1.status}`);
  assert('S6: finalized === true（闸门翻开）', s1.finalized === true);
  assert('S6: finalizedBy === "session_leave"', s1.finalizedBy === 'session_leave');
  const s2 = finalizeAssistantStop(s1, 'sse_stopped', { content: 'later' });
  assert('S6: session_leave 之后 sse_stopped → status 仍 streaming',
    s2.status === 'streaming');
}

console.log('\n[stop-state] S7 — shouldCloseStreamOnly + awaitingRunStoppedOnPage 各种组合');
{
  // streaming + 未请求 stop → true（仅关流，session-leave 总是允许）
  const a = shouldCloseStreamOnly({ isStreaming: true, isStopRequested: false, isFinalized: false });
  assert('S7a: streaming 但未请求 stop → close-stream-only', a === true, `actual=${a}`);
  // 未 streaming → false
  const b = shouldCloseStreamOnly({ isStreaming: false, isStopRequested: false, isFinalized: false });
  assert('S7b: 未 streaming → false', b === false);
  // PR-review Round 2 Item 5：HTTP 失败 + 未 finalize 也允许 session-leave 关流。
  const c = shouldCloseStreamOnly({ isStreaming: true, isStopRequested: true, isFinalized: false });
  assert('S7c: 已点停止未 finalize + session-leave → true（关流，后端 Run 自然完成）',
    c === true, `actual=${c}`);
  // streaming + 已点停止 + 已 finalize → true（关流）
  const d = shouldCloseStreamOnly({ isStreaming: true, isStopRequested: true, isFinalized: true });
  assert('S7d: 已点停止且已 finalize → true（关流）', d === true, `actual=${d}`);
  // queued 阶段 + 未点停止 + 未 finalize（isStreaming=false） → false
  const e = shouldCloseStreamOnly({ isStreaming: false, isStopRequested: false, isFinalized: false });
  assert('S7e: queued 阶段 session switch → false（不调 stop）', e === false, `actual=${e}`);

  // awaitingRunStoppedOnPage：用户停留在同一 assistant 页面等待 SSE run-stopped
  const aw1 = awaitingRunStoppedOnPage({ isStopRequested: true, isFinalized: false, hasStreamingAssistant: true });
  assert('S7f: 已点停止 + 未 finalize + 停留在 assistant → awaiting=true', aw1 === true,
    `actual=${aw1}`);
  const aw2 = awaitingRunStoppedOnPage({ isStopRequested: true, isFinalized: true, hasStreamingAssistant: true });
  assert('S7g: 已点停止 + 已 finalize → awaiting=false（已收敛）', aw2 === false,
    `actual=${aw2}`);
  const aw3 = awaitingRunStoppedOnPage({ isStopRequested: false, isFinalized: false, hasStreamingAssistant: true });
  assert('S7h: 未点停止 → awaiting=false', aw3 === false);
  const aw4 = awaitingRunStoppedOnPage({ isStopRequested: true, isFinalized: false, hasStreamingAssistant: false });
  assert('S7i: 已离开 assistant 页面 → awaiting=false', aw4 === false);
}

console.log('\n[stop-state] S8 — finalizeAssistantStop 不可变性');
{
  const s0 = makeState();
  const s1 = finalizeAssistantStop(s0, 'http_stop_ok');
  assert('S8: s0 未被 mutate（status 仍 streaming）', s0.status === 'streaming');
  assert('S8: s0 未被 mutate（finalized 仍 false）', s0.finalized === false);
  assert('S8: s1 是新对象', s1 !== s0);
}

console.log('\n[stop-state] S9 — applyTerminalSnapshot 不 mutate 入参');
{
  const s0 = makeState();
  const s1 = applyTerminalSnapshot(s0, { kind: 'http_stop_ok', snapshot: SNAP_HTTP });
  assert('S9: s0 未被 mutate（status 仍 streaming）', s0.status === 'streaming');
  assert('S9: s0 未被 mutate（finalized 仍 false）', s0.finalized === false);
  assert('S9: s1.state 是新对象', s1.state !== s0);
}

console.log('\n[stop-state] S10 — SSE-first-then-HTTP：HTTP 仍可补齐 citations（PR-review Round 5）');
{
  // 场景：SSE 先到（带不完整 / 早期 citations），HTTP 后到（带后端
  // 事务内合并后的最终 citations）。HTTP 必须 applied=false（不重复
  // 终态副作用），但 citationsChanged=true（让前端 update citations）。
  const s0 = makeState();
  const s0Req = finalizeAssistantStop(s0, 'stop_requested');
  const sseEarlyCites = [{ chunkId: 'c-1', score: 0.5 }];
  const sseSnap = {
    content: 'partial content',
    contentLength: 15,
    citations: sseEarlyCites as ReadonlyArray<unknown>,
  };
  const r1 = applyTerminalSnapshot(s0Req, { kind: 'sse_stopped', snapshot: sseSnap });
  assert('S10: SSE 先到 applied === true', r1.applied === true);
  assert('S10: SSE 先到 citationsChanged === true',
    r1.citationsChanged === true, `actual=${r1.citationsChanged}`);
  // HTTP 后到带"最终"citations（多了一条 c-2，是后端合并 DB 已有引用后的结果）
  const httpFinalCites = [
    { chunkId: 'c-1', score: 0.5 },
    { chunkId: 'c-2', score: 0.4 },
  ];
  const httpSnap = {
    content: 'partial content',
    contentLength: 15,
    citations: httpFinalCites as ReadonlyArray<unknown>,
  };
  const r2 = applyTerminalSnapshot(r1.state, { kind: 'http_stop_ok', snapshot: httpSnap });
  assert('S10: HTTP 后到 applied === false（不重复终态副作用）',
    r2.applied === false, `actual=${r2.applied}`);
  assert('S10: HTTP 后到 citationsChanged === true（让前端补齐最终引用）',
    r2.citationsChanged === true, `actual=${r2.citationsChanged}`);
  // 验证反向：HTTP 后到带空 citations → citationsChanged === false
  //   （空数组不触发更新；PR-review Round 5 Item 1 修复的最小契约）
  const r3 = applyTerminalSnapshot(r1.state, {
    kind: 'http_stop_ok',
    snapshot: { content: 'x', contentLength: 1, citations: [] as ReadonlyArray<unknown> },
  });
  assert('S10: HTTP 后到 citations 为空时 citationsChanged === false',
    r3.citationsChanged === false);
}

console.log('\n[stop-state] S11 — SSE-empty-then-HTTP-non-empty（PR-review Round 6 回归）');
{
  // 场景：SSE 先到达但 citations=[]（旧后端实现 bug 的残留影响，或
  //   executor 在 abort 期间没累积到引用），HTTP 后到达带 DB 已保留
  //   的最终引用。前端必须能识别 HTTP 带了非空 citations 并补齐 UI，
  //   不应因 applied=false 就吞掉所有副作用。
  const s0 = makeState();
  const s0Req = finalizeAssistantStop(s0, 'stop_requested');
  const sseEmptyCites: ReadonlyArray<unknown> = [];
  const sseSnap = {
    content: 'partial content',
    contentLength: 15,
    citations: sseEmptyCites,
  };
  const r1 = applyTerminalSnapshot(s0Req, { kind: 'sse_stopped', snapshot: sseSnap });
  assert('S11: SSE 空 citations 先到 applied === true',
    r1.applied === true);
  assert('S11: SSE 空 citations 先到 citationsChanged === false（空数组不触发）',
    r1.citationsChanged === false, `actual=${r1.citationsChanged}`);
  // HTTP 后到达，带 DB 已保留的最终 citations（PR-review Round 6 Item 1
  //   修复后，后端 stopRunByMessageId 会从 messages.citations 取 DB 值
  //   返回 HTTP response）。
  const httpFinalCites = [
    { chunkId: 'c-1', score: 0.5 },
    { chunkId: 'c-2', score: 0.6 },
  ];
  const httpSnap = {
    content: 'partial content',
    contentLength: 15,
    citations: httpFinalCites as ReadonlyArray<unknown>,
  };
  const r2 = applyTerminalSnapshot(r1.state, { kind: 'http_stop_ok', snapshot: httpSnap });
  assert('S11: HTTP 后到 applied === false（不重复终态副作用）',
    r2.applied === false, `actual=${r2.applied}`);
  assert('S11: HTTP 后到 citationsChanged === true（**关键** 补齐 DB 引用）',
    r2.citationsChanged === true, `actual=${r2.citationsChanged}`);
  // 验证反向：HTTP 也带空 citations → 不触发更新
  const r3 = applyTerminalSnapshot(r1.state, {
    kind: 'http_stop_ok',
    snapshot: { content: 'x', contentLength: 1, citations: [] as ReadonlyArray<unknown> },
  });
  assert('S11: HTTP 也空 citations 时 citationsChanged === false',
    r3.citationsChanged === false);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
