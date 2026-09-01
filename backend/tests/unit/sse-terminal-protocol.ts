/**
 * SSE 共享终态协议离线测试（注入式）。
 *
 * 保护的具体契约：
 *  - C1：正常完成 → emit `message-complete`（status=completed），
 *        且调用 finalizeAssistant(content, citations, 'completed') 写 DB。
 *  - C2：用户停止（Stop 路径，stream 事件 'stopped'）→ emit
 *        `message-complete`（status=stopped），调用 finalizeAssistant(..., 'stopped')。
 *  - C3：异常失败（stream 事件 'error'）→ emit `message-error`（status=failed），
 *        调用 finalizeAssistant(fullText, [], 'failed')。
 *  - C4：流循环抛出异常（非 done/stopped/error）→ 通过 finalizeAfterStreamError
 *        走错误分支，区分 AbortError 与真错误。
 *  - C5：所有终态路径都必须 `sweepRunningToolExecutions`（避免漏 running 行）。
 *  - C6：SSE 帧格式固定为 `event: <name>\ndata: <json>\n\n`。
 *  - C7：SSE 帧在 `sse.close()` 之前发出；close 不抛。
 *  - C8：工具调用错误事件 errorCode 恒为 SAFE_TOOL_ERROR_CODE（不暴露原文）。
 *
 * 不连接真实 DB：通过 `_setMessageFinalizerForTesting` /
 * `_setToolExecutionSinkForTesting` 注入内存假实现。
 *
 * Run with: npx tsx tests/unit/sse-terminal-protocol.ts
 */
import { buildSseController, isUuid, type SseController } from '../../src/core/execution/sse.js';
import {
  finalizeMessage,
  finalizeAfterStreamError,
  sweepRunningToolExecutions,
  _setMessageFinalizerForTesting,
  type MessageFinalizer,
} from '../../src/core/execution/message-finalize.js';
import {
  handleToolEvent,
  SAFE_TOOL_ERROR_CODE,
  _setToolExecutionSinkForTesting,
  type ToolExecutionSink,
} from '../../src/core/execution/tool-event.js';

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

/** SSE 帧抓取器。把 send 写入的所有帧解码成字符串数组。 */
function captureSse(): {
  sse: SseController;
  frames: string[];
  parseEvents(): { name: string; data: unknown }[];
} {
  const frames: string[] = [];
  const controller = buildSseController({
    enqueue: (chunk) => {
      frames.push(new TextDecoder().decode(chunk));
    },
    close: () => {},
    error: () => {},
  } as unknown as ReadableStreamDefaultController<Uint8Array>);

  function parseEvents(): { name: string; data: unknown }[] {
    const events: { name: string; data: unknown }[] = [];
    let pending: { name?: string; data?: unknown } = {};
    for (const chunk of frames) {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) {
          pending.name = line.slice('event: '.length);
        } else if (line.startsWith('data: ')) {
          pending.data = JSON.parse(line.slice('data: '.length));
        } else if (line === '' && pending.name !== undefined && pending.data !== undefined) {
          // 仅在 name 与 data 都已就绪时才推入事件，避免 chunk 边界上
          // 的尾随空行误触发空事件。
          events.push({ name: pending.name, data: pending.data });
          pending = {};
        }
      }
    }
    return events;
  }
  return { sse: controller, frames, parseEvents };
}

/** 内存假 finalizer。记录所有调用并返回可预测的 Message 对象。 */
function makeInMemoryFinalizer(): MessageFinalizer & {
  finalizeCalls: Array<{ id: string; content: string; citations: unknown[]; terminal: string }>;
  convergeCalls: Array<{ messageId: string }>;
} {
  const finalizeCalls: Array<{ id: string; content: string; citations: unknown[]; terminal: string }> = [];
  const convergeCalls: Array<{ messageId: string }> = [];
  return {
    finalizeCalls,
    convergeCalls,
    async finalizeAssistant(_workspaceId, id, content, citations, terminal) {
      // PR-1.2/1.3/1.5 整改：1d1f487 把签名改成 (workspaceId, id, content,
      // citations, terminal) 五参。本测试不依赖真实 workspace，把首参忽略。
      finalizeCalls.push({ id, content, citations, terminal });
      return {
        id,
        conversationId: 'c1',
        role: 'assistant',
        content,
        citations: citations as never,
        status: terminal,
        createdAt: '2026-08-26T00:00:00.000Z',
      };
    },
    async convergeRunningToolExecutions(_workspaceId, messageId) {
      // PR-1.2/1.3/1.5 整改：1d1f487 简化为 (workspaceId, messageId) 两参。
      convergeCalls.push({ messageId });
      return 0;
    },
  };
}

/** 内存假 tool sink。 */
function makeInMemoryToolSink(): ToolExecutionSink & {
  createCalls: Array<{ workspaceId: string; messageId: string; toolName: string }>;
  finalizeCalls: Array<{ id: string; status: string; errorCode?: string }>;
} {
  const createCalls: Array<{ workspaceId: string; messageId: string; toolName: string }> = [];
  const finalizeCalls: Array<{ id: string; status: string; errorCode?: string }> = [];
  let nextId = 1;
  return {
    createCalls,
    finalizeCalls,
    async createToolExecution(workspaceId, messageId, toolName, _input) {
      // PR-1.2/1.3/1.5 整改：1d1f487 把签名改成
      // (workspaceId, messageId, toolName, input) 四参。本测试不依赖真实
      // workspace，把首参与旧 `conversationId` 字段统一改为 `workspaceId`。
      createCalls.push({ workspaceId, messageId, toolName });
      return `exec-${nextId++}`;
    },
    async finalizeToolExecution(_workspaceId, id, _output, status, errorCode) {
      // PR-1.2/1.3/1.5 整改：1d1f487 把签名改成
      // (workspaceId, id, output, status, errorCode?) 五参；首参忽略。
      finalizeCalls.push({ id, status, errorCode });
    },
  };
}

console.log('[sse] 帧格式与 UUID');

// PR-1.2/1.3/1.5 整改：1d1f487 把 finalizeMessage / finalizeAfterStreamError /
// sweepRunningToolExecutions / handleToolEvent 的首参改成 workspaceId（V2.3.6 §5.1）。
// 本测试不依赖真实 workspace —— 用常量代替，避免每个 case 重复写字面量。
const TEST_WS = 'test-workspace';

// C6 / C7 / isUuid sanity
{
  const { sse, frames, parseEvents } = captureSse();
  sse.send('message-start', { id: 'm1', role: 'assistant', status: 'streaming' });
  sse.close();
  assert('C6: 帧格式固定为 `event: <name>\\ndata: <json>\\n\\n`',
    frames[0] === 'event: message-start\n' && frames[1] === 'data: {"id":"m1","role":"assistant","status":"streaming"}\n\n');
  const events = parseEvents();
  assert('C7: 事件可解析', events.length === 1 && events[0].name === 'message-start');
  assert('isUuid: 合法 UUID 通过', isUuid('550e8400-e29b-41d4-a716-446655440000'));
  assert('isUuid: 非法 UUID 拒绝', !isUuid('not-a-uuid'));
}

console.log('\n[sse] C1 — 正常完成');

// C1: 正常完成 → message-complete + finalizeAssistant(..., 'completed')
{
  const finalizer = makeInMemoryFinalizer();
  _setMessageFinalizerForTesting(finalizer);
  const { sse, parseEvents } = captureSse();
  await finalizeMessage(TEST_WS, 'm1', {
    terminal: 'completed',
    content: 'done',
    citations: [{ source: 'doc', snippet: 'x' } as never],
    fullText: 'done',
  }, sse);
  const events = parseEvents();
  assert('C1: emit `message-complete`',
    events.some((e) => e.name === 'message-complete'));
  const complete = events.find((e) => e.name === 'message-complete');
  assert('C1: message-complete.status === "completed"',
    complete !== undefined && (complete.data as { status: string }).status === 'completed');
  assert('C1: message-complete.content 透传',
    complete !== undefined && (complete.data as { content: string }).content === 'done');
  assert('C1: finalizeAssistant 被以 completed 调用一次',
    finalizer.finalizeCalls.length === 1 && finalizer.finalizeCalls[0].terminal === 'completed');
  assert('C1: citations 透传到 finalizeAssistant',
    Array.isArray(finalizer.finalizeCalls[0].citations) && finalizer.finalizeCalls[0].citations.length === 1);
  _setMessageFinalizerForTesting(null);
}

console.log('\n[sse] C2 — 用户停止');

// C2: 停止 → message-complete (status=stopped)
{
  const finalizer = makeInMemoryFinalizer();
  _setMessageFinalizerForTesting(finalizer);
  const { sse, parseEvents } = captureSse();
  await finalizeMessage(TEST_WS, 'm2', {
    terminal: 'stopped',
    content: 'partial',
    citations: [],
    fullText: 'partial-so-far',
  }, sse);
  const events = parseEvents();
  const complete = events.find((e) => e.name === 'message-complete');
  assert('C2: 停止路径 emit `message-complete`（不是 message-error）',
    events.length === 1 && complete?.name === 'message-complete');
  assert('C2: status === "stopped"',
    complete !== undefined && (complete.data as { status: string }).status === 'stopped');
  assert('C2: finalizeAssistant 以 stopped 终态落库',
    finalizer.finalizeCalls[0].terminal === 'stopped');
  assert('C2: citations 强制为空数组',
    Array.isArray(finalizer.finalizeCalls[0].citations) && finalizer.finalizeCalls[0].citations.length === 0);
  _setMessageFinalizerForTesting(null);
}

console.log('\n[sse] C3 — 异常失败');

// C3: error → message-error (status=failed)
{
  const finalizer = makeInMemoryFinalizer();
  _setMessageFinalizerForTesting(finalizer);
  const { sse, parseEvents } = captureSse();
  await finalizeMessage(TEST_WS, 'm3', {
    terminal: 'failed',
    fullText: 'partial',
    errorMessage: '上游 LLM 超时',
  }, sse);
  const events = parseEvents();
  const error = events.find((e) => e.name === 'message-error');
  assert('C3: 失败路径 emit `message-error`',
    events.length === 1 && error?.name === 'message-error');
  assert('C3: status === "failed"',
    error !== undefined && (error.data as { status: string }).status === 'failed');
  assert('C3: error.message 透传给客户端',
    error !== undefined && (error.data as { error: { message: string } }).error.message === '上游 LLM 超时');
  assert('C3: finalizeAssistant 以 failed 终态落库',
    finalizer.finalizeCalls[0].terminal === 'failed');
  _setMessageFinalizerForTesting(null);
}

console.log('\n[sse] C4 — 流循环抛出（Abort vs 真错误）');

// C4: finalizeAfterStreamError 区分 Abort 与真错误
{
  const finalizer = makeInMemoryFinalizer();
  _setMessageFinalizerForTesting(finalizer);

  const { sse: sse1, parseEvents: parse1 } = captureSse();
  await finalizeAfterStreamError(TEST_WS, 'm4a', 'partial-text', true, sse1);
  const e1 = parse1();
  const stopped = e1.find((e) => e.name === 'message-complete');
  assert('C4a: AbortError 走 stopped 分支，emit message-complete (status=stopped)',
    stopped !== undefined && (stopped.data as { status: string }).status === 'stopped');
  assert('C4a: 终态落库为 stopped',
    finalizer.finalizeCalls[0].terminal === 'stopped');
  assert('C4a: 触发 convergeRunningToolExecutions',
    finalizer.convergeCalls.length === 1 && finalizer.convergeCalls[0].messageId === 'm4a');

  const { sse: sse2, parseEvents: parse2 } = captureSse();
  await finalizeAfterStreamError(TEST_WS, 'm4b', 'partial-text', false, sse2);
  const e2 = parse2();
  const failed = e2.find((e) => e.name === 'message-error');
  assert('C4b: 真错误走 failed 分支，emit message-error (status=failed)',
    failed !== undefined && (failed.data as { status: string }).status === 'failed');
  assert('C4b: 终态落库为 failed',
    finalizer.finalizeCalls[1].terminal === 'failed');
  _setMessageFinalizerForTesting(null);
}

console.log('\n[sse] C5 — sweep 兜底');

// C5: sweepRunningToolExecutions 总是收敛
{
  const finalizer = makeInMemoryFinalizer();
  _setMessageFinalizerForTesting(finalizer);
  await sweepRunningToolExecutions(TEST_WS, 'm5', 'test');
  assert('C5: sweepRunningToolExecutions 触发 convergeRunningToolExecutions',
    finalizer.convergeCalls.length === 1 && finalizer.convergeCalls[0].messageId === 'm5');
  _setMessageFinalizerForTesting(null);
}

console.log('\n[sse] C8 — 工具错误 errorCode');

// C8: tool-call-error 的 errorCode 必须是 SAFE_TOOL_ERROR_CODE
{
  const sink = makeInMemoryToolSink();
  _setToolExecutionSinkForTesting(sink);
  const toolMap = new Map<string, string>();
  // 先 start，建立映射
  await handleToolEvent({
    type: 'tool-call-start',
    toolCallId: 'tc-1',
    toolName: 'lookup',
    input: { q: 'secret-payload' },
  }, TEST_WS, 'm6', toolMap, captureSse().sse);
  // 然后 error
  const { sse, parseEvents } = captureSse();
  await handleToolEvent({
    type: 'tool-call-error',
    toolCallId: 'tc-1',
    toolName: 'lookup',
    error: '包含敏感信息的原始错误：api_key=xxx',
  }, TEST_WS, 'm6', toolMap, sse);
  const events = parseEvents();
  const errorEvent = events.find((e) => e.name === 'tool-call-error')!;
  assert('C8: emit `tool-call-error`',
    errorEvent !== undefined);
  assert('C8: 错误事件 status === "failed"',
    (errorEvent.data as { status: string }).status === 'failed');
  assert('C8: 错误事件 errorCode === SAFE_TOOL_ERROR_CODE（恒定）',
    (errorEvent.data as { errorCode: string }).errorCode === SAFE_TOOL_ERROR_CODE);
  assert('C8: 错误事件不含原始 error 字符串（防泄露）',
    !JSON.stringify(errorEvent.data).includes('敏感信息'));
  assert('C8: 错误事件不含原始 input 字符串（防泄露）',
    !JSON.stringify(errorEvent.data).includes('secret-payload'));
  assert('C8: 错误事件字段仅 toolCallId / toolName / status / errorCode',
    Object.keys(errorEvent.data as object).sort().join(',') === 'errorCode,status,toolCallId,toolName');
  assert('C8: sink.finalizeToolExecution 被以 failed + SAFE_TOOL_ERROR_CODE 调用',
    sink.finalizeCalls[0].status === 'failed' && sink.finalizeCalls[0].errorCode === SAFE_TOOL_ERROR_CODE);
  _setToolExecutionSinkForTesting(null);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  // 不调 process.exit —— 让 npm run test:unit 继续跑后续 fixture；
  // 失败向上 throw，由 runner 接住 → 进程 exit 1。
  throw new Error(`sse-terminal-protocol 失败 ${failed} 项断言`);
}
