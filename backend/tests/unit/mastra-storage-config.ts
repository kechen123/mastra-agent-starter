/**
 * Mastra storage 模块契约测试（离线）。
 *
 * 保护的具体契约：
 *  - C1：固定 schema 常量 `MASTRA_RUNTIME_SCHEMA === 'mastra_runtime'`，
 *        与业务表完全隔离（业务 schema 由 `backend/database/init.sql` 管）。
 *  - C2：storage factory 可注入 fake；这是测试期间避免连真实 DB 的唯一
 *        入口，也是 `_setStorageFactoryForTesting` 的合法用例。
 *  - C3：未注入 factory + 缺少 DATABASE_URL → 必须显式抛错；
 *        禁止静默降级为内存 / Map 替代（约束 "不使用内存 Map"）。
 *  - C4：注入 factory 后，`getMastraStorage()` 必须返回该 fake；
 *        `_resetMastraStorageForTesting()` 必须让它重新评估 factory。
 *
 * 与项目其他 fixture 一致：以 console.log + 顶部 assert 风格跑断言，
 * 失败时设置 `process.exitCode = 1`，由 `tests/unit/run.ts` 聚合。
 *
 * Run with: npx tsx tests/unit/mastra-storage-config.ts
 */
import {
  MASTRA_RUNTIME_SCHEMA,
  MASTRA_STORAGE_ID,
  createMastraStorage,
  getMastraStorage,
  _setStorageFactoryForTesting,
  _resetMastraStorageForTesting,
} from '../../src/infrastructure/mastra/storage.js';

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

console.log('[mastra-storage] 常量契约');

// C1
assert(
  'MASTRA_RUNTIME_SCHEMA === "mastra_runtime"（业务表 schema 必须不受影响）',
  MASTRA_RUNTIME_SCHEMA === 'mastra_runtime',
);
assert(
  'MASTRA_STORAGE_ID 是稳定的非空字符串（PostgresStore 必须有 id）',
  typeof MASTRA_STORAGE_ID === 'string' && MASTRA_STORAGE_ID.length > 0,
);

console.log('\n[mastra-storage] factory 注入契约');

// C2
const fakeStore = { __isFakeMastraStore: true, schemaName: 'mastra_runtime' };
let factoryCallCount = 0;
_setStorageFactoryForTesting((opts) => {
  factoryCallCount++;
  // fake 必须能拿到 connectionString 透传——这是 _setStorageFactoryForTesting
  // 的契约；否则生产路径上的 PG 凭据注入无法被演练。
  return { ...fakeStore, _capturedConnectionString: opts.connectionString };
});

const created = createMastraStorage();
assert(
  '注入 factory 后 createMastraStorage() 返回 fake',
  (created as { __isFakeMastraStore?: boolean }).__isFakeMastraStore === true,
);
assert('factory 被调用一次', factoryCallCount === 1);
assert(
  'factory 收到 connectionString 透传（可能为空字符串或本地 .env 值，都是合法契约）',
  typeof (created as { _capturedConnectionString: string })._capturedConnectionString === 'string',
);

_setStorageFactoryForTesting(null);

console.log('\n[mastra-storage] 缺 DATABASE_URL 必须抛错');

// C3
const savedDatabaseUrl = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;
let threw = false;
let errMessage = '';
try {
  createMastraStorage();
} catch (err) {
  threw = true;
  errMessage = err instanceof Error ? err.message : String(err);
}
assert('缺 DATABASE_URL 且无 factory → 抛错（不允许静默降级到内存）', threw);
assert(
  '错误信息提示是 Mastra storage 配置问题',
  errMessage.includes('Mastra storage'),
);
if (savedDatabaseUrl !== undefined) process.env.DATABASE_URL = savedDatabaseUrl;

console.log('\n[mastra-storage] 单例与重置');

// C4
const fakeStore2 = { __isFakeMastraStore: true, _mark: 'first' };
const fakeStore3 = { __isFakeMastraStore: true, _mark: 'second' };
_setStorageFactoryForTesting(() => fakeStore2);
const a = getMastraStorage();
const b = getMastraStorage();
assert('getMastraStorage() 两次调用返回同一对象', a === b);
assert('第一次返回值来自 fakeStore2', a === fakeStore2);

_resetMastraStorageForTesting();
_setStorageFactoryForTesting(() => fakeStore3);
const c = getMastraStorage();
assert('reset + 替换 factory 后单例被重建', c === fakeStore3);
assert('重建后的对象不再是 fakeStore2', c !== fakeStore2);
_resetMastraStorageForTesting();
_setStorageFactoryForTesting(null);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
