import { normalizeTextChunk } from '../../src/core/execution/stream-text-normalizer.js';

let passed = 0;
let failed = 0;

function assert(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

console.log('[stream-text-normalizer] 累计快照必须转为纯增量');
let accumulated = '';
const cumulativeDeltas: string[] = [];
for (const incoming of ['1', '12', '123', '1234']) {
  const result = normalizeTextChunk(accumulated, incoming);
  accumulated = result.accumulatedText;
  cumulativeDeltas.push(result.delta);
}
assert('1 / 12 / 123 / 1234 -> 1 / 2 / 3 / 4', cumulativeDeltas, ['1', '2', '3', '4']);
assert('累计正文正确', accumulated, '1234');

console.log('[stream-text-normalizer] 纯增量不得被误去重');
accumulated = '';
const deltaDeltas: string[] = [];
for (const incoming of ['你', '好', '，', '你好']) {
  const result = normalizeTextChunk(accumulated, incoming);
  accumulated = result.accumulatedText;
  deltaDeltas.push(result.delta);
}
assert('纯增量原样保留（含重复文本）', deltaDeltas, ['你', '好', '，', '你好']);
assert('纯增量累积正确', accumulated, '你好，你好');

console.log('[stream-text-normalizer] 重复 token 仍属于真实增量');
assert('相同文本的真实增量不得被吞掉', normalizeTextChunk('你好', '你好'), {
  delta: '你好', accumulatedText: '你好你好',
});
assert('emoji 快照按 UTF-16 边界取后缀', normalizeTextChunk('A🚀', 'A🚀B'), {
  delta: 'B', accumulatedText: 'A🚀B',
});

console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
