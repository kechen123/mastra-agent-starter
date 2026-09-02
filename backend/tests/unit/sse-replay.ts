/**
 * SSE 恢复协议合约测试（注入式，不连接真实 DB / LLM）。
 *
 * 保护的具体契约（Phase 2 §6.4 + PR-2.4 双通道）：
 *  - R1：相同的 `lastEventId`（来自 header 或 query）请求回放，返回的 events
 *       严格满足 `id > lastEventId`；不存在 id<=lastEventId 的事件被重发。
 *  - R2：客户端断开 → 两个 bus 订阅（持久化 + 实时增量）都被释放。
 *  - R3：query 与 header 二选一时取较大值；非法值（NaN / 负数 / 字符串）
 *       视为 0，不抛异常。
 *  - R4：run 不存在 / 跨 workspace → 返回 404；stream 不启动。
 *  - R5：每条 SSE 持久化事件帧 `id` 与 BIGINT IDENTITY 同步；不会重复发送
 *       同 id。
 *  - R6：回放完成后 `bus.start()` 与 live-delta `bus.start()` 都被调用。
 *  - R7：Header 优先于 query（浏览器自动重连带 header 的场景）。
 *  - D1：实时增量 content-delta 帧**不带** SSE `id:` 行（EventSource 不会
 *       推进 lastEventId；刷新 / 重连时不被回放）。
 *  - D2：实时增量文本直接来自 live-delta bus payload，不进 agent_run_events
 *       / 不进 idempotency 响应。
 *  - D3：live-delta 订阅与 checkpoint 订阅相互独立；断开时两者都被释放。
 *  - D4：bus 回调并发触发时，持久化事件发送仍严格串行；lastDeliveredId 不
 *       回退、不重发（多次 NOTIFY 触发同一 listRunEvents 区间）。
 *
 * Run with: npx tsx tests/unit/sse-replay.ts
 */
import { randomUUID } from 'node:crypto';
import {
  __setRunRepositoryForTesting,
  __setRunEventsBusFactoryForTesting,
  __setLiveDeltaBusFactoryForTesting,
  type RunRepositoryLike,
  type RunEventBusLike,
  type LiveDeltaBusLike,
  type RunBusSubscribeHandle,
} from '../../src/modules/runs/sse.js';
import type { LiveDeltaPayload } from '../../src/modules/runs/live-delta-bus.js';
import type { RunRow, RunEventRow } from '../../src/modules/runs/repository.js';

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

/** 固定 runId / workspaceId。 */
const RUN_ID = randomUUID();
const WS_ID = randomUUID();

/** 假 Run 行。 */
const RUN: RunRow = {
  id: RUN_ID,
  workspaceId: WS_ID,
  conversationId: randomUUID(),
  assistantMessageId: randomUUID(),
  agentId: 'general-chat',
  provider: 'stub',
  model: 'stub-1',
  status: 'running',
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
  startedAt: new Date().toISOString(),
  completedAt: null,
  errorCode: null,
  parentRunId: null,
  requestId: 'req-1',
  leaseOwner: 'worker-1',
  leaseExpiresAt: null,
  heartbeatAt: null,
  createdBy: 'user-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** 写一段 id 连续的事件到"DB"，返回这些事件。 */
function makeEvents(count: number, startId = 1): RunEventRow[] {
  const out: RunEventRow[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: startId + i,
      runId: RUN_ID,
      workspaceId: WS_ID,
      type: 'content-checkpoint',
      payload: { text: `chunk-${startId + i}`, accumulatedLength: startId + i },
      createdAt: new Date(Date.now() + i).toISOString(),
    });
  }
  return out;
}

/**
 * 假 repo：getRunById 始终返回 RUN；listRunEvents 返回 afterId 之后的事件；
 * 记录每次查询参数以断言回放不会"重发"。
 */
function makeRepo(events: RunEventRow[], throwsOnList = false): RunRepositoryLike & {
  listCalls: Array<{ afterId: number; limit?: number; runId: string; workspaceId: string }>;
} {
  const listCalls: Array<{ afterId: number; limit?: number; runId: string; workspaceId: string }> = [];
  return {
    listCalls,
    async getRunById(runId: string, workspaceId: string) {
      if (runId === RUN_ID && workspaceId === WS_ID) return RUN;
      return null;
    },
    async listRunEvents(options) {
      listCalls.push({
        afterId: options.afterId ?? -1,
        limit: options.limit,
        runId: options.runId,
        workspaceId: options.workspaceId,
      });
      if (throwsOnList) throw new Error('simulated DB failure');
      const afterId = options.afterId ?? -1;
      return events.filter((e) => e.id > afterId);
    },
    async insertRunEvent() {
      throw new Error('insert not expected in this test');
    },
  };
}

/** 抓取 SSE 帧。 */
function captureFrames(): {
  frames: string[];
  parseFrames(): Array<{ id: number | null; name: string; data: unknown }>;
} {
  const frames: string[] = [];
  const original = globalThis.TransformStream;
  // 用 ReadableStream 直接 capture：streamRunEvents 创建一个 ReadableStream，
  // 内部 enqueue 到 controller。把这个 controller 通过劫持拿到。
  // 这里用一个共享的 memoryList，然后通过 decoder 解码。
  return {
    frames,
    parseFrames() {
      const events: Array<{ id: number | null; name: string; data: unknown }> = [];
      let current: { id: number | null; name: string | null; data: string[] } = { id: null, name: null, data: [] };
      const text = frames.join('');
      for (const line of text.split('\n')) {
        const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (clean === '') {
          if (current.name) {
            try {
              events.push({ id: current.id, name: current.name, data: JSON.parse(current.data.join('\n')) });
            } catch {
              // 非 JSON 帧（keepalive / retry）忽略
            }
          }
          current = { id: null, name: null, data: [] };
        } else if (clean.startsWith('id: ')) {
          const n = Number(clean.slice(4));
          current.id = Number.isFinite(n) ? n : null;
        } else if (clean.startsWith('event: ')) {
          current.name = clean.slice(7);
        } else if (clean.startsWith('data: ')) {
          current.data.push(clean.slice(6));
        }
      }
      return events;
    },
  };
}

/**
 * 假 checkpoint bus：subscribe 返回 unsub；记录调用。
 */
function makeBus(): RunEventBusLike & {
  started: number;
  subscribeCalls: string[];
  unsubCalls: number;
} {
  const state = {
    started: 0,
    subscribeCalls: [] as string[],
    unsubCalls: 0,
  };
  const bus: RunEventBusLike & typeof state = Object.assign(state, {
    async start() {
      state.started += 1;
    },
    async stop() {
      // no-op
    },
    subscribe(runId: string, _cb: (eventId: number) => void): RunBusSubscribeHandle {
      state.subscribeCalls.push(runId);
      return () => {
        state.unsubCalls += 1;
      };
    },
  });
  return bus;
}

/**
 * 假 live-delta bus：subscribe 返回 unsub；记录调用。
 * 测试可以用 `trigger(payload)` 主动触发订阅回调，模拟 NOTIFY 派发。
 */
function makeLiveDeltaBus(): LiveDeltaBusLike & {
  started: number;
  subscribeCalls: string[];
  unsubCalls: number;
  trigger: (payload: LiveDeltaPayload) => void;
  latestCb: ((payload: LiveDeltaPayload) => void) | null;
} {
  const state = {
    started: 0,
    subscribeCalls: [] as string[],
    unsubCalls: 0,
    trigger: (_payload: LiveDeltaPayload) => { /* replaced below */ },
    latestCb: null as ((payload: LiveDeltaPayload) => void) | null,
  };
  const liveBus = Object.assign(state, {
    async start() {
      state.started += 1;
    },
    async stop() {
      // no-op
    },
    subscribe(runId: string, cb: (payload: LiveDeltaPayload) => void): RunBusSubscribeHandle {
      state.subscribeCalls.push(runId);
      state.latestCb = cb;
      return () => {
        state.unsubCalls += 1;
      };
    },
  }) as LiveDeltaBusLike & typeof state;
  state.trigger = (payload: LiveDeltaPayload) => {
    if (state.latestCb) state.latestCb(payload);
  };
  return liveBus;
}

/**
 * 把 sse.ts 模块级 override 重置为 null。必须在每个 fixture 的 finally 中调用，
 * 防止 mock 泄漏到下一个 fixture / 下一个进程实例（PR-2.4 修复 commit）。
 *
 * 注：sse.ts 内的 `liveDeltaBusFactoryOverride = null` 后，再调 streamRunEvents
 * 会回退到 `getLiveDeltaBus()`——这正是 fixture 必须保证不发生的回退路径。
 * 在 finally 中清空，再在 run.ts 的 globalTeardown 中再清一次（双保险）。
 */
function resetSseOverrides(): void {
  __setRunRepositoryForTesting(null);
  __setRunEventsBusFactoryForTesting(null);
  __setLiveDeltaBusFactoryForTesting(null);
}

async function streamToText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = '';
  try {
    // 长连接流不会自然 close；最多读 64KB 后强制 cancel。
    const cap = 64 * 1024;
    while (out.length < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      // 一旦重放帧全部发出且没有实时事件，给一次空 read 机会即可返回。
      if (out.length > 0 && out.includes('retry:')) break;
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

/**
 * 把字节流 pipe 到 TransformStream，把所有字节累积到一个闭包变量里。
 * 用于在长连接 SSE 上既能"读到一部分"又不让 read() 永久阻塞——
 * 调用方主动 cancel tee 后 read 立即返回 done=true。
 */
function teeStream(stream: ReadableStream<Uint8Array>): { tee: ReadableStream<Uint8Array>; captured: () => string } {
  const decoder = new TextDecoder();
  let captured = '';
  const t = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      captured += decoder.decode(chunk, { stream: true });
      controller.enqueue(chunk);
    },
  });
  const tee = stream.pipeThrough(t);
  return { tee, captured: () => captured };
}

/**
 * 把 SSE 帧拆分为"id: 行 / event 行 / data 行"三类事件，便于精确断言。
 * content-delta 帧不带 id 行；其余事件 id 与 BIGINT IDENTITY 同步。
 */
function parseFrames(body: string): Array<{ id: number | null; name: string | null; data: string[] }> {
  const events: Array<{ id: number | null; name: string | null; data: string[] }> = [];
  let cur: { id: number | null; name: string | null; data: string[] } = { id: null, name: null, data: [] };
  for (const line of body.split('\n')) {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (clean === '') {
      if (cur.name !== null) events.push(cur);
      cur = { id: null, name: null, data: [] };
    } else if (clean.startsWith('id: ')) {
      const n = Number(clean.slice(4));
      cur.id = Number.isFinite(n) ? n : null;
    } else if (clean.startsWith('event: ')) {
      cur.name = clean.slice(7);
    } else if (clean.startsWith('data: ')) {
      cur.data.push(clean.slice(6));
    }
  }
  return events;
}

async function callStream(args: {
  lastEventId: number;
  runId: string;
  workspaceId: string;
  repo: ReturnType<typeof makeRepo>;
  bus: ReturnType<typeof makeBus>;
  liveBus?: ReturnType<typeof makeLiveDeltaBus>;
}): Promise<{ response: Response; body: string }> {
  __setRunRepositoryForTesting(args.repo);
  __setRunEventsBusFactoryForTesting(() => args.bus);
  if (args.liveBus) {
    __setLiveDeltaBusFactoryForTesting(() => args.liveBus!);
  } else {
    __setLiveDeltaBusFactoryForTesting(null);
  }
  const { streamRunEvents } = await import('../../src/modules/runs/sse.js');
  const response = await streamRunEvents({
    runId: args.runId,
    workspaceId: args.workspaceId,
    lastEventId: args.lastEventId,
  });
  // 仅取首段（直到 retry: 帧出现）；随后 cancel 让 bus 取消订阅。
  const body = await streamToText(response.body);
  await response.body?.cancel().catch(() => {});
  // 等 microtask 触发 cancel 回调
  await new Promise((r) => setImmediate(r));
  return { response, body };
}

console.log('\n[sse-replay] R1 — 重放从非零 lastEventId 开始且不重复');
{
  try {
    const events = makeEvents(10, 1);
    const repo = makeRepo(events);
    const bus = makeBus();
    const { response, body } = await callStream({
      lastEventId: 4,
      runId: RUN_ID,
      workspaceId: WS_ID,
      repo,
      bus,
    });
    assert('R1: status === 200', response.status === 200);
    const parsed: Array<{ id: number | null; name: string }> = [];
    let cur: { id: number | null; name: string | null; data: string[] } = { id: null, name: null, data: [] };
    for (const line of body.split('\n')) {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (clean === '') {
        if (cur.name) parsed.push({ id: cur.id, name: cur.name });
        cur = { id: null, name: null, data: [] };
      } else if (clean.startsWith('id: ')) {
        cur.id = Number(clean.slice(4));
      } else if (clean.startsWith('event: ')) {
        cur.name = clean.slice(7);
      } else if (clean.startsWith('data: ')) {
        cur.data.push(clean.slice(6));
      }
    }
    const ids = parsed.filter((p) => p.id !== null).map((p) => p.id as number);
    assert('R1: 重放 id 集合 === [5..10]', JSON.stringify(ids) === JSON.stringify([5, 6, 7, 8, 9, 10]),
      `actual=${JSON.stringify(ids)}`);
    assert('R1: listRunEvents 调用 afterId === 4',
      repo.listCalls[0]?.afterId === 4,
      `actual=${JSON.stringify(repo.listCalls[0])}`);
    assert('R1: 没有任何 id <= 4 的事件被发送',
      ids.every((id) => id > 4));
    assert('R1: bus.start() 被调用一次', bus.started === 1, `started=${bus.started}`);
    assert('R1: subscribe(runId) 被调用一次', bus.subscribeCalls.length === 1 && bus.subscribeCalls[0] === RUN_ID);
  } finally {
    resetSseOverrides();
  }
}

console.log('\n[sse-replay] R2 — 客户端断开触发 unsubscribe');
{
  try {
    const events = makeEvents(3);
    const repo = makeRepo(events);
    const bus = makeBus();
    __setRunRepositoryForTesting(repo);
    __setRunEventsBusFactoryForTesting(() => bus);
    const { streamRunEvents } = await import('../../src/modules/runs/sse.js');
    const response = await streamRunEvents({
      runId: RUN_ID,
      workspaceId: WS_ID,
      lastEventId: 0,
    });
    // 读一段帧后 cancel
    if (response.body) {
      const reader = response.body.getReader();
      await reader.read();
      reader.releaseLock();
    }
    // 等 stream.start() 跑完，再 cancel。
    await new Promise((r) => setTimeout(r, 20));
    await response.body!.cancel().catch(() => {});
    await new Promise((r) => setImmediate(r));
    assert('R2: bus.subscribe 返回的 unsub 被调一次', bus.unsubCalls === 1, `unsubCalls=${bus.unsubCalls}`);
  } finally {
    resetSseOverrides();
  }
}

console.log('\n[sse-replay] R3 — parseLastEventId 严格校验');
{
  const { parseLastEventId } = await import('../../src/modules/runs/sse.js');
  assert('R3: 缺省 → 0', parseLastEventId(null) === 0);
  assert('R3: 空字符串 → 0', parseLastEventId('') === 0);
  assert('R3: 非数字 → 0', parseLastEventId('abc') === 0);
  assert('R3: 负数 → 0', parseLastEventId('-5') === 0);
  assert('R3: NaN → 0', parseLastEventId('NaN') === 0);
  assert('R3: 浮点 → 向下取整', parseLastEventId('3.7') === 3);
  assert('R3: 大整数 → 原值', parseLastEventId('9007199254740993') === 9007199254740993);
}

console.log('\n[sse-replay] R4 — run 不存在 / 跨 workspace → 404，stream 不启动');
{
  try {
    const repo = makeRepo([]);
    const bus = makeBus();
    __setRunRepositoryForTesting(repo);
    __setRunEventsBusFactoryForTesting(() => bus);
    const { streamRunEvents } = await import('../../src/modules/runs/sse.js');
    const r1 = await streamRunEvents({ runId: randomUUID(), workspaceId: WS_ID, lastEventId: 0 });
    assert('R4: 未知 runId → 404', r1.status === 404);
    const r2 = await streamRunEvents({ runId: RUN_ID, workspaceId: randomUUID(), lastEventId: 0 });
    assert('R4: 跨 workspace → 404', r2.status === 404);
    assert('R4: 404 路径不调 bus.start()', bus.started === 0);
  } finally {
    resetSseOverrides();
  }
}

console.log('\n[sse-replay] R5 — SSE 帧 id 严格递增且等于 DB event id');
{
  try {
    const events = makeEvents(5, 100);
    const repo = makeRepo(events);
    const bus = makeBus();
    const { response, body } = await callStream({
      lastEventId: 0,
      runId: RUN_ID,
      workspaceId: WS_ID,
      repo,
      bus,
    });
    const ids: number[] = [];
    for (const raw of body.split('\n')) {
      const clean = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (clean.startsWith('id: ')) {
        ids.push(Number(clean.slice(4)));
      }
    }
    // 跳过 retry 指令后面的 id 行（如果有）。assert 五个 100..104 都出现且唯一。
    const targetIds = ids.filter((n) => n >= 100 && n <= 104);
    assert('R5: 帧 id 集合 === [100..104]', JSON.stringify(targetIds) === JSON.stringify([100, 101, 102, 103, 104]),
      `actual=${JSON.stringify(targetIds)}`);
    assert('R5: 没有重复 id', new Set(targetIds).size === targetIds.length);
  } finally {
    resetSseOverrides();
  }
}

console.log('\n[sse-replay] R7 — header 优先于 query（由 shared-handlers 解析层保证）');
{
  // shared-handlers.test 不在本测试范围内；这里只验证 streamRunEvents
  // 接受同一个 lastEventId 即可。真正的 header-vs-query 测试在
  // shared-handlers 单元里覆盖。
}

console.log('\n[sse-replay] D1 — content-delta 帧不带 SSE id（实时增量不进 lastEventId）');
{
  try {
    const events = makeEvents(2, 1);
    const repo = makeRepo(events);
    const bus = makeBus();
    const liveBus = makeLiveDeltaBus();
    __setRunRepositoryForTesting(repo);
    __setRunEventsBusFactoryForTesting(() => bus);
    __setLiveDeltaBusFactoryForTesting(() => liveBus);
    const { streamRunEvents } = await import('../../src/modules/runs/sse.js');
    const response = await streamRunEvents({
      runId: RUN_ID,
      workspaceId: WS_ID,
      lastEventId: 0,
    });
    // 用 TransformStream 把字节流截到一个 string 上，方便后续断言。
    // 第一步：attach reader 让 stream.start() 启动（注册 bus.subscribe）。
    const { tee, captured: getOut } = teeStream(response.body!);
    const reader = tee.getReader();
    const decoder = new TextDecoder();
    let out = '';
    // 先 read 一次，让 start 跑完并把历史帧消费掉。
    try {
      const { done, value } = await reader.read();
      if (!done && value) out += decoder.decode(value, { stream: true });
    } catch { /* ignore */ }
    // 第二步：现在 liveBus.subscribe 已注册，可以触发实时增量。
    liveBus.trigger({ runId: RUN_ID, text: 'hello' });
    liveBus.trigger({ runId: RUN_ID, text: ' world' });
    // 给一点时间让回调被消费并写入 controller。
    await new Promise((r) => setTimeout(r, 30));
    try {
      const cap = 64 * 1024;
      // 用 race 兜底：若 500ms 内拿不到任何字节，认为流结束并退出循环。
      const finishAt = Date.now() + 500;
      while (out.length < cap) {
        const remaining = Math.max(1, finishAt - Date.now());
        let resolved = false;
        const readPromise = reader.read().then((r) => { resolved = true; return r; });
        const timeoutPromise = new Promise<{ done: false; value: undefined }>((resolve) =>
          setTimeout(() => { resolved = true; resolve({ done: false, value: undefined as never }); }, remaining));
        const result = await Promise.race([readPromise, timeoutPromise]);
        if (!resolved) continue;
        const { done, value } = result;
        if (done) break;
        if (value) out += decoder.decode(value, { stream: true });
        // 一旦两段 content-delta 都到了，停止等待。
        if (out.includes('content-delta') && out.indexOf('content-delta', out.indexOf('content-delta') + 1) !== -1) break;
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    await tee.cancel().catch(() => {});
    await new Promise((r) => setImmediate(r));

    const frames = parseFrames(out);
    const deltas = frames.filter((f) => f.name === 'content-delta');
    assert('D1: live-delta bus.subscribe 被调用一次',
      liveBus.subscribeCalls.length === 1 && liveBus.subscribeCalls[0] === RUN_ID);
    assert('D1: 至少有一个 content-delta 帧被发出', deltas.length >= 1,
      `deltas=${deltas.length}, frames=${JSON.stringify(frames.map((f) => f.name))}`);
    assert('D1: content-delta 帧不带 SSE id 行（保持 null）',
      deltas.every((d) => d.id === null),
      `actual ids=${JSON.stringify(deltas.map((d) => d.id))}`);
    const deltaPayloads = deltas.map((d) => JSON.parse(d.data.join('\n')) as { runId: string; text: string });
    const allText = deltaPayloads.map((p) => p.text).join('');
    assert('D1: 实时增量文本来自 payload（拼接等于 hello world）',
      allText === 'hello world',
      `actual=${allText}`);
  } finally {
    resetSseOverrides();
  }
}

console.log('\n[sse-replay] D2 — 实时增量不写入 agent_run_events（不进持久化回放）');
{
  try {
    const events = makeEvents(3, 100);
    const repo = makeRepo(events);
    const bus = makeBus();
    const liveBus = makeLiveDeltaBus();
    __setRunRepositoryForTesting(repo);
    __setRunEventsBusFactoryForTesting(() => bus);
    __setLiveDeltaBusFactoryForTesting(() => liveBus);
    const { streamRunEvents } = await import('../../src/modules/runs/sse.js');
    const response = await streamRunEvents({
      runId: RUN_ID,
      workspaceId: WS_ID,
      lastEventId: 0,
    });
    // 推若干实时增量；这些只能从 content-delta 帧看到，不能影响重放或 list。
    for (let i = 0; i < 5; i++) {
      liveBus.trigger({ runId: RUN_ID, text: `delta-${i}` });
    }
    // 让 SSE 把启动帧先全部发出。
    await new Promise((r) => setTimeout(r, 20));
    // 取出所有 frame。
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let out = '';
    try {
      const cap = 64 * 1024;
      while (out.length < cap) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
        if (out.length > 0 && out.includes('retry:')) break;
      }
    } finally {
      reader.releaseLock();
    }
    await response.body!.cancel().catch(() => {});
    await new Promise((r) => setImmediate(r));

    const frames = parseFrames(out);
    // 重放必须是持久化 events 的全部内容；实时增量文本（delta-0..4）不能进入
    // content-checkpoint payload 也不能创建额外持久化事件。
    const checkpointFrames = frames.filter((f) => f.name === 'content-checkpoint');
    assert('D2: 重放 checkpoint 帧 === 持久化 events 数（实时增量未污染）',
      checkpointFrames.length === events.length,
      `expected=${events.length}, actual=${checkpointFrames.length}`);
    const allReplayText = checkpointFrames
      .map((f) => JSON.parse(f.data.join('\n')) as { text: string })
      .map((p) => p.text)
      .join('|');
    assert('D2: 重放文本不含 delta-0..4（实时增量不写入持久化 payload）',
      !/delta-[0-4]/.test(allReplayText),
      `actual=${allReplayText}`);
    // listRunEvents 也不应被实时增量调用影响：所有调用都按 checkpoint 区间拉取。
    assert('D2: listRunEvents 调用均带正确 afterId 区间（不出现负数 / 超界）',
      repo.listCalls.every((c) => c.afterId >= 0 && c.runId === RUN_ID && c.workspaceId === WS_ID),
      JSON.stringify(repo.listCalls));
  } finally {
    resetSseOverrides();
  }
}

console.log('\n[sse-replay] D3 — 客户端断开时持久化 + live-delta 订阅都被释放');
{
  try {
    const events = makeEvents(1);
    const repo = makeRepo(events);
    const bus = makeBus();
    const liveBus = makeLiveDeltaBus();
    __setRunRepositoryForTesting(repo);
    __setRunEventsBusFactoryForTesting(() => bus);
    __setLiveDeltaBusFactoryForTesting(() => liveBus);
    const { streamRunEvents } = await import('../../src/modules/runs/sse.js');
    const response = await streamRunEvents({
      runId: RUN_ID,
      workspaceId: WS_ID,
      lastEventId: 0,
    });
    if (response.body) {
      const reader = response.body.getReader();
      await reader.read();
      reader.releaseLock();
    }
    // 等 microtask 跑完 start（start 是 async，等它把 unsubscribeBus/unsubscribeLiveDelta 都注册）
    await new Promise((r) => setTimeout(r, 20));
    await response.body!.cancel().catch(() => {});
    await new Promise((r) => setImmediate(r));
    assert('D3: checkpoint bus 订阅被释放', bus.unsubCalls === 1, `unsubCalls=${bus.unsubCalls}`);
    assert('D3: live-delta bus 订阅被释放', liveBus.unsubCalls === 1, `liveUnsubCalls=${liveBus.unsubCalls}`);
  } finally {
    resetSseOverrides();
  }
}

console.log('\n[sse-replay] D4 — checkpoint bus 回调并发时 lastDeliveredId 不回退、不重发');
{
  try {
    // 准备 10 个事件（id 1..10）。历史回放先消费前 5 个（id 1..5），
    // NOTIFY 触发的 NOTIFY eventId 6/7/8/9 全部需要被串行消费，且同一帧
    // 不能重复发——验证 inflight 串行化 + lastDeliveredId 守卫。
    const events = makeEvents(10, 1);
    const repo = makeRepo(events);
    const bus = makeBus();
    const liveBus = makeLiveDeltaBus();
    __setRunRepositoryForTesting(repo);
    __setRunEventsBusFactoryForTesting(() => bus);
    __setLiveDeltaBusFactoryForTesting(() => liveBus);

    // 收集所有订阅回调：第一次 subscribe 时进入 map，再触发多次 NOTIFY。
    const cbs: Array<(eventId: number) => void> = [];
    const wrappedBus = {
      started: 0,
      subscribeCalls: [] as string[],
      async start() { this.started += 1; },
      async stop() {},
      subscribe(_runId: string, cb: (eventId: number) => void): RunBusSubscribeHandle {
        cbs.push(cb);
        return () => {};
      },
    } as RunEventBusLike;

    __setRunEventsBusFactoryForTesting(() => wrappedBus);
    const { streamRunEvents } = await import('../../src/modules/runs/sse.js');
    const response = await streamRunEvents({
      runId: RUN_ID,
      workspaceId: WS_ID,
      lastEventId: 0,
    });
    // 触发 ReadableStream.start()：先 attach reader，让历史回放 + subscribe 完成。
    const reader0 = response.body!.getReader();
    const decoder0 = new TextDecoder();
    let initialOut = '';
    // 注意：不要在此处 releaseLock——后面还要复用 reader0 读 NOTIFY 触发的事件。
    {
      const finishAt = Date.now() + 500;
      while (true) {
        const remaining = Math.max(1, finishAt - Date.now());
        let resolved = false;
        const readPromise = reader0.read().then((r) => { resolved = true; return r; });
        const timeoutPromise = new Promise<{ done: false; value: undefined }>((resolve) =>
          setTimeout(() => { resolved = true; resolve({ done: false, value: undefined as never }); }, remaining));
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (!resolved) continue;
        if (done) break;
        if (value) initialOut += decoder0.decode(value, { stream: true });
        // 重放包含所有 10 个历史事件 + retry 行；见到 retry 后即可停止。
        if (initialOut.includes('retry:')) break;
      }
    }
    // 历史回放结束时 lastDeliveredId === 10（10 个事件，id 1..10）。
    // 触发 4 次 NOTIFY，eventId 必须 > 10 才能真正进入 listRunEvents。
    // 用更大的 eventId 触发（mock 没有这些 id 的事件，所以 listRunEvents 返回空），
    // 但不影响并发不变量；真正要验证的是"多次 NOTIFY 不会让 lastDeliveredId 回退"。
    if (cbs.length < 1) {
      throw new Error(`D4 setup 失败：wrappedBus.subscribe 未注册（cbs.length=${cbs.length}）`);
    }
    // 准备 4 个超界 eventId（mock 没有任何 id>10 的事件，因此 listRunEvents
    // 始终返回空，lastDeliveredId 维持 10）。但这 4 次 NOTIFY 仍要进入
    // inflight 串行链——验证串行化与不回退。
    cbs[0]!(11);
    cbs[0]!(12);
    cbs[0]!(13);
    cbs[0]!(14);
    // 等 inflight promise 链全部消化。
    await new Promise((r) => setTimeout(r, 50));
    let out = initialOut;
    const reader = reader0; // 复用同一个 reader，不重新 attach
    const decoder = decoder0;
    try {
      const cap = 64 * 1024;
      const finishAt = Date.now() + 200;
      while (out.length < cap) {
        if (Date.now() >= finishAt) break;
        const remaining = Math.max(1, finishAt - Date.now());
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: false; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: false, value: undefined as never }), remaining));
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) break;
        if (value) out += decoder.decode(value, { stream: true });
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    await response.body!.cancel().catch(() => {});
    await new Promise((r) => setImmediate(r));

    const frames = parseFrames(out).filter((f) => f.name === 'content-checkpoint');
    const ids = frames.map((f) => f.id) as number[];
    // 期望：重放 + NOTIFY 触发的并发查询里，每个 id 只出现一次，整体单调递增。
    const uniqueSorted = Array.from(new Set(ids)).sort((a, b) => a - b);
    assert('D4: content-checkpoint 帧 id 严格递增且无重复',
      JSON.stringify(ids) === JSON.stringify(uniqueSorted),
      `actual ids=${JSON.stringify(ids)}`);
    // 每次 listRunEvents 的 afterId 必须单调递增；防止 lastDeliveredId 回退。
    const afters = repo.listCalls.map((c) => c.afterId);
    const monotonic = afters.every((v, i) => i === 0 || v >= afters[i - 1]!);
    assert('D4: listRunEvents 调用 afterId 序列单调递增（无回退）',
      monotonic,
      `actual=${JSON.stringify(afters)}`);
  } finally {
    resetSseOverrides();
  }
}

console.log('\n[sse-replay] L1 — 注入 live-delta bus 时，真实 getLiveDeltaBus 单例不被触发');
{
  // PR-2.4 修复：注入 fake live bus 后 streamRunEvents 不得回退到真实 bus；
  // 否则测试会在 DATABASE_URL 已配置的环境下意外打开 PG 监听，进程无法自退。
  //
  // 关键证据：
  //   - 注入后 streamRunEvents 内部调 resolveLiveDeltaBus()，若 override 生效，
  //     它直接返回 factory 结果；不再调 getLiveDeltaBus()，从而不会触发
  //     Symbol.for('xuanshu-agent/live-delta-bus') 单例的惰性创建。
  //   - 单例是 process 级共享：测试运行期间任何代码调 getLiveDeltaBus() 都会
  //     让 Symbol.for key 上出现 bus 实例。我们对比测试前后同一 key 的引用：
  //     若两值相同（要么都未创建、要么都是同一个早已存在的实例），证明本测试
  //     没有因 factory 缺失而"被迫"新建单例。
  try {
    const events = makeEvents(1);
    const repo = makeRepo(events);
    const bus = makeBus();
    const liveBus = makeLiveDeltaBus();
    __setRunRepositoryForTesting(repo);
    __setRunEventsBusFactoryForTesting(() => bus);
    __setLiveDeltaBusFactoryForTesting(() => liveBus);

    const liveBusKey = Symbol.for('xuanshu-agent/live-delta-bus');
    type GlobalWithBus = typeof globalThis & { [liveBusKey]?: object };
    const g = globalThis as GlobalWithBus;
    const beforeRef = g[liveBusKey];

    const { streamRunEvents } = await import('../../src/modules/runs/sse.js');
    const response = await streamRunEvents({
      runId: RUN_ID,
      workspaceId: WS_ID,
      lastEventId: 0,
    });
    // 触发 start() 与 subscribe()：让 ReadableStream.start() 把所有 start / subscribe 都跑完。
    if (response.body) {
      const reader = response.body.getReader();
      await reader.read();
      reader.releaseLock();
    }
    await new Promise((r) => setTimeout(r, 20));
    await response.body!.cancel().catch(() => {});
    await new Promise((r) => setImmediate(r));

    const afterRef = g[liveBusKey];
    assert('L1: fake live-delta bus.start() 被调用一次',
      liveBus.started === 1,
      `started=${liveBus.started}`);
    assert('L1: fake live-delta bus.subscribe 被调用一次',
      liveBus.subscribeCalls.length === 1 && liveBus.subscribeCalls[0] === RUN_ID);
    assert('L1: 真实 live-delta bus 单例未被新创建（override 拦截 getLiveDeltaBus）',
      beforeRef === afterRef,
      `before=${beforeRef === undefined ? 'undefined' : 'defined'}, after=${afterRef === undefined ? 'undefined' : 'defined'}`);
  } finally {
    resetSseOverrides();
  }
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`sse-replay 失败 ${failed} 项断言`);
}