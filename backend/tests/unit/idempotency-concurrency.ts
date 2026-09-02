/**
 * Idempotency 并发合约测试（注入式，不连接真实 DB）。
 *
 * 覆盖的合约（V2 §6.2）：
 *   - C1：`fingerprintRequest` 对 key 顺序无关（canonical JSON）。
 *   - C2：`isUuid` 严格 5 段 8-4-4-4-12 校验。
 *   - C3：模拟 advisory_xact_lock 串行化的同 key 并发同 fingerprint 请求：
 *       * 整个并发集合只产生一次"副作用"（这里用一个 sideEffects 闭包计数）；
 *       * 所有调用方都拿到同一稳定响应；
 *       * 单 key 不同 fingerprint → 返回 409 IDEMPOTENCY_KEY_REUSED 语义。
 *
 * 真实 PG `pg_advisory_xact_lock` 串行化在仓库的 init.sql + repository.ts 实现；
 * 本测试只模拟其语义（JS 进程内串行队列），不替代集成测试。
 *
 * Run with: npx tsx tests/unit/idempotency-concurrency.ts
 */
import assert from 'node:assert/strict';
import {
  fingerprintRequest,
  isUuid,
} from '../../src/modules/idempotency/repository.js';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n[idempotency] C1 — fingerprintRequest 稳定且 key 顺序无关');
{
  const a = fingerprintRequest('POST', '/conversations', { agentId: 'a', knowledgeBaseId: null });
  const b = fingerprintRequest('POST', '/conversations', { knowledgeBaseId: null, agentId: 'a' });
  const c = fingerprintRequest('post', '/conversations', { agentId: 'a', knowledgeBaseId: null }); // case-insensitive method
  check('C1: 同内容不同 key 顺序 → 同 fingerprint', a === b, `a=${a.slice(0, 8)} b=${b.slice(0, 8)}`);
  check('C1: 大小写归一化方法 → 同 fingerprint', a === c, `a=${a.slice(0, 8)} c=${c.slice(0, 8)}`);
  check('C1: fingerprint 是 64 位 hex', /^[0-9a-f]{64}$/.test(a));
  const d = fingerprintRequest('POST', '/conversations', { agentId: 'b', knowledgeBaseId: null });
  check('C1: 不同内容 → 不同 fingerprint', a !== d);
  // 嵌套对象 + 数组也要 canonical
  const e = fingerprintRequest('POST', '/messages', { items: [{ a: 1, b: 2 }, { c: 3 }] });
  const f = fingerprintRequest('POST', '/messages', { items: [{ b: 2, a: 1 }, { c: 3 }] });
  check('C1: 嵌套对象 key 顺序无关', e === f);
}

console.log('\n[idempotency] C2 — isUuid 严格格式');
{
  check('C2: 标准 v4 → true', isUuid('00000000-0000-4000-8000-000000000000'));
  check('C2: 大写 → true', isUuid('A1B2C3D4-E5F6-4789-A012-3456789ABCDE'));
  check('C2: 空串 → false', !isUuid(''));
  check('C2: 缺连字符 → false', !isUuid('00000000000040008000000000000000'));
  check('C2: 段长度错 → false', !isUuid('0000000-0000-4000-8000-000000000000'));
  check('C2: 非 hex 字符 → false', !isUuid('zzzzzzzz-0000-4000-8000-000000000000'));
  check('C2: version 位不是 1-5 → false', !isUuid('00000000-0000-6000-8000-000000000000'));
  check('C2: null → false', !isUuid(null));
  check('C2: undefined → false', !isUuid(undefined));
  check('C2: 非字符串 → false', !isUuid(123 as unknown as string));
}

console.log('\n[idempotency] C3 — 并发同 key 同 fingerprint → 单副作用 + 稳定响应');

/**
 * 模拟 advisory_xact_lock + idempotency_keys 占位表行为的简化版本。
 * 真实实现在 src/modules/idempotency/repository.ts::claimOrLookupIdempotency，
 * 依赖 PG 行锁。本测试用 JS 进程内 promise queue 复现"串行化声明 + 占位等待"
 * 的核心语义。
 *
 * 关键不变量：
 *   - 同一 (ws, user, key) 的所有 claimOrLookup 调用必须串行执行；
 *   - 第一个"claimed"成功的会执行 sideEffect 并写 response；
 *   - 后续 claimOrLookup 在占位期间看到已有 cached response → 返回同一 hit。
 */
async function simulateClaim(args: {
  workspaceId: string;
  userId: string;
  key: string;
  fingerprint: string;
  store: Map<string, { fingerprint: string; responseStatus: number | null; responseBody: unknown; completedAt: number | null }>;
  locks: Map<string, Promise<void>>;
  sideEffect: () => Promise<{ status: number; body: unknown }>;
}): Promise<
  | { claimed: true; status: number; body: unknown }
  | { claimed: false; hit: { status: number; body: unknown } }
  | { claimed: false; mismatch: true }
> {
  const lockKey = `${args.workspaceId}:${args.userId}:${args.key}`;
  // 阻塞直到前一个持有者完成
  const prev = args.locks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => { release = res; });
  args.locks.set(lockKey, prev.then(() => next));
  await prev;

  try {
    const row = args.store.get(lockKey);
    if (!row) {
      // 占位行（completedAt === null）
      args.store.set(lockKey, {
        fingerprint: args.fingerprint,
        responseStatus: null,
        responseBody: null,
        completedAt: null,
      });
      const result = await args.sideEffect();
      args.store.set(lockKey, {
        fingerprint: args.fingerprint,
        responseStatus: result.status,
        responseBody: result.body,
        completedAt: Date.now(),
      });
      return { claimed: true, status: result.status, body: result.body };
    }
    if (row.fingerprint !== args.fingerprint) {
      return { claimed: false, mismatch: true };
    }
    if (row.completedAt === null) {
      // 占位中（理论 advisory lock 下不应撞上）。失败安全：等待占位者提交。
      // 测试中不会出现。
      throw new Error('placeholder still in-flight under advisory lock');
    }
    return { claimed: false, hit: { status: row.responseStatus!, body: row.responseBody } };
  } finally {
    release();
  }
}

{
  const store = new Map<string, { fingerprint: string; responseStatus: number | null; responseBody: unknown; completedAt: number | null }>();
  const locks = new Map<string, Promise<void>>();
  let sideEffectCalls = 0;
  const ws = 'ws-1';
  const user = 'user-1';
  const key = 'idem-1';
  const fp = fingerprintRequest('POST', '/conversations', { agentId: 'a' });

  // 模拟 N 个并发请求，全部用同 fingerprint
  const N = 50;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      simulateClaim({
        workspaceId: ws,
        userId: user,
        key,
        fingerprint: fp,
        store,
        locks,
        async sideEffect() {
          sideEffectCalls += 1;
          return { status: 201, body: { conversationId: `c-${i}` } };
        },
      }),
    ),
  );

  // 期望：
    // - 至少 1 个 claimed；其余全部 hit；并且 body.conversationId 来自首个 claimed。
    // - 副作用只执行 1 次。
  const claimed = results.filter((r) => 'claimed' in r && r.claimed);
  const hits = results.filter((r) => 'hit' in r && r.hit);
  check('C3: sideEffect 只执行 1 次', sideEffectCalls === 1, `actual=${sideEffectCalls}`);
  check('C3: claimed 数量 === 1', claimed.length === 1, `actual=${claimed.length}`);
  check('C3: hit 数量 === N-1', hits.length === N - 1, `actual=${hits.length}`);
  // 第一个 claimed 的 body 应该被所有 hits 共享
  if (claimed.length === 1 && claimed[0]!.claimed) {
    const firstBody = claimed[0]!.body;
    const allSame = hits.every((h) => 'hit' in h && JSON.stringify(h.hit.body) === JSON.stringify(firstBody));
    check('C3: 所有 hit body 与首次 claimed body 完全一致', allSame);
  }
}

console.log('\n[idempotency] C4 — 同 key 不同 fingerprint → mismatch');
{
  const store = new Map<string, { fingerprint: string; responseStatus: number | null; responseBody: unknown; completedAt: number | null }>();
  const locks = new Map<string, Promise<void>>();
  const ws = 'ws-1';
  const user = 'user-1';
  const key = 'idem-2';
  const fp1 = fingerprintRequest('POST', '/conversations', { agentId: 'a' });
  const fp2 = fingerprintRequest('POST', '/conversations', { agentId: 'b' });

  let sideEffectCalls = 0;
  const r1 = await simulateClaim({
    workspaceId: ws,
    userId: user,
    key,
    fingerprint: fp1,
    store,
    locks,
    async sideEffect() {
      sideEffectCalls += 1;
      return { status: 201, body: { conversationId: 'c-1' } };
    },
  });
  check('C4: 首次请求 claimed', 'claimed' in r1 && r1.claimed);

  // 第二次同 key 不同 fingerprint → 409 mismatch
  let mismatchReturn: { claimed: false; mismatch: true } | null = null;
  try {
    await simulateClaim({
      workspaceId: ws,
      userId: user,
      key,
      fingerprint: fp2,
      store,
      locks,
      async sideEffect() {
        sideEffectCalls += 1;
        return { status: 201, body: { conversationId: 'c-2' } };
      },
    });
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
  }
  const r2 = await simulateClaim({
    workspaceId: ws,
    userId: user,
    key,
    fingerprint: fp2,
    store,
    locks,
    async sideEffect() {
      sideEffectCalls += 1;
      return { status: 201, body: { conversationId: 'c-2' } };
    },
  });
  check('C4: 同 key 不同 fingerprint → mismatch', 'mismatch' in r2 && r2.mismatch);
  if ('mismatch' in r2 && r2.mismatch) mismatchReturn = r2;
  check('C4: mismatch 路径未触发副作用', sideEffectCalls === 1);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`idempotency-concurrency 失败 ${failed} 项断言`);
}