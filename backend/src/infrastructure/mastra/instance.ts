/**
 * Mastra 实例工厂（Phase 3.0 Durable Agent Runtime 修订）。
 *
 * 设计动机：
 *  - 阶段 2 的 `mastra/index.ts` 静态 import `server/bootstrap.ts`，会触发
 *    `preloadSkillRegistry()` / `startRunExecutor()` / Skill 注册副作用，
 *    单元测试与最小化路径被迫加载整套 HTTP 入口与 Skill 文件扫描。
 *    任何一次 Skill 扫描异常（例如某个本地 SKILL.md frontmatter 不合法，
 *    日志里会反复出现 "Skill 名称非法: 结构化摘要"）都会污染测试输出。
 *  - Phase 3.0 把"装配 Mastra"和"装配 HTTP Server"拆开：
 *      * `instance.ts`：仅构造 Mastra 实例 + 装配 storage / tools / agents，
 *        不耦合 server、Skill 加载、run executor；
 *      * `index.ts`：仍然做"server + Mastra"组合装配，但所有调用方
 *        都应该优先用 `createMastraInstance` 显式构造；
 *      * 单测 / 迁移脚本：直接调工厂，不走 bootstrap。
 *
 * 公开 API 边界：
 *  - 严禁调用 `__registerMastra` / `__setMastraInstanceForTesting` 等
 *    `__` 前缀 internal API；所有 Tool / Agent 注册必须走
 *    `new Mastra({ storage, tools, agents })` 公开注册路径。
 *  - 严禁注入内存 Map / fake 持久化替代。Storage 由 `infrastructure/mastra/
 *    storage.ts` 注入；测试通过 `_setStorageFactoryForTesting` 替换，
 *    不允许在本模块内部绕过 storage 模块直接 new PostgresStore。
 */
import { Mastra } from '@mastra/core';
import type { Config } from '@mastra/core';
import type { ToolAction } from '@mastra/core/tools';
import type { AgentDefinition } from '../../core/agent/types.js';
import { listAgentDefinitions } from '../../core/agent/registry.js';
import { buildGlobalToolMap } from '../../core/tool/registry.js';
import { createMastraStorage } from './storage.js';

/**
 * `Mastra({ server })` 的配置类型。v1 stable 未在 `@mastra/core` 顶层
 * re-export `ServerConfig`；本模块仅在构造 Mastra 单例时需要它，按
 * `unknown` 处理即可——调用方传进来的对象字面量就是 v1 期望的形状。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServerConfigLike = Record<string, any>;

/**
 * 构造一个 `Mastra` 实例所需的全部输入。
 *
 * - `storage` 缺省时按 `createMastraStorage()` 解析（生产路径走
 *   `@mastra/pg` PostgresStore；测试由 `_setStorageFactoryForTesting` 替身）。
 * - `agents` 缺省时按 `listAgentDefinitions()` 装配静态 Agent 字典。
 *   装配时**不会**触发任何 Skill / HTTP / run executor 副作用。
 * - `tools` 缺省时为空字典；当前阶段 Tool 通过 per-request resolveTools
 *   注入到 Agent（具体 Agent 工厂负责），Mastra-level `tools` 仅作为
 *   未来全局 Tool 的预留入口。
 */
export interface CreateMastraInstanceOptions {
  storage?: unknown;
  agents?: Record<string, unknown>;
  tools?: Record<string, ToolAction<any, any, any, any, any, any>>;
  /**
   * 是否让 Mastra 自带 server 配置。默认 false——HTTP 入口由
   * `mastra/index.ts` 在 server bootstrap 时再决定；测试 / 脚本路径
   * 永远不应启用 server。
   */
  withServer?: boolean;
  server?: ServerConfigLike;
}

type StaticAgentBuilder = (definition: AgentDefinition) => unknown;

let _staticAgentBuilderOverride: StaticAgentBuilder | null = null;

/**
 * 测试钩子：替换"装配 Mastra 时构造的静态 Agent"步骤。
 * 仅在测试代码里调用；生产路径不调本函数。
 */
export function _setStaticAgentBuilderForTesting(
  fn: StaticAgentBuilder | null,
): void {
  _staticAgentBuilderOverride = fn;
}

function buildStaticAgents(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of listAgentDefinitions()) {
    out[def.id] = _staticAgentBuilderOverride
      ? _staticAgentBuilderOverride(def)
      : def.factory(undefined, undefined, undefined);
  }
  return out;
}

/**
 * 工厂入口。**所有调用方**应通过本函数构造 Mastra，而不是直接
 * `new Mastra(...)`，以便未来在工厂里加 telemetry / observability hook。
 *
 * 关键保证：
 *  - 不 import `server/bootstrap.ts`，不会触发 Skill 加载、run executor、
 *    HTTP route 装配等副作用；
 *  - storage 始终来自 `createMastraStorage()`，即 `MASTRA_RUNTIME_SCHEMA`
 *    schema 隔离；
 *  - agents 来自 `listAgentDefinitions()`，不直接依赖具体 Agent 实现。
 */
export function createMastraInstance(
  opts: CreateMastraInstanceOptions = {},
): Mastra {
  const storage =
    opts.storage !== undefined ? opts.storage : createMastraStorage();
  const agents =
    opts.agents !== undefined ? opts.agents : buildStaticAgents();
  // Phase 3.0：缺省 tools 时注入全局 Tool 注册表，让所有可恢复 Tool
  // 都走 Mastra 公共注册路径（`Mastra({ tools })`）。具体 Agent 不再
  // inline 持有 tools；Agent 通过 `mastraInstance.tools` 拿同一份注册表，
  // per-request 通过 `streamOptions.activeTools` 过滤可用子集。
  //
  // `buildGlobalToolMap()` 返回 `Record<string, unknown>`（registry 内部
  // 不耦合 Mastra tools 类型），这里 cast 到 ToolAction 字典以满足
  // `new Mastra({ tools })` 的 `TTools extends Record<string, ToolAction<...>>`
  // 约束。runtime 期 v1 会按 tool 调用入口处理。
  const tools =
    opts.tools ??
    (buildGlobalToolMap() as unknown as Record<
      string,
      ToolAction<any, any, any, any, any, any>
    >);

  // `new Mastra({ storage, agents, server })` 是 Mastra 公开注册路径；
  // 这里把 unknown 收紧到 Mastra 配置期望的类型，避免引入具体 storage SDK 类型。
  type StorageType = Config extends { storage?: infer S } ? S : never;
  type AgentMapType = Config extends { agents?: infer A } ? A : never;

  // server 配置：仅当调用方显式 opts.withServer === true 时才传入。
  // 不传 server 时 Mastra 构造期不会触碰 registerApiRoute / auth provider，
  // 即便传入 apiRoutes 也仅在 `withServer: true` 时才生效。
  if (opts.withServer === true && opts.server) {
    return new Mastra({
      storage: storage as StorageType,
      agents: agents as AgentMapType,
      tools,
      server: opts.server,
    });
  }
  return new Mastra({
    storage: storage as StorageType,
    agents: agents as AgentMapType,
    tools,
  });
}
