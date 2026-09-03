# Mastra Agent Starter 架构文档

> **文档定位**：本文描述 **当前已实现** 的系统架构（as-built）——文中出现的每个模块、表、路由都对应仓库里真实存在的代码。
> 目标演进架构见 [`architecture-v2.md`](architecture-v2.md)；从当前实现走到 V2 的路径与 PR 切片见 [`implementation-plan.md`](implementation-plan.md)。
> 本文与 V2 文档冲突时，**以本文为当前代码事实**；阶段 1 的 `workspaces` 与 Skill 三表、阶段 2 的 `agent_runs`、`agent_run_events`、幂等 POST、SSE 断点续传与双通道实时流均通过合约测试。**Phase 3.0（Durable Agent Runtime）进行中**：storage、Tool 公共注册和 ID 参数透传已实现；跨重启恢复审批 Run 未完成真实 PostgreSQL 端到端验证。`storage_finalize_jobs`、`embedding_profiles`、`document_embeddings`、人工审批（`tool_approval_requests`）、Tool Policy 等仍**未**实现；本次仅为 Phase 3.x 的前置条件。

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

位于 `backend/src/core/skill/registry.ts`，以 **facade** 形式存在，真实职责拆分到：

- `discovery.ts` —— 文件系统扫描（builtin / local / marketplace），`readSkillMdEntries()` 显式 `continue` 跳过 `_template`
- `parser.ts` —— SKILL.md frontmatter 解析（allowed-tools、name、description），纯函数
- `compatibility.ts` —— `classifyFromFiles` / `analyzeCompatibility`：脚本与可执行扩展名 → `requires-runtime`；未注册工具 → `requires-runtime`；Agent 工具未授权 → `requires-runtime`
- `bindings.ts` —— Agent ↔ Skill 绑定（双重校验：Tool 已注册 + Agent toolIds 已包含），DB CRUD
- `registry.ts` —— facade：内存三张 Map（builtin / local / installed）+ `ensureSkillRegistryLoaded()` 幂等闸门 + `tryRegisterExecution()` / `getSkill` / `listSkills` 等公共 API

关键约束：

- **文件系统驱动** — 三类来源：
  - `backend/src/skills/builtin/<id>/SKILL.md` —— 随版本发布
  - `backend/src/skills/local/<id>/SKILL.md` —— 本地自定义
  - `backend/market-skills/<owner>/<repo>/<skill>/SKILL.md` —— skills.sh 安装
- `_template` 目录会被 `discovery.ts` 的 `readSkillMdEntries()` 跳过（`if (id === '_template') continue`），**不会污染 Skill 列表**
- DB `skill_packages`、`workspace_skills` 与 `agent_skill_bindings` 三表驱动全局包、Workspace 启用与 Agent 绑定
- `compatibility === 'compatible'` 才会被采纳；`requires-runtime` 在 `resolveSkillsForAgent()` 阶段被丢弃
- 一次 `ensureSkillRegistryLoaded()` 必须只触发一次 DB hydration；失败时回滚到加载前快照、清空 in-flight Promise、下次调用可重试（不允许把"仅 builtin/local/marketplace 的部分列表"当作完整注册表）

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

### 11. Mastra 装配（阶段 3.0 起承担 storage / Agent 注册）

位于 `backend/src/mastra/index.ts`，主要责任：

1. **PostgresStore 接入**：通过 `infrastructure/mastra/storage.ts` 的 `createMastraStorage()` 构造 `@mastra/pg` 的 `PostgresStore`，落到独立 schema `mastra_runtime`（由 `@mastra/pg` 的 `schemaName` 隔离；Mastra 框架自身的 DDL 由官方机制生成）。构造期不连真实 DB；缺 `DATABASE_URL` 时**显式抛错**，绝不静默降级到内存存储。
2. **静态 Agent 注册**：以 `listAgentDefinitions()` 为权威列表，对每个 Agent 调用 `definition.factory()` 构造静态 Agent；**当前实现**下静态 Agent 构造期拿不到 `mastraInstance`（`definition.factory` 的第三个参数在静态构造路径下是 `undefined`），仅通过 v1 公开 `new Mastra({ agents })` 路径接入同一 storage。`mastra.getAgent(id)` 命中；`mastra.getStorage()` 返回阶段 3.0 注入的 PostgresStore。
3. **`apiRoutes` / `LocalAuthProvider`** 沿用阶段 2 的实现，`server.bootstrap` 路径不变。
4. **测试钩子**：`_setStaticAgentBuilderForTesting` / `_setStorageFactoryForTesting` / `_resetMastraStorageForTesting` / `_setMastraInstanceForTesting` / `_resetMastraInstanceCacheForTesting` 只用于离线单元测试，不入生产路径。

约束：
- 不调用 `__registerMastra` 等 internal API；所有 Agent 走 public `new Mastra({ agents })` + public `mastra.getAgent()`。
- 不引入内存 Map / 前端伪恢复兼容补丁顶替持久化。
- `core/agent/runtime.ts` 在每次请求时按工作区解析 Skill / Tool / 知识库后调用 `definition.factory(tools, skills, mastra)`。per-request 路径下，`mastraInstance` 由 `runtime.getMastraInstance()` 解析（生产路径走 lazy dynamic import `await import('mastra/index.js')`；单元测试可通过 `_setMastraInstanceForTesting(fakeMastra)` 注入 fake，不触发 `server/bootstrap.ts` 的副作用）。具体 Agent 工厂把 `mastra` 注入 `new Agent({ ..., mastra })`，让 per-request Agent 也通过 public API 访问 storage。

业务逻辑（Agent / Tool / Skill / Route / 业务模块）一概不进 `mastra/`，仅保留这一层最薄的胶水。

**Phase 3.0 当前事实**（2026-09-02）：
- 已实现：storage 注入、`Mastra({ agents })` 公共注册路径、`Mastra({ tools })` 全局 Tool 注册、`streamOptions.runId / memory.thread / memory.resource` 三个标识字段透传、Skill 名错误的 try/catch 隔离。
- 未验证：`Mastra.storage` 在真实 PostgreSQL 上持久化 snapshot 后、跨重启从 snapshot 恢复挂起 Run 的端到端路径；`agent_runs` ↔ Mastra snapshot 的同源校验；高风险 Tool 审批链路仍属后续阶段。

#### 11.1. `infrastructure/mastra/storage.ts`

Mastra 持久化存储接入点：

```ts
export const MASTRA_RUNTIME_SCHEMA = 'mastra_runtime';
export const MASTRA_STORAGE_ID = 'mastra-runtime-storage';

export function createMastraStorage(opts?: { connectionString?: string }): unknown {
  // 生产路径：new PostgresStore({ id, connectionString, schemaName })
  // 缺 DATABASE_URL → 抛错；
  // 测试钩子 _setStorageFactoryForTesting：仅测试期间注入 fake。
}
```

存储的 schema 隔离与业务 `init.sql` 完全独立：业务表走 `public`，Mastra 内部表走 `mastra_runtime`；两个 schema 的 DDL 来源互不交叉。

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

### 13. 单进程会话执行互斥

`backend/src/core/execution/controller.ts` 用内存 Map 维护"同一会话同一时刻
只能有一个生成任务"，避免同会话的 `/ask` 与 `/regenerate` 并发导致用户消息与
助手消息顺序错乱、setup 失败留下 active 记录、pending/streaming 消息永久悬挂
等问题。

控制器内部维护两张索引并由统一方法维护：

- `conversationId → ActiveExecution`（包括 AbortController、partial content、
  当前绑定的 assistantMessageId）
- `assistantMessageId → conversationId`（给 `stop` / SSE `finally` 用）

`tryReserveConversationExecution` 是单次 Map 写操作原子预占，避免 check-then-set
竞态；冲突时返回 `ExecutionConflictError`，路由层映射为 409。

**重要边界（多实例部署必读）：**

- 该互斥 **仅在单个 Node.js 进程内** 生效。重启进程必然清空 Map。
- **多实例生产部署不能依赖此 Map**——同会话的请求可能路由到不同实例。需要
  数据库执行租约（`SELECT ... FOR UPDATE` / advisory lock）、分布式锁（如
  Redis / etcd）或 `messages.conversation_id + status` 的部分唯一约束。本项目
  暂不提供跨进程互斥实现。
- 不替代业务层校验（如"只能重新生成最后一条助手消息"）。
- SSE 正常 / 停止 / 异常终态均由 `buildAskStreamResponse` 的 `finally` 块
  释放；setup 阶段失败由路由层主动释放会话锁并收敛 pending/streaming 消息
  为 failed。

## 数据流

### 问答请求流

1. 用户发送 `POST /ask`，携带 `conversationId` 和 `message`
2. `server/routes/messages/ask.ts` **先**对 `conversationId` 调用
   `tryReserveConversationExecution` 原子预占；冲突直接 409，不写任何消息
3. 保存用户消息到数据库
4. 创建 `assistant` 消息，状态为 `pending`
5. `bindAssistantMessageToExecution` 把助手消息 ID 绑定到已预占的会话执行
6. 注册执行上下文（AbortController）
7. 调用 `streamAgent(agentId, …)` 进入 `core/agent/runtime.ts`
8. 运行时按 `definition.capabilities.knowledgeBase` 决定是否走 RAG/Citation 分支
9. 动态解析 Tools 和 Skills → 调用 `definition.factory(tools, skills)` 拿到一个临时 Mastra Agent
10. `agent.stream(prompt, { abortSignal })` 产生内部流，运行时转换为统一的 `StreamEvent`
11. 共享驱动 `core/execution/ask-driver.ts::buildAskStreamResponse` 把事件包装为 SSE 推送给前端：
   - `message-start`: 助手消息开始生成
   - `content-delta`: 文本片段
   - `tool-call-start`: 工具调用开始（载荷 `{ toolCallId, toolName, status: 'running' }`）
   - `tool-call-complete`: 工具调用成功（载荷 `{ toolCallId, toolName, status: 'completed' }`）
   - `tool-call-error`: 工具调用失败（载荷 `{ toolCallId, toolName, status: 'failed', errorCode: 'tool_error' }`，errorCode 恒定，不暴露原始错误）
   - `message-complete`: 生成完成（含 status: completed 或 stopped）
   - `message-error`: 生成失败
12. 终态由 `core/execution/message-finalize.ts` 统一处理（DB 行 + SSE 事件），失败回退由 `finalizeAfterStreamError` 兜底
13. `finally` 块调用 `sweepRunningToolExecutions()` 收敛残留执行记录，再调用
    `cleanupExecution()` 释放双索引执行记录

`/ask`、`/messages/:id/stop`、`/messages/:id/regenerate` 三条路由共享同一驱动，唯一差异是上游输入（消息 ID / 历史切片）；`stop.ts` 仅通过 `abortExecution()` 中断执行控制器，不重复实现 SSE 协议。

### 技能市场安装流

1. 前端调用 `GET /skills/market/search?q=...` 或 `GET /skills/market/popular`
2. 用户从结果中选择 `owner/repo/skillName`，前端调用 `POST /skills/market/preview` 预览
3. 预览通过 `fetchSkillFiles()` 拉取真实文件列表，计算 `compatibility`
4. 前端调用 `POST /skills/market/install`
5. 服务端下载所有文件到 `backend/market-skills/<owner>/<repo>/<skillName>/`，注册到全局 `skill_packages` 并在当前 Workspace 启用
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
| `/auth/login` | POST | 用户名 / 密码登录（公开） | `server/routes/auth.ts` |
| `/auth/me` | GET | 当前已登录用户 | `server/routes/auth.ts` |
| `/auth/logout` | POST | 吊销当前会话 | `server/routes/auth.ts` |
| `/skills` | GET | 列出所有技能 | `server/routes/skills.ts` |
| `/skills/:id` | GET / DELETE | 获取 / 卸载技能 | `server/routes/skills.ts` |
| `/skills/market/search` | GET | 搜索 skills.sh | `server/routes/skills.ts` |
| `/skills/market/popular` | GET | skills.sh 热门技能 | `server/routes/skills.ts` |
| `/skills/market/preview` | POST | 预览市场技能 | `server/routes/skills.ts` |
| `/skills/market/install` | POST | 安装市场技能 | `server/routes/skills.ts` |
| `/skills/:id/update` | POST | 更新已安装技能 | `server/routes/skills.ts` |
| `/skills/:id/bind` | POST | 绑定技能到 Agent | `server/routes/skills.ts` |
| `/skills/:id/unbind` | POST | 解绑技能从 Agent | `server/routes/skills.ts` |
| `/ask` | POST | 流式问答（SSE） | `server/routes/messages/ask.ts` |
| `/messages/:id/stop` | POST | 停止生成 | `server/routes/messages/stop.ts` |
| `/messages/:id/regenerate` | POST | 重新生成 | `server/routes/messages/regenerate.ts` |
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

### Phase 1 本地认证（2026-08-26 落地）

| 组件 | 实现 | 说明 |
|------|------|------|
| 密码哈希 | Node `crypto.scrypt`，参数 `N=2^14, r=8, p=1`，16 字节盐、64 字节密钥 | 格式 `scrypt$N=...,r=...,p=...$<saltB64Url>$<hashB64Url>`；比较走 `timingSafeEqual` |
| 会话 token | 32 字节随机 `randomBytes` → base64url，仅存 SHA-256 | 原始 token 只出现在 HttpOnly Cookie 中 |
| Cookie | `mastra_session`，`HttpOnly; Path=/; SameSite=Strict; Max-Age=AUTH_SESSION_TTL_DAYS*86400` | `Secure` 由 `AUTH_COOKIE_SECURE` 控制（生产建议开） |
| CSRF | Origin 白名单（`AUTH_ALLOWED_ORIGIN`，精确匹配） | 仅作用于 `POST / PATCH / PUT / DELETE`；`/auth/login` 路由层单独校验，authorizeUser 放行 |
| 用户名 | `normalizeUsername()`：trim + lowercase + 长度 3-64 + 字符集 `[a-z0-9._-]` | `username_normalized` UNIQUE 用于登录查表 |
| 数据库表 | `app_users(id, username, username_normalized UNIQUE, password_hash, disabled_at, created_at, updated_at)` + `auth_sessions(id, user_id, token_hash UNIQUE, expires_at, revoked_at, last_seen_at, created_at)` | `username_normalized` 与 `token_hash` 的 UNIQUE 约束已自带索引，**不**再加同名索引；仅 `auth_sessions(user_id)` 加二级索引；不维护"活跃 token"专用部分索引；`last_seen_at` Phase 1 不写入（避免 SSE / 高频 GET 写放大），列保留仅为后续阶段预留 |
| 多设备 | 每次登录独立创建记录，`POST /auth/logout` 仅吊销当前 Cookie 对应 session | 其它设备的会话不受影响 |
| 注销路由 | `POST /auth/logout` 是 `requiresAuth: false` | 注销必须能清掉任何状态下的 Cookie（过期/已吊销/篡改）；鉴权中间件失败时 Set-Cookie 无法送达；路由层用 `isOriginAllowed` 兜底 |
| 失败信息 | 缺用户、密码错误、用户名格式非法、用户禁用 均统一返回"用户名或密码错误。" | 用户名枚举与密码错误在同一文案 |
| 路由保护 | `GET /healthz`、`GET /readyz`、`POST /auth/login`、`POST /auth/logout` 公开；其余业务路由显式 `requiresAuth: true` | `POST /auth/logout` 必须公开（详见上方"注销路由"行），静态契约扫描的 allowlist 同步包含四项；防止被改回 false |

环境变量：

- `AUTH_SESSION_TTL_DAYS`（默认 7）
- `AUTH_COOKIE_SECURE`（默认 `false`，生产环境务必 `true`）
- `AUTH_ALLOWED_ORIGIN`（精确匹配，默认 `http://localhost:5173`）

新建账号：`cd backend && npm run users:create -- --username <username>`（密码通过交互式终端两次输入，不走命令行参数）。

## 当前安全边界（必读）

当前版本定位为 **本地开发或受信任网络中的已认证 Starter**。本地账号拥有个人 Workspace；当前尚未提供组织级租户、角色授权和生产级治理能力。

`DEPLOYMENT_PROFILE=production` 当前会在配置加载时拒绝启动。它是防误部署保护，不替代认证；只有完成身份、租户隔离与限流后才允许开放生产档位。

明确边界：

- **不** 适用于公网直接部署——速率限制、租户隔离、Tool 风险治理都未实现。
- Workspace 隔离已覆盖会话、知识库、文档、分块、工具执行与 Agent-Skill 绑定；跨 Workspace 资源访问统一隐藏为 404。公开生产部署仍不适用，因为速率限制、Tool 风险治理和审批流尚未实现。
- **不** 实现审批流——`ToolDefinition.metadata` 中的 `destructive` / `openWorld` 字段仅作为能力声明与 UI 展示，**不是** 运行时授权策略。
- **Phase 1 认证范围**——本地用户名 / 密码登录与个人 Workspace 已落地；会话、知识库、文档、分块、工具执行与 Agent-Skill 绑定按 Workspace 隔离。未实现密码找回 / 多因素 / 风控锁定 / 公开注册，以及组织共享 Workspace、角色与资源级授权。

### Tool Metadata 的真实定位

`ToolDefinition.metadata` 中的 `readOnly` / `destructive` / `idempotent` / `openWorld` / `requiresRuntime` 字段当前是 **能力声明与 UI 展示信息**，**不是** 生产级授权系统。任何自定义 Tool 不得返回密码、Token、Cookie、Authorization Header 或其他 secret；`destructive: true` 或 `openWorld: true` 的 Tool 在引入生产业务前 **必须** 接入身份认证、租户/资源归属校验、用户确认或策略审批、以及输入输出脱敏与审计。详细约束见 `docs/tools.md` § Tool Metadata 的真实定位。

### 前端结构

`frontend/src/` 按职责拆分为：

- `app/App.tsx` —— 应用入口（仅承载应用级 state：主题、当前模块、会话列表、跨模块编排、SSE 事件分发与模块路由）
- `components/layout/Sidebar.tsx` —— 左侧栏（主题切换 / 模块切换 / 会话列表）
- `features/chat/components/ChatWorkspace.tsx` —— 对话工作区（消息流、引用、工具调用、Agent 选择、知识库选择、再生按钮）
- `features/chat/components/CitationPanel.tsx` —— 单条引用面板
- `features/knowledge/components/KnowledgeBaseWorkspace.tsx` —— 知识库管理（上传 / 列表 / 删除 / 状态展示）
- `features/capabilities/components/SkillsWorkspace.tsx` —— 技能面板（本地 / 市场 / 绑定 / 工具）
- `types/ui.ts` —— 跨模块共享类型（`Theme`、`Module`、`ChatMessage`、`ToolCallState`、`ConversationState`、`KnowledgeBaseChoice`）
- `lib/api.ts` / `lib/conversations.ts` —— 后端 API 客户端封装
- `types/conversation.ts` —— 会话 / 消息业务类型

App.tsx 通过 props 把应用级 state 注入到各 feature 工作区；feature 之间互不直接引用、不共享组件状态。`ChatMessage` / `ToolCallState` 等跨模块类型集中在 `types/ui.ts`，避免 feature 内部相互耦合。
