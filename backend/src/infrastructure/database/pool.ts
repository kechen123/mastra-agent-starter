import { Pool } from 'pg';

let pool: Pool | undefined;

/**
 * 全局 PG 连接池：单例。所有 `modules/` 下走 `getDatabasePool()` 拿连接
 * 的代码都会复用本池——这意味着测试时如果想"全局池也只看到测试 schema"，
 * 必须用 `__setTestPool()` 把全局池替换成带 `search_path` 的测试池。
 *
 * 生产路径：永远走默认初始化（`DATABASE_URL`）。`__setTestPool` 仅由测试
 * 入口（integration 启动处）调用，绝不在生产代码里出现。
 */
export function getDatabasePool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL 未配置。');
  }
  pool = new Pool({ connectionString });
  return pool;
}

/**
 * 测试钩子：把全局池替换为带 `search_path` 的专用测试池。
 *
 * 适用 case：集成测试需要被测代码（含 route handler / service）走全局池
 * 时也只能看到测试 schema，避免在 `public` 里写测试行污染真实库。
 *
 * 用法：
 *   const testPool = new Pool({
 *     connectionString: process.env.TEST_DATABASE_URL,
 *     options: `-c search_path=${schema},public`,
 *   });
 *   __setTestPool(testPool);
 *   try {
 *     await meRoute.handler(fakeContext);
 *   } finally {
 *     await testPool.end();
 *     __resetTestPool();
 *   }
 *
 * 安全：调用方必须保证 `TEST_DATABASE_URL` 已设置且连接到的数据库名
 * 在测试库允许列表内（`assertTestDatabase()` 会真实打开连接并
 * `SELECT current_database()` 校验），避免误把生产库换掉。
 */
export function __setTestPool(replacement: Pool): void {
  pool = replacement;
}

export function __resetTestPool(): void {
  pool = undefined;
}

/**
 * 测试专用：把对全局池的所有写入操作 + 紧跟其后的 DB 工作**串行化**到
 * 一条单链 Promise 上。`__setTestPool` / `__resetTestPool` 本身仍是同步赋值
 * （避免改动生产路径），但只要所有"会触碰全局池"的 fixture 把场景包
 * 进 `await withGlobalPoolGuard(async () => { ... })`，各场景对全局池的
 * 占用就不会重叠 —— 避免两个 fixture 并发跑时互相把对方的 search_path
 * 路径偷走、写入 auth_sessions.user_id 跑到对方的 schema、FK 失败这种
 * 跨 fixture 串扰（典型症状：`insert or update on table "auth_sessions"
 * violates foreign key constraint "auth_sessions_user_id_fkey"`，且只在
 * 全套一起跑时出现）。
 *
 * 用法（workspace-context.ts 形态）：
 *   await withGlobalPoolGuard(async () => {
 *     const testPool = installTestPool(schema);
 *     try {
 *       await ensurePersonalWorkspace(userId);
 *       await createSession({ userId, ttlDays });
 *       ...
 *     } finally {
 *       await restoreGlobalPool(testPool);
 *     }
 *   });
 *
 * 用法（isolation-contract.ts 形态）：
 *   await withGlobalPoolGuard(async () => {
 *     setGlobal(a);
 *     try {
 *       await serviceFn();
 *     } finally {
 *       resetGlobal();
 *     }
 *   });
 *
 * 实现细节：
 *   - 单条 Promise 链 `poolChain`，每次 `withGlobalPoolGuard` 把它延长一节，
 *     等前一节 settle 后才执行 fn；
 *   - fn 抛错时仍继续 resolve 下一节（用 finally 把 resolve 放外层），让
 *     链不会"卡死"在失败 case 上；
 *   - 仅供测试代码使用；生产路径不调本函数。
 */
let poolChain: Promise<unknown> = Promise.resolve();
export async function withGlobalPoolGuard<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const prev = poolChain;
  let release!: () => void;
  const myTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  poolChain = myTurn;
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}