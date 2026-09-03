import type { Agent } from '@mastra/core/agent';
import type { AgentDefinition } from './types.js';

/**
 * 内存版 Agent 注册表。Core 层并不感知具体存在哪些 Agent -
 * 真正的 Agent 列表由 `backend/src/agents/index.ts` 在加载时组合，
 * 该文件是唯一允许调用 `registerAgent()` 的模块。
 *
 * 设计动机：
 * - 保持 Core 与具体 Agent 实现解耦，方便独立单元测试。
 * - 启动时显式注册，所有路由注册时只需读取，不需要扫描文件系统。
 */
const agentMap = new Map<string, AgentDefinition>();

export function registerAgent(definition: AgentDefinition): void {
  if (agentMap.has(definition.id)) {
    throw new Error(`Agent ${definition.id} already registered`);
  }
  agentMap.set(definition.id, definition);
}

export function getAgentDefinition(agentId: string): AgentDefinition | undefined {
  return agentMap.get(agentId);
}

export function listAgentDefinitions(): AgentDefinition[] {
  return Array.from(agentMap.values()).map((d) => ({ ...d }));
}

export function isValidAgentId(agentId: string): boolean {
  return agentMap.has(agentId);
}

/**
 * 测试钩子：清空 Agent 注册表。
 *
 * Phase 3.0 修订——单元测试经常需要注入"测试 stub Agent"覆盖某个生产
 * AgentDefinition 的行为；stub 通过 `registerAgent()` 写入内存 map，
 * 容易泄漏到下一个 fixture。本函数仅供 unit 测试在收尾时调用，
 * 生产路径绝不调。
 */
export function _clearAgentRegistryForTesting(): void {
  agentMap.clear();
}

/**
 * 测试钩子：覆盖"per-request factory"解析。
 *
 * Phase 3.0 修订动机：原本测试通过 `registerAgent()` 注入 stub 工厂，
 * 但 stub 缺少 v1 框架 `Mastra.addAgent` 期望的若干方法（如
 * `getConfiguredProcessorWorkflows` / `listScorers` / `listTools` 等），
 * 会让生产 `mastra/index.ts` 单例构造失败。
 *
 * 本钩子把"per-request 工厂替换"与"Agent 注册表"解耦：测试仅覆盖
 * `runtime.ts` 解析出来的工厂；生产 `Mastra({ agents })` 仍然用真实
 * AgentDefinition 构造真实 `new Agent(...)`，避免上述问题。
 *
 * 仅供 unit 测试在期望"捕获 stream 选项"等场景下使用；生产路径
 * 绝不调本函数。
 */
let _factoryOverride: ((agentId: string) => Agent | undefined) | null = null;
export function _setPerRequestFactoryOverrideForTesting(
  fn: ((agentId: string) => Agent | undefined) | null,
): void {
  _factoryOverride = fn;
}

/**
 * `runtime.ts` 用本函数取出 per-request Agent。
 *
 * 优先返回测试 override；缺省时按 `AgentDefinition.factory` 构造。
 * 不抛错：调用方负责按 `null` 走"Agent 不存在"分支。
 */
export function resolvePerRequestAgent(
  agentId: string,
  tools: Record<string, unknown> | undefined,
  skills: unknown[] | undefined,
  mastraInstance: unknown,
): Agent | null {
  if (_factoryOverride) {
    const got = _factoryOverride(agentId);
    if (got) return got;
  }
  const def = agentMap.get(agentId);
  if (!def) return null;
  return def.factory(tools, skills, mastraInstance as never);
}
