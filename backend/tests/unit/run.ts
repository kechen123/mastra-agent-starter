/**
 * Unit-test runner. Each `tests/unit/*.ts` fixture runs its assertions at
 * import-time (top-level `console.log` + `assert` calls) and exits with code
 * 1 on any failure. Importing the module IS the test.
 *
 * Run with: npx tsx tests/unit/run.ts
 *
 * 全局收尾（PR-2.4 修复 commit）：
 *   - 每个 fixture 跑完后清理 sse.ts 的全部 override（repo / bus / live-delta bus），
 *     防止某 fixture 注入的 mock 泄漏到下一个 fixture 或下一个进程实例；
 *   - 强制 stop 真实 run-events-bus 与 live-delta-bus 的单例；
 *     即便某 fixture 意外触发了真实 bus（不应发生，但作为兜底），
 *     也会在 runner 退出前关闭 PG 连接；
 *   - 不调用 `process.exit()`；让 Node 在事件循环空时自然退出。
 *     若某 fixture 留下未释放的 timer / pg connection / 未关闭 handle，
 *     进程应当挂住暴露问题，而不是被强制掩盖。fixtures 通过
 *     `process.exitCode = 1` 报告失败，Node 自然以非零状态退出。
 *
 * 注：本模块并未 import sse.ts / live-delta-bus.ts / run-events-bus.ts；
 * 用动态 import 是为了在 import 失败时（例如文件不存在）给出更可读的报错。
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const here = readdirSync(__dirname)
  .filter((f) => f.endsWith('.ts') && f !== 'run.ts')
  .sort();

for (const file of here) {
  console.log(`\n── ${file} ──`);
  await import(pathToFileURL(join(__dirname, file)).href);
}

console.log('\nAll unit fixtures completed.');

/**
 * 全局收尾：清理所有 override、停掉真实 bus。
 *
 * 任一步骤都 try/catch 兜底——即便某 fixture 抛了未捕获异常、即便真实 bus
 * 已经半挂，我们仍然要保证 runner 干净退出。
 */
async function globalTeardown(): Promise<void> {
  // 1) 清理 sse.ts 内的三个 override 模块级变量。
  //    这些 override 是 fixture 用来注入 mock 的；不清理会泄漏到下次 import / 下个进程。
  try {
    const sse = await import('../../src/modules/runs/sse.js');
    sse.__setRunRepositoryForTesting(null);
    sse.__setRunEventsBusFactoryForTesting(null);
    sse.__setLiveDeltaBusFactoryForTesting(null);
  } catch (err) {
    console.warn(`[teardown] 清理 sse override 失败：${err instanceof Error ? err.message : String(err)}`);
  }

  // 2) 停掉真实 bus（仅当 fixture 意外触发了 .start() 时才有实际效果）。
  //    LiveDeltaBus / RunEventsBus 的 stop() 内部都做了 `if (this.listener) ...` 守卫，
  //    所以从未 start 过的实例 stop 是 no-op。
  try {
    const { getLiveDeltaBus } = await import('../../src/modules/runs/live-delta-bus.js');
    await getLiveDeltaBus().stop();
  } catch (err) {
    console.warn(`[teardown] stop live-delta-bus 失败：${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const { getRunEventsBus } = await import('../../src/modules/runs/run-events-bus.js');
    await getRunEventsBus().stop();
  } catch (err) {
    console.warn(`[teardown] stop run-events-bus 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

try {
  await globalTeardown();
} catch {
  /* teardown 自身已 try/catch；保留这里仅为再兜底 */
}

// 不调用 process.exit()；让 Node 自然退出。
// fixtures 通过 process.exitCode = 1 报告失败；若 event loop 内仍有活跃 handle
// （timer / pg client / 未关闭 socket），进程会挂住——这是预期的"暴露泄漏"信号。
if (process.exitCode === undefined) {
  process.exitCode = 0;
}
