/**
 * Mastra 装配（Phase 3.0 Durable Agent Runtime 修订）。
 *
 * 本模块负责：
 *   1. 接入 `@mastra/pg` 的 `PostgresStore`，落到独立 schema `mastra_runtime`
 *      （隔离由 `infrastructure/mastra/storage.ts` 保证）。
 *   2. 通过 Mastra 的**公共**注册路径（`agents` / `storage` / `tools` 配置
 *      + `new Mastra({...})`）装配 Mastra，使 `mastra.getStorage()` 拿到我们
 *      注入的 storage，`mastra.getAgent(id)` 命中业务 Agent。
 *   3. 保留阶段 2 的 `LocalAuthProvider` 与 `apiRoutes`，HTTP 入口形态
 *      不变。
 *
 * 关键约束：
 *   - 严禁 `__registerMastra`、`__setMastraInstanceForTesting` 等 internal /
 *     `__` 前缀 API；Agent 仅走 public `agents` 注册路径。
 *   - 严禁引入内存 Map / 前端伪恢复兼容补丁：storage 缺失必须立即抛错。
 *   - Phase 3.0 不实现审批表 / 审批 API / 审批 UI；本次仅建立可恢复
 *     Mastra 运行时基础，使后续 `requireToolApproval / approveToolCall /
 *     declineToolCall` 可以挂在 storage 上。
 *
 * 拆分说明：
 *   - `infrastructure/mastra/instance.ts` 是无 server 副作用的纯工厂；
 *   - 本文件负责把 server + 业务 auth / apiRoutes 注入到 Mastra；
 *   - 测试优先使用 `createMastraInstance({ storage })`，不导入本文件，
 *     以避免触发 Skill 加载、run executor、HTTP route 注册等副作用。
 *
 * 标识映射契约（Phase 3.0 修订）：
 *   - 业务 `agent_runs.id`  ↔  Mastra `runId`
 *   - 业务 `conversations.id`  ↔  Mastra `threadId`
 *   - 业务 `workspaces.id`  ↔  Mastra `resourceId`
 *   实际传值由 `core/execution/run-executor.ts` 在调 `streamAgent` 时
 *   显式提供；`core/agent/runtime.ts` 透传到 `agent.stream({...})` 的
 *   公开 streamOptions（见 `@mastra/core/agent.types.d.ts` 中 `runId?`
 *   与 `memory?: { thread, resource }`）。映射**不**依赖本模块的运行时
 *   注入；Mastra 单例构造时并不知道具体 Run，标识由调用方在 stream 时
 *   按 Run 携带。
 */
import type { Mastra } from '@mastra/core';
import { apiRoutes } from '../server/bootstrap.js';
import { LocalAuthProvider } from '../infrastructure/auth/local-auth-provider.js';
import { createMastraStorage } from '../infrastructure/mastra/storage.js';
import { createMastraInstance } from '../infrastructure/mastra/instance.js';

const authProvider = new LocalAuthProvider();

/**
 * 唯一的 `mastra` 导出。本模块仍 import `server/bootstrap.ts`（保留
 * 阶段 2 的 HTTP 入口形态）；但所有测试 / 脚本路径应优先使用
 * `createMastraInstance({ storage, agents, tools })`，避免触发 Skill
 * 加载与 run executor 副作用。
 */
export const mastra: Mastra = createMastraInstance({
  storage: createMastraStorage(),
  withServer: true,
  server: {
    apiRoutes,
    auth: authProvider,
  },
}) as Mastra;

export { authProvider };
