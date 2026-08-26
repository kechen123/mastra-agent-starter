# Agent 系统文档

## Agent 定义

玄枢当前内置两个 Agent，通过 `backend/src/mastra/agents/registry.ts` 中的 `AgentDefinition` 描述：

### 通用对话 Agent (`general-chat`)

- **用途**: 日常闲聊、百科问答、技术支持、生活咨询
- **能力**: `tools: true`, `skills: true`, `knowledgeBase: false`, `citations: false`
- **默认工具**: `calculator`, `get-current-time`
- **默认技能**: 无（运行时仅根据 `agent_skill_bindings` 表动态注入，默认为空）

### 知识库问答 Agent (`knowledge-base`)

- **用途**: 基于绑定知识库的资料进行问答
- **能力**: `tools: true`, `skills: true`, `knowledgeBase: true`, `citations: true`
- **默认工具**: `calculator`, `get-current-time`
- **默认技能**: 无（运行时仅根据 `agent_skill_bindings` 表动态注入，默认为空）
- **约束**: 必须绑定知识库才能使用；回答仅基于检索到的资料，不调用外部知识

## Agent 运行时

`backend/src/mastra/agents/runtime.ts` 中的 `streamAgent()` 是核心入口：

1. 根据 `agentId` 查找 `AgentDefinition`
2. 调用 `resolveToolIds()` 和 `resolveTools()` 获取工具集
3. 调用 `getAgentSkillBindings()` 获取数据库中的动态技能绑定
4. 通过 `resolveSkills()` 实例化技能（仅 `compatible` 会被采纳；`requires-runtime` 永远不会被注入）
5. 使用工厂函数 `createGeneralAgent(tools, skills)` 或 `createKnowledgeBaseAgent(tools, skills)` 创建临时 Agent 实例
6. 调用 `agent.stream()` 并转换事件为统一的 `StreamEvent`

> 历史说明：Stage 3 初版曾提供硬编码 `defaultSkillIds` 默认值；为避免双重真相与不可绑定技能被默默启用，已移除该机制。技能必须显式通过 `POST /skills/:id/bind` 绑定才会注入。

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

1. 在 `registry.ts` 的 `definitions` 数组中添加新的 `AgentDefinition`
2. 在 `runtime.ts` 的 `streamAgent()` 中添加对应的 `if (agentId === 'xxx')` 分支
3. 在 `agents/` 目录下创建对应的工厂函数（如 `createXXXAgent`）
4. 可选：在 `frontend/src/App.tsx` 中更新默认 `capabilities` 回退值
