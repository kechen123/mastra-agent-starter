# Mastra Agent Starter

面向业务团队的 [Mastra](https://mastra.ai/) 智能应用起步模板。它把对话、知识库、工具调用、技能编排和 Workspace 数据隔离整合为一套可直接运行的基础平台，帮助团队把精力放在业务 Agent 和业务能力本身，而不是重复搭建底层链路。

> 当前仅适合本地开发或受信任网络中的已认证演示环境；生产级租户治理、Tool 审批等能力仍在演进中。详细边界见 [架构文档](docs/architecture.md)。

> **2026-09-14 V2 Chat Runtime 修复（历史验证记录）**
> 本段记录当时的验收边界；其“backend lint 通过”不应外推为当前事实。当前依赖基线已是 `@mastra/core@1.65.0`，1.61 的真实模型/审批恢复记录仅是历史证据，尚未在 1.65.0 上重做真实模型或浏览器 E2E。
> - 后端停止一致性：`abortRunByMessage()` 返回结构化 discriminated union；HTTP stop / SSE run-stopped / final checkpoint / message.content 共用 V2 executor 不可变文本快照。**仅承诺同一进程实例内收敛；跨实例 stop 不在本轮范围**。
> - 前端 stop 状态机：`src/lib/stop-state-machine.ts` 纯逻辑模块 + 30 用例单测；HTTP/SSE 任意顺序幂等；session switch / KB / capabilities 页面**不**调后端 stop。
> - Tool call 稳定 ID：`tool_executions.tool_call_id` + UNIQUE(workspace_id, run_id, tool_call_id)；`upsertToolExecution` / `finalizeToolExecutionByCallId` 幂等；批量查消除 N+1。
> - RAG 阈值 / AbortSignal / 错误归类：`RAG_MIN_SIMILARITY` 默认 0.5（严格 [0,1]）；`EMBEDDING_TIMEOUT_MS` 默认 15000ms；embedding provider 错误归一为内部 `EmbeddingError` 类，**不**抛原始 body / endpoint / key 字样。
> - Test/CI：frontend `npm test` 用 tsx 直跑；integration runner 顶层 TEST_DATABASE_URL + safety-identifier 闸门守护，无 DB 时 SKIPPED（**不**算 passed）。
> - 真实 PostgreSQL / 真实 DeepSeek / 真实 Embedding / 真实 MinerU / 浏览器前后端端到端联调：**本轮未授权 / 未在本流水线验证**，保留为 staging e2e 待办。

> **2026-09-15 安全与验证修复（已实现；仅离线自动检查）**：后端锁文件固定到 `fast-uri@3.1.6`、`hono@4.13.5`、`js-yaml@3.15.2`；上传在 multipart 解析前限制请求体（文件仍严格 ≤10 MB）；Run 的 `run-failed` SSE 仅发布稳定错误码对应的安全中文文案；Markdown 仅允许 HTTPS、本机 HTTP 与受控相对链接；API 响应补齐 `nosniff`、拒绝嵌入、referrer 与 permissions 头，Vite 入口补 CSP/referrer meta；计算器不再动态执行 JavaScript。隔离 PostgreSQL integration workflow 已加入 CI（Core-only / RAG fixture 两个矩阵）。本轮未连接 PostgreSQL、未调用模型/Embedding/MinerU、未做浏览器或部署网关响应验收；仓库既有 backend lint 错误仍未在本轮范围内修复。

## 开箱即用

- **可追溯的智能对话**：支持通用问答、SSE 流式输出、停止生成与重新生成。
- **V2 聊天链路闭环**：Run Executor 透传会话绑定的知识库并持久化 citations；Tool 的开始、完成、失败状态可经 Run SSE 实时展示，刷新会话后从业务表恢复；停止生成走 `/v1/v2alpha/messages/:id/stop` 主接口。
- **带引用的知识库问答**：文档异步入库（HTTP 202 → 后台 ingestion Worker 推进 parsing / chunking / embedding / finalizing）；Core 模式下 chunk 文本落库可被引用，RAG 启用时向量检索补充。**PR-4.1 / 4.2 / 4.3 已完成**——异步管线已落代码并经真实 PostgreSQL 端到端 18 passed、0 failed（详见下方 PR-4 验证状态块）；引用功能**未**达到 staging / production readiness，仍需在真实多进程 / 真实 Embedding Provider / 真实 MinerU / 浏览器端到端四项边界完成演练。
- **可组合的 Agent 能力**：按 Agent 组合知识库、Tool 和 Skill，避免为不同业务复制运行时。
- **受控的工具与技能体系**：Tool 统一注册、执行留痕；Skill 支持内置、本地业务和 skills.sh 市场来源。
- **开箱即用的个人工作区**：本地账号登录后自动拥有独立 Workspace，业务数据按 Workspace 隔离。

运行时已经具备持久化 Run、断点续传、Tool 策略（Workspace 隔离 + 三态评估 + activeTools 过滤）与 Tool 审批闭环（高风险 Tool 触发 `/v1/approvals` 收件箱；approve → Mastra `approveToolCall` 返回的 resume stream 接口、decline/expire → `declineToolCall` 返回的 resume stream 接口（代码通过 facade 调用 SDK，而**非** `streamAgent(prompt)` 重发）；超时 worker 仅做 DB-only `expired` 决策登记；Run Executor scheduler/reconciler 是唯一 SDK 调用与 stream 消费方）的能力；完整实现范围与仍在演进的能力请以 [当前架构](docs/architecture.md) 为准。

> **PR-4 验证状态（2026-09-11，第二轮 Codex review 后）**：PR-4.1 / PR-4.2 / PR-4.3 **代码已完成**，**真实 PostgreSQL 端到端 18 passed、0 failed**（详见下方"已验证的真实 PG 集成测试"小节）。引用功能**未**达到 staging / production readiness，仍需在以下四类边界完成演练：
>
> 1. 多进程 Worker 真并行 `FOR UPDATE SKIP LOCKED` 单飞 / heartbeat 续约 / hard-crash sweeper 接管。
> 2. 真实 MinerU 解析失败 / 网络抖动重试。
> 3. 真实 Embedding Provider HTTP 接入。
> 4. 浏览器前后端端到端联调。
>
> - **代码已落地**：
>   - **Schema / Core-RAG 分层**：`backend/database/init.sql` 新增 `document_ingestion_jobs` / `storage_finalize_jobs` / `storage_deletion_outbox`（Core-only）；RAG 块（`vector` 扩展 + `embedding_profiles` + `document_embeddings`）由 bootstrap 顶层 `CREATE EXTENSION IF NOT EXISTS vector` + `SET LOCAL app.rag_enabled='on'` 触发；**PR-4.2 整改：HNSW 全局索引删除**（`embedding vector` 是可变维度列，必须按 profile 维度 partial 建；本轮不建）。
>   - **schema-init.ts**：接受 `{ ragEnabled: boolean }`（**必需**），在 first-time 路径同一事务内完成扩展创建与 `SET LOCAL`，DO 块不再承担 `CREATE EXTENSION`。
>   - **migrate.ts**：显式传 `config.ragEnabled` 给 `ensureSchema`。
>   - **HTTP 202 上传**：单事务串 documents + ingestion_jobs + finalize_jobs；catch 23505 触发 partial unique race 重查 + 200 复用既有 record。**PR-4 第二轮整改把 `createUploadBundle` 公开导出**作为集成测试入口（生产路由仍只通过 HTTP 202 暴露）。
>   - **ingestion claim**：JOIN documents 过滤 `deleted_at IS NULL AND storage_status='ready'`；claim / transition / markFailed 全部单事务 + lease fencing；**PR-4.2 整改：attempts 单点 ++**（仅 claim 时 +1，requeue 不再 +1）。
>   - **PR-4.2 整改 4 重守卫**：transitionIngestionStatus / markFailedTerminal 全部带 `lease_owner=worker AND lease_expires_at>now() AND status IN active AND documents.deleted_at IS NULL`。
>   - **PR-4 第二轮整改 参数位动态化**：`transitionIngestionStatus` 的 SQL placeholder 由 `params.push(...)` 后 `${params.length}` 生成，不再写死 `$4/$5/$6/$7`；覆盖 parsing / chunking / embedding / finalizing / ready / failed / requeue 全路径。
>   - **PR-4.2 整改 requeue 合并**：transitionIngestionStatus requeue 直接 `status='queued'` 单事务返回，删除旧 `flushRequeueToQueued` 二次 autocommit。
>   - **PR-4.2 整改 softDeleteDocument**：清 lease_owner / lease_expires_at / heartbeat_at（3 字段）防止旧 worker 推进已删文档。
>   - **PR-4.2 整改 finalize / outbox 3 重守卫**：done / failed / requeue 全部带 `status='processing' AND lease_owner=worker AND lease_expires_at>now()`。
>   - **PR-4.2 整改 finalize / outbox heartbeat**：storage_finalize_jobs + storage_deletion_outbox 都加 `heartbeat_at TIMESTAMPTZ`；worker 在长 IO（rename / S3 remove）期间每 `LEASE_MS/3` 续约 lease；sweeper 仅在 lease + heartbeat 都过期时收回；所有 heartbeat UPDATE 必须带 3 重守卫。
>   - **PR-4 第二轮整改 finalize / outbox sweeper 单次入口**：`_runFinalizeLeaseSweeperOnce` / `_runOutboxLeaseSweeperOnce` 导出供集成测试调用真实生产 sweeper；`runFinalizeOnce` / `runOutboxOnce` 也在 `_runFinalizeOnce` / `_runOutboxOnce` 别名导出。
>   - **PR-4.2 整改 finalize 幂等**：DocumentStorage 新增 `exists()`；local-storage / fake-storage 在"staging 不存在 + final 已存在"时静默成功，让"DB 写回失败后的下一轮 tick"幂等收敛。
>   - **PR-4.2 整改 active profile 自动创建**：`getOrCreateActiveEmbeddingProfile`（partial unique `one_active_embedding_profile_per_workspace` 兜底）；config 新增显式 `embeddingProvider`。
>   - **finalize + outbox**：claim 切 `processing` + lease + attempts++ + 真实退避 `2^(n-1)*1s` 封顶 5min；sweeper 按 lease 收回。
>   - **前端最小状态展示**：8 态 + 进度字段；1.5s 轮询仅对中间态触发。
> - **已验证的真实 PG 集成测试**（2026-09-11 第二轮整改后重跑，18 passed、0 failed）：
>   - **Core-only 文件**：[`backend/tests/integration/pr4-async-doc-rag-core.ts`](backend/tests/integration/pr4-async-doc-rag-core.ts) — 16 用例；进程以空 `EMBEDDING_API_KEY` 启动，让 `config.ragEnabled=false`（生产 Core-only 边界）。
>   - **RAG 文件**：[`backend/tests/integration/pr4-async-doc-rag-rag.ts`](backend/tests/integration/pr4-async-doc-rag-rag.ts) — 2 用例；进程以非空无敏感占位 `EMBEDDING_API_KEY` 启动，让 `config.ragEnabled=true`（生产 RAG 边界）。
>   - 两套用例分别以**独立进程**运行，`config.ragEnabled` 由本进程 env 决定，跟生产路径语义完全一致；**不**修改生产 `config` 模块，不调用真实 embedding API，不泄露真实 key。
>   - 沙箱无 PG 时两文件按各自用例数干净 SKIP；当前已 **18 passed、0 failed**：
>     - **#1** Core-only fresh schema：RAG 表不存在 + `app.rag_enabled='off'`。
>     - **#2** RAG fresh schema：RAG 表存在 + 无全局 HNSW。
>     - **#3** 并发上传 partial unique race：走生产 `createUploadBundle` + abort staging。
>     - **#4** ingestion claim 在 `storage_pending` 时抢不到：走生产 `claimNextIngestionJob`。
>     - **#5** finalize claim 跨实例并发 → 恰好一个 `processing`：走生产 `_runFinalizeOnce`。
>     - **#6 / #9** finalize / outbox lease 过期 sweeper 回收：走生产 `_runFinalizeLeaseSweeperOnce` / `_runOutboxLeaseSweeperOnce`，不复刻 SQL。
>     - **#7** ingestion transition 失败时整事务回滚：走生产 `transitionIngestionStatus`。
>     - **#8** soft delete 4 表串联原子性 + 清 lease 三字段：走生产 `softDeleteDocument`。
>     - **#10** outbox 删除成功 → `status=done + processed_at=now`：走生产 `_runOutboxOnce`。
>     - **#11** requeue attempts 只 +1（claim 单点 ++）；**#12** 删除后旧 worker 无法 ready；**#13** lease 过期 worker 拒绝写 done/failed。
>     - **#14** finalize 成功 + DB 写回失败 → 触发器注入重试幂等收敛。
>     - **#15** RAG 自动 active profile + 并发收敛（生产 `getOrCreateActiveEmbeddingProfile`）。
>     - **#16** outbox 两 worker 并发仅一个 remove。
>     - **#17** ingestion worker 真实跑全链路（生产 `runIngestionWorkerOnce`，Core-only 跳过 embedding）。
>     - **#18** transitionIngestionStatus 非 requeue 全路径真实 PG 覆盖（含 ready / failed 终态）。
> - **未验证（仍需在 staging 演练边界完成）**：
>   - 多进程 Worker 真并行下 `FOR UPDATE SKIP LOCKED` 单飞 / heartbeat 续约 / hard-crash sweeper 接管。
>   - MinerU 真实解析失败 / 网络抖动重试。
>   - Embedding Provider 真实 HTTP 接入。
>   - 浏览器前后端端到端联调。
> - **静态验证**：本轮通过 `npm run typecheck`（backend）+ `npm run build`（frontend）+ `git diff --check`。PR-4 fixture 在未配置 `TEST_DATABASE_URL` 时经 `tsx --test tests/integration/pr4-async-doc-rag-{core,rag}.ts` 干净 SKIP；**真实 PostgreSQL 端到端 18 passed、0 failed**（Core-only 16 + RAG 2；两套用例分别在独立进程跑 —— Core-only 文件以空 `EMBEDDING_API_KEY` 启动让 `config.ragEnabled=false`，RAG 文件以非空无敏感占位 `EMBEDDING_API_KEY` 启动让 `config.ragEnabled=true`；全程调 `runIngestionWorkerOnce` / `_runFinalizeOnce` / `_runOutboxOnce` / `transitionIngestionStatus` / `getOrCreateActiveEmbeddingProfile` / `createUploadBundle` 等生产入口，不调用真实 embedding API、不泄露真实 key、不修改生产 `config` 模块）。
> - **retriever-query-embedding.ts 整改（2026-09-11）**：`assertQueryEmbeddingValid` 第二参数 `expectedDimensions` 改为 optional，默认回退到 `DATABASE_EMBEDDING_DIM`，与 unit fixture 单参调用对齐。**之前** fixture 单参调用被误传 `undefined`，触发"Got unwanted exception... 长度必须为 undefined"——被 `node:test` 的"resource generated asynchronous activity after the test ended"机制吞掉，呈现 0 failed 的虚假干净验证。**已修正**：`expectedDimensions` 默认值让 fixture 与生产路径同时跑通；fixture 错误信息正则同步对齐为带"active profile dimensions" 的生产文案。
> - **旧 sync ingestion 死代码已删除**：`backend/src/modules/documents/ingestion.ts`（写已删除列 `document_chunks.embedding` + 写无效 `documents.status='completed'`），无生产调用方。
> - **范围外**：`learning/`（学习草稿）已加入 `.gitignore`，不属于 PR-4 提交范围。
>
> **PR-3.3.2 / 3.3.2.1 验证状态（2026-09-08）**：本仓库 `backend/tests/integration/tool-policy-pg.ts` 在真实 PostgreSQL + `FakeAgentFacade`（fake resume stream）下覆盖 (a) waiting_approval 保留、(b) approve 后真实消费 resume stream 推 Run → completed、(c) decline 终态、(c-2) expire 走 `system-approval-worker` 平台身份、(d) W2 SDK transient fail → approve 进入 `approved_resume_indeterminate` + Run 推回 `waiting_approval` 等 reconciler 接管、(e) scheduler 原子事务单飞、(f) `listSuspendedRuns` fail-closed、(g) 跨重启接管、(h) W2 attempts 耗尽 → `APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED` 收敛、(x) `created_by` NULL 拒绝创建审批，**107 passed, 0 failed**（Codex 于 2026-09-08 使用真实 PostgreSQL 本轮重跑通过；测试 facade / resume stream 为 fake）。
>
> 本轮（PR-3.3.2 / 3.3.2.1）：
> - **生产代码修复**（Codex 2026-09-07 第一次 review 发现阻塞级 crash window；PR-3.3.2.1 第二次 review 指出跨聚合编排违反 + 跨实例并发竞态）：新增 `sweepExpiredApprovalResumeLeases`（`backend/src/core/execution/approval-resume-recovery.ts`——从 `modules/tool-policy/repository.ts` 拆分到 execution 层以消除跨聚合编排违反）按 Tool 元数据 + approval 状态分流恢复 worker 进程被直接杀死（JavaScript catch 不执行）的孤儿现场；新增事件类型 `run-resume-reclaimed`。普通 `sweepExpiredLeases` 的 SQL 增加 `NOT EXISTS` 子句**排除** approval-resume Run，跨进程下两个 sweeper 真并行也安全；写入时清 `lease_owner / lease_expires_at / heartbeat_at`。
> - **测试已 Codex 实跑通过**：`approval-reconcile-safety.ts`（真实 PG + FakeAgentFacade）覆盖 reconciler lease fencing / backoff / **非幂等或未注册 Tool 拒绝自动重试** / 原子回滚 / 终态手工介入行退出扫描集；`executor-terminal-lease-fence.ts`（真实 PG + 真实 `runResumeSchedulerOnce` + deferred AsyncIterable stream，**`done / stopped / error` 三场景独立 seed**——`stopped` 用真实生产入口 `abortRunByMessage(assistantMessageId)` 触发、Settle 用 `listActiveExecutions()` 轮询、三场景均断言对应 `XxxRun 跳过：Run 已终态或当前 worker 已丢失 lease` 日志路径）覆盖执行器终态写入 `lease_owner = WORKER_ID` fence 在生产路径下生效；`multi-process-resume.ts` + `multi-process-resume-child.ts`（两个独立 Node 子进程 + IPC 同步屏障 + 共享 schema + 显式 tsx loader 注入 `backend/node_modules/tsx/dist/loader.mjs` 转 file URL 后 `--import` + 全 schema 生命周期 try/finally 兜底 + watchdog 仅在两个 child 都结束后清除 + ready 前 early-exit 兜底）覆盖跨进程 `approveToolCall` 单飞；`hard-crash-lease-recovery.ts`（真实 PG + 直接调生产 `runHardCrashApprovalResumeSweeperOnce`）覆盖 W4 hard-crash sweeper 7 项验收（含跨实例并发场景：hard-crash sweeper 与普通 `sweepExpiredLeases` 真并行时，approval-resume Run **不**变 `failed + LEASE_EXPIRED`）。
>
> **基线**（PR-3.3.1 / PR-3.3 / PR-3.3.2 / 3.3.2.1）：Backend `npm run typecheck` 通过；Backend unit fixtures 通过；`git diff --check` 通过；frontend production build 通过（保留既有 chunk-size warning 与 ineffective dynamic import；**仅**是 warning，**不**是 error / failure）。
>
> **Codex 实测结果（本轮 PR-3.3.2.1）**：
> - `tool-policy-pg.ts`：**107 passed, 0 failed**（Codex 于 2026-09-08 使用真实 PostgreSQL 本轮重跑通过；测试 facade / resume stream 为 fake）；
> - `hard-crash-lease-recovery.ts`：**32 passed, 0 failed**；
> - `multi-process-resume.ts`：**9 passed, 0 failed**；
> - `executor-terminal-lease-fence.ts`：`done` / `stopped` / `error` 三场景全部通过；
> - `approval-reconcile-safety.ts`：通过。
>
> **验证边界（保留）**：涉及 Mastra resume SDK/stream 边界的 PG 集成测试（`tool-policy-pg.ts` / `multi-process-resume.ts` / `executor-terminal-lease-fence.ts` / `approval-reconcile-safety.ts`）使用 `FakeAgentFacade` / fake stream——验证的是 worker 抢占层 + SDK 边界协议 + lease fencing + 跨进程资源抢占；`hard-crash-lease-recovery.ts` 直接验证生产 sweeper 的 PostgreSQL 状态收敛（不依赖 facade）。已通过本机真实 Mastra Core 1.61.0 + DeepSeek 的 approve / decline / timeout HTTP/SSE 三条基础路径以及 pending 后进程重启再批准的工具结果校验。**完整容灾与多实例真实 SDK e2e 尚未验证**：真实网络故障、真实 SDK 多实例并发去重、真实 `listSuspendedRuns` 返回结构、SSE 跨实例扇出、真实浏览器 UI 联调、真实 staging 部署、PostgresStore 在多实例下的 lock 行为——这些属 PR-3.3 staging e2e 待办，**不是** PR-3.3.2 / 3.3.2.1 的功能缺口。详见 [实测记录](docs/runbooks/2026-09-04-approval-verification.md) 与 [架构](docs/architecture.md)。

## 快速开始

开始前请准备：

- Node.js 22+
- PostgreSQL 15+
- Docker（可选；用于启动本地 PostgreSQL）
- DeepSeek API Key 和 Embedding Provider 凭据

### 配置本地环境

PowerShell：

```powershell
Copy-Item backend/.env.example backend/.env
# 编辑 backend/.env，填写本地凭据；不要提交该文件
docker compose up -d
```

首次创建数据库数据卷时会执行 `backend/database/init.sql`。如需手动初始化或重建本地数据库，请先阅读 [开发指南](docs/development.md)，避免对共享数据库执行初始化。

### 启动服务

```powershell
Set-Location backend
npm ci
npm run migrate
npm run users:create -- --username alice
npm run dev
```

创建账号时，密码会在交互式终端中输入，不会作为命令行参数保存。

在另一个终端执行：

```powershell
Set-Location frontend
npm ci
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)，使用刚创建的账号登录。

### 提交前检查

```powershell
Set-Location backend
npm run typecheck

Set-Location frontend
npm run lint
npm run build
```

### CI 与部署安全边界

- `.github/workflows/verify.yml` 运行不依赖外部凭据的 contracts、unit、fixtures、前端测试及构建。
- `.github/workflows/integration.yml` 使用独立 `pgvector/pgvector:pg16` service 与带 `safety-identifier=test_...` 的测试连接串；Core-only 和 RAG fixture 分进程执行。真实 DeepSeek、Embedding、MinerU 和浏览器 E2E 不在普通 CI 中伪造为通过。
- 文档上传的应用上限为单文件 10 MB、请求体 10.5 MB（为 multipart 开销预留）；生产反向代理仍必须配置相同或更低的 body limit 与安全响应头。前端 CSP meta 无法覆盖 `frame-ancestors`，反向代理应额外下发 `Content-Security-Policy: frame-ancestors 'none'`。

服务可用性可通过 `GET /healthz` 检查进程，通过 `GET /readyz` 检查数据库、LLM 与 Embedding 基础配置；后者在依赖未就绪时会返回 `503`，且不会泄露凭据。

## 在此基础上扩展

业务实现应落在既有扩展点中，避免直接耦合 Mastra Runtime：

| 目标 | 入口 |
| --- | --- |
| 新增 Agent | `backend/src/agents/`：复制 `_template`，再在 `backend/src/agents/index.ts` 注册 |
| 新增 Tool | `backend/src/tools/`：复制 `_template`，在 `backend/src/tools/index.ts` 注册，并配置对应 Agent 的 `toolIds` |
| 新增本地业务 Skill | `backend/src/skills/local/<your-skill>/SKILL.md`：重启后端后自动发现，再通过 API 绑定 |
| 安装市场 Skill | 前端 Skills 页面；安装内容存放在 `backend/market-skills/` |
| 新增业务模块 | `backend/src/modules/`：保持与核心运行时分层，按 Workspace 传递并校验归属 |
| 新增 HTTP API | `backend/src/server/routes/`：并在 `backend/src/server/bootstrap.ts` 的 `apiRoutes` 注册 |
| 修改品牌或默认模型 | `backend/src/config.ts` 与环境变量 `APP_NAME`、`APP_SHORT_NAME`、`LLM_PROVIDER`、`LLM_MODEL` |

新增 Agent、Tool 或 Skill 的常规路径是“复制模板 → 填写业务定义 → 在唯一入口注册”。开发约束与完整示例见 [扩展指南](docs/extending.md)。后端代码改动至少执行 `npm run typecheck`，前端代码改动至少执行 `npm run build`；不要把真实密钥、Token 或共享数据库配置提交到仓库。

## 深入了解

- [当前实现架构](docs/architecture.md)：已落地能力、数据流、安全边界和已知未验证项。
- [目标架构（V2）](docs/architecture-v2.md)：后续演进设计，不代表当前已经实现。
- [实施计划](docs/implementation-plan.md)：从现状到 V2 的阶段与 PR 切片。
- [Agent 系统](docs/agents.md)
- [Tool 系统](docs/tools.md)
- [Skill 系统](docs/skills.md)
- [开发指南](docs/development.md)
- [扩展指南](docs/extending.md)

文档表述冲突时，以 `docs/architecture.md` 记录的当前实现事实为准。

## 许可证

MIT
