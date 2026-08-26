import type { AgentDefinition } from './types.js';

/**
 * 内存版 Agent 注册表。Core 层并不感知具体存在哪些 Agent —
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