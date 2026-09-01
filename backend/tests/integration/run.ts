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
 * Run with: npx tsx tests/integration/run.ts
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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