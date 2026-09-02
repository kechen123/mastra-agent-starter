/**
 * 实时增量 JSON-payload 字节安全拆分器测试（PR-2.4 修复 commit）。
 *
 * 覆盖：
 *   - 纯 ASCII 安全拆分；
 *   - 中文 3-byte 字符不得被截断；
 *   - 4-byte emoji / 增补平面字符不得被截断（surrogate pair 完整）；
 *   - 单次 delta 超过阈值时正确拆成多个 chunk；
 *   - 单字符本身就超阈值（极少见）→ 丢弃、droppedBytes 正确记录；
 *   - 拆分后每个 chunk 拼回 envelope 后最终 JSON payload 字节数 < 7900；
 *   - JSON 转义边界：大量 `"`、`\`、换行、控制字符必须正确处理，不能因为转义
 *     越界或丢掉整批；最终每个 chunk 拼 envelope 的字节数仍严格 < 7900；
 *   - 混合中文 / emoji / JSON 特殊字符的整体往返。
 *
 * Run with: npx tsx tests/unit/live-delta-splitter.test.ts
 */
import {
  jsonByteCost,
  jsonEnvelopeSplitBytes,
  splitByJsonTextBytes,
  type SplitResult,
} from '../../src/modules/runs/live-delta-splitter.js';

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

/** 标准 envelope 的 prefix/suffix 字节数；UUID 固定便于断言。 */
const RUN_ID = '00000000-0000-4000-8000-000000000000';
const ENVELOPE = JSON.stringify({ runId: RUN_ID });
const { prefixBytes: PREFIX_BYTES, suffixBytes: SUFFIX_BYTES } = jsonEnvelopeSplitBytes({ runId: RUN_ID });
const MAX_PAYLOAD = 7900;
const MAX_TEXT = MAX_PAYLOAD - PREFIX_BYTES - SUFFIX_BYTES;

/**
 * 验证每个 chunk 拼回 envelope 后最终 JSON payload 字节数 < MAX_PAYLOAD，
 * 且拼接结果 === original。
 */
function verifyChunks(r: SplitResult, original: string): void {
  for (let i = 0; i < r.chunks.length; i++) {
    const chunk = r.chunks[i]!;
    const payload = `${ENVELOPE},"text":${JSON.stringify(chunk)}}`;
    const bytes = Buffer.byteLength(payload, 'utf8');
    assert(`每个 chunk 拼 envelope 后 < ${MAX_PAYLOAD}B（chunk#${i}）`, bytes < MAX_PAYLOAD,
      `bytes=${bytes}, chunk=${JSON.stringify(chunk.slice(0, 30))}${chunk.length > 30 ? '…' : ''}`);
  }
  assert('拼接 chunks === 原文', r.chunks.join('') === original,
    `joined=${JSON.stringify(r.chunks.join('').slice(0, 60))}…`);
  // chunkJsonBytes 与 chunks 长度一致，且总和 ≤ MAX_TEXT * chunks.length
  assert('chunkJsonBytes 数组长度 === chunks.length',
    r.chunkJsonBytes.length === r.chunks.length,
    `chunks=${r.chunks.length}, chunkJsonBytes=${r.chunkJsonBytes.length}`);
}

function split(text: string): SplitResult {
  return splitByJsonTextBytes({
    text,
    envelopePrefixBytes: PREFIX_BYTES,
    envelopeSuffixBytes: SUFFIX_BYTES,
    maxPayloadBytes: MAX_PAYLOAD,
  });
}

console.log(`[splitter] 环境：envelope=${PREFIX_BYTES}+${SUFFIX_BYTES} bytes, maxText=${MAX_TEXT} bytes`);

console.log('\n[splitter] S1 — 纯 ASCII 拆分');
{
  const r = split('abcdefghij');
  assert('S1: 单 chunk 装下整段', r.chunks.length === 1 && r.chunks[0] === 'abcdefghij');
  assert('S1: droppedBytes === 0', r.droppedBytes === 0);
  verifyChunks(r, 'abcdefghij');
}

console.log('\n[splitter] S2 — 中文 3-byte 字符安全拆分');
{
  const text = '一二三四五六七八九十'.repeat(100);
  const r = split(text);
  assert('S2: 整段装下单 chunk', r.chunks.length === 1, `chunks=${r.chunks.length}`);
  assert('S2: droppedBytes === 0', r.droppedBytes === 0);
  verifyChunks(r, text);
}

console.log('\n[splitter] S3 — 4-byte emoji / 增补平面字符不拆 surrogate pair');
{
  const text = '🚀'.repeat(500);
  const r = split(text);
  assert('S3: 单 chunk 装下 500 emoji', r.chunks.length === 1, `chunks=${r.chunks.length}`);
  assert('S3: chunk 由 emoji 组成', r.chunks[0] === text);
  verifyChunks(r, text);
}

console.log('\n[splitter] S4 — 超长单次 delta 拆多包');
{
  const text = 'a'.repeat(20_000);
  const r = split(text);
  assert('S4: 拆成 ≥ 3 个 chunk', r.chunks.length >= 3, `n=${r.chunks.length}`);
  assert('S4: droppedBytes === 0', r.droppedBytes === 0);
  verifyChunks(r, text);
}

console.log('\n[splitter] S5 — 中英混合 + emoji + 超 8KB 单次 delta');
{
  const asciiPart = 'a'.repeat(8_000);
  const cjkPart = '你'.repeat(1_000);
  const emojiPart = '🚀'.repeat(1_000);
  const text = cjkPart + asciiPart + emojiPart;
  const r = split(text);
  assert('S5: 拆成多个 chunk', r.chunks.length >= 2, `n=${r.chunks.length}`);
  assert('S5: droppedBytes === 0', r.droppedBytes === 0);
  verifyChunks(r, text);
}

console.log('\n[splitter] S6 — 单字符 JSON 字节超阈值 → 丢弃');
{
  // maxTextBytes 调到 5：单 ASCII chunkJsonBytes=3 < 5 → 'a'/'b' 能装下；
  // emoji cpJsonBytes=4，但 maxTextBytes-2=3，4 > 3 → 丢弃。
  const r = splitByJsonTextBytes({
    text: 'a🚀b',
    envelopePrefixBytes: PREFIX_BYTES,
    envelopeSuffixBytes: SUFFIX_BYTES,
    maxPayloadBytes: PREFIX_BYTES + SUFFIX_BYTES + 5, // maxText = 5
  });
  // 'a' (cpJsonBytes=1): buf='a' (bufJsonBytes=3).
  // '🚀' (cpJsonBytes=4 > maxTextBytes-2=3): droppedBytes += 4+2=6.
  // 'b' (cpJsonBytes=1): 3+1=4 < 5 → append buf='ab' (bufJsonBytes=4).
  // 最终 chunks = ['ab'], droppedBytes = 6.
  assert('S6: 单 emoji 被丢弃', r.droppedBytes === 6, `actual=${r.droppedBytes}`);
  assert('S6: chunks === ["ab"]',
    JSON.stringify(r.chunks) === JSON.stringify(['ab']),
    `actual=${JSON.stringify(r.chunks)}`);
  assert('S6: chunkJsonBytes === [4]', r.chunkJsonBytes[0] === 4,
    `actual=${JSON.stringify(r.chunkJsonBytes)}`);
  assert('S6: 拼接 === "ab"（emoji 缺失）', r.chunks.join('') === 'ab');
  // 二次校验：内部断言已确保 < maxPayloadBytes。
  assert('S6: 拼接 payload 字节 < 上限',
    PREFIX_BYTES + r.chunkJsonBytes[0]! + SUFFIX_BYTES < PREFIX_BYTES + SUFFIX_BYTES + 5,
    `actual=${PREFIX_BYTES + r.chunkJsonBytes[0]! + SUFFIX_BYTES}`);
}

console.log('\n[splitter] S7 — 空输入');
{
  const r = split('');
  assert('S7: 空输入 → 0 chunks', r.chunks.length === 0);
  assert('S7: droppedBytes === 0', r.droppedBytes === 0);
  assert('S7: chunkJsonBytes 为空数组', r.chunkJsonBytes.length === 0);
}

console.log('\n[splitter] S8 — 极端边界：text 字节开销恰好等于 maxTextBytes');
{
  // maxText = 3（恰好装下 1 ASCII：含外层 quotes = 1 + 2 = 3 bytes）。
  // maxPayloadBytes = 61 以保证 1 ASCII 拼 envelope 后 60 bytes 严格 < 61。
  const r = splitByJsonTextBytes({
    text: 'a',
    envelopePrefixBytes: PREFIX_BYTES,
    envelopeSuffixBytes: SUFFIX_BYTES,
    maxPayloadBytes: PREFIX_BYTES + SUFFIX_BYTES + 4,
  });
  assert('S8: 1 个 ASCII 装下', r.chunks.length === 1 && r.chunks[0] === 'a');
  assert('S8: chunkJsonBytes === [3]（含外层 quotes）',
    r.chunkJsonBytes[0] === 3,
    `actual=${r.chunkJsonBytes[0]}`);
}

console.log('\n[splitter] S9 — 大量 JSON 双引号（"）');
{
  // 每个 " 在 JSON 中占 2 byte（\"）。
  const text = '"'.repeat(1_000);
  const r = split(text);
  assert('S9: droppedBytes === 0', r.droppedBytes === 0);
  verifyChunks(r, text);
}

console.log('\n[splitter] S10 — 大量 JSON 反斜杠（\\）');
{
  // 每个 \ 在 JSON 中占 2 byte（\\）。
  const text = '\\'.repeat(2_000);
  const r = split(text);
  assert('S10: droppedBytes === 0', r.droppedBytes === 0);
  verifyChunks(r, text);
}

console.log('\n[splitter] S11 — 大量换行 + 控制字符');
{
  // \n / \t / \r → 2 byte；\0 → 6 byte。
  const text = '\n'.repeat(1_500) + '\t'.repeat(500) + '\0'.repeat(200) + '\r'.repeat(200);
  const r = split(text);
  assert('S11: droppedBytes === 0', r.droppedBytes === 0);
  verifyChunks(r, text);
}

console.log('\n[splitter] S12 — 混合 中文 / " / \\ / \\n + emoji');
{
  const text = (
    '中'.repeat(1_000) +             // 3000 byte
    '"'.repeat(1_000) +              // 2000 byte
    '\\'.repeat(1_000) +             // 2000 byte
    '\n'.repeat(1_000) +             // 2000 byte
    '🚀'.repeat(1_000)               // 4000 byte
  );
  const r = split(text);
  assert('S12: 拆成多个 chunk', r.chunks.length >= 2, `n=${r.chunks.length}`);
  assert('S12: droppedBytes === 0', r.droppedBytes === 0);
  verifyChunks(r, text);
}

console.log('\n[splitter] S13 — 大量连续双引号极端负载（>8KB）');
{
  // 5000 个 " → JSON 字节 10000，触发多 chunk。
  const text = '"'.repeat(5_000);
  const r = split(text);
  assert('S13: 拆成 ≥ 2 个 chunk', r.chunks.length >= 2, `n=${r.chunks.length}`);
  assert('S13: droppedBytes === 0', r.droppedBytes === 0);
  verifyChunks(r, text);
}

console.log('\n[splitter] S14 — 超长反斜杠 + 换行 + 中文（>13KB）');
{
  const cjkPart = '界'.repeat(3_000);
  const bsPart = '\\'.repeat(2_000);
  const nlPart = '\n'.repeat(2_000);
  const text = cjkPart + bsPart + nlPart;
  const r = split(text);
  assert('S14: 拆成多个 chunk', r.chunks.length >= 2, `n=${r.chunks.length}`);
  assert('S14: droppedBytes === 0', r.droppedBytes === 0);
  verifyChunks(r, text);
}

console.log('\n[splitter] S15 — 直接验算 jsonByteCost');
{
  assert('S15: " JSON 字节开销 === 2', jsonByteCost('"') === 2);
  assert('S15: \\ JSON 字节开销 === 2', jsonByteCost('\\') === 2);
  assert('S15: \\n JSON 字节开销 === 2', jsonByteCost('\n') === 2);
  assert('S15: \\0 JSON 字节开销 === 6', jsonByteCost('\0') === 6);
  assert('S15: 中 JSON 字节开销 === 3', jsonByteCost('中') === 3);
  assert('S15: 🚀 JSON 字节开销 === 4', jsonByteCost('🚀') === 4);
  assert('S15: a JSON 字节开销 === 1', jsonByteCost('a') === 1);
}

console.log('\n[splitter] S16 — envelope split bytes 自洽');
{
  // 用 envelope + 1 ASCII 拼一个完整 payload；
  // 字节长度 === prefixBytes + chunkJsonBytes(1 ASCII = 3) + suffixBytes。
  const text = 'x';
  const payload = `${ENVELOPE},"text":${JSON.stringify(text)}}`;
  const expected = PREFIX_BYTES + 3 + SUFFIX_BYTES;
  const actual = Buffer.byteLength(payload, 'utf8');
  assert('S16: prefixBytes + chunkJsonBytes(3) + suffixBytes === 完整 payload 字节',
    actual === expected,
    `expected=${expected}, actual=${actual}`);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}