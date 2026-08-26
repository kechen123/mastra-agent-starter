import type { Agent } from '@mastra/core/agent';

/**
 * Agent 的能力矩阵。Runtime 在每次请求时检查：
 * - `knowledgeBase`：决定是否需要绑定 knowledgeBaseId、检索引文。
 * - `citations`：决定检索到的引文是否回传前端（同时仍会注入 prompt）。
 * - `tools`：决定是否按 toolIds 解析 Tool 注册表。
 * - `skills`：决定是否按 agent_skill_bindings 解析 Skill 并注入。
 *
 * 任何字段为 false 的 Agent，对应能力的代码路径完全不会执行，
 * 例如 knowledgeBase=false 时不会调用 RAG 检索器。
 */
export interface AgentCapabilities {
  knowledgeBase: boolean;
  citations: boolean;
  tools: boolean;
  skills: boolean;
}

/**
 * 把 tools/skills 装配成可运行 Mastra Agent 的工厂。
 * 每个具体 Agent 放在 `backend/src/agents/<id>/`，导出此签名的工厂。
 *
 * Core Runtime 故意不耦合 Mastra：
 * - tools/skills 在此签名里是 `any`，由各 Agent 的工厂自行收敛成 Mastra 的
 *   `ToolsInput` / `Agent['skills']` 等窄类型。
 * - 这样 Core 层不依赖具体框架细节，便于替换或测试。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentFactory = (tools?: any, skills?: any[]) => Agent;

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  toolIds?: string[];
  capabilities: AgentCapabilities;
  factory: AgentFactory;
}