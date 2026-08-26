/**
 * Skill Registry 加载契约测试（离线）。
 *
 * 保护的具体契约：
 *  - C1：一次 `ensureSkillRegistryLoaded()` 只触发一次 DB hydration
 *        （防止"fire-and-forget + 显式 await"的双调用造成两次查询）。
 *  - C2：hydration 失败时 `ensureSkillRegistryLoaded()` 必须拒绝；
 *        `isSkillRegistryLoaded()` 必须保持 false；后续调用可以重试。
 *  - C3：hydration 成功后并发调用复用同一个加载 Promise；后续调用短路返回。
 *  - C4：失败后调用方拿到的 promise 必须 reject，不能静默吞掉错误。
 *
 * 用 `_setSkillRegistryLoaderForTesting` 注入计数器 loader，避免连接真实 DB。
 * 计数器 loader 模拟"DB hydration 步骤"——是真实 `loadInstalledSkills` 中的
 * 唯一需要可注入副作用。
 *
 * Run with: npx tsx tests/unit/registry-hydration.ts
 */
import {
  ensureSkillRegistryLoaded,
  isSkillRegistryLoaded,
  _setSkillRegistryLoaderForTesting,
} from '../../src/core/skill/registry.js';

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
 * 构造一个可注入 loader：用 counter 记录调用次数，用 barrier 控制 resolve 时机。
 */
function makeCountingLoader(opts: { rejectFirst?: boolean; delayMs?: number } = {}) {
  let calls = 0;
  const barrier = new Promise<void>((resolve, reject) => {
    if (opts.rejectFirst) {
      // 立刻拒绝一次；下一次切换为 resolve（模拟"DB 恢复"）
      setTimeout(() => reject(new Error('simulated DB failure')), 5);
    } else {
      setTimeout(() => resolve(), opts.delayMs ?? 0);
    }
  });
  const loader = async (): Promise<void> => {
    calls++;
    await barrier;
  };
  return {
    loader,
    counter: () => calls,
  };
}

async function withLoader<T>(loader: () => Promise<void>, fn: () => Promise<T>): Promise<T> {
  _setSkillRegistryLoaderForTesting(loader);
  try {
    return await fn();
  } finally {
    // 恢复默认 loader，但保持 hydrationCompleted / hydrationPromise 状态
    // 由后续测试自行控制。
    _setSkillRegistryLoaderForTesting(null);
  }
}

console.log('[registry] 单次 hydration');

// C1：一次加载只一次 DB hydration
{
  const c = makeCountingLoader({ delayMs: 5 });
  await withLoader(c.loader, async () => {
    await ensureSkillRegistryLoaded();
    await ensureSkillRegistryLoaded();
    await ensureSkillRegistryLoaded();
    assert(
      'C1: 三次 ensureSkillRegistryLoaded 调用 → loader 仅被调用 1 次',
      c.counter() === 1,
      `counter=${c.counter()}`,
    );
    assert(
      'C1: hydration 成功后 isSkillRegistryLoaded() 返回 true',
      isSkillRegistryLoaded() === true,
    );
  });
}

console.log('\n[registry] 并发复用');

// C3：并发调用复用同一 Promise
{
  const c = makeCountingLoader({ delayMs: 30 });
  await withLoader(c.loader, async () => {
    const p1 = ensureSkillRegistryLoaded();
    const p2 = ensureSkillRegistryLoaded();
    const p3 = ensureSkillRegistryLoaded();
    assert('C3: 三个并发调用共享同一 Promise', p1 === p2 && p2 === p3);
    await Promise.all([p1, p2, p3]);
    assert('C3: 并发共享 loader 后 loader 调用次数仍为 1', c.counter() === 1);
  });
}

console.log('\n[registry] 失败可重试');

// C2 + C4：失败时必须 reject、不能静默成功
{
  // 第一次拒绝 → 第二次成功：模拟"DB 暂时不可用然后恢复"。
  let firstCallReject = true;
  let calls = 0;
  const loader = async (): Promise<void> => {
    calls++;
    if (firstCallReject) {
      await new Promise((_, reject) => setTimeout(() => reject(new Error('simulated DB failure')), 5));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  _setSkillRegistryLoaderForTesting(loader);

  // 第一次：失败
  let rejected = false;
  let errMessage = '';
  try {
    await ensureSkillRegistryLoaded();
  } catch (err) {
    rejected = true;
    errMessage = err instanceof Error ? err.message : String(err);
  }
  assert('C4: 失败时 ensureSkillRegistryLoaded() 必须 reject', rejected);
  assert(
    'C4: 错误信息透传给调用方（不是空 catch）',
    errMessage.includes('simulated DB failure'),
    `actual message=${JSON.stringify(errMessage)}`,
  );
  assert(
    'C2: 失败后 isSkillRegistryLoaded() 仍为 false',
    isSkillRegistryLoaded() === false,
  );
  assert('C2: 失败后 loader 被调用过一次', calls === 1);

  // 第二次：成功（DB 恢复）—— 必须能重试
  firstCallReject = false;
  await ensureSkillRegistryLoaded();
  assert(
    'C2: 失败后下次调用可以重试并最终成功',
    isSkillRegistryLoaded() === true,
  );
  assert('C2: 第二次调用前 loader 共被调用 2 次', calls === 2);

  // 第三次（成功状态后）：应短路返回，loader 不再被调用
  await ensureSkillRegistryLoaded();
  assert('C2: 成功后再次 ensure 短路，loader 不变', calls === 2);

  _setSkillRegistryLoaderForTesting(null);
}

console.log('\n[registry] 失败后内存索引被回滚');

// C2 强化：失败时 builtin/local/marketplace 都不应被错误地保留为"已加载"。
// 这是 Codex 关注点："不允许把'仅 builtin/local/marketplace 的部分列表'
// 当作完整已加载注册表"。
{
  // 先成功一次，让内置索引（如果存在）被填充。
  _setSkillRegistryLoaderForTesting(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  await ensureSkillRegistryLoaded();
  assert(
    '成功路径：isSkillRegistryLoaded() === true',
    isSkillRegistryLoaded() === true,
  );

  // 然后切换到一个会失败的 loader。失败后 hydrationCompleted 必须回到 false。
  _setSkillRegistryLoaderForTesting(async () => {
    await new Promise((_, reject) => setTimeout(() => reject(new Error('boom')), 5));
  });
  let rejected2 = false;
  try {
    await ensureSkillRegistryLoaded();
  } catch {
    rejected2 = true;
  }
  assert(
    '失败路径：必须 reject',
    rejected2,
  );
  assert(
    '失败路径：isSkillRegistryLoaded() 回到 false（不允许假阳性）',
    isSkillRegistryLoaded() === false,
  );

  _setSkillRegistryLoaderForTesting(null);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
