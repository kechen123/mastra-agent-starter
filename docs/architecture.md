# Mastra Agent Starter 架构文档

## 概述

Mastra Agent Starter 是一个基于 Mastra 框架的智能对话平台，支持通用对话和知识库问答两种 Agent 模式。系统采用前后端分离架构，使用 PostgreSQL 持久化数据，并通过 SSE 流式传输实现实时对话体验。

## 技术栈

- **后端**: Mastra (~1.61.0), TypeScript, PostgreSQL
- **前端**: React 19, Vite, Tailwind CSS 4
- **数据存储**: PostgreSQL（会话、消息、知识库、技能执行审计）

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                         前端 (React)                          │
│  ┌─────────┐  ┌─────────────┐  ┌─────────┐  ┌──────────┐  │
│  │ 对话模块 │  │  知识库模块  │  │ 技能模块 │  │  设置   │  │
│  └─────────┘  └─────────────┘  └─────────┘  └──────────┘  │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP / SSE
┌────────────────────▼────────────────────────────────────────┐
│              mastra/index.ts (薄适配器)                       │
│                          │                                  │
│                          ▼                                  │
│              server/bootstrap.ts (装配)                      │
│       ┌─────────┬───────────┬────────────┬────────────┐       │
│       ▼         ▼           ▼            ▼            ▼       │
│   Agents/    Tools/     Skills/      Modules/    Routes/      │
│   index.ts   index.ts   builtin/    (conversa-  (HTTP)       │
│   (注册)     (注册)     local/      tions, KB,               │
│              marketplace/ docs, …)                          │
└─────────────────────────────────────────────────────────────┘
                          │
                   ┌──────┴──────┐
                   │  PostgreSQL │
                   └─────────────┘
```

## 核心模块

### 1. Agent 运行时 (Agent Runtime)

位于 `backend/src/core/agent/runtime.ts`。负责协调 Agent 的流式执行：

- 根据 `agentId` 查找 `AgentDefinition`
- 依据 `capabilities.knowledgeBase` 决定是否需要引文（替换历史版本里的 `if (agentId === 'general-chat')` 硬编码）
- 动态解析并注入 Tools 和 Skills
- 通过 AsyncGenerator 产生标准化的 `StreamEvent`（delta、done、stopped、error、tool-call-start、tool-call-complete、tool-call-error）
- 统一处理 AbortSignal 和异常边界

### 2. Core / Agent Registry

位于 `backend/src/core/agent/registry.ts`。

- `registerAgent(definition)` — 唯一对外注册入口（**仅由 `agents/index.ts` 调用**）
- `getAgentDefinition(id)` — 运行时查找
- `listAgentDefinitions()` — 给 `GET /agents` 暴露

`AgentDefinition` 描述能力矩阵：`knowledgeBase`, `citations`, `tools`, `skills`。运行时通过这些 boolean 决定行为分支，**不依赖具体 Agent id**。

### 3. Tool Registry

位于 `backend/src/core/tool/registry.ts`。

- 提供注册中心模式，所有工具通过 `registerTool()` 注册
- `resolveTools()` 根据 Agent 的 `toolIds` 配置解析可用工具
- `resolveToolIds()` 支持 allowed-tools 交集过滤

具体工具位于 `backend/src/tools/<id>/tool.ts`，由 `backend/src/tools/index.ts` 统一 `registerTool()`。

### 4. Skill Registry

位于 `backend/src/core/skill/registry.ts`。

- **文件系统驱动** — 三类来源：
  - `backend/src/skills/builtin/<id>/SKILL.md` —— 随版本发布
  - `backend/src/skills/local/<id>/SKILL.md` —— 本地自定义
  - `backend/market-skills/<owner>/<repo>/<skill>/SKILL.md` —— skills.sh 安装
- `_template` 目录会被 `readSkillMdEntries()` 跳过，**不会污染 Skill 列表**
- DB `skills_installed` 与 `agent_skill_bindings` 表驱动运行时注入与绑定
- `compatibility === 'compatible'` 才会被采纳；`requires-runtime` 在 `resolveSkillsForAgent()` 阶段被丢弃

### 5. Agent 定义与能力绑定

具体 Agent 定义在 `backend/src/agents/<id>/agent.ts`，由 `backend/src/agents/index.ts` 统一 `registerAgent()`。

`AgentDefinition.toolIds` 列出了 Agent 可用的 Tool；**不包含 `defaultSkillIds`**。运行时仅根据 DB 绑定注入技能，避免硬编码默认值。

### 6. 会话与消息服务

位于 `backend/src/modules/conversations/service.ts`：

- 管理 `conversations` 和 `messages` 表
- 支持持久化的多轮对话
- 消息状态机：`pending → streaming → completed | stopped | failed`
- 创建会话时按 Agent 的 `capabilities.knowledgeBase` 强制 `knowledgeBaseId` 的合法性（无 KB 能力的 Agent 强制 `null`）

### 7. 知识库检索

位于 `backend/src/modules/knowledge/rag/retriever.ts`：

- 在提问时将用户问题向量化
- 从绑定的知识库中检索相关片段（Citation）
- 返回带元数据的引文列表

### 8. 工具执行审计

位于 `backend/src/modules/conversations/tool-executions.ts`：

- 记录每次工具调用到 `tool_executions` 表
- 状态跟踪：`running → completed | failed | stopped`
- 记录输入、输出、耗时、错误码
- `convergeRunningToolExecutions()` 在流结束/异常/停止时把残留 `running` 记录收敛为 `stopped` / `failed`

### 9. Skill 市场（skills.sh）

位于 `backend/src/infrastructure/external-skills/market.ts`。**通过 `@mastra/server` 提供的官方 helpers 调用官方 API**：

- `searchMarketSkills(query)` → `searchSkillsSh()`（GET `/api/skills?query=...`）
- `listPopularMarketSkills()` → `getPopularSkillsSh()`（GET `/api/skills/top`）
- `previewMarketSkill(owner, repo, skillName)` → `previewSkillsSh()` + `fetchSkillFiles()` 计算兼容性
- `installMarketSkill(owner, repo, skillName)` → 拉取文件 → `market-skills/<owner>/<repo>/<skillName>/`
- `updateMarketSkill(id)` → 重新拉取并更新
- `uninstallMarketSkill(id)` → 删除本地文件 + 清理 DB + 刷新注册表

### 10. Server Bootstrap

位于 `backend/src/server/bootstrap.ts`，是装配的单一来源：

1. **副作用导入** — `import '../agents/index.js'` 与 `import '../tools/index.js'`，触发所有 `registerAgent()` / `registerTool()` 调用
2. **`preloadSkillRegistry()`** — 非阻塞预热 Skill 注册表，让首次 `GET /skills` 命中缓存
3. **`apiRoutes` 数组** — 把所有路由组装起来，最终由 `mastra/index.ts` 喂给 `new Mastra({ server: { apiRoutes } })`

### 11. Mastra 薄适配器

位于 `backend/src/mastra/index.ts`，**只有 ~25 行**：

```typescript
import { Mastra } from '@mastra/core';
import { apiRoutes } from '../server/bootstrap.js';

export const mastra = new Mastra({ server: { apiRoutes } });
```

业务逻辑（Agent / Tool / Skill / Route / 业务模块）一概不进 `mastra/`，仅保留这一层最薄的胶水。

### 12. LLM Provider 边界（DeepSeek-first）

位于 `backend/src/infrastructure/llm/`：

```
infrastructure/llm/
├── types.ts                # LlmProviderAdapter 契约
├── registry.ts             # Provider 解析 + resolveDefaultChatModel
└── providers/
    └── deepseek.ts         # 唯一已实现的 Provider Adapter
```

**当前 Starter 仅启用 DeepSeek**；OpenAI / Anthropic / Gemini / Azure / Ollama / OpenAI-compatible 部署的真实调用均**不在本阶段范围内**，仅在 `providers/` 目录下预留清晰的扩展边界。

依赖方向：

- `infrastructure/llm/` **不** import `agents/`、`core/`、`tools/`、`skills/`、`modules/`、`server/`；
- `core/agent/*` 完全感知不到 Provider 存在；
- Agent factory 只调用通用 `resolveDefaultChatModel()` / `resolveDefaultChatModelInfo()`；
- `/capabilities` 路由调用无凭据校验的模型描述入口输出 `defaultChatModel`（完整模型 ID）与 `llm` 元信息；
- Frontend 只展示 `capabilities.llm.{provider, model, displayName}`，**不**传入任何 Provider / API Key。

新增 Provider 实际需要修改的文件：

1. `backend/src/infrastructure/llm/providers/<provider>.ts`：实现 `LlmProviderAdapter`；
2. `backend/src/infrastructure/llm/registry.ts`：在 `PROVIDERS` 表中追加一项。

不允许修改 Agent、Core Runtime、Routes、Frontend 业务代码；不实现自动扫描、动态 import、插件热加载。错误信息使用明确中文，**不**泄露密钥、Header 或环境变量内容。

配置入口：

- `LLM_PROVIDER` 默认 `deepseek`；是否已注册由 Provider Registry 统一拒绝，新增 Adapter 后无需修改配置层；
- `LLM_MODEL` 默认 `deepseek-v4-flash`（不含 `deepseek/` 前缀）；
- `DEEPSEEK_API_KEY` 在首次调用 `resolveDefaultChatModel()`（创建 Agent / 发起模型调用）时校验；能力描述接口不校验，缺失时不输出 key 本身；
- 历史变量 `AGENT_CHAT_MODEL=deepseek/<model>` 仍可解析为对应模型并输出弃用警告；其他 Provider 前缀被拒绝；
- `XUANSHU_CHAT_MODEL` 仅输出弃用警告，不参与解析。

## 数据流

### 问答请求流

1. 用户发送 `POST /ask`，携带 `conversationId` 和 `message`
2. `server/routes/ask.ts` 保存用户消息到数据库
3. 创建 `assistant` 消息，状态为 `pending`
4. 注册执行上下文（AbortController）
5. 调用 `streamAgent(agentId, …)` 进入 `core/agent/runtime.ts`
6. 运行时按 `definition.capabilities.knowledgeBase` 决定是否走 RAG/Citation 分支
7. 动态解析 Tools 和 Skills → 调用 `definition.factory(tools, skills)` 拿到一个临时 Mastra Agent
8. `agent.stream(prompt, { abortSignal })` 产生内部流，运行时转换为统一的 `StreamEvent`
9. 路由把事件包装为 SSE 推送给前端：
   - `message-start`: 助手消息开始生成
   - `content-delta`: 文本片段
   - `tool-call-start`: 工具调用开始（载荷 `{ toolCallId, toolName, status: 'running' }`）
   - `tool-call-complete`: 工具调用成功（载荷 `{ toolCallId, toolName, status: 'completed' }`）
   - `tool-call-error`: 工具调用失败（载荷 `{ toolCallId, toolName, status: 'failed', errorCode }`）
   - `message-complete`: 生成完成
   - `message-error`: 生成失败
10. 最终持久化助手消息的最终内容、状态和引文
11. 流退出前调用 `convergeRunningToolExecutions()` 收敛残留执行记录

### 技能市场安装流

1. 前端调用 `GET /skills/market/search?q=...` 或 `GET /skills/market/popular`
2. 用户从结果中选择 `owner/repo/skillName`，前端调用 `POST /skills/market/preview` 预览
3. 预览通过 `fetchSkillFiles()` 拉取真实文件列表，计算 `compatibility`
4. 前端调用 `POST /skills/market/install`
5. 服务端下载所有文件到 `backend/market-skills/<owner>/<repo>/<skillName>/`，注册到 `skills_installed` 表
6. 调用 `loadInstalledSkills()` 刷新内存缓存
7. `compatible` 技能可通过 `POST /skills/:id/bind` 绑定到 Agent

## 路由表

| 路由 | 方法 | 说明 | 处理器位置 |
|------|------|------|-----------|
| `/agents` | GET | 列出可用 Agent 定义 | `server/routes/agents.ts` |
| `/tools` | GET | 列出可用工具定义 | `server/routes/tools.ts` |
| `/capabilities` | GET | 获取系统能力配置 | `server/routes/capabilities.ts` |
| `/healthz` | GET | 后端进程存活检查 | `server/routes/health.ts` |
| `/readyz` | GET | 数据库、LLM、Embedding 就绪检查 | `server/routes/health.ts` |
| `/skills` | GET | 列出所有技能 | `server/routes/skills.ts` |
| `/skills/:id` | GET / DELETE | 获取 / 卸载技能 | `server/routes/skills.ts` |
| `/skills/market/search` | GET | 搜索 skills.sh | `server/routes/skills.ts` |
| `/skills/market/popular` | GET | skills.sh 热门技能 | `server/routes/skills.ts` |
| `/skills/market/preview` | POST | 预览市场技能 | `server/routes/skills.ts` |
| `/skills/market/install` | POST | 安装市场技能 | `server/routes/skills.ts` |
| `/skills/:id/update` | POST | 更新已安装技能 | `server/routes/skills.ts` |
| `/skills/:id/bind` | POST | 绑定技能到 Agent | `server/routes/skills.ts` |
| `/skills/:id/unbind` | POST | 解绑技能从 Agent | `server/routes/skills.ts` |
| `/ask` | POST | 流式问答（SSE） | `server/routes/ask.ts` |
| `/messages/:id/stop` | POST | 停止生成 | `server/routes/ask.ts` |
| `/messages/:id/regenerate` | POST | 重新生成 | `server/routes/ask.ts` |
| `/conversations` | GET / POST | 会话列表 / 创建 | `server/routes/conversations.ts` |
| `/conversations/:id` | GET / PATCH / DELETE | 会话详情 / 更新 / 删除 | `server/routes/conversations.ts` |
| `/knowledge-bases` | GET / POST | 知识库列表 / 创建 | `server/routes/knowledge-bases.ts` |
| `/knowledge-bases/:id` | GET / PATCH / DELETE | 知识库详情 / 更新 / 删除 | `server/routes/knowledge-bases.ts` |
| `/knowledge-bases/:id/documents` | POST / GET | 上传 / 列出文档 | `server/routes/documents.ts` |
| `/documents/:id` | GET / DELETE | 文档详情 / 删除 | `server/routes/documents.ts` |

## 安全设计

- **Tool 沙箱**: Calculator 使用正则白名单过滤表达式，只允许数字和 `+-*/().`，拒绝任何代码注入
- **SQL 注入防护**: 所有数据库操作使用参数化查询
- **输入校验**: 严格校验 UUID 格式、字符串长度上限（2000 字符）
- **无凭证暴露**: 不保存密钥、Token、Header 到日志或数据库
- **Skill 兼容性检测**: 自动扫描技能目录中的脚本文件，标记 `requires-runtime` 以防止不安全的自动执行
- **SSE 最小载荷**: 工具调用仅推送 `{ toolCallId, toolName, status }`，完整 input/output/error 仅持久化在 `tool_executions` 表中

## 当前安全边界（必读）

当前版本定位为 **单租户、本地开发或受信任网络中的匿名演示 Starter**。

`DEPLOYMENT_PROFILE=production` 当前会在配置加载时拒绝启动。它是防误部署保护，不替代认证；只有完成身份、租户隔离与限流后才允许开放生产档位。

明确边界：

- **不** 适用于公网直接部署——所有路由都是匿名访问，没有任何身份校验或速率限制。
- **不** 适用于多用户、多租户、私有知识库隔离场景——`conversations`、`knowledge_bases`、`documents`、`tool_executions`、`agent_skill_bindings` 都没有 owner/tenant 归属列。
- **不** 实现审批流——`ToolDefinition.metadata` 中的 `destructive` / `openWorld` 字段仅作为能力声明与 UI 展示，**不是** 运行时授权策略。
- **不** 实现登录系统——`requiresAuth: false` 不应被批量改为 `true`，在没有真实身份提供方时那会造成伪安全或系统不可用。

未来接入认证时，**必须** 先建立请求身份上下文，再为上述五张表增加 owner/tenant 归属列；本阶段不创建这些列、不写迁移脚本。

### Tool Metadata 的真实定位

`ToolDefinition.metadata` 中的 `readOnly` / `destructive` / `idempotent` / `openWorld` / `requiresRuntime` 字段当前是 **能力声明与 UI 展示信息**，**不是** 生产级授权系统。任何自定义 Tool 不得返回密码、Token、Cookie、Authorization Header 或其他 secret；`destructive: true` 或 `openWorld: true` 的 Tool 在引入生产业务前 **必须** 接入身份认证、租户/资源归属校验、用户确认或策略审批、以及输入输出脱敏与审计。详细约束见 `docs/tools.md` § Tool Metadata 的真实定位。

### 前端组件拆分（后续建议）

`frontend/src/App.tsx` 当前已承载较多跨模块逻辑（Sidebar / Chat / Knowledge / Skills）。本阶段 **不** 拆组件，避免把基座可靠性阶段扩大为 UI 重构。建议：**当 App.tsx 再次出现跨模块变更时，再按 Sidebar / Chat / Knowledge / Skills 拆分**；当前不应创建空组件目录或空组件文件。
