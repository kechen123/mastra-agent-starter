/**
 * retriever.ts fixture — 覆盖 `assertQueryEmbeddingValid` 的纯函数契约。
 *
 * 不连数据库：本测试只覆盖 `queryEmbedding` 的 4 条输入校验规则：
 *   1. 是数组（Array.isArray === true）
 *   2. 长度严格 === DATABASE_EMBEDDING_DIM（2048）
 *   3. 每个元素都是 number
 *   4. 每个元素都是有限数（Number.isFinite === true，排除 NaN / ±Infinity）
 *
 * 实际 `searchKnowledgeBase` 的检索行为留给集成测试。
 *
 * 运行：`cd backend && npx tsx tests/unit/retriever-query-embedding.ts`
 */
import assert from 'node:assert/strict';
import { DATABASE_EMBEDDING_DIM } from '../../src/config.js';
import { assertQueryEmbeddingValid } from '../../src/modules/knowledge/rag/retriever.js';

// 健全性守卫：本文件的有效样本长度必须等于数据库 schema 的固定值。
// 写死 2048 会与 config 漂移；改用 DATABASE_EMBEDDING_DIM。
const DIM = DATABASE_EMBEDDING_DIM;

// ─── 合法样本应当通过 ─────────────────────────────────────────────────
{
  // 全 0
  const valid = new Array<number>(DIM).fill(0);
  assert.doesNotThrow(
    () => assertQueryEmbeddingValid(valid),
    '全 0 向量应当通过校验',
  );

  // 全 1（有限正数）
  assert.doesNotThrow(
    () => assertQueryEmbeddingValid(new Array<number>(DIM).fill(1)),
    '全 1 向量应当通过校验',
  );

  // 包含正 / 负 / 小数 / 0
  const mixed = new Array<number>(DIM).fill(0).map((_, i) =>
    i % 4 === 0 ? 0 : i % 4 === 1 ? 1 : i % 4 === 2 ? -1 : 0.5,
  );
  assert.doesNotThrow(
    () => assertQueryEmbeddingValid(mixed),
    '含 0 / 1 / -1 / 0.5 的混合向量应当通过校验',
  );
}

// ─── 不是数组 → 抛错 ─────────────────────────────────────────────────
{
  for (const bad of [null, undefined, 'foo', 42, 3.14, {}, true, false]) {
    assert.throws(
      () => assertQueryEmbeddingValid(bad),
      /queryEmbedding 必须是数组/,
      `非数组值 ${typeof bad}: ${String(bad)} 应当被拒绝`,
    );
  }
}

// ─── 长度不对 → 抛错 ─────────────────────────────────────────────────
{
  // 短 1
  assert.throws(
    () => assertQueryEmbeddingValid(new Array(DIM - 1).fill(0)),
    new RegExp(`queryEmbedding 长度必须为 ${DIM}，实际: ${DIM - 1}`),
    '短 1 维应当被拒绝',
  );

  // 长 1
  assert.throws(
    () => assertQueryEmbeddingValid(new Array(DIM + 1).fill(0)),
    new RegExp(`queryEmbedding 长度必须为 ${DIM}，实际: ${DIM + 1}`),
    '长 1 维应当被拒绝',
  );

  // 空数组
  assert.throws(
    () => assertQueryEmbeddingValid([]),
    new RegExp(`queryEmbedding 长度必须为 ${DIM}，实际: 0`),
    '空数组应当被拒绝',
  );

  // 单元素
  assert.throws(
    () => assertQueryEmbeddingValid([0.5]),
    new RegExp(`queryEmbedding 长度必须为 ${DIM}，实际: 1`),
    '单元素向量应当被拒绝',
  );
}

// ─── 含非 number 元素 → 抛错 ─────────────────────────────────────────
{
  // 含字符串
  const withStr = new Array<unknown>(DIM).fill(0);
  withStr[100] = 'NaN';
  assert.throws(
    () => assertQueryEmbeddingValid(withStr),
    /queryEmbedding\[100\] 不是有限数.*typeof=string/,
    '含字符串元素应当被拒绝',
  );

  // 含 null
  const withNull = new Array<unknown>(DIM).fill(0);
  withNull[50] = null;
  assert.throws(
    () => assertQueryEmbeddingValid(withNull),
    /queryEmbedding\[50\] 不是有限数.*typeof=object/,
    '含 null 元素应当被拒绝',
  );

  // 含 undefined
  const withUndef = new Array<unknown>(DIM).fill(0);
  withUndef[200] = undefined;
  assert.throws(
    () => assertQueryEmbeddingValid(withUndef),
    /queryEmbedding\[200\] 不是有限数.*typeof=undefined/,
    '含 undefined 元素应当被拒绝',
  );

  // 含对象
  const withObj = new Array<unknown>(DIM).fill(0);
  withObj[10] = { x: 1 };
  assert.throws(
    () => assertQueryEmbeddingValid(withObj),
    /queryEmbedding\[10\] 不是有限数.*typeof=object/,
    '含对象元素应当被拒绝',
  );

  // 含 boolean
  const withBool = new Array<unknown>(DIM).fill(0);
  withBool[300] = true;
  assert.throws(
    () => assertQueryEmbeddingValid(withBool),
    /queryEmbedding\[300\] 不是有限数.*typeof=boolean/,
    '含 boolean 元素应当被拒绝',
  );
}

// ─── 含非有限数（NaN / ±Infinity）→ 抛错 ────────────────────────────
{
  const withNaN = new Array<number>(DIM).fill(0);
  withNaN[0] = NaN;
  assert.throws(
    () => assertQueryEmbeddingValid(withNaN),
    /queryEmbedding\[0\] 不是有限数/,
    '含 NaN 元素应当被拒绝（typeof=number 但 Number.isFinite=false）',
  );

  const withPosInf = new Array<number>(DIM).fill(0);
  withPosInf[DIM - 1] = Infinity;
  assert.throws(
    () => assertQueryEmbeddingValid(withPosInf),
    new RegExp(`queryEmbedding\\[${DIM - 1}\\] 不是有限数`),
    '含 Infinity 元素应当被拒绝',
  );

  const withNegInf = new Array<number>(DIM).fill(0);
  withNegInf[500] = -Infinity;
  assert.throws(
    () => assertQueryEmbeddingValid(withNegInf),
    /queryEmbedding\[500\] 不是有限数/,
    '含 -Infinity 元素应当被拒绝',
  );
}

// ─── 校验函数返回类型谓词：合法路径通过后类型应为 number[] ──────────
{
  const valid: unknown = new Array<number>(DIM).fill(0.5);
  // 类型谓词在编译期生效；这里再过一遍校验保证运行时无副作用。
  assertQueryEmbeddingValid(valid);
  // 若类型断言失败，下面这一行 TS 会拒编；这里仅做 length === DIM 二次确认。
  assert.ok(
    Array.isArray(valid) && valid.length === DIM,
    '合法向量通过后仍是 number[]',
  );
}

console.log('  ✓ retriever queryEmbedding validation passed');