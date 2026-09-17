/**
 * Integration-test runner. 仅执行 `runner-fixtures.ts` manifest 中显式列出的
 * fixture —— **不**扫描 `tests/integration/*.ts`。这样：
 *   - 旧独立脚本（顶层 process.exit）保持原状、可独立 `npx tsx` 运行；
 *   - runner 只接触能 hook 真实 cleanup 的新 fixture；
 *   - 退出码按"是否任一 fixture 失败"统计，不受旧脚本的独立退出码影响。
 *
 * 行为契约（PR-1.2 关闭审查整改）：
 *   - 任一 manifest fixture 失败（throw / reject / process.exitCode=1）→
 *     npm run test:integration 退出码非 0；
 *   - 每个 fixture 必须自清理：finally 关闭 DB pool / 临时目录 / URL mock /
 *     embedding mock / runtime overrides，不留活跃 handle；
 *   - 无 DB 环境：DB-bound fixture 各自 throw / print 后 return；runner 仍
 *     必须打印"实际执行了哪些 fixture"清单再退出。
 *
 * Skip 规则（顶层）：
 *   - `run.ts`（本文件）
 *   - `runner-fixtures.ts`（manifest）
 *   - `_helpers/`（测试替身；只被 fixture 引用）
 *   - `*.placeholder.ts`（需要外部条件才会跑的占位 fixture）
 *
 * 隔离安全（PR-4.3）：
 *   - 顶层 SKIP 闸门：`TEST_DATABASE_URL` 必须显式提供且**必须**包含
 *     `safety-identifier`（推荐 `_test`），用以避免误连到共享 / 生产 DB。
 *   - `TEST_DATABASE_URL` 缺失或不包含 safety-identifier → 整个 runner
 *     SKIPPED（exit 0 + SKIPPED 提示），**不**算"passed"，CI 应把它从
 *     regular 流水线剔除。
 *
 * Run with: npx tsx tests/integration/run.ts
 * 或：     TEST_DATABASE_URL=postgres://...?safety-identifier=test_db_xxx npm run test:integration
 */
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNNER_FIXTURES } from './runner-fixtures.js';
import { acquireMockEmbeddingProvider, releaseMockEmbeddingProvider } from './_helpers/embedding-mock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 顶层 SKIP 闸门：TEST_DATABASE_URL + safety-identifier 必须同时存在。
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
const safetyIdentifierOk = /safety[_-]?identifier=test_/i.test(testDatabaseUrl);
if (!testDatabaseUrl || !safetyIdentifierOk) {
  console.warn(
    '[integration] SKIPPED: TEST_DATABASE_URL 未设置或不包含 "safety-identifier=test_..." 标记。' +
      ' 为避免误连共享 / 生产数据库，整个 integration runner 不执行任何 fixture。',
  );
  console.warn(
    '  → 设置示例: TEST_DATABASE_URL="postgres://user:pass@host:5432/db_test?safety-identifier=test_db_$(date +%s)"',
  );
  console.log('\nAll runner fixtures SKIPPED.');
  process.exit(0);
}

interface FixtureResult {
  file: string;
  status: 'pass' | 'fail';
  exitCode: number;
  error?: unknown;
}

const results: FixtureResult[] = [];

console.log(`[integration] runner manifest: ${RUNNER_FIXTURES.length} fixtures`);

// 标记 runner 模式：fixture 可借此识别"由 runner 持有 mock"避免重复启动。
process.env.DAYMIND_INTEGRATION_RUNNER = '1';

// 在 fixture 循环开始前 acquire 一次：跨所有 fixture 共享同一 mock endpoint。
// finally 统一 release → refcount=0 → 关闭 server、清 env vars。
const mockInfo = await acquireMockEmbeddingProvider();
console.log(`[integration] embedding mock listening on ${mockInfo.url} (runner-owned)`);

try {
  for (const file of RUNNER_FIXTURES) {
    console.log(`\n── ${file} ──`);
    // 每个 fixture 重新清空 exitCode，跨 fixture 互不影响（除非 fixture 自己置 1）
    const exitBefore = process.exitCode ?? 0;
    process.exitCode = 0;
    let fixtureError: unknown = null;
    try {
      await import(pathToFileURL(join(__dirname, file)).href);
    } catch (error) {
      fixtureError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ fixture throw: ${message}`);
    }
    const exitAfter = process.exitCode ?? 0;
    const finalExit = exitAfter === 0 && fixtureError ? 1 : exitAfter;
    results.push({
      file,
      status: finalExit === 0 ? 'pass' : 'fail',
      exitCode: finalExit,
      ...(fixtureError ? { error: fixtureError } : {}),
    });
    // runner 跟踪的 exitCode 取两轮中的非零较大值
    process.exitCode = Math.max(exitBefore, finalExit);
  }
} finally {
  // runner 释放 mock —— refcount=0 时 server.close() 真实执行，
  // 不留监听端口与活动 handle。
  await releaseMockEmbeddingProvider().catch(() => undefined);
  delete process.env.DAYMIND_INTEGRATION_RUNNER;
}

console.log('\n──────────────────────────────────────────────────────────');
console.log('Runner fixture 执行结果:');
for (const r of results) {
  const marker = r.status === 'pass' ? '✓' : '✗';
  const detail = r.error instanceof Error ? ` — ${r.error.message}` : '';
  console.log(`  ${marker} ${r.file}${detail}`);
}
const passed = results.filter((r) => r.status === 'pass').length;
console.log(`\n汇总: ${passed}/${results.length} fixture 通过`);

const failed = results.filter((r) => r.status !== 'pass').length;
if (failed > 0) {
  console.error(`\nIntegration runner: ${failed} 个 fixture 失败（exit 1）`);
  process.exit(1);
}
console.log('\nAll runner fixtures completed.');