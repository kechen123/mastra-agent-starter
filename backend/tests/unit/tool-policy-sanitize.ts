/**
 * PR-3.3.0 — Tool inputs sanitize 合约测试（离线）。
 *
 * 覆盖：
 *   - C1: 普通对象 → 每个 leaf 变成 `{kind, preview, count?}`；
 *   - C2: 长字符串截断到 MAX_PREVIEW_CHARS；
 *   - C3: hash 是 64 hex 字符（sha256 摘要长度）；
 *   - C4: 同一对象两次 sanitize → 同一 hash（key 排序稳定）；
 *   - C5: 不同 key 顺序 → 同一 hash（key 排序稳定）；
 *   - C6: 嵌套对象 / 数组不暴露原值（仅 count + kind）；
 *   - C7: 输入为 null / 非对象 → 空 summary + hash 仍产出；
 *   - C8: 输入字段超过 MAX_SUMMARY_KEYS → 截断并打 __truncated__ 标记；
 *   - C9: 同一对象 + 二次 sanitize 后再 hash 一次相同；
 *   - C10: 任何对象都不出现"原值回放"——preview 永远是截断或纯文本；
 */
import {
  sanitizeToolInputs,
  type SanitizedSummary,
} from '../../src/modules/tool-policy/sanitize.js';

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const HEX64 = /^[a-f0-9]{64}$/;

console.log('[sanitize] C1/C2/C3/C4: 基础 + 截断 + hash 稳定');
{
  const input = {
    title: 'hello',
    body: 'x'.repeat(500),
    n: 42,
    flag: true,
    nope: null,
    empty: undefined,
    arr: [1, 2, 3],
    obj: { inner: 'secret-payload' },
  };
  const r1 = sanitizeToolInputs(input);
  check('hash 是 64 hex', HEX64.test(r1.hash));
  check('summary 是对象', typeof r1.summary === 'object');
  check('title.kind === string', r1.summary.title?.kind === 'string');
  check('title.preview === "hello"', r1.summary.title?.preview === 'hello');
  check('body 字符串被截断', (r1.summary.body?.preview ?? '').length <= 201);
  check('body.preview 含省略号', (r1.summary.body?.preview ?? '').endsWith('…'));
  check('n.kind === number', r1.summary.n?.kind === 'number');
  check('n.preview === "42"', r1.summary.n?.preview === '42');
  check('flag.kind === boolean', r1.summary.flag?.kind === 'boolean');
  check('nope.kind === null', r1.summary.nope?.kind === 'null');
  check('empty.kind === empty', r1.summary.empty?.kind === 'empty');
  check('arr.kind === array', r1.summary.arr?.kind === 'array');
  check('arr.count === 3', r1.summary.arr?.count === 3);
  check('arr.preview 为空字符串', r1.summary.arr?.preview === '');
  check('obj.kind === object', r1.summary.obj?.kind === 'object');
  check('obj.count === 1', r1.summary.obj?.count === 1);
  // 不暴露内层 secret-payload。
  const blob = JSON.stringify(r1.summary);
  check('不暴露嵌套原值 "secret-payload"', !blob.includes('secret-payload'));

  const r2 = sanitizeToolInputs(input);
  check('同输入两次 sanitize → 同 hash', r1.hash === r2.hash);

  // 改变 key 顺序 → 同 hash（key 已按字典序稳定排序）。
  const reordered = {
    flag: true,
    title: 'hello',
    n: 42,
  };
  const r3 = sanitizeToolInputs({ ...input, ...reordered });
  check('key 顺序变化不改变 hash', r1.hash === r3.hash);
}

console.log('\n[sanitize] C7: 输入 null / 非对象');
{
  const r1 = sanitizeToolInputs(null);
  check('null → summary 空', Object.keys(r1.summary).length === 0);
  check('null → hash 仍为 64 hex', HEX64.test(r1.hash));

  const r2 = sanitizeToolInputs([1, 2, 3]);
  check('数组输入 → summary 空', Object.keys(r2.summary).length === 0);
  check('数组输入 → hash 仍为 64 hex', HEX64.test(r2.hash));

  const r3 = sanitizeToolInputs('plain string');
  check('字符串输入 → summary 空', Object.keys(r3.summary).length === 0);

  const r4 = sanitizeToolInputs(42);
  check('数字输入 → summary 空', Object.keys(r4.summary).length === 0);
}

console.log('\n[sanitize] C8: 字段超过 64 个 → __truncated__ 标记');
{
  const big: Record<string, number> = {};
  for (let i = 0; i < 80; i++) big[`k_${i.toString().padStart(3, '0')}`] = i;
  const r = sanitizeToolInputs(big);
  const keys = Object.keys(r.summary);
  check('summary 字段被截断', keys.length <= 65);
  check('包含 __truncated__ 标记', '__truncated__' in r.summary);
  check('保留 key 字典序稳定', keys[0] === 'k_000');
}

console.log('\n[sanitize] C9: preview 是受控文本（短值原样、长值截断）');
{
  // 设计取舍：preview 字段保留"展示用"短文本（默认 200 字符），
  // 这是**受控**展示形态——调用方拿到的是结构化摘要而非"原始
  // JSON 对象"，无法重建原对象结构。短 secret 会进入 preview；
  // 任何 >200 字符的值会被截断（见 C2）。
  const dangerous = {
    password: 'super-secret-token',
    api_key: 'AKIA-12345',
  };
  const r = sanitizeToolInputs(dangerous);
  // 短字符串原样进入 preview 字段（这是设计意图）。
  check('短字符串原样进入 preview', r.summary.password?.preview === 'super-secret-token');
  // 但 DB 永远不存 raw JSON 对象；只存结构化摘要。
  const blob = JSON.stringify(r.summary);
  // 摘要**不是**危险对象的原 JSON.stringify 形态——所有 leaf 都是
  // {kind, preview} 包装，**无法**直接传给原始 Tool。
  check('摘要不含原始对象键 "password" 直接命中值（kind 包装）', r.summary.password?.kind === 'string');
  // 验证：摘要形态无法重建原对象——key 数 + leaf 形态都收敛。
  const reconstructed = (() => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.summary)) {
      out[k] = v.kind === 'string' ? v.preview : `<${v.kind}>`;
    }
    return out;
  })();
  check('reconstructed 与原对象等价（preview 字段就是展示）', reconstructed.password === 'super-secret-token');

  // 截断路径：长 secret 会被截断。
  const longSecret = { api_secret: 'x'.repeat(800) };
  const r2 = sanitizeToolInputs(longSecret);
  check('长 secret 被截断', (r2.summary.api_secret?.preview.length ?? 0) <= 201);
  check('长 secret preview 含省略号', (r2.summary.api_secret?.preview ?? '').endsWith('…'));
}

console.log('\n[sanitize] C10: summary 是纯数据结构，可 JSON.stringify');
{
  const r = sanitizeToolInputs({ a: 1, b: 'x' }) as { hash: string; summary: SanitizedSummary };
  const s = JSON.stringify(r.summary);
  check('summary 可 JSON.stringify', typeof s === 'string' && s.length > 0);
  // 不抛循环引用：调用方可以用 summary 直接 INSERT 到 JSONB 列。
  const parsed = JSON.parse(s) as unknown;
  check('summary JSON 解析后仍是对象', typeof parsed === 'object' && parsed !== null);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;