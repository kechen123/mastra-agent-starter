# Mastra Agent Starter 架构文档

> **2026-09-14 V2 Chat Runtime 收尾基线**：
> 本轮在 PR-4 之上完成 V2 chat runtime 修复：
>   - 后端停止一致性：`abortRunByMessage()` 返回结构化 discriminated union（`AbortRunResult`），HTTP stop / SSE run-stopped / final checkpoint / message.content 共用 V2 executor 的 `execution.fullText` 不可变文本快照。同一进程单实例收敛；**跨实例**不属本轮范围。
>   - 前端 stop 状态机：`src/lib/stop-state-machine.ts` 纯逻辑模块 + 30 用例单测；HTTP/SSE 任意顺序幂等；session switch / KB / capabilities 页面**不**调后端 stop。
>   - Tool call 稳定 ID：`tool_executions.tool_call_id` + UNIQUE(workspace_id, run_id, tool_call_id)；`upsertToolExecution` / `finalizeToolExecutionByCallId` 幂等；批量查消除 N+1。
>   - RAG 阈值 / AbortSignal / 错误归类：`RAG_MIN_SIMILARITY` 默认 0.5（严格 [0,1]）；`EMBEDDING_TIMEOUT_MS` 默认 15000ms；embedding provider 错误归一为内部 `EmbeddingError` 类，**不**抛原始 body / endpoint / key 字样。
>   - Test/CI：frontend `npm test` 用 tsx 直跑 + 30 状态机 + 23 renderer 用例；backend `tests/unit/rag-threshold-abort-sanitize.ts` + `tool-execution-dedup.ts`；integration runner 顶层 TEST_DATABASE_URL + safety-identifier 闸门守护，无 DB 时 SKIPPED（**不**算 passed）。
>   - 真实 PostgreSQL / 真实 DeepSeek / 真实 Embedding / 真实 MinerU / 浏览器前后端端到端联调：**本轮未授权 / 未在本流水线验证**，保留为 staging e2e 待办。
>
> **PR-4 状态（2026-09-11，第二轮 Codex review 后）**：PR-4.1 / PR-4.2 / PR-4.3 代码已完成；真实 PostgreSQL 端到端 **18 passed、0 failed**（Core-only 16 + RAG 2）的早期快照保留供历史对照——本轮 verify **未重跑**该用例集，仅以 unit / contracts / fixtures 覆盖新增契约。

> **文档定位**：本文描述 **当前已实现** 的系统架构（as-built）——文中出现的每个模块、表、路由都对应仓库里真实存在的代码。
> 目标演进架构见 [`architecture-v2.md`](architecture-v2.md)；从当前实现走到 V2 的路径与 PR 切片见 [`implementation-plan.md`](implementation-plan.md)。
> 本文与 V2 文档冲突时，**以本文为当前代码事实**；阶段 1 的 `workspaces` 与 Skill 三表、阶段 2 的 `agent_runs`、`agent_run_events`、幂等 POST、SSE 断点续传与双通道实时流均通过合约测试。**Phase 3.0（Durable Agent Runtime）已落地**：`@mastra/pg` PostgresStore 接到 `mastra_runtime` schema；`streamOptions.runId / memory.thread / memory.resource` 透传到 stream 调用。**Phase 3.1（Tool Policy / Approval Schema 与 Repository）已落地**：`tool_policy_rules` + `tool_approval_requests` 两表已在 `init.sql` 阶段 3.1 段落实；`agent_runs` 持有 `UNIQUE(id, workspace_id)`，`tool_approval_requests` 走复合外键 `(run_id, workspace_id) → agent_runs(id, workspace_id)`，**审批请求与 Run 在数据库层强制同 Workspace**（跨 workspace 写入会被 PG 拒绝）；`modules/tool-policy/` 暴露最小数据访问层（参数化 SQL / workspace 隔离 / 原子 resolve）。**Phase 3.2（Tool Policy Evaluator + Policy-aware Tool Resolver）已落地策略评估与可用工具过滤**：`modules/tool-policy/evaluator.ts` 实现 `allowed` / `requires-approval` / `forbidden` 三态决策，`resolver.ts` 把 `runtime.ts` 的 activeTools 计算从"按 ID 存在性过滤"升级为"按 workspace 策略逐 Tool 决策、仅 allowed 入列"。**Phase 3.3（Tool Approval Closed-Loop）已落地**：`requires-approval` Tool 通过 Tool Gateway 包装层 + `requireToolApproval` 接入 Mastra 1.61 `approveToolCall` / `declineToolCall` 闭环；`/v1/approvals` REST API（list / detail / resolve approve|decline）；15 秒超时 worker（`expireApproval`）+ 启动一次跨重启 reconcile（`reconcileInflightApprovals` + `listSuspendedRuns`）；前端 `useApprovals` hook + `ApprovalCard` 组件订阅 SSE `approval-requested` / `approval-resolved`。`storage_finalize_jobs`、`embedding_profiles`、`document_embeddings` 等已**由 PR-4 落地**（详见下方 §7 与 Phase 4 节）。

> **PR-4 状态（2026-09-11，第二轮 Codex review 后）**：PR-4.1 / PR-4.2 / PR-4.3 **代码已完成**；**真实 PostgreSQL 端到端 18 passed、0 failed**（Core-only 16 + RAG 2，两套用例分别在独立进程运行：`config.ragEnabled` 由本进程 env 决定，跟生产路径语义完全一致；不修改生产 `config` 模块，不调用真实 embedding API，不泄露真实 key）。本节关于 Phase 3.x 的描述维持原状；PR-4 协议与已验证事实见下文 §7。**staging / production readiness 仍需在 4 类边界完成演练**：(1) 多进程 Worker 真并行；(2) 真实 MinerU；(3) 真实 Embedding Provider HTTP；(4) 浏览器前后端端到端联调。

> **2026-09-14 V2 聊天链路修复**：Run Executor 从会话真实读取 `knowledgeBaseId` 并持久化 Agent 返回的 citations；Tool 调用在 `tool_executions` 与 `agent_run_events` 双向留痕，SSE 新增 `tool-call-failed`，前端实时及刷新恢复均可展示 Tool 状态；前端停止请求切换到 `/v1/v2alpha/messages/:id/stop`。已通过 backend typecheck、unit fixtures 与 frontend production build；尚未进行真实浏览器/模型端到端验证。

## 概述

Mastra Agent Starter 是一个基于 Mastra 框架的智能对话平台，支持通用对话和知识库问答两种 Agent 模式。系统采用前后端分离架构，使用 PostgreSQL 持久化数据，并通过 SSE 流式传输实现实时对话体验。

## 技术栈

- **后端**: Mastra (@mastra/core 1.65.0, @mastra/pg 1.23.0, @mastra/server 1.65.0, mastra 1.28.0), TypeScript, PostgreSQL
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

**PR-4.2 验证状态（2026-09-11，第二轮 Codex review 后）**：异步 ingestion / RAG 路径**代码已落**，**真实 PostgreSQL 端到端已验证 18 passed、0 failed**（Core-only 16 + RAG 2）；**多进程并发恢复 / 真实 embedding provider 接入 / 真实 MinerU 解析失败路径仍待 staging e2e**——本节列出的协议与代码事实可以参考，但**这些边界不能视为已稳定可用**。

- **检索路径重写**：从 `document_chunks.embedding` 切到 JOIN `document_embeddings + document_chunks + documents`；维度按 `embedding_profiles.is_active=true` profile 校验（不再硬编码 `DATABASE_EMBEDDING_DIM`）；`documents.status='ready'` 过滤保证 RAG 不读 ingestion 中间态。
- **RAG 表创建**：PR-4 整改后，`embedding_profiles` / `document_embeddings` 由 bootstrap **顶层 SQL** `CREATE EXTENSION IF NOT EXISTS vector` 触发（DO 块内**禁止** `CREATE EXTENSION`），同事务内 `SET LOCAL app.rag_enabled='on'` 让 init.sql 末尾的条件块读到正确状态。Core-only 部署 ragEnabled=false → vector 扩展 / 两张 RAG 表**全部不存在**；fresh-init 决定一次 Core 或 RAG 形态，**之后不再无迁移切换**。
- **HTTP 202 异步 ingestion**：单事务串 documents + ingestion_jobs + finalize_jobs（partial unique 兜底跨并发 race）。Worker 1s tick + 15s heartbeat + 30s lease sweeper，阶段推进 queued → parsing → chunking → embedding → finalizing → ready；ingestion claim **必须** `documents.storage_status='ready' AND deleted_at IS NULL`。失败按 `2^(n-1) × 1s` 退避（封顶 5min）→ 终态 failed；Core-only 跳过 embedding 写但仍写 `document_chunks`。
- **finalize + outbox 严格 lease fencing**：两 worker 都加 `processing` 状态机；claim 单事务内 SELECT FOR UPDATE SKIP LOCKED → UPDATE status='processing' + lease_owner + lease_expires_at + attempts++；IO 在事务外；sweeper 按 lease 过期收回 processing → pending + 小退避。Outbox 表新增 status / lease_owner / lease_expires_at / next_attempt_at。
- **软删除 4 动作单事务**：documents 软删除 + finalize (pending/processing) 取消 + ingestion (active) 取消 + outbox 入队；缺一会全部回滚。

详细协议见
[`docs/superpowers/plans/2026-09-10-pr4-async-doc-rag.md`](superpowers/plans/2026-09-10-pr4-async-doc-rag.md)
与 [`docs/architecture-v2.md` §8](architecture-v2.md)。

**真实 PG 集成测试**（2026-09-11，第二轮整改后重跑）：

- [`backend/tests/integration/pr4-async-doc-rag-core.ts`](../backend/tests/integration/pr4-async-doc-rag-core.ts) — 16 用例，进程以空 `EMBEDDING_API_KEY` 启动，`config.ragEnabled=false`（生产 Core-only 边界）。
- [`backend/tests/integration/pr4-async-doc-rag-rag.ts`](../backend/tests/integration/pr4-async-doc-rag-rag.ts) — 2 用例，进程以非空无敏感占位 `EMBEDDING_API_KEY` 启动，`config.ragEnabled=true`（生产 RAG 边界）。
- 两套用例分别以**独立进程**运行，`config.ragEnabled` 由本进程 env 决定，与生产路径语义完全一致；**不**修改生产 `config` 模块，不调用真实 embedding API，不泄露真实 key。
- 沙箱无 PG 时两个文件按各自用例数干净 SKIP；当前 PG 端到端已 **18 passed、0 failed**（Core-only 16 + RAG 2，分别调 `runIngestionWorkerOnce` / `_runFinalizeOnce` / `_runOutboxOnce` / `transitionIngestionStatus` / `getOrCreateActiveEmbeddingProfile` / `createUploadBundle` 等生产入口）。

### 8. 工具执行审计

位于 `backend/src/modules/conversations/tool-executions.ts`：

- 记录每次工具调用到 `tool_executions` 表
- **V2 阶段 2 稳定 ID**：`tool_call_id`（Mastra toolCallId）是跨 SSE / Mastra / approval resume / 历史恢复 / 前端卡片的统一业务 ID；
  `(workspace_id, run_id, tool_call_id)` 上 UNIQUE。`upsertToolExecution` / `finalizeToolExecutionByCallId` 幂等。
- DB id 仅作为内部 PK；前端 / 上层一律使用 `tool_call_id` 做 dedup。
- 状态跟踪：`running → completed | failed | stopped`
- 记录输入、输出、耗时、错误码
- `convergeRunningToolExecutions()` 在流结束/异常/停止时把残留 `running` 记录收敛为 `stopped` / `failed`
- 批量查询：`getToolExecutionsByMessages(workspaceId, messageIds[])` 一次性拉所有 assistant message 的 tool executions，**消除 N+1**。

### 8.1 V2 停止一致性（单实例收敛边界，2026-09-14）

> **本节仅描述同一进程实例内的 V2 停止一致性。跨实例 stop 不在本轮范围。**

`backend/src/core/execution/run-executor.ts` 与 `backend/src/server/routes/v2alpha/shared-handlers.ts` 协同保证四条路径**共用同一份不可变文本快照**：

1. `messages.content` —— `stopRun` 写库内容（取自 `execution.fullText`）；
2. 最终 `content-checkpoint` —— stream 的 `done / stopped` 事件分支写入；
3. `run-stopped` 事件 `payload.contentLength` —— `stopRun` 落库前算好的 snapshot length；
4. HTTP `/v1/v2alpha/messages/:id/stop` 响应 body —— `executor.fullText.length`。

`abortRunByMessage(messageId)` 不再返回 `boolean`，而返回结构化 discriminated union：

```ts
type AbortRunResult =
  | { kind: 'not_hit' }
  | {
      kind: 'aborted';
      runId: string;
      workspaceId: string;
      /** 当前累积的文本快照。空字符串也是合法终态（contentLength=0）。 */
      fullText: string;
      /** 当前累积的引用。停止时只追加、不清除。 */
      citations: Citation[];
    };
```

行为：

- HTTP handler 优先取 executor 快照作为权威；executor 未命中（DB 行 active 但 executor 已 GC / 当前实例未承接该 Run）才回退到 legacy `controller.partialContent`。
- `stopRunByMessageId` 在 Run 已为终态时**幂等**返回 `{stopped: false, run, reason: 'already_terminal', contentLength}`，`contentLength` 取自当前 `message.content` 长度，**不**覆写 content / citations / 不重复写 run-stopped 事件。
- 空文本停止（用户立刻停止）合法终态：`status='stopped'` + `contentLength=0`。
- 引用语义：停止只追加不清除；只有在"untrusted/uncommitted"语义下才清空（见代码注释）。

**跨实例边界**：本轮**不**承诺多进程同时接管同一 Run 的 stop 收敛。多进程部署需后续 lease fencing + 跨实例 finalizer（待 PR-后续），目前单一进程实例内的事务收敛是唯一保证。

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

**Phase 3.0 当前事实**（2026-09-03）：
- 已实现：storage 注入、`Mastra({ agents })` 公共注册路径、`Mastra({ tools })` 全局 Tool 注册、`streamOptions.runId / memory.thread / memory.resource` 三个标识字段透传、Skill 名错误的 try/catch 隔离。
- 未验证：`Mastra.storage` 在真实 PostgreSQL 上持久化 snapshot 后、跨重启从 snapshot 恢复挂起 Run 的端到端路径；`agent_runs` ↔ Mastra snapshot 的同源校验；高风险 Tool 审批链路仍属后续阶段。

**Phase 3.1 完成时快照**（2026-09-03；后续 PR-3.2 / PR-3.3 已覆盖；当前真实状态见下方 Phase 3.3）：
- 已落地：`backend/database/init.sql` 阶段 3.1 段新增 `tool_policy_rules` + `tool_approval_requests` 两表（V2 §7 决策；CHECK / FK / UNIQUE / 部分索引齐全，**不**向 `agent_runs` 新增 `approval_request_id`）。**跨 Workspace 完整性**：`agent_runs` 持有 `UNIQUE(id, workspace_id)`（约束名 `agent_runs_id_workspace_unique`，独立索引与 PK 共存）；`tool_approval_requests` 走复合外键 `FOREIGN KEY (run_id, workspace_id) REFERENCES agent_runs(id, workspace_id) ON DELETE CASCADE`（约束名 `tool_approval_requests_run_workspace_fk`）；旧的单列 `run_id → agent_runs(id)` FK 已彻底删除。`backend/src/modules/tool-policy/repository.ts` 暴露最小 Repository：`createApprovalRequest` / `getApprovalRequestById` / `listPendingApprovalRequests` / `resolveApprovalRequest`（原子 update + fallback 状态判定）/ `upsertPolicyRule` / `getPolicyRule`。`backend/tests/unit/tool-policy-schema.ts` + `tool-policy-repository.ts` 用 fake client 覆盖 SQL 文本约束、参数化、workspace 过滤、原子 resolve 路径。
- 在该 PR 完成时未实现；现已由 PR-3.3 落地，当前真实状态见下方 Phase 3.3 节：
  - 策略评估器（evaluator）→ 已由 PR-3.2 落地（`evaluator.ts` + `resolver.ts`）；
  - Tool Gateway 注入 `workspaceId` + 策略评估 + 二次校验 → 已由 PR-3.3 落地（`core/agent/tool-approval-gateway.ts` 包装层 + `requireToolApproval` 经 `runtime.ts` 注入 `agent.stream()`）；
  - Mastra SDK `requireToolApproval` 接入与 `approveToolCall` / `declineToolCall` / `resumeStream` 路径 → 已由 PR-3.3 落地（通过 `core/agent/runtime.ts` + `mastra-facade.ts` facade 接入；本机真实 Mastra Core 1.61.0 + DeepSeek 的 approve / decline / timeout 三条 HTTP/SSE 基础路径及 pending 后重启再 approve 已有验证记录，**完整容灾与多实例真实 SDK e2e 尚未验证**）；
  - 审批 API（`/v1/approvals*`）→ 已由 PR-3.3 落地；
  - 审批 UI（`ApprovalCard` / `useApprovals` + SSE `approval-requested` / `approval-resolved` 订阅）→ 已由 PR-3.3 落地；
  - 超时 worker（`tool_approval_requests.expires_at < now()` → Run 转 `stopped + APPROVAL_EXPIRED`）→ **已被 PR-3.3 替代**：timeout worker 现仅 DB-only 写 `status='expired'` + `resolver_id=system-approval-worker`（`00000000-0000-0000-0000-0000000000a1`），由 `runResumeSchedulerOnce` 下次 tick 调 `declineToolCall(reason='expired')` 并经 `consumeAgentStream` 真实消费 resume stream 收尾 Run；
  - 跨重启 Run 恢复的端到端路径 → 已由 PR-3.3 落地（`runReconcileIndeterminateOnce` + W2 reconciliation）。
- 状态语义：审批记录通过复合外键 `(run_id, workspace_id)` 强制 Run 与 Workspace 一一对应；单 Run 可挂多条请求。`requester_id` 必填；`resolver_id` 由 `resolveApprovalRequest` 回填；`status` 枚举 `pending / approved / declined / expired`（**不**使用 `rejected`）。

**Phase 3.2 完成时快照**（2026-09-03；后续 PR-3.3 已覆盖；当前真实状态见下方 Phase 3.3）：
- 已落地：`backend/src/modules/tool-policy/evaluator.ts` 实现单 Tool 三态判定（信任模型：仅服务端 `ToolDefinition.metadata` 与 DB `tool_policy_rules`；不信任 Tool execute 入口或 Mastra 工具调用中任何"自报字段"）。决策矩阵：未注册 / `requiresRuntime` → `forbidden`；`destructive` → `requires-approval`（即便 DB 显式 `allow` 也不降级）；`openWorld` 缺策略 / `deny` → `forbidden`，显式 `allow` → `allowed`，`require_approval` → `requires-approval`；低风险 + `deny` → `forbidden`，低风险 + `allow` 或无策略 → `allowed`，低风险 + `require_approval` → `requires-approval`。`backend/src/modules/tool-policy/resolver.ts` 提供 `resolveAllowedToolIds(workspaceId, toolIds, ctx)` 仅返回 `allowed` 子集、保留输入顺序；`createDefaultResolverContext()` 装配真实 Tool 注册表 + `tool_policy_rules` repository。`backend/src/core/agent/runtime.ts` 把 `activeTools` 计算从 `resolveToolIds(...,undefined)` 升级为 `resolveAllowedToolIdsForRuntime(...)`，并暴露 `_setPolicyResolverForTesting(impl)` 测试钩子；calculator / get-current-time 既有行为不变（低风险 + 无策略 → `allowed`）。`backend/tests/unit/tool-policy-evaluator.ts`（7 类决策）、`tool-policy-resolver.ts`（仅 `allowed` 入列）、`tool-policy-runtime-filtering.ts`（runtime 接线）三个离线 fixture 全部通过；`dynamic-tool-resolution.ts` 同步注入 stub resolver 维持既有合约。
- 在该 PR 完成时未实现；现已由 PR-3.3 落地，当前真实状态见下方 Phase 3.3 节：
  - `requires-approval` Tool 的审批运行时（Mastra `requireToolApproval` 接入 + `approveToolCall` / `declineToolCall` / `resumeStream` 路径 + 审批持久化 + resolve API）→ 已由 PR-3.3 落地；本机真实 Mastra Core 1.61.0 + DeepSeek 的 approve / decline / timeout 三条 HTTP/SSE 基础路径及 pending 后重启再 approve 已有验证记录，**完整容灾与多实例真实 SDK e2e 尚未验证**；
  - Tool Gateway 在具体 Tool execute 前的二次校验 → 已由 PR-3.3 落地（`core/agent/tool-approval-gateway.ts`）；
  - 审批 API（`/v1/approvals*`）→ 已由 PR-3.3 落地；
  - 审批 UI（`ApprovalCard` / `useApprovals` + SSE `approval-requested` / `approval-resolved` 订阅）→ 已由 PR-3.3 落地；
  - 超时 worker（`tool_approval_requests.expires_at < now()` → Run 转 `stopped + APPROVAL_EXPIRED`）→ **已被 PR-3.3 替代**：timeout worker 现仅 DB-only 写 `status='expired'` + `resolver_id=system-approval-worker`（`00000000-0000-0000-0000-0000000000a1`），由 `runResumeSchedulerOnce` 下次 tick 调 `declineToolCall(reason='expired')` 并经 `consumeAgentStream` 真实消费 resume stream 收尾 Run；
  - 跨重启 Run 恢复的端到端路径 → 已由 PR-3.3 落地（`runReconcileIndeterminateOnce` + W2 reconciliation）。
- 重要设计选择：PR-3.2 完成时**不**把 `requireToolApproval` 传入 `agent.stream()`——一旦传入，require-approval Tool 会在 Mastra 内部挂起 Run，但 PR-3.2 时**没有**对应的 approve / decline API 可以恢复；该路径由 PR-3.3 把审批持久化 + resolve API 一次性接通后开启。

**Phase 3.3 当前事实**（2026-09-04，Tool Approval Closed-Loop，含 Replay Fix）：

**职责边界（强不变量）**：

| 模块 | DB 写入 | Mastra SDK 调用 | stream 消费 |
|---|---|---|---|
| `server/routes/approvals.ts` HTTP 层 | ❌ | ❌ | ❌ |
| `modules/tool-policy/state-machine.ts` `resolveApproval` / `expireApproval` / `reconcileInflightApprovals` | ✅ | ❌ | ❌ |
| `modules/tool-policy/timeout-worker.ts` `expirePendingOnce` / `reconcileOnce` | ✅ 调 DB-only 函数 | ❌ | ❌ |
| `core/execution/run-executor.ts` `runResumeSchedulerOnce` / `runReconcileIndeterminateOnce` | ✅ + 单事务原子 | ✅ **唯一调用方** | ✅ **唯一消费方** |

- **DB-only 模块**：`approvals API` 只做 auth / workspace / decision 校验 + outcome 映射；`state-machine.resolveApproval` / `expireApproval` / `reconcileInflightApprovals` 只做"决策登记"（pending → approved/declined/expired + resolver_id + resolved_at）+ inflight 行的 DB-only takeover；`timeout-worker` 每 15 秒扫过期 pending 行 + 启动期 reconcile，**不**调 Mastra SDK、**不**消费 stream。
- **Run Executor 是唯一 SDK 调用与 stream 消费方**：`runResumeSchedulerOnce` 按 `listApprovalsPendingResume` 选出 `('approved'|'declined'|'expired') AND mastra_resume_started_at IS NULL` 的行，原子推 Run → 'running' + INSERT `run-resumed` + 写 `mastra_resume_started_at`，再调 `facade.approveToolCall({runId, toolCallId, workspaceId})` / `facade.declineToolCall({runId, toolCallId, reason, workspaceId})` 拿 `AsyncIterable<unknown>`，由 `consumeAgentStream(execution, stream)` 真实消费 resume stream、写 message checkpoint、推 Run 终态（completed/stopped/failed）+ SSE 事件。
- **`consumeAgentStream` 是首次 Run 与 resume 共享的公共能力**：`core/agent/runtime.ts` 抽取；`run-executor.ts` 的 `consumeResumeStream` 复用同一消费者。**不再**调 `streamAgent(prompt)` 重发（已删除）。

**W2 approve SDK 调用结果不确定窗口（Reconciliation 闭环）**：

- 触发：`consumeResumeStream` 调 `facade.approveToolCall` 抛错（`approval.status === 'approved'`）；decline 路径 SDK 抛错走幂等 `run-failed` 不进 reconciliation。
- W2 第 N 次（1 ≤ N ≤ MAX_RESUME_ATTEMPTS=3）失败：`markApprovalResumeIndeterminate` 原子写 `status='approved_resume_indeterminate'` + `resume_attempts += 1` + `resolver_error='APPROVE_SDK_INDETERMINATE: …'` + `lease_expires_at = now() + 30_000ms` backoff；**保留** `mastra_resume_started_at` 阻止 scheduler 立即重扫；Run 推回 `waiting_approval` 等 reconciler。
- **Reconciler 前置幂等检查**：`runReconcileIndeterminateOnce` 在调 `facade.listSuspendedRuns` **之前**用 `getToolDefinition(approval.toolId).metadata.idempotent` 校验 Tool 元数据——未注册或非幂等 Tool 直接 fail-closed 写 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED: tool <id> is not registered as idempotent; automatic approve replay is forbidden` + Run → `failed`，**不**调 SDK、**不**查 `listSuspendedRuns`。W2 自动重放**仅**适用于明确声明 `metadata.idempotent === true` 的 Tool（当前只有 `calculator`）。这是因为 Tool 外部副作用是否已落地无法由本地 DB 证明未发生——盲目重试非幂等 Tool 会造成双重执行风险。
- Reconciler 校验：扫 `resume_attempts < MAX AND resolver_error NOT LIKE 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_%'` 的行；调 `facade.listSuspendedRuns({threadId, resourceId, workspaceId, agentId})` 严格校验 `runId === approval.runId` / `toolCallId === approval.toolCallId` / `workspaceId === approval.workspaceId` / `status === 'suspended'` 等。校验通过 → `revertApprovalForReconcile`（DB-only：`status='approved'` + 清 `mastra_resume_started_at`），scheduler 自然接管重试 approve；**不**直接调 SDK。
- 校验失败 / attempts 耗尽（`resume_attempts >= MAX`）→ fail-closed：approval 保留 `approved_resume_indeterminate` + `mastra_resume_started_at` 保留 + `resolver_error` 覆盖为 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED: …` 或 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED: …`；Run → `failed` + 相应 `error_code`，写 `run-failed` 事件 + `messages.status='failed'` 收尾。**这些行永久退出自动 reconciler 扫描集**（`resolver_error` 前缀过滤 + `resume_attempts >= MAX` 双重防护）——避免重复调 SDK / `listSuspendedRuns` 与日志噪声；approval 行、`mastra_resume_started_at`、人工介入错误信息全部保留供运维检索。

**Crash window 综述（PR-3.3.2.1 终态语义）**：

| 窗口 | catch 是否能执行 | 行为 | 兜底路径 |
|---|---|---|---|
| W1（`resumeAwaitingRunsOnce` claim 事务提交前进程退出） | N/A（事务 ROLLBACK） | 整事务 ROLLBACK，approval 留在终态 + `mastra_resume_started_at IS NULL` | scheduler 下次 tick 重新抢占 |
| W2（`consumeResumeStream` 调 `facade.approveToolCall` 抛 JavaScript 异常） | 是 | `markApprovalResumeIndeterminate` + Run 推回 `waiting_approval`，保留 `mastra_resume_started_at` 阻止重扫 | reconciler 在 lease 到期后用 `listSuspendedRuns` 严格校验（**仅限 `metadata.idempotent === true` 的 Tool**）→ revert 或人工介入 |
| W2'（`declineToolCall` 抛 JavaScript 异常） | 是 | decline 语义幂等 → `run-failed` + 释放 lease；approval 状态不变 | 用户主动重发指令恢复 |
| W3（`consumeAgentStream` 在 resume stream 消费中抛错） | 是（for await 的 try/catch） | 同 W2 / W2' | 同上 |
| **W4（worker 进程被直接杀死——Node 进程死亡 / OOM / 容器 kill / 主机重启；claim 事务已提交、`mastra_resume_started_at` 已写、Run 持 lease，但 worker 在 SDK 调用前 / 中 / 终态落库前死）** | **否**（JavaScript catch **不**会执行） | approval 永久停在 `approved / declined / expired` + `mastra_resume_started_at NOT NULL`；原 `sweepExpiredLeases` 会把这种孤儿 Run 写成 `failed` + `LEASE_EXPIRED`——留下"approved + started_at NOT NULL + failed LEASE_EXPIRED"不可恢复的孤儿组合 | **`sweepExpiredApprovalResumeLeases`（PR-3.3.2.1 新增）按 Tool 元数据 + approval 状态分流恢复**：approved + 幂等 Tool + attempts 未耗尽 → `approved_resume_indeterminate` + Run → `waiting_approval` + 写 `run-resume-reclaimed` 事件；approved + 非幂等 / 未注册 Tool → 人工介入 + Run → `failed` + `APPROVAL_RESUME_RECLAIMED_MANUAL_INTERVENTION_REQUIRED`；approved + attempts 耗尽 → 人工介入 + Run → `failed` + `APPROVAL_RESUME_RECLAIMED_ATTEMPTS_EXHAUSTED`；declined / expired 硬崩溃 → **不**重放（决策已生效）+ Run → `failed` + `APPROVAL_RESUME_HARD_CRASH_FAIL_CLOSED_DECLINED` 或 `_EXPIRED` + 进程丢失诊断。所有 SQL 同事务（见 `hard-crash-lease-recovery.ts`） |
| 迟到 worker 终态写入（`lease_owner` 已被其他 worker 接管） | N/A（worker 仍存活） | `completeRun / stopRun / failRun` 的 `WHERE lease_owner = WORKER_ID` 影响 0 行 → ROLLBACK | messages / agent_run_events 不被错误终态覆盖（`executor-terminal-lease-fence.ts` `done / stopped / error` 三场景独立 seed，**已 Codex 实跑通过**） |
| 普通 Run lease 过期（`status IN ('queued','running')` + `lease_expires_at < now()`，**无 approval 上下文**） | N/A | `sweepExpiredLeases` 写 `status='failed'` + `error_code='LEASE_EXPIRED'` + `run-failed` 事件 + `messages.status='failed'` | 后台 sweeper 30s tick；不影响 `waiting_approval`（由 `tool_approval_requests.expires_at` 驱动） |

**关键不变量**：JavaScript try/catch **只能**捕获同步 / 异步代码主动抛出的异常；Node 进程被直接杀死（SIGKILL / OOM / 容器 kill / 主机重启）**不**会触发任何 catch。`sweepExpiredApprovalResumeLeases`（PR-3.3.2.1 新增，`backend/src/core/execution/approval-resume-recovery.ts`）是 W4 硬崩溃现场的唯一自动恢复机制——它由 `sweepOnce` 在普通 `sweepExpiredLeases` **之前**调用；**且**（PR-3.3.2.1 跨实例并发修复）普通 `sweepExpiredLeases` 的 SQL 增加 `NOT EXISTS` 子句**排除** approval-resume Run，**不**依赖调用顺序——跨进程下两个 sweeper 真并行时仍必须分流。`SELECT ... FOR UPDATE SKIP LOCKED` 保证多 sweeper 并发时同一行只回收一次。

`sweepExpiredLeases` 仅作用于 `queued` / `running` Run；`waiting_approval` Run **不**走 lease sweeper（lease 已在 `consumeResumeStream` 入口清理），其过期由 `tool_approval_requests.expires_at` + 15s timeout worker 驱动——`status='expired'` 后由 `runResumeSchedulerOnce` 下次 tick 接管并走 `declineToolCall(reason='expired')` 收尾。普通 Run lease expiry 行为保持不变；reconciler 扫描集不与 sweeper 冲突，因为 reconciler 处理的 `approved_resume_indeterminate` approval 必然来自已经过 `markApprovalResumeIndeterminate` 写入的状态，而非 `sweepExpiredLeases` 主动标记的状态。

**Schema 与安全不变量**：`database/init.sql` 阶段 3.3 段保持 `requester_id UUID NOT NULL REFERENCES app_users(id)` 与 `resolver_id UUID NOT NULL REFERENCES app_users(id)`；system-initiated 路径走预设 `system-approval-worker` 平台用户 UUID `00000000-0000-0000-0000-0000000000a1`（init.sql 阶段 3.3 段 INSERT 一行 `app_users(username='system-approval-worker')` 支撑）。Repository `createApprovalRequest` 强制 `requesterId` 非空（`agent_runs.created_by` NULL 时拒绝创建）；`takeoverInflightLease` 同步写 `mastra_resume_started_at`（避免 takeover 后被 scheduler 再次调度）。`tool_approval_requests` 表**不**保存 `suspension_id`——Mastra 1.61 公开 API 不接收、也不返回独立可持久化 suspension token；恢复键仅为 `(run_id, tool_call_id)`。原始敏感 Tool 输入**永不**进入 `tool_approval_requests`，仅存脱敏摘要（`{kind, preview, count?}`）+ SHA-256 `inputs_hash`。

**Facade 接口（`MastraAgentFacade`）**：`modules/tool-policy/mastra-facade.ts` 的 `listSuspendedRuns` 是 **Agent 实例方法**（`agent.listSuspendedRuns({threadId, resourceId, workspaceId, agentId})`），非全局静态；`validateSuspendedRunsSnapshot` 严格校验 `runId/toolCallId/threadId/resourceId`，缺一即 fail-closed 抛错（不返回空数组）。`approveToolCall/declineToolCall` 返回 `Promise<AsyncIterable<unknown>>`，匹配 Mastra 1.61 公开 API；state-machine 内部不再有"general-chat 兜底"。

**API 与前端**：`/v1/approvals`（GET 列表 + UUID 校验）、`/v1/approvals/:id`（GET 详情）、`/v1/approvals/:id/resolve`（POST approve|decline），错误码 `NOT_FOUND` / `INPUT_VALIDATION_FAILED` / `APPROVAL_ALREADY_RESOLVED` / `APPROVAL_INFLIGHT` / `INTERNAL_ERROR`。HTTP 路由**不**再持有 Mastra stream 句柄；`resolveApprovalHandler` 仅做 outcome 映射。前端 `useApprovals` hook + `ApprovalCard` 组件订阅 SSE `approval-requested` / `approval-resolved` 事件 + 倒计时 + Approve/Decline 按钮。

**测试状态（2026-09-08）**：

- 单元：`backend/tests/unit/tool-policy-{state-machine,timeout,evaluator,resolver,runtime-filtering,sanitize,repository,schema}.ts` + `approvals-route.ts` + `dynamic-tool-resolution.ts` 等；`npm run test:unit` 全通过。
- 集成：**真实 PostgreSQL + `FakeAgentFacade`（fake resume stream）** —— `backend/tests/integration/tool-policy-pg.ts` 覆盖 (a) waiting_approval 保留 / (b) approve → resume stream 消费 → Run → completed / (c) decline → Run → completed / (c-2) expire 走 `system-approval-worker` → Run → completed / (d) **W2 approve SDK 失败 → approval 推到 `approved_resume_indeterminate` + Run 推回 `waiting_approval` + reconciler 校验通过后 revert 让 scheduler 重新接管** / (e) scheduler 原子事务单飞（Run 已不 `waiting_approval` 时跳过，不调 facade） / (f) `listSuspendedRuns` fail-closed（缺 workspaceId/agentId/threadId/resourceId 抛错，正常路径返回匹配快照） / (g) 跨重启新 worker 通过 scheduler 接管 / (h) **3 次 W2 失败 → attempts 耗尽 → `APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED` + Run → failed + 后续多次 scheduler/reconciler tick 不再调 SDK 或 `listSuspendedRuns`** / (x) `agent_runs.created_by` NULL → Repository 拒绝创建审批；**107 passed, 0 failed**。
- 真实 PG + 真实执行器路径下的安全防护 —— `backend/tests/integration/approval-reconcile-safety.ts`（**已 Codex 实跑通过**）：lease fencing（worker-A claim 后 worker-B 因 lease_contended 被拒；原 worker 过期后接管 + 旧 worker 的 revert / fail 被拒）/ reconciler backoff（lease 未到期时不被扫到）/ **未注册或非幂等 Tool（`metadata.idempotent !== true`）进入人工介入、不调 SDK、不查 `listSuspendedRuns`** / 同事务原子回滚（`messages` 触发器注入失败 → approval 人工介入标记 + Run → waiting_approval 全量回滚，不留脑裂）/ 终态手工介入行永久退出 reconciler 扫描集（`resolver_error` 前缀 + `resume_attempts >= MAX` 双重防护）。验证命令：`cd backend && RUN_PG_TOOL_POLICY=1 npx tsx tests/integration/approval-reconcile-safety.ts`。
- **执行器终态 lease fencing** —— `backend/tests/integration/executor-terminal-lease-fence.ts`（**已 Codex 实跑通过**）：驱动生产 `runResumeSchedulerOnce` + 注入 deferred `AsyncIterable` 的 FakeAgentFacade，**真实生产路径**上覆盖 `done` → `completeRun` / `stopped` → `stopRun` / `error` → `failRun` **三场景独立 seed**。每个场景在 stream 落地前手动 UPDATE `lease_owner='late-stale-worker-B'`，断言 `agent_runs.status` 不会变成 `completed / stopped / failed`、`messages.status` 不会变成终态、`agent_run_events` 不会出现对应 `run-completed / run-stopped / run-failed`、`lease_owner` 仍是手动覆盖的迟到 worker、`approveToolCall` 仍只调用 1 次，并断言对应 `XxxRun 跳过：Run 已终态或当前 worker 已丢失 lease` 日志路径。三场景全部通过。验证命令：`cd backend && RUN_PG_TOOL_POLICY=1 RUN_PG_LEASE_FENCE=1 npx tsx tests/integration/executor-terminal-lease-fence.ts`。
- **多进程 resume SDK facade 竞争** —— `backend/tests/integration/multi-process-resume.ts`（父进程）+ `multi-process-resume-child.ts`（子进程）（**已 Codex 实跑通过：9 passed, 0 failed**）：在临时随机 schema 上 `fork` 两个独立 Node 子进程（不同 pid → 不同 `WORKER_ID`），通过 IPC `START` 信号同时调 `runResumeSchedulerOnce`；子进程把每次 `approveToolCall` 写入共享 `sdk_call_log` 表。**Codex 2026-09-07 第一次 review 触发的关键修复**：(1) seed `approved` approval 时填合法 `resolver_id = seedUserId`；(2) 全 schema 生命周期由最外层 `try/finally` 兜底——任意阶段失败都 kill 子进程、关 Pool、DROP schema、保留原始失败；(3) watchdog 修正在第一 child exit 时不立即清除——两个 child 都结束后才 `clearTimeout`；超时后强杀两个 child 并以失败退出；(4) 子进程轮询到达截止仍未收敛必须 `exit(3)`，收敛到非 `completed` 终态必须 `exit(4)`；(5) fork .ts 用显式 tsx loader `execArgv`，绝对路径经 `pathToFileURL` 包装成 file URL 后通过 `--import` 注入（Windows ESM 不接受 `E:\...`）；(6) 不打印 DATABASE_URL；(7) ready 前 child exit 立即记 originalError；(8) SDK facade 单飞通过父进程回收 `sdk_call_log` + `agent_run_events` + `messages` 三表断言。验证命令：`cd backend && RUN_PG_MULTI_PROCESS=1 npx tsx tests/integration/multi-process-resume.ts`。
- **W4 hard-crash 恢复（PR-3.3.2.1 新增）** —— `backend/tests/integration/hard-crash-lease-recovery.ts`（**生产代码已修复；已 Codex 实跑通过：32 passed, 0 failed**）：驱动 `runHardCrashApprovalResumeSweeperOnce` 入口（直接调新加的 `sweepExpiredApprovalResumeLeases`），覆盖 7 项验收：(a) approved + 幂等 Tool → 转 `approved_resume_indeterminate` + Run → `waiting_approval` + 写 `run-resume-reclaimed` 事件 + 清 lease + `resume_attempts += 1`；(b) approved + 非幂等 Tool → 人工介入 + Run → `failed` + `APPROVAL_RESUME_RECLAIMED_MANUAL_INTERVENTION_REQUIRED`；(c) attempts 耗尽 → 人工介入 + Run → `failed` + `APPROVAL_RESUME_RECLAIMED_ATTEMPTS_EXHAUSTED`；(d) 普通 running Run（无 approval 上下文）走原 `sweepExpiredLeases` 路径 → `failed` + `LEASE_EXPIRED`；(e) 两个 sweeper 并发 SKIP LOCKED 单飞；(f) 终态后不存在 `approved + started_at NOT NULL + failed LEASE_EXPIRED` 孤儿组合；(g) **跨实例并发**：hard-crash sweeper 与普通 `sweepExpiredLeases` 真并行（`Promise.all`）时，approval-resume Run **不**变 `failed + LEASE_EXPIRED`，依赖普通 sweeper 的 SQL `NOT EXISTS` 排除。验证命令：`cd backend && RUN_PG_HARD_CRASH_LEASE=1 npx tsx tests/integration/hard-crash-lease-recovery.ts`。
- **W2 自动重试仅限明确注册为幂等的 Tool**：`reconcileIndeterminateApprovalsOnce` 在调 `facade.listSuspendedRuns` 之前先用 `getToolDefinition(approval.toolId).metadata.idempotent` 校验：未注册或非幂等 Tool **直接 fail-closed 写 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED: tool <id> is not registered as idempotent; automatic approve replay is forbidden` + Run → failed**——不查 SDK、不重复 SDK 调用。calculator (`metadata.idempotent === true`) 是当前唯一允许 W2 自动重放的 Tool。
- 前端：`cd frontend && npm run build` 通过；保留既有 ineffective dynamic import 与 500KB chunk-size warning。
- `git diff --check` 无冲突。

**未验证边界（PR-3.3 staging e2e 待办）**：

- **完整容灾与多实例真实 SDK e2e 尚未验证**：本机真实 Mastra Core 1.61.0 + DeepSeek 的 approve / decline / timeout 三条 HTTP/SSE 基础路径以及 pending 后进程重启再 approve 已有验证记录；涉及 Mastra resume SDK/stream 边界的 PG 集成测试（`tool-policy-pg.ts` / `multi-process-resume.ts` / `executor-terminal-lease-fence.ts` / `approval-reconcile-safety.ts`）使用 `FakeAgentFacade` / fake stream，**hard-crash-lease-recovery.ts 直接验证生产 sweeper 的 PostgreSQL 状态收敛**（不依赖 facade）。尚未验证：真实网络故障、真实 SDK 多实例并发去重、真实 `listSuspendedRuns` 返回结构、SSE 跨实例扇出、真实浏览器 UI 联调、真实 staging 部署、PostgresStore 在多实例下的 lock 行为。**这是 PR-3.3 的 staging 未验证项，不是 Phase 4 工作**。
- **多进程真实 SDK 端到端未跑通**：`multi-process-resume.ts`（PR-3.3.2 / 3.3.2.1 收尾）已 Codex 实跑通过（9 passed, 0 failed）——验证的是 facade 层的跨进程资源抢占（原子 `UPDATE ... WHERE mastra_resume_started_at IS NULL` 兜底 + IPC 同步屏障 + `sdk_call_log` 共享介质）；facade 仍是 fake。多实例生产部署下真实 Mastra SDK 并发去重、SSE 跨实例扇出、PostgresStore lock 行为**仍**未在本 PR 验收——属 PR-3.3 staging e2e 待办。**本测试不能被引用为"多实例生产并发已验证"。**
- 网络抖动 / 进程在 SDK 调用返回前被 kill / 真实 stream 异常形态（network error / rate limit / partial response）等容灾演练仍待 staging 实测。
- 前端 `ApprovalCard` ↔ 真实 SSE 推送：本地浏览器 + 真后端的端到端未在本 PR 人工验收跑通。

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
- **审批运行时已落地**——服务端注册的 `ToolDefinition.metadata` 中 `destructive` / `openWorld` / `requiresRuntime` 是 PR-3.2 策略评估器的风险输入；PR-3.3 让 `requires-approval` Tool 通过 Tool Gateway 包装层 + `requireToolApproval` + `/v1/approvals/:id/resolve` 走完整 Mastra 审批与持久化 resolve 闭环（参见上文 Phase 3.3 节）。metadata 本身**仍不能**单独授权：必须叠加 PR-3.2 策略评估器 + PR-3.3 审批运行时才能让高风险 Tool 进入生产业务；速率限制、Tool 风险治理与公开生产部署的整体策略仍**未**完成。
- **Phase 1 认证范围**——本地用户名 / 密码登录与个人 Workspace 已落地；会话、知识库、文档、分块、工具执行与 Agent-Skill 绑定按 Workspace 隔离。未实现密码找回 / 多因素 / 风控锁定 / 公开注册，以及组织共享 Workspace、角色与资源级授权。

### Tool Metadata 的真实定位

`ToolDefinition.metadata` 中的 `readOnly` / `destructive` / `idempotent` / `openWorld` / `requiresRuntime` 字段由服务端注册表维护。PR-3.2 已将 `destructive` / `openWorld` / `requiresRuntime` 作为策略评估器的风险输入，用于按 Workspace 过滤 `activeTools`；PR-3.3 已让 `requires-approval` Tool 走 Mastra 审批运行时（`Tool Gateway` 包装层 + `requireToolApproval` + `/v1/approvals/:id/resolve` approve/decline 闭环）。它们仍**不是**可由 Tool、Skill、模型输入自行声明的授权依据，也不是生产级授权系统。任何自定义 Tool 不得返回密码、Token、Cookie、Authorization Header 或其他 secret；`destructive: true` 或 `openWorld: true` 的 Tool 在引入生产业务前 **必须**接入 PR-3.3 的审批运行时，并完成身份认证、租户/资源归属校验、输入输出脱敏与审计。详细约束见 `docs/tools.md` § Tool Metadata 的真实定位。

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
