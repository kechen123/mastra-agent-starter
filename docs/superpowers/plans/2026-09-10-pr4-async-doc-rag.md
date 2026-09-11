# PR-4 异步文档处理与 RAG 基础设施 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 或 superpowers:executing-plans 实施本计划；勾选用 `- [ ]`。

**Goal:** 把同步上传管线改为持久化 ingestion job + 后台 Worker；按 Core/RAG 分层重排 Schema；存储走 staging/finalize/outbox；文档状态机与真实进度可观察；不破坏 PR-3 已落地的 Run / Approval / SSE / Workspace 隔离。

**Architecture:** HTTP 202 + 持久化 job + PG `FOR UPDATE SKIP LOCKED` Worker + lease/heartbeat/attempts；DocumentStorage 抽象（本地 FS 实现）落 staging → finalize；删除走软删除 + outbox；Embedding 模型迁出 document_chunks，引入 `embedding_profiles` + `document_embeddings`；Core Schema 不依赖 pgvector；RAG Schema 由 `rag_enabled` 开关按 fresh init 启用。

**Tech Stack:** TypeScript、Mastra 1.61、PostgreSQL 15+、pg、Node 22；前端 React + Tailwind（**不升级依赖**）。

## 全局约束（来自用户指令）

- `backend/database/init.sql` 是 Schema 唯一来源；不创建 `migrations/`。
- Fresh DB only；不写旧库兼容 / 数据回填 / 迁移链。
- 不升级 npm / TS / Mastra / React。
- Core 模式不得要求 pgvector；RAG 启用由 `EMBEDDING_API_KEY` 存在 → `rag_enabled=true` 决定。
- 不修改聊天 UI / assistant-ui / Tailwind / 主题；前端仅做最小状态展示。
- 不创建/切换 git 分支；不自动 commit / push。
- Worker 不得在 PG 事务内执行网络 / 文件解析 / embedding。
- 失败必须有有限重试、指数退避、终态 `failed`；删除走 outbox 幂等重试。
- 跨 workspace 拒绝、引用元数据（title / chapter / documentName / chunkIndex / source）完整保留。
- `documents.status` 终态集合：`queued / parsing / chunking / embedding / finalizing / ready / failed / cancelled`。
- 真实进度字段：`total_chunks` / `completed_chunks`；禁止前端假百分比。

---

## 实施顺序

PR-4.1 → PR-4.2 → PR-4.3 → RAG 读路径切换。每个阶段都先静态类型，再最小验证。

---

## PR-4.1 Schema 与 Core / RAG 分层

### Task 1.1 init.sql：调整 documents 状态机与字段

**Files**
- Modify: `backend/database/init.sql`（documents / document_chunks / 新增三张 ingestion / storage 表）
- Modify: `backend/src/modules/documents/service.ts`（DocumentStatus 类型 + Repository 投影）

**Schema 改动摘要（不写完整 SQL 在此，仅列变更）**：
- `documents`：扩展 `status` CHECK 为 `('queued','parsing','chunking','embedding','finalizing','ready','failed','cancelled')`；新增 `total_chunks INT NOT NULL DEFAULT 0`、`completed_chunks INT NOT NULL DEFAULT 0`、`failure_reason TEXT`；保留 `deleted_at` 软删除。
- `document_chunks`：**删除** `embedding vector(2048)` 列；新增 `profile_id UUID`（RAG-only，FK 到 `embedding_profiles(id)` ON DELETE SET NULL；仅 RAG-enabled schema 创建此列）。
- **Core-only 新增**：
  - `document_ingestion_jobs` —— workspace_id / document_id / status / attempts / max_attempts / lease_owner / lease_expires_at / heartbeat_at / next_attempt_at / error_code / error_detail；CHECK 包含 `('queued','parsing','chunking','embedding','finalizing','ready','failed','cancelled')`；partial unique `(document_id) WHERE status IN ('queued','parsing','chunking','embedding','finalizing')`。
  - `storage_finalize_jobs` —— workspace_id / document_id / staging_key / final_key / status / attempts / max_attempts / lease_owner / lease_expires_at / next_attempt_at / last_error / processed_at；CHECK 含 `('pending','done','failed','cancelled')`。
  - `storage_deletion_outbox` —— storage_key / document_id（ON DELETE SET NULL）/ enqueued_at / processed_at / attempts / last_error；partial index `(enqueued_at) WHERE processed_at IS NULL`。
- **RAG-only 新增**（由条件 DDL 块包住；只有 `RAG_ENABLED=1` 才创建）：
  - `embedding_profiles` —— id / workspace_id / provider / model / dimensions / version / status(`active`/`inactive`/`migrating`/`legacy`) / is_active / created_at / updated_at；partial unique `(workspace_id) WHERE is_active=true`。
  - `document_embeddings` —— workspace_id / document_id / chunk_id / profile_id / embedding vector / dimensions / content_hash / created_at / updated_at；UNIQUE `(chunk_id, profile_id)`；普通过滤索引 `document_embeddings_workspace_chunk_idx` / `document_embeddings_profile_chunk_idx`（仅 RAG-enabled）。**本轮不建 HNSW 索引**：`embedding vector` 是可变维度列，HNSW 必须绑定固定 dimensions 才能 DDL，全局 HNSW 既不可创建、也会把后续切维度卡死；未来如需按 `(profile_id, dimensions)` 建 partial HNSW 属 profile 生命周期职责，不在本 plan 范围内。
- **Core-only 必须删除的依赖**：
  - 现有 `CREATE EXTENSION IF NOT EXISTS vector` —— 移入 RAG 块；Core 块**不**创建。
- 字段类型不兼容时，使用 `ALTER TABLE ... DROP COLUMN embedding` —— fresh DB 模式允许直接重排。

**任务 1.1 接口契约**（后续 task 消费）：
- `DocumentStatus = 'queued' | 'parsing' | 'chunking' | 'embedding' | 'finalizing' | 'ready' | 'failed' | 'cancelled'`。
- `documents.totalChunks / completedChunks / failureReason` 字段可读可写。
- `document_chunks.embedding` 不再可读；RAG 向量来自 `document_embeddings`。

- [ ] **Step 1**：在 init.sql 删除 `CREATE EXTENSION IF NOT EXISTS vector`；把现有 `documents.status` CHECK 改为新枚举；新增 `total_chunks / completed_chunks / failure_reason` 列；`document_chunks.embedding` 列删除；新增 Core 块三张表 + 索引。
- [ ] **Step 2**：在 init.sql 末尾追加 RAG 条件块 `DO $$ BEGIN IF current_setting('app.rag_enabled', true) = 'on' THEN ... CREATE EXTENSION vector; ... END IF; END $$;`。
- [ ] **Step 3**：更新 `backend/src/modules/documents/service.ts` 的 `DocumentStatus` 类型与 SELECT 投影。
- [ ] **Step 4**：`cd backend && npm run typecheck` —— 通过。

### Task 1.2 Core/RAG 启用开关

**Files**
- Modify: `backend/src/config.ts`（`ragEnabled` 派生 + 启动期校验）
- Modify: `backend/src/server/init.ts` 或 `bootstrap.ts`（启动期根据 `ragEnabled` 决定是否执行 RAG 块）

- [ ] **Step 1**：`config.ragEnabled` 由 `process.env.EMBEDDING_API_KEY` 存在与否推导；与 `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` 同时缺失则 Core-only。
- [ ] **Step 2**：在 `backend/src/scripts/migrate.ts` 启动期通过 `SET LOCAL app.rag_enabled = 'on'/'off'` 切换；与现有 `_init_meta` checksum 流程共存。
- [ ] **Step 3**：`cd backend && npm run typecheck` 通过；记录为 Core-only 路径不引用 pgvector 的检查点（无 schema fixture，只靠 typecheck + grep 静态约束）。

---

## PR-4.2 异步 ingestion job + outbox + Worker

### Task 2.1 DocumentStorage 抽象 + LocalFS 实现

**Files**
- Create: `backend/src/infrastructure/storage/document-storage.ts`（接口 + factory）
- Create: `backend/src/infrastructure/storage/local-storage.ts`（本地 FS 实现：`data/staging/` 与 `data/documents/`）
- Modify: `backend/.gitignore`（忽略 `data/`）

**接口契约**：
```ts
interface DocumentStorage {
  putStaging(uploadId: string, body: Buffer, meta: { mimeType: string; size: number }): Promise<{ stagingKey: string; sha256: string }>;
  finalize(stagingKey: string, finalKey: string): Promise<void>;
  abortStaging(stagingKey: string): Promise<void>;
  remove(finalKey: string): Promise<void>;
  getBytes(finalKey: string): Promise<Buffer>;
}
```

- [ ] **Step 1**：定义接口与本地 FS 实现（含 staging / final 两目录隔离）。
- [ ] **Step 2**：sha256 计算；目录创建；`rename` 即 finalize；`unlink` 即 abort/remove。
- [ ] **Step 3**：`backend/src/server/init.ts` 在 bootstrap 时注入 singleton `getDocumentStorage()`。

### Task 2.2 ingestion jobs Repository

**Files**
- Create: `backend/src/modules/documents/jobs-repository.ts`

**契约**：
- `enqueueIngestionJob({ workspaceId, documentId })` —— INSERT `status='queued'`。
- `claimNextIngestionJob(workerId, leaseMs=120_000)` —— `FOR UPDATE SKIP LOCKED` 抢占；返回 `IngestionJobRow`。
- `heartbeatIngestionJob(workerId, jobId)` —— 续约 lease。
- `transitionStatus(workerId, jobId, status, errorCode?, errorDetail?)` —— 受 lease 保护的状态推进；`finalizing → ready` 落 `documents.status='ready'` 与 `documents.totalChunks / completedChunks`。
- `markFailedTerminal(workerId, jobId, errorCode, errorDetail)` —— 终态 `failed`，清 lease。
- `cancelForDocument(documentId)` —— 终止所有 active 状态。

- [ ] **Step 1**：实现全部 6 个函数；全部 SQL 参数化、全部带 workspace_id 过滤。
- [ ] **Step 2**：`cd backend && npm run typecheck`。

### Task 2.3 ingestion Worker

**Files**
- Create: `backend/src/modules/documents/ingestion-worker.ts`

**流程**：
1. 每 1s 调用 `claimNextIngestionJob(WORKER_ID)`；无 job → sleep。
2. 推进阶段：`queued → parsing → chunking → embedding → finalizing → ready`；每个阶段调对应 service。
3. parse：从 `DocumentStorage.getBytes(finalKey)` 读 bytes；调 `getParser()` 解析（与 routes 同源，提取 `parsers/split-text.ts`）。
4. chunking：复用现有 `splitText` 逻辑；写入 `document_chunks`。
5. embedding：**仅当 `ragEnabled` 为 true** 才计算 + 写 `document_embeddings`；Core-only 模式只写 chunk 文本。
6. finalizing：把 `documents.status` 推 `finalizing`；ready：同步把 `documents.status` 与对应 ingestion_job 一起推 `ready`。
7. 失败：`attempts++`；未达 `max_attempts` → `status='queued'` + `next_attempt_at = now() + exp_backoff`；达 → `status='failed'` + `failure_reason`。
8. Worker 必须**不**持事务做网络/文件/embedding；只在 DB 写入短事务内 commit 状态变更。

**生命周期**：
- `startIngestionWorker()` —— 启动后台 loop；返回 stop handle。
- `bootstrap.ts` 在 `initializeApp()` 后调 `startIngestionWorker()`。
- stop 在 SIGTERM / SIGINT 触发；先 await 当前 job 收尾再退出。

- [ ] **Step 1**：实现 worker loop + 阶段推进。
- [ ] **Step 2**：实现失败路径与退避。
- [ ] **Step 3**：实现 stop handle；接入 `bootstrap.ts`。

### Task 2.4 storage finalize worker + deletion outbox worker

**Files**
- Create: `backend/src/modules/documents/storage-workers.ts`
- Modify: `backend/src/server/bootstrap.ts`（启动两个 worker）

**契约**：
- `runStorageFinalizeOnce()` —— 抢占一个 `storage_finalize_jobs.pending` 行，调 `storage.finalize(stagingKey, finalKey)`，成功 → `UPDATE status='done' + documents.storage_status='ready'`；失败 → 退避。
- `runDeletionOutboxOnce()` —— 抢占一批 `processed_at IS NULL` 行，调 `storage.remove(storage_key)`；成功 → `processed_at=now()`；失败 → `attempts++`。

- [ ] **Step 1**：实现 finalize + outbox worker。
- [ ] **Step 2**：接入 bootstrap；幂等启动。

### Task 2.5 Upload route 改为 202

**Files**
- Modify: `backend/src/server/routes/documents.ts`
- Modify: `backend/src/modules/documents/service.ts`（拆出 `uploadStagingDocument`，仅做 staging + DB INSERT + job enqueue）

**新行为**：
- 接收 `multipart/form-data`；计算 sha256。
- `putStaging` → 拿到 `stagingKey`。
- 命中 `documents_dedup_unique_idx` → abort staging，返回 200 + 现有 record。
- 未命中 → DB 三表 INSERT：`documents(storage_status='storage_pending', status='queued')` + `document_ingestion_jobs(status='queued')` + `storage_finalize_jobs(staging_key, final_key, status='pending')`。
- 返回 **HTTP 202**：`{ documentId, jobId, status: 'queued', stage: 'queued' }`。

- [ ] **Step 1**：改造 upload route；新增 `uploadStagingDocument` service。
- [ ] **Step 2**：保持现有 `getDocument` / `listDocuments` 不变；扩展 SELECT 投影带 `totalChunks / completedChunks / failureReason`。

### Task 2.6 Delete route 软删除 + outbox

**Files**
- Modify: `backend/src/server/routes/documents.ts`
- Modify: `backend/src/modules/documents/service.ts`（新增 `softDeleteDocument`）

**行为**：
- 单事务：`UPDATE documents SET deleted_at=now(), status='cancelled'` + `INSERT storage_deletion_outbox(storage_key, document_id)` + `UPDATE storage_finalize_jobs SET status='cancelled'` + `UPDATE document_ingestion_jobs SET status='cancelled'`。
- 返回 204。

- [ ] **Step 1**：实现 `softDeleteDocument`；迁移 delete route。
- [ ] **Step 2**：`npm run typecheck` 通过。

### Task 2.7 进度查询接口

**Files**
- Modify: `backend/src/server/routes/documents.ts`（新增 `GET /documents/:id/progress` 或扩展 `getDocument` 返回进度字段）

**契约**：`getDocument` 已带 `totalChunks / completedChunks / failureReason / status`，无需新增端点；前端用 `GET /documents/:id` 直接读。

- [ ] **Step 1**：校验 `getDocument` SELECT 包含全部进度字段。
- [ ] **Step 2**：`npm run typecheck`。

---

## PR-4.3 最小前端状态展示

### Task 3.1 更新类型与 API 客户端

**Files**
- Modify: `frontend/src/lib/api.ts`（`KnowledgeDocument` 状态枚举扩展）

**变更**：
- `KnowledgeDocument.status` 增加 `'finalizing' | 'cancelled'`；`totalChunks` / `completedChunks` / `failureReason` 字段。
- `uploadDocument` 仍返回 `KnowledgeDocument`（现代表 202 立即返回的 record，status='queued'）。

- [ ] **Step 1**：扩展类型。

### Task 3.2 文档卡片显示真实进度

**Files**
- Modify: `frontend/src/features/knowledge/components/KnowledgeBaseWorkspace.tsx`

**变更**：
- `STATUS_LABEL` 增加 `finalizing: '收尾中'` / `cancelled: '已取消'`。
- 处理中状态卡片显示 `completed/total` 进度文本（**不**用百分比；只显示「已完成 X / 总计 Y」）。
- 失败状态显示 `document.failureReason`。
- 删除按钮在 `cancelled` 行禁用。
- 上传成功后 `isUploading=false` 由后端 202 触发；前端继续轮询 `GET /documents/:id` 直到 `status` ∈ {ready, failed, cancelled}；轮询间隔 1500ms。

- [ ] **Step 1**：扩展 `STATUS_LABEL`；增加进度文本；增加 `failureReason` 行。
- [ ] **Step 2**：在 `App.tsx` 或组件内增加轮询逻辑（仅对非终态文档）。
- [ ] **Step 3**：`cd frontend && npm run build` 通过。

---

## RAG 读路径切换

### Task 4.1 retriever 改读 document_embeddings

**Files**
- Modify: `backend/src/modules/knowledge/rag/retriever.ts`

**变更**：
- WHERE 条件：`JOIN document_chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id WHERE c.workspace_id=$1 AND c.knowledge_base_id=$2 AND d.status='ready' AND e.profile_id IN (SELECT id FROM embedding_profiles WHERE is_active=true AND status='active') AND e.embedding IS NOT NULL`。
- 距离计算用 `<=>` against `e.embedding`。
- JOIN 出 `chunk metadata`；保留 citation 字段（title/documentName/chunkIndex/heading/source）。

- [ ] **Step 1**：改造 SQL。
- [ ] **Step 2**：`npm run typecheck`。

---

## 自动化验证

### Task 5.1 后端单元 / 集成 fixture

**Files**
- Create: `backend/tests/unit/ingestion-jobs-repository.ts`（fake client 覆盖 claim/heartbeat/transition/fail/cancel）
- Create: `backend/tests/unit/ingestion-worker.ts`（mock storage + mock embedder；覆盖 happy / fail-retry / final-failed / cancelled 路径）
- Create: `backend/tests/unit/upload-route-async.ts`（fake DB / fake storage；断言 202 + status='queued'）
- Create: `backend/tests/integration/document-async-pg.ts`（真实 PG schema；覆盖：上传 202 / Worker 推进 / 进度查询 / 软删除 outbox）

- [ ] **Step 1**：写 fake-client 单元测试。
- [ ] **Step 2**：写 mock storage / embedder 单元测试。
- [ ] **Step 3**：写真实 PG 集成测试（可选；RUN_PG_DOCS=1）。
- [ ] **Step 4**：`cd backend && npx tsx backend/tests/unit/ingestion-jobs-repository.ts` —— 通过。

### Task 5.2 前端 typecheck / build

- [ ] `cd frontend && npm run build` —— 通过。

### Task 5.3 git diff --check

- [ ] `cd backend && git diff --check` —— 无空白冲突。
- [ ] `git status` —— 列出全部新增 / 修改文件。

---

## 文档同步

### Task 6.1 README.md

- [ ] 更新「开箱即用」章节：把"文档经 PostgreSQL + pgvector 检索"改为"文档异步入库；RAG 启用时检索就绪片段"。
- [ ] 更新「基线」段落：标注 PR-4 状态（部分已落地、其余未验证）。

### Task 6.2 docs/architecture.md

- [ ] 新增「PR-4 异步文档管线」段落，描述 ingestion job / Worker / outbox / storage / RAG 边界。
- [ ] 标注未验证项：跨实例并发、storage finalize 竞态、MinerU 重试、跨 workspace 反向嗅探。

### Task 6.3 docs/implementation-plan.md

- [ ] 更新 PR-4.1 / PR-4.2 / PR-4.3 状态：实际落地了什么、什么未验证。
- [ ] 把"创建 migrations/*.sql"删除；标注本轮按用户裁决走 fresh init。

---

## 执行注意事项

1. 不要触碰 PR-3 已落地的代码路径（approvals、agent_runs、conversations、messages）。
2. 不升级任何依赖。
3. 不创建 git 分支；不 commit / push。
4. Worker 启动在 `bootstrap.ts`，与 `startRunExecutor` / `startApprovalTimeoutWorker` 同一序列。
5. RAG 条件 DDL 通过 `SET LOCAL app.rag_enabled = 'on'` + `current_setting` 检查；Core-only 启动不会执行 RAG 块。
6. 跨 workspace 完整性：所有写入路径必须带 `workspace_id` 过滤；跨 workspace 一律返回 404。

---

## 未完成 / 未验证项（明确告知 Codex）

- 跨实例并发抢占（多 Worker 进程同时跑）的真实 PG 端到端验证：仅靠单元 + 集成 fixture，未跑真实多进程。
- Storage finalize 竞态（删事务 vs finalize worker 真同时）的真实 PG 端到端验证：仅靠静态 SQL 与类型校验。
- MinerU 解析失败 / 网络抖动重试的真实网络演练：仅靠 fake parser 单元覆盖。
- 浏览器端到端：仅前端 build 通过，未启动真实后端联调。
- Embedding Provider 实际接入：仅类型签名 / config 派生；未实测调用。

---

## 最终状态（2026-09-11，第二轮 Codex review 后）

**PR-4.1 / PR-4.2 / PR-4.3 代码已完成**；**真实 PostgreSQL 端到端 18 passed、0 failed**（Core-only 16 + RAG 2）：

- [`backend/tests/integration/pr4-async-doc-rag-core.ts`](../../backend/tests/integration/pr4-async-doc-rag-core.ts) — 16 用例；进程以空 `EMBEDDING_API_KEY` 启动，让 `config.ragEnabled=false`（生产 Core-only 边界）。
- [`backend/tests/integration/pr4-async-doc-rag-rag.ts`](../../backend/tests/integration/pr4-async-doc-rag-rag.ts) — 2 用例；进程以非空无敏感占位 `EMBEDDING_API_KEY` 启动，让 `config.ragEnabled=true`（生产 RAG 边界）。
- 两套用例分别以**独立进程**运行，`config.ragEnabled` 由本进程 env 决定，与生产路径语义完全一致；**不**修改生产 `config` 模块，不调用真实 embedding API，不泄露真实 key。
- 全部调 `runIngestionWorkerOnce` / `_runFinalizeOnce` / `_runOutboxOnce` / `transitionIngestionStatus` / `getOrCreateActiveEmbeddingProfile` / `createUploadBundle` 等生产入口，不复刻 SQL。

**PR-4.4（存量向量迁移）已取消**：本模板采用 fresh DB + `backend/database/init.sql` 单一来源，不维护旧库迁移；§8.4.2 六步迁移依赖旧库，本项目模板统一以 init.sql 为起点，存量数据不存在，需要时由维护者按 V2 §8.4.2 手动跑 init.sql 重建。

**Staging / production readiness 仍需在 4 类边界完成演练**（真实 PG 端到端 18 passed 不覆盖这些边界）：

1. 多进程 Worker 真并行 `FOR UPDATE SKIP LOCKED` 单飞 / heartbeat 续约 / hard-crash sweeper 接管。
2. 真实 MinerU 解析失败 / 网络抖动重试。
3. 真实 Embedding Provider HTTP 接入。
4. 浏览器前后端端到端联调。

**静态验证**：本轮通过 `npm run typecheck`（backend）+ `npm run build`（frontend）+ `git diff --check`。沙箱无 PG 时两 PR-4 fixture 文件按各自用例数干净 SKIP。

**本计划历史 task 列表（Task 1.1 – Task 6.3）保持原状**——历史交付项的真实状态在 `architecture.md` §7 与 `implementation-plan.md` 阶段 4 节表述。本节为最终事实声明，不重新改写历史 task 的 checkbox 状态。
