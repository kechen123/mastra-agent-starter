/**
 * Lease fake —— 固定 lease_owner + 可控 now()。
 *
 * 用途（V2 §6.3 / implementation-plan §PR-0.3）：
 *   - 阶段 2 起 `agent_runs` / `storage_finalize_jobs` / `document_ingestion_jobs`
 *     都会持有 `lease_owner` / `lease_expires_at`；
 *   - 测试要驱动「Lease 过期 → failed」「抢占失败」「心跳续约」三种场景，
 *     但生产代码路径里只有 `now()` 是变量——本工具替换 `Date.now()`，
 *     让测试快进时间。
 *
 * 设计：
 *   - `installFakeClock(initial)` 接管全局 `Date.now()`；
 *   - `advanceClock(ms)` 把虚拟时间向前推进，所有持有 `Date.now()` 的代码
 *     都看到新值；
 *   - `getFixedLeaseOwner()` 返回测试约定的固定 workerId 便于在断言中识别；
 *   - `uninstallFakeClock()` 恢复原生 `Date.now()`。
 *
 * 范围限制（实现简化）：
 *   - 只替换 `Date.now()`，不替换 `new Date()`；
 *     生产代码若用 `new Date()` 取当前时间，需自行改用 `Date.now()` 或
 *     显式依赖本工具。
 *   - 不替换 PG 服务端时间——SQL 里 `now()` 仍是数据库时钟。
 *     需要驱动 SQL 时间请用 `db-isolation.ts` + 显式 `INSERT` 时写入。
 *
 * 进程级单实例：fake 状态共享，同一进程跑多个 fake-clock 测试需串行。
 */

const realDateNow: () => number = Date.now.bind(Date);

let fakeNowMs: number | null = null;

const FIXED_LEASE_OWNER = 'test-worker-fixed';

export function getFixedLeaseOwner(): string {
  return FIXED_LEASE_OWNER;
}

/**
 * 安装 fake clock：从 `initialMs` 开始（或当前时间）。
 */
export function installFakeClock(initialMs?: number): void {
  if (fakeNowMs !== null) {
    throw new Error(
      'fake clock 已安装；请先 uninstallFakeClock() 再调用 installFakeClock()。',
    );
  }
  fakeNowMs = initialMs ?? realDateNow();
  // eslint-disable-next-line no-global-assign
  Date.now = (): number => fakeNowMs as number;
}

/**
 * 把 fake clock 向前推进 `deltaMs`。
 */
export function advanceClock(deltaMs: number): void {
  if (fakeNowMs === null) {
    throw new Error('fake clock 未安装；先调用 installFakeClock()。');
  }
  fakeNowMs += deltaMs;
}

/**
 * 读取当前 fake clock 的毫秒数（未安装时返回原生 Date.now()）。
 */
export function now(): number {
  return fakeNowMs ?? realDateNow();
}

/**
 * 恢复原生 Date.now()；后续 fake 调用会抛错。
 */
export function uninstallFakeClock(): void {
  if (fakeNowMs === null) return;
  Date.now = realDateNow;
  fakeNowMs = null;
}

/**
 * 在 fake clock 生命周期内执行体；结束自动 uninstall。
 */
export async function withFakeClock<T>(
  body: () => Promise<T>,
  initialMs?: number,
): Promise<T> {
  installFakeClock(initialMs);
  try {
    return await body();
  } finally {
    uninstallFakeClock();
  }
}
