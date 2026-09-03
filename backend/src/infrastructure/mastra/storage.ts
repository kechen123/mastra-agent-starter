import 'dotenv/config';
import { PostgresStore } from '@mastra/pg';

/**
 * Phase 3.0 — Mastra 持久化存储模块。
 *
 * 设计动机：
 *  - `requireToolApproval / approveToolCall / declineToolCall` 均依赖
 *    `Mastra.storage` 上的 workflow snapshot storage。本次不实现审批接口，
 *    但 storage 缺失会让 Mastra 启动期打印 "No storage configured" 警告，
 *    并且任何"重启后恢复挂起 Run"的入口都失效。这是 Phase 3.x 的前置条件。
 *  - Mastra 框架自身的 DDL 由 `@mastra/pg` 通过正式机制创建，全部落
 *    入独立 schema `mastra_runtime`，与 `backend/database/init.sql` 中的
 *    业务表（`app_users / agent_runs / …`）分离，避免相互污染。
 *  - 真实路径必须走 PostgresStore + PostgreSQL；不接受内存 Map 或 fake
 *    替代持久化。仅有测试钩子 `_setStorageFactoryForTesting` 允许在
 *    unit 测试中临时替换，确保 CI 不依赖真实数据库。
 *  - 不手写或不复制 `@mastra/pg` 内部 DDL；schema 隔离完全交给官方
 *    `schemaName` 参数。
 */
export const MASTRA_RUNTIME_SCHEMA = 'mastra_runtime';
export const MASTRA_STORAGE_ID = 'mastra-runtime-storage';

export interface MastraStorageFactoryOptions {
  connectionString: string;
}

type StorageFactory = (opts: MastraStorageFactoryOptions) => unknown;

let factoryOverride: StorageFactory | null = null;

/**
 * 测试钩子：把 storage 构造逻辑替换为 fake。
 *
 * 仅在测试代码里调用，生产路径绝不调用。生产路径必须走 PostgresStore → 真实
 * PostgreSQL。设置后必须在下一次 `createMastraStorage()` 调用之前
 * `_resetMastraStorageForTesting()`（详见 `getMastraStorage()`）。
 */
export function _setStorageFactoryForTesting(fn: StorageFactory | null): void {
  factoryOverride = fn;
}

/**
 * 构造 Mastra 持久化存储。
 *
 * - 默认依赖 `DATABASE_URL`；缺失时直接抛错，绝不静默降级为内存存储。
 * - 通过 `schemaName` 隔离到独立 schema `mastra_runtime`。
 * - 调用方负责把返回值传给 `new Mastra({ storage })`，避免在本模块内部
 *   import 任何具体运行时。
 */
export function createMastraStorage(opts?: { connectionString?: string }): unknown {
  if (factoryOverride) {
    const connectionString =
      opts?.connectionString ?? process.env.DATABASE_URL ?? '';
    return factoryOverride({ connectionString });
  }
  const connectionString = opts?.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'Mastra storage 未配置：缺少 DATABASE_URL，且未注入测试 factory。' +
        'Phase 3.0 要求生产路径走 PostgreSQL，禁止降级到内存替代。',
    );
  }
  return new PostgresStore({
    id: MASTRA_STORAGE_ID,
    connectionString,
    schemaName: MASTRA_RUNTIME_SCHEMA,
  });
}

let cached: unknown | undefined;

/**
 * 单例惰性 getter。多次调用复用同一实例。
 *
 * 测试代码在替换 factory 后必须先调用 `_resetMastraStorageForTesting()`，
 * 否则旧值会被继续复用，违反"约束"。
 */
export function getMastraStorage(): unknown {
  if (cached !== undefined) return cached;
  cached = createMastraStorage();
  return cached;
}

export function _resetMastraStorageForTesting(): void {
  cached = undefined;
}
