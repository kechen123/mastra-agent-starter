# Agent 系统文档

## Agent 定义

Mastra Agent Starter当前内置两个 Agent，通过 `AgentDefinition` 描述（见 `backend/src/core/agent/types.ts`）。**具体定义和注册** 都在 `backend/src/agents/` 下。

### 通用对话 Agent (`general-chat`)

- **位置**: `backend/src/agents/general-chat/{agent.ts, instructions.ts}`
- **注册**: `backend/src/agents/index.ts`
- **用途**: 日常闲聊、百科问答、技术支持、生活咨询
- **能力**: `tools: true`, `skills: true`, `knowledgeBase: false`, `citations: false`
- **默认工具**: `calculator`, `get-current-time`
- **默认技能**: 无（运行时仅根据 `agent_skill_bindings` 表动态注入，默认为空）

### 知识库问答 Agent (`knowledge-base`)

- **位置**: `backend/src/agents/knowledge-base/{agent.ts, instructions.ts}`
- **注册**: `backend/src/agents/index.ts`
- **用途**: 基于绑定知识库的资料进行问答
- **能力**: `tools: true`, `skills: true`, `knowledgeBase: true`, `citations: true`
- **默认工具**: `calculator`, `get-current-time`
- **默认技能**: 无
- **约束**: 必须绑定知识库才能使用；回答仅基于检索到的资料，不调用外部知识

## AgentDefinition 类型

```typescript
interface AgentCapabilities {
  knowledgeBase: boolean;
  citations: boolean;
  tools: boolean;
  skills: boolean;
}

type AgentFactory = (tools?: any, skills?: any[]) => Agent;

interface AgentDefinition {
  id: string;            // 稳定的小写连字符 ID（如 general-chat）
  name: string;          // 展示名
  description?: string;  // 一句话简介
  toolIds?: string[];    // 允许使用的 Tool ID
  capabilities: AgentCapabilities;
  factory: AgentFactory; // 生成 Mastra Agent 的工厂
}
```

能力矩阵的语义：

| 字段 | 含义 |
|------|------|
| `knowledgeBase` | `true` → 运行时要求 `knowledgeBaseId`、检索 RAG、把上下文注入 prompt；`false` → 走普通 prompt 路径 |
| `citations` | `true` → `done` 事件携带 `citations[]` 一起返回 |
| `tools` | `true` → 运行时解析 `toolIds` 并注入 `Agent.tools` |
| `skills` | `true` → 运行时根据 DB 绑定解析 Skill 并注入 |

> **设计要点**：运行时**只读 `capabilities`**，从不硬编码 `if (agentId === 'xxx')`。新增 Agent 时只要把 capability 写对，运行时不需要任何修改。

## Agent 模型解析

所有 Agent factory 通过 **`infrastructure/llm/registry.ts:resolveDefaultChatModel()`** 获取运行时模型字符串。该函数：

1. 读取 `config.chatProvider`（默认 `deepseek`）和 `config.chatModel`（不含 Provider 前缀的短模型名）；
2. 调用对应 Provider Adapter 的 `resolveModelId()` 拼接完整模型 ID（如 `deepseek/deepseek-v4-flash`）；
3. 调用 Adapter 的 `assertCredentials()` 校验当前 Provider 的凭据（缺失时抛明确中文错误，**不**包含 key 本身）。

**严禁**在 Agent factory 中直接读取 `process.env`、`DEEPSEEK_API_KEY`，也不允许拼接 `provider/model` 字符串——所有 Provider 相关的实现细节都收敛在 `infrastructure/llm/providers/` 内。

> 当前 Starter 仅启用 DeepSeek。新增 Provider 时，在 `backend/src/infrastructure/llm/providers/<provider>.ts` 实现 `LlmProviderAdapter`，并在 `infrastructure/llm/registry.ts` 中显式 import 与注册；**无需修改任何 Agent、Runtime、Route、Frontend 业务代码**。

## Agent 运行时

`backend/src/core/agent/runtime.ts` 的 `streamAgent()` 是核心入口：

1. 根据 `agentId` 查找 `AgentDefinition`
2. `ensureSkillRegistryLoaded()` —— 确保 Skill 注册表已加载
3. `resolveToolIds(definition.toolIds, …)` + `resolveTools(…)` → 工具集
4. `getAgentSkillBindings(agentId)` + `resolveSkillsForAgent(...)` → 技能集（仅 `compatible`）
5. **能力驱动分支**：
   - `definition.capabilities.knowledgeBase === true` → 必须有 `knowledgeBaseId` → 检索 → 没有结果返回 done-empty → 把 Citation 上下文拼进 prompt
   - 否则 → 普通多轮对话 prompt
6. 调用 `definition.factory(tools, skills)` 创建一个临时 Mastra Agent
7. `agent.stream(prompt, { abortSignal })` 把内部流转换为统一 `StreamEvent`

> 历史说明：Stage 3 初版曾提供硬编码 `defaultSkillIds` 默认值与 `if (agentId === 'general-chat')` 之类的分支；为避免双重真相与不可绑定技能被默默启用，已移除该机制。技能必须显式通过 `POST /skills/:id/bind` 绑定才会注入。

## 流式事件

```typescript
type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; content: string; citations: Citation[] }
  | { type: 'stopped'; content: string }
  | { type: 'error'; error: string }
  | { type: 'tool-call-start'; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool-call-complete'; toolCallId: string; toolName: string; output: Record<string, unknown> }
  | { type: 'tool-call-error'; toolCallId: string; toolName: string; error: string };
```

> 注意：以上 `StreamEvent` 是后端内部的工具调用事件结构。**对外 SSE 推送的载荷是经过清洗的最小子集**（`{ toolCallId, toolName, status }`，错误事件额外含 `errorCode`）。完整 input/output 仅持久化到 `tool_executions` 表，不暴露给前端。

## Agent 能力矩阵

| Agent | knowledgeBase | citations | tools | skills |
|-------|----------------|-----------|-------|--------|
| `general-chat` | ❌ | ❌ | ✅ | ✅ |
| `knowledge-base` | ✅ | ✅ | ✅ | ✅ |

## 添加新 Agent

完整步骤见 `docs/extending.md` § 添加新 Agent。简要：

1. 在 `backend/src/agents/<your-id>/` 下新建目录
2. 复制 `backend/src/agents/_template/` 作为起点，修改 `agent.ts` 和 `instructions.ts`
3. 在 `backend/src/agents/index.ts` 中追加 `registerAgent(yourDef)`
4. 重启后端，新 Agent 会出现在 `GET /agents`

> 不要再修改 `core/agent/*` 或 `core/agent/runtime.ts`。运行时是通用 driver，所有差异通过 `capabilities` 和 `factory` 表达。