/**
 * Execution controller 双索引注册表单元测试（注入式）。
 *
 * 保护的具体契约：
 *  - R1：同会话首次 `tryReserveConversationExecution` 成功。
 *  - R2：同会话二次 reserve（不同消息 ID）抛 `ExecutionConflictError`，
 *        文案表达"该会话正在生成中"。
 *  - R3：不同会话可同时 reserve。
 *  - R4：`bindAssistantMessageToExecution` 之后，`isExecutionActive(messageId)`
 *        与 `isConversationExecutionActive(conversationId)` 都为 true。
 *  - R5：`abortExecution(messageId)` 找到正确 AbortController 并 abort。
 *  - R6：partial content 跨多次 `appendPartialContent` 累加。
 *  - R7：`cleanupExecution(messageId)` 同时清空两个索引。
 *  - R8：cleanup 后同一会话可以再次 reserve。
 *  - R9：清理一个会话不影响另一会话的活跃执行。
 *  - R10：`resetExecutionControllerForTests()` 彻底清空所有状态。
 *
 * Run with: npx tsx tests/unit/execution-controller.ts
 */
import {
  abortExecution,
  appendPartialContent,
  bindAssistantMessageToExecution,
  cleanupConversationExecution,
  cleanupExecution,
  ExecutionConflictError,
  getPartialContent,
  isConversationExecutionActive,
  isExecutionActive,
  resetExecutionControllerForTests,
  tryReserveConversationExecution,
} from '../../src/core/execution/controller.js';

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

function assertThrows(label: string, fn: () => void, match?: RegExp): void {
  try {
    fn();
    assert(label, false, 'expected throw');
  } catch (err) {
    if (match && !match.test((err as Error).message)) {
      assert(label, false, `message ${JSON.stringify((err as Error).message)} 不匹配 ${match}`);
    } else {
      assert(label, true);
    }
  }
}

console.log('[controller] R1 — 同会话首次 reserve 成功');

{
  resetExecutionControllerForTests();
  const r = tryReserveConversationExecution('conv-A');
  assert('R1: reserve 返回 controller', 'controller' in r);
  if ('controller' in r) {
    assert('R1: controller 是 AbortController', r.controller instanceof AbortController);
  }
  assert('R1: isConversationExecutionActive(conv-A) === true', isConversationExecutionActive('conv-A'));
}

console.log('\n[controller] R2 — 同会话二次 reserve 抛 conflict');

{
  resetExecutionControllerForTests();
  tryReserveConversationExecution('conv-A');
  const r = tryReserveConversationExecution('conv-A');
  assert('R2: 二次 reserve 返回 conflict', 'conflict' in r);
  if ('conflict' in r) {
    assert('R2: conflict 是 ExecutionConflictError', r.conflict instanceof ExecutionConflictError);
    assert('R2: 文案表达"该会话正在生成中"', /该会话正在生成中/.test(r.conflict.message));
  }
}

console.log('\n[controller] R3 — 不同会话可同时 reserve');

{
  resetExecutionControllerForTests();
  const r1 = tryReserveConversationExecution('conv-A');
  const r2 = tryReserveConversationExecution('conv-B');
  assert('R3: conv-A reserve 成功', 'controller' in r1);
  assert('R3: conv-B reserve 成功', 'controller' in r2);
  assert('R3: conv-A 仍是活跃', isConversationExecutionActive('conv-A'));
  assert('R3: conv-B 仍是活跃', isConversationExecutionActive('conv-B'));
}

console.log('\n[controller] R4 — bind 后 isExecutionActive(messageId) === true');

{
  resetExecutionControllerForTests();
  tryReserveConversationExecution('conv-A');
  bindAssistantMessageToExecution('conv-A', 'msg-1');
  assert('R4: isExecutionActive(msg-1) === true', isExecutionActive('msg-1'));
  assert('R4: isConversationExecutionActive(conv-A) === true', isConversationExecutionActive('conv-A'));
}

console.log('\n[controller] R4b — bind 在不存在的预占上抛错');

{
  resetExecutionControllerForTests();
  assertThrows(
    'R4b: bind 未预占的会话 → throw',
    () => bindAssistantMessageToExecution('conv-NOT-RESERVED', 'msg-x'),
    /预占已丢失/,
  );
}

console.log('\n[controller] R4c — 同会话尝试绑定第二个不同 messageId 被拒绝');

{
  resetExecutionControllerForTests();
  tryReserveConversationExecution('conv-A');
  bindAssistantMessageToExecution('conv-A', 'msg-1');
  assertThrows(
    'R4c: 同会话重复 bind 不同 messageId → throw',
    () => bindAssistantMessageToExecution('conv-A', 'msg-2'),
    /已绑定到助手消息 msg-1/,
  );
  // 原绑定保持不变
  assert('R4c: 原消息索引未被覆盖', isExecutionActive('msg-1'));
  assert('R4c: 新消息未被写入', !isExecutionActive('msg-2'));
  assert('R4c: 会话仍处活跃态', isConversationExecutionActive('conv-A'));
}

console.log('\n[controller] R4d — 同 messageId 尝试绑定到不同会话被拒绝');

{
  resetExecutionControllerForTests();
  const rA = tryReserveConversationExecution('conv-A');
  const rB = tryReserveConversationExecution('conv-B');
  bindAssistantMessageToExecution('conv-A', 'msg-shared');
  assertThrows(
    'R4d: 同 messageId 跨会话 bind → throw',
    () => bindAssistantMessageToExecution('conv-B', 'msg-shared'),
    /已绑定到会话 conv-A/,
  );
  // 两会话的索引都未被破坏
  assert('R4d: msg-shared 仍指向 conv-A（abort 命中 A 的 controller）',
    abortExecution('msg-shared').success === true && ('controller' in rA) && rA.controller.signal.aborted);
  assert('R4d: conv-B 的 controller 未被 abort（独立 AbortController）',
    'controller' in rB && !rB.controller.signal.aborted);
  assert('R4d: conv-B 仍处活跃态（reserve 未丢失）', isConversationExecutionActive('conv-B'));
}

console.log('\n[controller] R4e — 同 (conv, msg) 重复 bind 幂等');

{
  resetExecutionControllerForTests();
  tryReserveConversationExecution('conv-A');
  bindAssistantMessageToExecution('conv-A', 'msg-1');
  bindAssistantMessageToExecution('conv-A', 'msg-1');
  bindAssistantMessageToExecution('conv-A', 'msg-1');
  assert('R4e: 幂等 bind 后 isExecutionActive(msg-1) 仍 true', isExecutionActive('msg-1'));
  assert('R4e: 幂等 bind 后 isConversationExecutionActive(conv-A) 仍 true', isConversationExecutionActive('conv-A'));
  cleanupExecution('msg-1');
  assert('R4e: cleanup 后两个索引都被释放', !isExecutionActive('msg-1') && !isConversationExecutionActive('conv-A'));
}

console.log('\n[controller] R5 — abort 通过 messageId 找到正确 controller');

{
  resetExecutionControllerForTests();
  const r = tryReserveConversationExecution('conv-A');
  bindAssistantMessageToExecution('conv-A', 'msg-1');
  if (!('controller' in r)) throw new Error('reserve failed in test setup');
  const result = abortExecution('msg-1');
  assert('R5: abort 成功', result.success === true);
  assert('R5: abort 触发 controller.abort()', r.controller.signal.aborted);
  assert('R5: abort 后 partialContent 为空字符串', result.partialContent === null);
  cleanupExecution('msg-1');
}

console.log('\n[controller] R5b — abort 未注册的消息 ID');

{
  resetExecutionControllerForTests();
  const result = abortExecution('msg-NOT-REGISTERED');
  assert('R5b: abort 未注册消息 → success=false', result.success === false);
  assert('R5b: partialContent 为 null', result.partialContent === null);
}

console.log('\n[controller] R6 — partial content 关联');

{
  resetExecutionControllerForTests();
  tryReserveConversationExecution('conv-A');
  bindAssistantMessageToExecution('conv-A', 'msg-1');
  appendPartialContent('msg-1', 'hello ');
  appendPartialContent('msg-1', 'world');
  appendPartialContent('msg-1', '!');
  assert('R6: getPartialContent(msg-1) 累加结果', getPartialContent('msg-1') === 'hello world!');
}

console.log('\n[controller] R7 — cleanup 后两个索引都被清除');

{
  resetExecutionControllerForTests();
  tryReserveConversationExecution('conv-A');
  bindAssistantMessageToExecution('conv-A', 'msg-1');
  appendPartialContent('msg-1', 'partial');
  cleanupExecution('msg-1');
  assert('R7: isExecutionActive(msg-1) === false', !isExecutionActive('msg-1'));
  assert('R7: isConversationExecutionActive(conv-A) === false', !isConversationExecutionActive('conv-A'));
  assert('R7: getPartialContent(msg-1) === ""', getPartialContent('msg-1') === '');
}

console.log('\n[controller] R8 — cleanup 后同一会话可以再次 reserve');

{
  resetExecutionControllerForTests();
  tryReserveConversationExecution('conv-A');
  bindAssistantMessageToExecution('conv-A', 'msg-1');
  cleanupExecution('msg-1');
  const r = tryReserveConversationExecution('conv-A');
  assert('R8: cleanup 后 reserve 再次成功', 'controller' in r);
}

console.log('\n[controller] R9 — 一个会话的 cleanup 不影响另一个');

{
  resetExecutionControllerForTests();
  tryReserveConversationExecution('conv-A');
  tryReserveConversationExecution('conv-B');
  bindAssistantMessageToExecution('conv-A', 'msg-A');
  bindAssistantMessageToExecution('conv-B', 'msg-B');
  cleanupConversationExecution('conv-A');
  assert('R9: conv-A 已清理', !isConversationExecutionActive('conv-A'));
  assert('R9: conv-B 仍活跃', isConversationExecutionActive('conv-B'));
  assert('R9: msg-A 索引也被清', !isExecutionActive('msg-A'));
  assert('R9: msg-B 索引仍存在', isExecutionActive('msg-B'));
}

console.log('\n[controller] R10 — reset 彻底清空');

{
  tryReserveConversationExecution('conv-A');
  tryReserveConversationExecution('conv-B');
  resetExecutionControllerForTests();
  assert('R10: conv-A 已被清空', !isConversationExecutionActive('conv-A'));
  assert('R10: conv-B 已被清空', !isConversationExecutionActive('conv-B'));
  const r = tryReserveConversationExecution('conv-A');
  assert('R10: reset 后 reserve 成功（无残留污染）', 'controller' in r);
  resetExecutionControllerForTests();
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
