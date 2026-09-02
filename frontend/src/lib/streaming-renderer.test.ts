/**
 * 流式渲染状态机单元测试（PR-2.4 双通道 SSE 前端合并策略）。
 *
 * 覆盖场景：
 *   - 实时 delta 单独追加；
 *   - 实时 delta → 包含该 delta 的 checkpoint 收敛（不得重复追加）；
 *   - 实时 delta 推进得更远 → checkpoint 短时保留实时文本；
 *   - 非前缀 checkpoint → 重置；
 *   - 终态排队（仅在全部渲染后才切换 status）；
 *   - reset 行为；
 *
 * Run with: npx tsx src/lib/streaming-renderer.test.ts
 */
import {
  applyCheckpoint,
  applyDelta,
  createRendererState,
  markTerminal,
  resetRenderer,
  type RendererOps,
} from './streaming-renderer';

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

/**
 * 用队列模拟 rAF；`flushAll()` 逐帧执行所有回调。
 *
 * 这样测试不依赖真实 rAF 时序，但仍能验证"apply*() 排队 → flush 实际写入"。
 */
function makeOps(): RendererOps & {
  flushAll(): void;
  pendingCount(): number;
  domWrites: string[];
  terminalStatus: string | null;
} {
  const queue: Array<() => void> = [];
  const ops = {
    domWrites: [] as string[],
    terminalStatus: null as string | null,
    scheduleRaf(cb: () => void): number {
      queue.push(cb);
      return queue.length;
    },
    cancelRaf(_h: number): void {
      // 测试不依赖精确句柄：队列长度变更仅用于诊断。
    },
    writeToDom(fullText: string): void {
      ops.domWrites.push(fullText);
    },
    setTerminalStatus(status: 'completed' | 'stopped' | 'failed'): void {
      ops.terminalStatus = status;
    },
    flushAll(): void {
      while (queue.length > 0) {
        const cb = queue.shift()!;
        cb();
      }
    },
    pendingCount(): number {
      return queue.length;
    },
  };
  return ops;
}

console.log('[renderer] R1 — 实时 delta 单独追加（happy path）');
{
  const state = createRendererState();
  const ops = makeOps();
  applyDelta(state, 'abc', ops);
  ops.flushAll();
  assert('R1: 每帧只推进一个字符',
    JSON.stringify(ops.domWrites) === JSON.stringify(['a', 'ab', 'abc']),
    `actual=${JSON.stringify(ops.domWrites)}`);
  assert('R1: targetText === "abc"', state.targetText === 'abc');
  applyDelta(state, 'def', ops);
  ops.flushAll();
  assert('R1: 第二轮最终写入 === "abcdef"', ops.domWrites[ops.domWrites.length - 1] === 'abcdef',
    `actual=${JSON.stringify(ops.domWrites)}`);
}

console.log('\n[renderer] R2 — 已收到 live delta、未 RAF flush 时收到包含该 delta 的 checkpoint');
{
  // PR-2.4 修复回归：appendLiveDelta + applyCheckpoint 不得重复追加。
  const state = createRendererState();
  const ops = makeOps();
  // step 1：先到 checkpoint 'ab'，并 flush（模拟 rAF 已渲染）。
  applyCheckpoint(state, 'ab', ops);
  ops.flushAll();
  // step 2：来实时 delta 'c'，但还没 RAF flush（pending raf）。
  applyDelta(state, 'c', ops);
  assert('R2: 调度了 1 帧 raf 但尚未执行', ops.pendingCount() === 1);
  // step 3：来 'abc' checkpoint（含 step 2 的 delta 内容）。此时：
  //   - targetText 当前 === 'abc'（'ab' + 'c'）
  //   - checkpoint === 'abc'
  //   - 应当 no-op（targetText === checkpoint），不再额外写入 dom。
  applyCheckpoint(state, 'abc', ops);
  // step 4：执行 flush；只会再写一次 targetText='abc'（幂等）。
  ops.flushAll();
  assert('R2: 最终 targetText === "abc"', state.targetText === 'abc',
    `actual=${JSON.stringify(state.targetText)}`);
  // 关键断言：final 写入必须是 "abc"，不得出现 "abcabc" / "abcbc"。
  const lastWrite = ops.domWrites[ops.domWrites.length - 1];
  assert('R2: 最后一次 dom 写入 === "abc"，不重复',
    lastWrite === 'abc',
    `actual=${JSON.stringify(ops.domWrites)}`);
  assert('R2: 全程没有写入 "abcabc" / "abcbc" 等重复',
    !ops.domWrites.includes('abcabc') && !ops.domWrites.includes('abcbc'),
    `actual=${JSON.stringify(ops.domWrites)}`);
}

console.log('\n[renderer] R3 — 实时 delta 推进得更远，checkpoint 短时不回退');
{
  const state = createRendererState();
  const ops = makeOps();
  applyCheckpoint(state, 'abc', ops);
  applyDelta(state, 'def', ops);
  ops.flushAll();
  assert('R3: targetText === "abcdef"', state.targetText === 'abcdef');
  // 旧 checkpoint 到达：'abc'，已不再更长前缀但仍是前缀 → 保留实时文本。
  applyCheckpoint(state, 'abc', ops);
  ops.flushAll();
  assert('R3: targetText 仍是 "abcdef"，不被旧 checkpoint 回退',
    state.targetText === 'abcdef',
    `actual=${JSON.stringify(state.targetText)}`);
}

console.log('\n[renderer] R4 — 非前缀 checkpoint 覆盖（含语义不可比）');
{
  const state = createRendererState();
  const ops = makeOps();
  applyDelta(state, '你好', ops);
  applyDelta(state, ' world', ops);
  ops.flushAll();
  // 收到一个完全不前缀的 checkpoint（异常路径，例如后端重传或断线续传异常）。
  applyCheckpoint(state, '全新文本', ops);
  ops.flushAll();
  assert('R4: targetText 收敛到 checkpoint', state.targetText === '全新文本',
    `actual=${JSON.stringify(state.targetText)}`);
  assert('R4: dom 写入至少出现 "全新文本"',
    ops.domWrites.includes('全新文本'),
    `actual=${JSON.stringify(ops.domWrites)}`);
}

console.log('\n[renderer] R5 — 终态排队：仅当全部渲染后才切换 status');
{
  const state = createRendererState();
  const ops = makeOps();
  applyDelta(state, 'partial', ops);
  // 未 flush：标记终态。
  markTerminal(state, 'completed', ops);
  ops.flushAll();
  assert('R5: 终态 === "completed"', ops.terminalStatus === 'completed');
  assert('R5: dom 写入 === "partial"', ops.domWrites[ops.domWrites.length - 1] === 'partial');
}

console.log('\n[renderer] R6 — 多帧多次：高频 delta 不重复字符');
{
  const state = createRendererState();
  const ops = makeOps();
  for (const ch of 'hello world') {
    applyDelta(state, ch, ops);
  }
  ops.flushAll();
  assert('R6: targetText === "hello world"', state.targetText === 'hello world');
  assert('R6: 每一帧只追加一个字符，末帧为完整文本',
    ops.domWrites.length === Array.from('hello world').length && ops.domWrites[ops.domWrites.length - 1] === 'hello world',
    `actual=${JSON.stringify(ops.domWrites)}`);
}

console.log('\n[renderer] R7 — reset 行为');
{
  const state = createRendererState();
  const ops = makeOps();
  applyDelta(state, 'partial', ops);
  ops.flushAll();
  resetRenderer(state, ops);
  assert('R7: targetText 清空', state.targetText === '');
  assert('R7: renderedPrefixLength === 0', state.renderedPrefixLength === 0);
  assert('R7: pendingTerminal === null', state.pendingTerminal === null);
  assert('R7: rafHandle === null', state.rafHandle === null);
}

console.log('\n[renderer] R8 — 中文 / emoji 多字节字符不重复');
{
  const state = createRendererState();
  const ops = makeOps();
  applyDelta(state, '你好', ops);
  applyDelta(state, '🚀', ops);
  applyCheckpoint(state, '你好🌏', ops);
  ops.flushAll();
  assert('R8: targetText === "你好🌏"', state.targetText === '你好🌏',
    `actual=${JSON.stringify(state.targetText)}`);
  // dom 写入序列不能含重复字符：用 codePoint 计数校验。
  const lastWrite = ops.domWrites[ops.domWrites.length - 1]!;
  const cp = Array.from(lastWrite);
  assert('R8: 最后一次 dom 写入 === "你好🌏"（3 codePoints）',
    lastWrite === '你好🌏' && cp.length === 3,
    `actual cp=${JSON.stringify(cp)}`);
  // 关键：不能出现"你好🌏你好🌏"或"你好🌏🚀"等重叠写入。
  assert('R8: 完整文本仅在最后一帧写入一次',
    ops.domWrites.filter((w) => w === '你好🌏').length === 1,
    `actual=${JSON.stringify(ops.domWrites)}`);
}

console.log('\n[renderer] R9 — emoji 作为一个视觉字符推进，绝不拆 surrogate pair');
{
  const state = createRendererState();
  const ops = makeOps();
  applyDelta(state, 'A🚀B', ops);
  ops.flushAll();
  assert('R9: 写入序列为 A → A🚀 → A🚀B',
    JSON.stringify(ops.domWrites) === JSON.stringify(['A', 'A🚀', 'A🚀B']),
    `actual=${JSON.stringify(ops.domWrites)}`);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
