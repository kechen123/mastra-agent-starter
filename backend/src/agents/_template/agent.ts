import { Agent } from '@mastra/core/agent';
import type { AgentDefinition } from '../../core/agent/types.js';
import { resolveDefaultChatModel } from '../../infrastructure/llm/registry.js';
import { templateInstructions } from './instructions.js';

/**
 * 模板工厂 —— 复制本文件到 `backend/src/agents/<your-id>/agent.ts` 后调整：
 *
 *   - Agent 的 id / name / model；
 *   - 系统提示词（见 `./instructions.ts`）；
 *   - capabilities 能力矩阵；
 *   - 真正需要的 `toolIds`（空数组请直接删掉字段）。
 *
 * 工厂签名由 `core/agent/types.ts` 固定，并由 `core/agent/runtime.ts` 调用。
 * 它接收本次请求已解析好的 tools/skills，必须返回一个可运行的 Mastra Agent。
 *
 * 模型通过 `infrastructure/llm/registry.ts:resolveDefaultChatModel()` 解析：
 * 不要直接读取 Provider 环境变量，也不要拼接 `provider/model` 字符串；
 * 所有 Provider 相关的逻辑都收敛在 `infrastructure/llm/` 内。
 */
export function createTemplateAgent(tools?: Record<string, unknown>, skills?: unknown[]): Agent {
  return new Agent({
    id: 'template-agent',
    name: '模板 Agent',
    model: resolveDefaultChatModel(),
    instructions: templateInstructions,
    ...(tools && Object.keys(tools).length > 0 ? { tools: tools as any } : {}),
    ...(skills && skills.length > 0 ? { skills: skills as any } : {}),
  });
}

/**
 * 模板 AgentDefinition。id 必须是稳定的、连字符小写形式；description 用一句话
 * 描述 Agent 即可。capabilities 决定 Runtime 行为：
 *
 *   - `knowledgeBase: true`：Runtime 要求 knowledgeBaseId、通过 RAG 检索引文、
 *     并注入 prompt。若希望引文返回给用户，再把 `citations: true`。
 *   - `tools: true`：Runtime 会按 Tool 注册表解析 `toolIds`。
 *   - `skills: true`：Runtime 会从 DB 解析绑定关系，并按本 Agent 的 toolIds 过滤。
 *
 * 严禁注册本模板，详见 `_template/README.md`。
 */
export const templateAgent: AgentDefinition = {
  id: 'template-agent',
  name: '模板 Agent',
  description: '复制此模板以创建新 Agent。',
  toolIds: [],
  capabilities: { knowledgeBase: false, citations: false, tools: true, skills: true },
  factory: createTemplateAgent,
};