import type { Agent } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core';

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
 * 第三参数 `mastraInstance`：
 *  - 由 `core/agent/runtime.ts` 在 per-request 调用时传入当前 Mastra
 *    实例；具体 Agent 工厂可选择把它注入 `new Agent({..., mastra})`，
 *    从而让 Agent 通过 public Mastra 注册路径访问持久化 storage；
 *  - 启动期 `new Mastra({ agents })` 也走本工厂，但当前实例尚未构造，
 *    因此 `mastraInstance` 为 undefined；v1 框架仍会把 storage 通过
 *    `agents` 配置注入等价效果。
 *
 * 约束：Core 层不直接依赖 Mastra SDK 的具体类型，第三个参数声明为
 * `Mastra`（来自 `@mastra/core` 顶层）以便共享类型而无需拉取 `mastra`。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentFactory = (
  tools?: any,
  skills?: unknown[],
  mastraInstance?: Mastra,
) => Agent;

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  toolIds?: string[];
  capabilities: AgentCapabilities;
  factory: AgentFactory;
}
