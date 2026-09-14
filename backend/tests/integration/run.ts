/**
 * Integration-test runner. Imports each `tests/integration/*.ts` fixture
 * in sorted order. Each fixture is responsible for its own setup/teardown
 * and **must not call `process.exit()`** — failures propagate via throw.
 *
 * 行为契约（PR-1.2 关闭审查整改）：
 *   - 不再 `process.exit(0)` 提前退出 → runner 能继续 import 全部 fixture。
 *   - 任一 fixture 失败（throw / reject）→ npm run test:integration exit 1。
 *   - **不**吞掉失败：try/catch 只用来"继续 import 后续 fixture"，最终统一
 *     报告所有失败并以非 0 退出。
 *   - 无 DB 环境：DB-bound fixture 各自 SKIPPED 打印后 return；runner 必须
 *     打印 `All integration fixtures completed.`，证明全部 fixture 都被加载。
 *
 * Skip 规则：
 *   - `run.ts`（本文件）
 *   - `*.placeholder.ts`（需要外部条件才会跑的占位 fixture）
 *
 * 隔离安全（PR-4.3）：
 *   - 顶层 SKIP 闸门：`TEST_DATABASE_URL` 必须显式提供且**必须**包含
 *     `safety-identifier`（推荐 `_test`），用以避免误连到共享 / 生产 DB。
 *   - `TEST_DATABASE_URL` 缺失或不包含 safety-identifier → 整个 runner
 *     SKIPPED（exit 0 + SKIPPED 提示），**不**算"passed"，CI 应把它从
 *     regular 流水线剔除。
 *   - 即便 fixture 自己再检查 TEST_DATABASE_URL，runner 层也再防一层。
 *
 * Run with: npx tsx tests/integration/run.ts
 * 或：     TEST_DATABASE_URL=postgres://...?safety-identifier=test_db_xxx npm run test:integration
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

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
  console.log('\nAll integration fixtures SKIPPED.');
  process.exit(0);
}

const here = readdirSync(__dirname)
  .filter(
    (f) =>
      f.endsWith('.ts') && f !== 'run.ts' && !f.endsWith('-placeholder.ts'),
  )
  .sort();

interface FixtureFailure {
  file: string;
  error: unknown;
}

const failures: FixtureFailure[] = [];

for (const file of here) {
  console.log(`\n── ${file} ──`);
  try {
    await import(pathToFileURL(join(__dirname, file)).href);
  } catch (error) {
    // fixture 失败时记录并继续 —— 这样单个失败不会阻断其它 fixture 被 import。
    // 最终统一汇总，确保 npm run test:integration exit != 0。
    failures.push({ file, error });
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ fixture 失败: ${message}`);
  }
}

if (failures.length > 0) {
  console.error(
    `\nIntegration runner: ${failures.length} 个 fixture 失败（exit 1）`,
  );
  for (const f of failures) {
    console.error(`  - ${f.file}`);
  }
  console.log('\nAll integration fixtures completed.');
  process.exit(1);
}

console.log('\nAll integration fixtures completed.');