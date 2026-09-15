# V2 实施计划（阶段 0～5 / PR 切片）

> **当前执行进度（2026-09-08 PR-3.3.2 / 3.3.2.1 实测验证收尾）**：PR-3.3.1 的本机真实 SDK / 模型基础三路径、pending 后重启批准、107 项真实 PG + fake facade 集成均通过；PR-3.3.2 / 3.3.2.1 本轮新增四项 PG 集成已 Codex 实跑通过——`hard-crash-lease-recovery.ts` 32 passed, 0 failed；`multi-process-resume.ts` 9 passed, 0 failed；`executor-terminal-lease-fence.ts` `done / stopped / error` 三场景全部通过；`approval-reconcile-safety.ts` 通过。Backend `npm run typecheck`、Backend unit fixtures、`git diff --check`、frontend `npm run build` 均通过（前端仅保留 chunk-size / ineffective dynamic import warning，不视作失败）。
>
> **2026-09-14 V2 聊天链路补齐**：知识库 ID 与 citations 已进入 Run Executor 主链路；Tool 开始/完成/失败事件同时进入业务执行留痕、可回放 Run 事件和前端消息状态；停止请求统一为 V2 主接口。backend typecheck、unit fixtures、frontend build 已通过；真实浏览器/模型端到端仍待验证。

> **2026-09-15 当前验证与版本边界**：`@mastra/core@1.65.0` 是当前依赖基线；文中 1.61 的真实 DeepSeek/审批记录仅作历史证据。当前代码已加入隔离 PostgreSQL CI workflow、依赖安全锁定、上传 body limit、SSE 错误脱敏、Markdown URL 白名单、响应头与非动态 Calculator；本机已完成 typecheck、离线 unit/前端测试与构建，未在本轮连接 PostgreSQL 或执行真实模型、Embedding、MinerU、浏览器 E2E。后续凡引用 1.61 验收，均不得表述为 1.65.0 已验证。
>
> **本轮新增（PR-3.3.2 / 3.3.2.1）**：
> - **生产代码修复**：`sweepExpiredApprovalResumeLeases`（`backend/src/core/execution/approval-resume-recovery.ts`——PR-3.3.2.1 从 `modules/tool-policy/repository.ts` 拆分到 execution 层以消除跨聚合编排违反）—— 修复 Codex 2026-09-07 第一次 review 发现的**阻塞级 crash window**（worker 进程被直接杀死时 JavaScript catch 不会执行，原 sweeper 会把孤儿 Run 错误地写成 `failed` + `LEASE_EXPIRED`，留下不可恢复的孤儿组合）。按 Tool 元数据 + approval 状态分流恢复。新增事件类型 `run-resume-reclaimed`。
> - **跨实例并发修复**：普通 `sweepExpiredLeases` 的 SQL 增加 `NOT EXISTS` 子句**排除** approval-resume Run（`tool_approval_requests.status IN ('approved','declined','expired') AND mastra_resume_started_at IS NOT NULL`）——不能依赖调用顺序，跨进程下两个 sweeper 真并行时仍必须分流。同时 `sweepExpiredLeases` 写入 `failed` 时清 `lease_owner / lease_expires_at / heartbeat_at`，避免心跳 / sweeper 重复触发。
> - **测试已 Codex 实跑通过**：
>   - `executor-terminal-lease-fence.ts` —— `done / stopped / error` 三场景独立 seed，覆盖 `completeRun / stopRun / failRun` 终态 `lease_owner` fence；`stopped` 用真实生产入口 `abortRunByMessage(assistantMessageId)` 触发，Settle 用 `listActiveExecutions()` 轮询，三场景均断言对应 `XxxRun 跳过：Run 已终态或当前 worker 已丢失 lease` 日志路径；
>   - `multi-process-resume.ts` + `multi-process-resume-child.ts` —— 修复 `resolver_id` 缺失、schema 生命周期 try/finally、watchdog 早清、Windows ESM `--import` 必须 file URL、ready 前 early-exit 等关键问题；
>   - `hard-crash-lease-recovery.ts` —— 覆盖 W4 hard-crash sweeper 7 项验收（含跨实例并发场景）；
>   - `approval-reconcile-safety.ts` —— 覆盖 reconciler lease fencing / backoff / 非幂等 Tool 拒绝自动重试 / 原子回滚 / 终态手工介入行退出扫描集。
>
> **仍不是完整生产容灾验收**：网络抖动 / 真实 SDK 并发去重 / 多实例 SSE 跨实例扇出 / 浏览器端到端仍未验证（属 PR-3.3 staging e2e 待办）。**PR-4 状态（2026-09-11，第二轮 Codex review 后）**：PR-4.1 / PR-4.2 / PR-4.3 **代码已完成**；**真实 PostgreSQL 端到端 18 passed、0 failed**（Core-only 16 + RAG 2，分别调 `runIngestionWorkerOnce` / `_runFinalizeOnce` / `_runOutboxOnce` / `transitionIngestionStatus` / `getOrCreateActiveEmbeddingProfile` / `createUploadBundle` 等生产入口；详见 `architecture.md` §7 与 PR-4.x 各小节）。**staging 演练未完成**（仅 4 类边界）：多进程 Worker 真并行 / 真实 MinerU / 真实 Embedding Provider HTTP / 浏览器前后端端到端联调。**PR-4.4（存量向量迁移）已取消**：本模板采用 fresh DB + `backend/database/init.sql` 单一来源，不维护旧库迁移。涉及 Mastra resume SDK/stream 边界的 PG 集成测试（`tool-policy-pg.ts` / `multi-process-resume.ts` / `executor-terminal-lease-fence.ts` / `approval-reconcile-safety.ts`）使用 `FakeAgentFacade` / fake stream——验证的是 worker 抢占层 + SDK 边界协议 + lease fencing + 跨进程资源抢占；`hard-crash-lease-recovery.ts` 直接验证生产 sweeper 的 PostgreSQL 状态收敛（不依赖 facade）。本机真实 Mastra Core 1.61.0 + DeepSeek 的 approve / decline / timeout 三条 HTTP/SSE 基础路径及 pending 后重启再 approve 已有验证记录；**完整容灾与多实例真实 SDK e2e 尚未验证**——这是 PR-3.3 staging e2e 待办，**不是** PR-3.3.2 / 3.3.2.1 的功能缺口。详见 [实测与交接记录](runbooks/2026-09-04-approval-verification.md)。

> **本版本已被本次裁决覆盖**：迁移链 / 增量迁移 / `LEGACY_WORKSPACE_OWNER_USER_ID` ——以 `docs/superpowers/specs/2026-08-28-workspace-id-isolation-design.md` §5 为准。PR-1.2 / PR-1.3 / PR-1.4 / PR-1.5 已合并落地。

> **状态：基于 V2.3.6（2026-08-28）** —— `architecture-v2.md` 已升版至 V2.3.6，五项定向修正全部落定（含 §8.4.1 Core/RAG Schema 边界与 §8.4.2 存量内联向量迁移）。本文档据此拆解阶段 0～5 的 PR 切片。**自此进入代码开发**：阶段 0–3 已落地（PR-1.x / PR-2 / PR-3.0–3.3）；阶段 4 的 PR-4.1 / PR-4.2 / PR-4.3 代码已完成并经真实 PostgreSQL 端到端 18 passed、0 failed（详见下方阶段 4 节）；PR-4.4 已取消，模板统一走 fresh DB + init.sql。

## 本文档的定位

| 文档 | 角色 | 冲突时 |
|---|---|---|
| [`architecture.md`](architecture.md) | 当前已实现（as-built） | 描述现状以它为准 |
| [`architecture-v2.md`](architecture-v2.md) | **目标规范**（V2.3.6） | 描述目标以它为准 |
| 本文档 | 从现状走到目标的**落地路径** | **只拆解规范，不覆盖规范** |

**硬约束**（用户裁决）：`architecture-v2.md` 是目标规范，实施计划只能拆解规范，不能暗中覆盖规范。所有规范缺口必须回到 `architecture-v2.md` 升版并落定，再回到本文档拆 PR——不允许在实施计划里「就地裁决」架构问题。

---

## 前置架构裁决（2026-08-28）

代码基线勘察发现 7 项设计文档与仓库现状的冲突。按归属划分如下：

| # | 问题 | 处理位置 | 裁决 | 状态 |
|---|---|---|---|---|
| 1 | 存量内联向量迁移无设计 | V2 §8.4.2 + 本计划 PR-4.x | V2 定义迁移语义、校验与回滚；本计划拆 PR | ✅ V2.3.6 落定 |
| 2 | Core 模式剥离 pgvector 与基线矛盾 | V2 §8.4.1 + 本计划 PR-0.x / PR-4.x | V2 定义 Core/RAG Schema 边界；本计划安排基线拆分 | ✅ V2.3.6 落定 |
| 3 | backend 缺 `lint` 脚本 | 本计划 阶段 0 PR-0.2 | 工程落地问题，不需要架构裁决 | 已归属 |
| 4 | §8.7 验收用过时字段 `locked_at` | V2 §8.7 | 改为 `lease_owner` / `lease_expires_at` | ✅ V2.3.6 落定 |
| 5 | `skills_installed → skill_packages` 阶段不明 | V2 §5.1 | 明确放在**阶段 1**，与 Skill 三表迁移同阶段 | ✅ V2.3.6 落定 |
| 6 | `document_chunks` 未纳入隔离合约测试 | V2 §5.4 | §5.4 测试清单加入 `document_chunks` | ✅ V2.3.6 落定 |
| 7 | 评测表为伪 schema | 本计划 阶段 5 PR-5.1 | 增加「Schema 定稿 PR」作为 runner 实现前置 | 已归属 |

### 1、2 项裁决摘要（详见 `architecture-v2.md` §8.4.1 / §8.4.2）

**Schema 分层**
- 新安装 **Core Schema 不创建** `vector` 扩展、**不创建** `document_chunks.embedding`。
- **RAG 启用时**才创建 `vector` 扩展 + `embedding_profiles` + `document_embeddings` 及普通过滤索引（`document_embeddings_workspace_chunk_idx` / `document_embeddings_profile_chunk_idx`）；**本轮不建 HNSW 索引**——`embedding vector` 是可变维度列，HNSW 必须绑定固定 dimensions 才能 DDL，全局 HNSW 既不可创建、也会把后续切维度卡死；未来如需按 `(profile_id, dimensions)` 建 partial HNSW 属 profile 生命周期职责，本轮不在 init.sql 里做。
- Core 路径 SQL 禁止引用 `vector` 类型 / `<=>` / `document_embeddings`。

**存量库迁移**
- 先建新表 + Legacy Embedding Profile（`status='migrating', is_active=false`），再迁移或重算存量向量。
- 仅当 `LEGACY_EMBEDDING_PROVIDER` + `LEGACY_EMBEDDING_MODEL` + `LEGACY_EMBEDDING_DIMENSIONS` 全部显式确认且维度匹配列 typmod 才允许原样搬迁；否则必须重新 embedding，**禁止伪造模型归属**。
- 迁移前后校验：向量数量、chunk 覆盖率、维度、`content_hash`。
- 唯一切换点 `embedding_profiles.status='active'`，**回滚窗口内禁止 DROP 列**。

---

## 全局约束

| # | 约束 | 来源 |
|---|---|---|
| G-1 | **Init.sql 唯一**：所有 Schema 集中定义在 `backend/database/init.sql` 单文件；项目不维护迁移链。`npm run migrate` 计算 init.sql 的 SHA-256 并与 `_init_meta` 中登记值比对。详见 §5.3 / G-2 | §5.3、阶段 0 验收 |
| G-2 | **Schema 唯一来源**：`backend/database/init.sql` 是 Schema 唯一来源；项目不维护迁移链；`npm run migrate` 计算 SHA-256 checksum 后执行：未登记 → 应用；一致 → 跳过；不一致 → 拒绝（退出码 2）。任何 DB 失败 → ROLLBACK | §5.3、阶段 0 验收 |
| G-3 | **（已撤销）** 原 G-3 命名约定与 §5.3 / G-2 冲突；项目不维护迁移链，不需要文件命名约束 | 既有约定 |
| G-4 | **测试 runner**：后端 `package.json` 的 `test` 脚本用 `tsx` 直接加载 `src/**/*.test.ts`；新增测试文件放对应模块目录，命名 `<module>.test.ts` | `backend/package.json` 当前实现 |
| G-5 | **CI 门禁**（`.github/workflows/verify.yml`）：backend `lint`（PR-0.2 后存在）+ `typecheck` + `test`；frontend `lint` + `typecheck` + `build`；任一失败阻断 merge | §4.1 |
| G-6 | **Core / RAG SQL 隔离**：RAG-only 路径（`<=>`、`vector(...)`、`document_embeddings`）必须包在 `if (await ragEnabled())` 分支；Core 路径 SQL 编译期静态可证不引用 RAG 表 | §8.4.1 |
| G-7 | **占位拒绝**：本计划所有 PR 必须给出可执行的 SQL/TS 片段；任何"TBD"/"类似 N"/"适当处理"在落 PR 时由 reviewer 直接退回 | writing-plans skill §No Placeholders |

## 阶段依赖总图

```
PR-0.1 Schema baseline  ─┐
PR-0.2 lint + CI gate   ─┼─► 阶段 1 ─► 阶段 2 ─► 阶段 3 ─► 阶段 4 ─► 阶段 5
PR-0.3 测试约定       ─┘             │           │           │           │
                                  PR-1.x       PR-2.x       PR-3.x       PR-4.x  PR-5.x
                                  Workspace   Session/Run  Tool Policy  RAG 迁移  Eval/Prod
                                  隔离合约    Idempotency  审批         Core/RAG
                                  Skill三表   SSE 续传                  拆分
```

阶段 1 之前所有 PR 必须先合；阶段 2 之前所有阶段 1 PR 必须先合；后续同理。

---

## 阶段 0：设计与工程基线

**目标**：把仓库从「能跑但与目标规范有结构性偏差」的状态，整成「每个 PR 改动都可在 verify.yml 中证伪/证实」的状态。

### PR-0.1：把 `init.sql` 改写为可迁移基线（Schema 分层前置）

**Files**
- Modify: `backend/database/init.sql`
- Create: `backend/database/migrations/0000-init-baseline.sql`
- Modify: `backend/src/infrastructure/db/migrate.ts`（如不存在则新建）

> 实际未创建此文件——PR-1.2 / PR-1.3 / PR-1.5 已在 `backend/database/init.sql` 单文件中合并落地（见 G-2 / §5.3）。

**依赖**：无

**Schema**：**本期不引入** Core/RAG 拆分（避免改动爆炸）。仅把 `init.sql` 改写为不含 `vector` 扩展、不含 `document_chunks.embedding` 的「Core 基线」；pgvector / `embedding vector(2048)` 一并移到 `0002-rag-extensions.sql`（**本 PR 不创建**，留作 PR-4.1）。`init.sql` 内容由 PR-0.1 提供完整 SQL（见下方）。

**API**：无

**前端**：无

**测试**
- 新增 `backend/src/infrastructure/db/__tests__/migrate.test.ts`：跑一次空数据库 → 断言 `init.sql` 已应用 + `0000` 在 `_migrations` 中、且 `vector` 扩展、`document_chunks.embedding` 列都不存在。

**门禁**：`npm run typecheck`、`npm run test`、`docker compose down -v && docker compose up -d` 后 `psql \dx` 不含 vector。

### PR-0.2：补齐 backend `lint` 脚本与 CI 门禁

**Files**
- Modify: `backend/package.json`（新增 `lint` 脚本）
- Create: `backend/.eslintrc.cjs`（或 `.eslintrc.json`）
- Modify: `.github/workflows/verify.yml`（追加 `npm run lint`）

**注意**：用户裁决 #3。lint 规则保持最小集（`@typescript-eslint/recommended-type-checked` + `no-floating-promises`），不引入风格化规则。

**测试**
- 故意写一段 `Promise` 未 await（`src/__tests__/lint-fixture.ts`），断言 `npm run lint` 报错并拒绝通过。

**门禁**：CI 红 → 修 fixture → 绿。

### PR-0.3：测试约定与隔离合约测试脚手架

**Files**
- Create: `backend/src/test-utils/db-isolation.ts`（每测试一个 schema 命名空间，事务回滚）
- Create: `backend/src/test-utils/lease-fake.ts`（注入固定 `lease_owner` / 可控时间）
- Modify: `backend/package.json`（`test` 脚本如需调整则改）

**测试**：用 doc_chunks 跨 workspace 读测试作为占位（断言**失败**，因为 §5.1 还未加 `workspace_id`），证明脚手架可用。

**门禁**：脚手架测试通过。

### 阶段 0 验收

- [ ] `init.sql` 不再依赖 pgvector；本地冷启动不再要求安装 `vector` 扩展
- [ ] `npm run lint` 存在且 CI 强制
- [ ] 测试脚手架可独立隔离数据库状态

---

## 阶段 1：Workspace 与资源隔离

**目标**：建立请求身份上下文与 `workspace_id` 归属；五张核心表 + `document_chunks` 全部加归属列；隔离合约测试覆盖所有归属表。

> **阶段 1 目标（PR-1.2 / PR-1.3 / PR-1.5 已合并落地）**：建立请求身份上下文与 `workspace_id` 归属；五张核心表 + `document_chunks` 全部加归属列；隔离合约测试覆盖所有归属表。**Schema 唯一来源**：`backend/database/init.sql`（不维护迁移链，见 §5.3 / G-2）。

### PR-1.1：workspace 与会话身份上下文（V2.3.6 收紧版）

**目标**：把 V2.3.6 §5.1 的 Personal Workspace 唯一性、Personal/Shared 互斥
约束、`onConflict` 并发安全、登录顺序（先 ensure 后 createSession）、请求级
非空 `workspaceId` 全部落地。

**Files**
- Create: `backend/database/migrations/0002-workspaces.sql`（PR-1.1 首次落地；已应用，不可改）
- Create: `backend/database/migrations/0003-workspace-constraints.sql`（PR-1.1 修正；本次新增）
- Create: `backend/src/modules/auth/workspace-context.ts`
- Create: `backend/src/test-utils/migrations.ts`（测试侧：跑 `init.sql` + `migrations/*.sql`）
- Modify: `backend/src/modules/auth/service.ts`（`SafeUser.workspaceId` 非空；登录顺序固定）
- Modify: `backend/src/server/routes/auth.ts`（`/auth/me` 走 `resolveAuthenticatedContext`）

> 实际未创建此文件——PR-1.2 / PR-1.3 / PR-1.5 已在 `backend/database/init.sql` 单文件中合并落地（见 G-2 / §5.3）。

**Schema**（V2.3.6 §5.1 终态）：

`workspaces`：
- `id UUID PK`
- `kind TEXT NOT NULL DEFAULT 'shared' CHECK (kind IN ('personal','shared'))`
- `name TEXT NOT NULL CHECK (length(btrim(name)) > 0)`
- `owner_user_id UUID REFERENCES app_users(id) ON DELETE CASCADE`
  - **个人**：`owner_user_id` 非空；
  - **共享**：`owner_user_id` 必为 NULL；owner 身份仅由
    `workspace_members.role='owner'` 表达。
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `deleted_at TIMESTAMPTZ`（保留列，PR-1.1 阶段不消费）
- `CHECK ((kind='personal' AND owner_user_id IS NOT NULL) OR (kind='shared' AND owner_user_id IS NULL))`
- `UNIQUE INDEX one_personal_workspace_per_user (owner_user_id) WHERE kind='personal'`

`workspace_members`：
- `workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`
- `user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE`
- `role TEXT NOT NULL CHECK (role IN ('owner','admin','member'))`
- `joined_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `PRIMARY KEY (workspace_id, user_id)`

**`ensurePersonalWorkspace(userId)` 契约**：

```sql
-- 1) 用户存在性
SELECT id FROM app_users WHERE id = $1 AND disabled_at IS NULL;

-- 2) 并发安全的 INSERT：partial unique 保证幂等
INSERT INTO workspaces (kind, name, owner_user_id)
VALUES ('personal', 'personal', $1)
ON CONFLICT (owner_user_id) WHERE kind = 'personal' DO NOTHING
RETURNING id;

-- 3) 兜底 SELECT（另一个事务可能赢）
SELECT id FROM workspaces
 WHERE kind = 'personal' AND owner_user_id = $1;

-- 4) 补齐 owner 成员行；行不存在 → INSERT；行存在但 role 不是 owner
--    → DO UPDATE 修正 role（Personal owner 必须为 owner，是 V2.3.6 §5.1
--    不变量）；行存在且 role='owner' → WHERE 子句过滤，零更新。
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ($1, $2, 'owner')
ON CONFLICT (workspace_id, user_id) DO UPDATE
  SET role = 'owner'
  WHERE workspace_members.role <> 'owner';
```

- **不**依赖"成员加入时间最早的一条"推断 Personal；
- **不**用 Shared 命中 personal；
- Personal name 统一为 `'personal'`，不包含密码 / token / 用户敏感信息；
- 返回 `{ userId, workspaceId }`；`workspaceId` **始终**非空；
- 真实错误（断连、约束冲突、用户不存在）**直接向上抛**，不静默吞掉。

**登录顺序（V2.3.6 强约束）**：

```text
verifyPassword() 成功
  → ensurePersonalWorkspace(userId)   // 失败 → 整个 login 失败
  → createSession({ userId, ttlDays })
  → 返回 SafeUser + session
```

`createSession` **不能**先于 `ensurePersonalWorkspace`；否则 Workspace 初始化
失败会留下"有效 Session 但 workspaceId 缺失"的悬空状态。

**`SafeUser`**：

```ts
interface SafeUser {
  id: string;
  username: string;
  workspaceId: string;  // 非空
}
```

`getUserById()` 返回 `PublicUser`（仅 `id, username`），不再伪造 `workspaceId=null`。
需要 workspaceId 的调用方走 `resolveCurrentUser` 或 `ensurePersonalWorkspace`。

**请求级 Workspace 上下文**（V2.3.6 §5.1 强约束）：

- 新增 `resolveAuthenticatedContext(request)`：从 session token 解析身份，
  自动 `ensurePersonalWorkspace`，返回 `{ userId, username, workspaceId }`
  （`workspaceId` **始终**非空）；
- **不**读 `X-Workspace-Id` / `?workspaceId=` / `body.workspaceId` 等客户端
  字段——伪造请求覆盖不到服务端上下文；
- 路由层不另造第二套认证中间件，沿用现有 `requiresAuth: true` + `Request`；
- 真实错误向上抛，**不**降级为 `null`。
- 新增 **`withAuthenticatedWorkspace(handler)`** 高阶包装器：自动调
  `resolveAuthenticatedContext`、自动 401 映射、自动注入 `AuthenticatedContext`。
  **所有 `requiresAuth: true` 的业务路由都必须经过本包装器**——这是 V2.3.6
  §5.1 的强制约束，目的是让 PR-1.2 给业务表加 `workspace_id` 时所有写入路径
  都能拿到可信的非空 `workspaceId`，而不是逐路由手写 401 映射。本阶段
  已在 `/auth/me` 落地，后续 PR-1.2 / PR-1.5 接入所有 `requiresAuth: true`
  路由（conversations、knowledge_bases、documents、messages、tool_executions
  等）时也**必须**走本包装器。

**测试**（`tests/integration/workspace-context.ts`，对接真实 `migrations/*.sql`）：

1. 首次创建 Personal Workspace；
2. 连续调用返回相同 ID；
3. 两个独立连接同时为同一 userId 调用 → 同一 ID + workspaces / workspace_members 各 1 行；
4. Personal Workspace `owner_user_id` 非空；
5. Shared Workspace 写非空 `owner_user_id` 被 CHECK 拒绝；
6. Personal Workspace 写空 `owner_user_id` 被 CHECK 拒绝；
7. 同一 userId 第二个 Personal 被 partial unique 拒绝；
8. 已有 Personal 但 owner 成员行缺失时自动补齐；
9. 已有 Shared 成员关系时不被当作 Personal；
10. 用户不存在抛 `UserNotFoundError`；
11. **真实 `/auth/me` 路由 handler**（`meRoute.handler(fakeContext)`）在带 cookie
    请求上返回非空 `workspaceId`；无 cookie 返回 401。**不**仅是直接调
    `resolveAuthenticatedContext()`；
12. 登录时 `ensurePersonalWorkspace` 抛错 → `createSession` 从未被调用、
    `auth_sessions` 表该 userId 0 行（**不**留悬空 Session）。通过 DI 注入
    失败 ensure + spy createSession 验证；
13. Personal owner 成员行 role 错误（如 'member'）时自动修复为 'owner'
    （**不**用 `ON CONFLICT DO NOTHING` 保留错误角色）；
14. 伪造 `X-Workspace-Id` / `?workspaceId=` / `body.workspaceId` 都被忽略（端到端
    走 `meRoute.handler`，覆盖 P0 篡改防御）；
15. DB 不可达 / 死连接时 `ensurePersonalWorkspace` 抛错（不静默返回 null）；
16. 未登录 → `meRoute.handler` 返回 401（路由层 401）。

测试基建（强制要求）：
- `src/test-utils/migrations.ts` 新增 `runProjectMigrations(client, options?)`：
  跑项目 `init.sql` + `migrations/*.sql` 到隔离 schema；支持 `through` 上界截断，
  避免后续阶段（PR-1.4 / PR-4.x）一旦加新迁移就把当前阶段测试拖崩。**不**
  复用测试里手抄的 schema（避免"测试与生产 schema 漂移"）；
- `src/test-utils/db-isolation.ts` 新增 `assertTestDatabase()`：**强制**
  `RUN_DB_TESTS=1 XUANSHU_TEST_DB=1`，避免误指向共享 / 预发 / 生产库；
  新增 `createIsolatedSchema()` / `dropIsolatedSchema()` 给"并发 / 全局池
  跨事务可见"的场景用；
- `src/infrastructure/database/pool.ts` 新增 `__setTestPool(pool)` /
  `__resetTestPool()`：把全局池换成带 `search_path=schema,public` 的专用
  测试池，避免端到端路由测试在 `public` 默认 schema 写入测试行；
- 集成测试文件**只**用以上测试基建；**不**允许直接 `new Pool(...)` +
  `DATABASE_URL` 后写 `public`。

**门禁**：
- `npm run typecheck` 0 error；
- `npm run lint` 0 error；
- `npm test`（离线）全通过；
- `RUN_DB_TESTS=1 XUANSHU_TEST_DB=1 DATABASE_URL=... npx tsx tests/integration/workspace-context.ts` 39 项全过；
- 不向 `conversations` / `knowledge_bases` / `documents` / `document_chunks` /
  `tool_executions` / `agent_skill_bindings` 加 `workspace_id`（属于 PR-1.2）；
- `git grep "withAuthenticatedWorkspace" backend/src/server/routes` 命中**所有**
  `requiresAuth: true` 路由（PR-1.2 接入时强制）。

### PR-1.2：五张核心表加 `workspace_id`（不实现隔离校验，仅加列）

**Files**
- Create: `backend/database/migrations/0004-tenant-columns.sql`（`conversations` / `knowledge_bases` / `documents` / `tool_executions` / `agent_skill_bindings` 加 `workspace_id UUID NOT NULL REFERENCES workspaces(id)`）
- Modify: 各表写入路径补 `workspace_id`

> 实际未创建此文件——PR-1.2 / PR-1.3 / PR-1.5 已在 `backend/database/init.sql` 单文件中合并落地（见 G-2 / §5.3）。

**注意**：V2.3.6 §5.1 明确本阶段只加列与默认值回填；隔离校验在 PR-1.5 集中做。

**测试**：迁移前后 `column column_name='workspace_id'` 命中六张表（含 `document_chunks`，见 PR-1.3）。

### PR-1.3：`document_chunks.workspace_id`（仅归属列；RAG 推迟到阶段 4）

**范围收窄**（V2.3.6 §8.4.1 / §8.4.2）：

- 本 PR **只**给 `document_chunks` 加 `workspace_id UUID NOT NULL REFERENCES workspaces(id)`；
- **不**创建 `embedding_profiles` / `document_embeddings` 表；
- **不**安装 `vector` 扩展；
- **不**写 HNSW 索引或任何 pgvector 相关结构。

RAG 相关对象（pgvector 扩展、`embedding_profiles`、`document_embeddings`、
HNSW 索引）统一推迟到阶段 4 RAG 模块迁移。RAG Schema 创建顺序明确为：

```text
CREATE EXTENSION vector
→ embedding_profiles
→ document_embeddings
→ 向量索引
```

**Files**
- Create: `backend/database/migrations/0005-chunks-workspace-id.sql`
- Modify: `backend/src/modules/documents/chunks.ts`（写入路径补 `workspace_id`）

> 实际未创建此文件——PR-1.2 / PR-1.3 / PR-1.5 已在 `backend/database/init.sql` 单文件中合并落地（见 G-2 / §5.3）。

**Schema**
```sql
ALTER TABLE document_chunks
  ADD COLUMN workspace_id UUID REFERENCES workspaces(id);
-- 后续 PR-1.5 隔离合约通过后设 NOT NULL
```

**注意**：
- 早期 V2.3.6 草稿里"在 Core 阶段创建带 `vector(...)` 的表" / "不创建
  pgvector 扩展却期望迁移失败" / "把迁移失败当成测试通过" 的设计
  **均已废除**——它们违反 V2.3.6 §8.4.1 Core-only 安装语义。
- Core-only 安装不得引入任何 pgvector 依赖；RAG 是可选增强。

**测试**：
- 迁移后 `\d document_chunks` 命中 `workspace_id` 列；
- Core-only 安装（无 `vector` 扩展）下，迁移成功，无 pgvector 对象创建。

### PR-1.4：Skill 三表迁移 + `skills_installed → skill_packages` 重命名（已落地）

**Files**
- Create: `backend/database/migrations/0006-skill-packages.sql`
- Modify: `backend/src/modules/skills/`（所有引用 `skills_installed` 的地方改为 `skill_packages`）

> 已合并至 `backend/database/init.sql`：`skill_packages` 是全局目录表，`workspace_skills` 控制 Workspace 启用状态，`agent_skill_bindings` 保留 Workspace 内 Agent 绑定与 enabled 状态。

**Schema**
```sql
-- skill_packages 是全局目录表，不加 workspace_id
CREATE TABLE skill_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('builtin','local','market')),
  current_version TEXT NOT NULL,
  manifest JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
```
同时把 `agent_skill_bindings` 中对 `skills_installed` 的 FK 改为 `skill_packages`。

**测试**：迁移双向：旧库跳过 `skills_installed` 不存在 → 失败信息可读；新库反向回滚可去掉拆分。

**门禁**：所有 `grep -r skills_installed backend/src` 无命中。

### PR-1.5：跨 Workspace 隔离合约测试（含 `document_chunks`）

**Files**
- Create: `backend/src/test-utils/isolation-contract.ts`
- Modify: `backend/src/modules/{conversations,knowledge_bases,documents,document_chunks,tool_executions,agent_skill_bindings}/` 全部 SELECT 路径

**测试**：每个模块一份 `isolation.test.ts`，断言：
1. 读：跨 workspace 返回 0 行
2. 写：跨 workspace insert 失败（FK 违规或显式拒绝）
3. 软删除：跨 workspace 不可见
4. 直接外键查询：跨 workspace 返回 404

### 阶段 1 验收（映射 V2 §5.4）

- [x] 所有 6 张归属表都具备 `workspace_id`（**含 `document_chunks`**）
- [x] `skill_packages` 是全局目录表，绑定表归属 workspace
- [ ] 真实 PostgreSQL 隔离合约与 soft delete / partial unique index 回归仍待配置独立测试库后执行

---

## 阶段 2：路由、会话恢复与持久化 Run

**目标**：把「POST 即响应」改成「POST 创建幂等命令 + SSE 订阅事件」；SSE 可在断线后通过 `Last-Event-ID` 续传；`agent_runs` 持久化整个 Agent 生命周期。

> **状态（2026-09-02）**：已验收、已合并。`backend npm run typecheck`、`backend npm run test:unit`、`frontend npm run build` 与 Phase 2 新增合约测试均已通过；真实浏览器 + PostgreSQL 链路也已人工验收，确认逐字流式显示、刷新续接，以及终态“重新生成”按钮出现后聊天视口仍跟随到底部。
>
> 旧 `users`、`pending/succeeded`、`(run_id, seq)`、POST 返回 200 等契约不再使用。

### 实施范围（以 V2 为准）

1. Schema 唯一维护在 `backend/database/init.sql`：补齐 conversations draft/active、`messages.current_run_id`、`agent_runs`、全局 BIGINT identity 的 `agent_run_events` 与 `idempotency_keys`。外键使用 `app_users`；Run 状态为 `queued` / `running` / `waiting_approval` / `completed` / `stopped` / `failed`。
2. 新协议同时提供 `/v1/v2alpha` 和 `/v1`：`POST` 创建幂等命令并返回稳定 JSON；`GET /runs/:runId/events` 负责 SSE 订阅与 `Last-Event-ID` 回放。Mastra 的自定义路由保留 `/api` 给内置能力，若对外需要 `/api/v1`，由反向代理映射到 `/v1`。旧根路径继续保留，并带弃用响应头。
   本地前端的 Vite 代理同时覆盖 `/api/*`（旧接口 rewrite）和 `/v1/*`（V2/SSE 原样转发），否则服务端返回的 `eventsUrl` 会落在 5173 并 404。
3. 发送消息的单事务依次创建 user message、pending assistant message、queued Run、`run-queued` 事件、`current_run_id` 回填与幂等响应缓存；同会话活跃 Run 冲突返回 409。
4. 前端采用 `/chat/new`、`/chat/:conversationId` 的服务端 Draft 与历史恢复；SSE 最后事件 ID 写入 `sessionStorage["mastra:lastEventId:<runId>"]`，重连只 GET 订阅、不重复 POST。
5. Run 执行具备持久化状态、文本 checkpoint、最小 lease/heartbeat/orphan 回收，以及 `X-Request-ID` 与安全结构化日志。

### PR-2.1：阶段 2 Schema 补齐

**Files**
- Modify: `backend/database/init.sql`
  - `conversations`：补 `status draft/active`、`created_by` FK → `app_users(id) ON DELETE SET NULL`。
  - `messages`：补 `current_run_id UUID NULL`（与 `agent_runs.id` 关联；FK 在 `agent_runs` 建表后再加）。
  - 新增 `agent_runs` 表（`lease_owner` / `lease_expires_at` / `heartbeat_at` / `request_id` / `parent_run_id` / `error_code`）；partial unique `(conversation_id) WHERE status IN ('queued','running','waiting_approval')`。
  - 新增 `agent_run_events`：BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY，`type` CHECK 含 10 个事件，`payload JSONB`、`workspace_id`、必要的索引。
  - 新增 `idempotency_keys`：PK `(workspace_id, user_id, key)`，`fingerprint TEXT NOT NULL`、`response_status`、`response_body JSONB`、`expires_at`（24h TTL）。
- 开发阶段 schema 以删库重建后的 `init.sql` 为唯一事实来源；不维护旧库兼容、数据回填或迁移路径，除非用户明确要求。

### PR-2.2：V2 路由 + 共享 Handler

**Files**
- Create: `backend/src/modules/idempotency/repository.ts`
- Create: `backend/src/modules/runs/repository.ts`
- Create: `backend/src/modules/runs/run-events-bus.ts`
- Create: `backend/src/modules/runs/service.ts`
- Create: `backend/src/modules/runs/sse.ts`
- Create: `backend/src/server/routes/v2alpha/{index.ts,shared-handlers.ts}`
- Modify: `backend/src/server/bootstrap.ts`
  - 注册 8 个 V2 路由（v2alpha + v1 × conversations / messages / SSE）；
  - 旧 `/ask`、`/conversations*`、`/messages/*` 走 `withDeprecationHeaders()` 包一层（Deprecation / Sunset / Link）；
  - 进程启动调一次 `startRunExecutor()`（幂等）。

**契约**
- `POST /v1/v2alpha/conversations` — 创建 draft conversation，校验 agentId/knowledgeBaseId 归属；写 idempotency。
- `POST /v1/v2alpha/conversations/:id/messages` — 单事务 7 步（V2 §6.2）；同会话活跃 Run 冲突返回 409。
- `GET /v1/v2alpha/runs/:runId/events` — SSE 订阅 + `Last-Event-ID` 回放；workspace 隔离校验。

### PR-2.3：Run Executor + 前端 SSE 重连 + draft 流

**Files**
- Create: `backend/src/core/execution/run-executor.ts`
- Modify: `frontend/src/lib/conversations.ts`
- Modify: `frontend/src/app/App.tsx`

**后端**
- 每 1s poll 抢占（`FOR UPDATE SKIP LOCKED`），60s lease / 15s heartbeat；
- 文本 checkpoint 节流（每 400ms 或累计 512 字符），且 `completed` / `stopped` 终态事务在需要时补写最终文本 checkpoint，避免实时 UI 落后于落库正文；
- lease 过期由 sweeper（30s）转 `failed` + `LEASE_EXPIRED` + `run-failed` 事件；
- `run-queued` / `run-started` / `run-completed` / `run-stopped` / `run-failed` 在同一事务写入 `agent_runs` 与 `agent_run_events`，确保 SSE 重放完整。

**前端**
- `/chat/new`、`/chat/:conversationId` 路径式 History API（兼容旧 `?conversation=`）；
- 首条消息 → `createDraftConversation` → `replaceState(/chat/<id>)`；再次发问 → `postMessage` 拿到 `runId` + `eventsUrl`；
- 加载会话时若最后一条 assistant message 携带 `currentRunId`，立即 EventSource 重连，lastEventId 优先取 sessionStorage；
- run 终态关闭 EventSource + 清 sessionStorage 缓存。

### PR-2.4：SSE 双通道实时增量升级（PR-2.4）

**Files**
- Modify: `backend/src/core/execution/run-executor.ts`（新增 `liveBuffer` / `liveLastFlushAt` + `flushLiveDelta`；delta 事件累积到 ~30ms / ≤256 字符触发 `publishLiveDelta`；终态路径前补一次 flush）
- Modify: `backend/src/modules/runs/repository.ts`（新增 `LIVE_DELTA_CHANNEL` 常量与 `publishLiveDelta` 帮助函数；payload 受 8KB 限制保护）
- Create: `backend/src/modules/runs/live-delta-bus.ts`（独立 LISTEN client + fan-out hub；与持久化 bus 互不耦合）
- Modify: `backend/src/modules/runs/sse.ts`（subscribe 双 bus；`content-delta` SSE 帧不带 id；持久化事件发送严格串行化 in-flight + lastDeliveredId 守卫；cancel 时释放两个订阅）
- Modify: `frontend/src/lib/conversations.ts`（`V2RunEvent` 增 `content-delta`；监听 `content-delta` 事件；`dispatch` 永不推进 lastEventId 给无 id 帧）
- Modify: `backend/src/core/agent/runtime.ts`、`backend/src/core/execution/stream-text-normalizer.ts`（将 Provider 的累计 `text-delta` 快照归一化为纯增量，禁止 `1 / 12 / 123` 重复累计）
- Modify: `frontend/src/app/App.tsx`、`frontend/src/lib/streaming-renderer.ts`（网络接收缓冲与视觉显示游标分离；每个 `requestAnimationFrame` 只推进一个 Unicode code point；checkpoint 作为权威快照收敛，绝不把累计快照当增量追加）
- Modify: `frontend/src/features/chat/components/AssistantChatWorkspace.tsx`（启用 assistant-ui 原生 ResizeObserver 自动跟随器；流式文本、Markdown 排版和终态操作区改变高度时跟随到底部，用户主动上滑后暂停）
- Modify: `backend/tests/unit/sse-replay.ts`（新增 D1–D4 用例：delta 不带 id、不进持久化、双订阅各自释放、并发回调不重发不回退）

**Schema**：不变（PR-2.4 不动 `init.sql`）。

**API**：不变（同一个 `GET /v1/runs/:runId/events` 端点；增加事件类型 `content-delta`）。

**前端**：双通道协议对外接口已落地；详情见 `architecture-v2.md` §6.4.1。

**协议不变性**
- `content-delta` 不进 `agent_run_events`、不进 `idempotency_keys` 响应；
- 持久化事件帧 id = `agent_run_events.id`（BIGINT IDENTITY），仍可 `Last-Event-ID` 重连；
- SSE 连接取消时持久化 + 实时增量两个订阅都被释放；
- workspace / 用户归属校验路径与 PR-2.3 完全一致；
- 不得引入新生产依赖、不得改 SQL、不得做旧库兼容。

**验收**：详见 `architecture-v2.md` §6.4.2；与 PR-2.3 阶段 2 验收并列。

### 阶段 2 验收（映射 V2 §6.6）

- [x] 同一 `Idempotency-Key` 重 POST 不会产生多个 run（合约：`tests/unit/idempotency-concurrency.ts`）
- [x] SSE 中断后续传不丢、不重（合约：`tests/unit/sse-replay.ts`，覆盖 R1-R5、R7）
- [x] `agent_runs` 与 `agent_run_events` 完成生命周期持久化，且 sweeper 同事务（合约：`tests/unit/sweeper-transactional.ts`，覆盖 S1-S4）
- [x] `/chat/new` 服务端创建 draft，`/chat/:conversationId` 可恢复历史与进行中的 Run
- [x] 旧根路径兼容且带弃用响应头；新前端走 `/v1/v2alpha`
- [x] 后端 `npm run typecheck`、前端 `npm run build` 与上述合约测试全部通过

---

## 阶段 3：Tool Policy 与审批

**状态（2026-09-04）**：阶段 3.0（Durable Agent Runtime）已落地（`@mastra/pg` PostgresStore 接到 `mastra_runtime` schema，`streamOptions.runId / memory.thread / memory.resource` 透传）；阶段 3.1（Tool Policy / Approval Schema 与 Repository）已落地；**阶段 3.2（Tool Policy Evaluator 与策略感知 Tool Resolver）已落地**：`modules/tool-policy/evaluator.ts` 提供三态决策（`allowed` / `requires-approval` / `forbidden`）；`modules/tool-policy/resolver.ts` 把 activeTools 过滤从"按 `toolMap.has(id)` 存在性"升级为"按 workspace 策略逐 Tool 决策、仅 allowed 入列"；`runtime.ts` 接入新解析器并暴露 `_setPolicyResolverForTesting` 钩子。**阶段 3.3（Tool Approval Closed-Loop，含 Replay Fix）已落地**：Tool Gateway 接入 `workspaceId` + `requireToolApproval`；`requires-approval` Tool 现在走 Mastra 审批流程（不再 fail-closed）；`/v1/approvals` REST API（list / detail / resolve approve|decline）；Mastra `approveToolCall` / `declineToolCall` 接入 + `resumeStream` 闭环；**职责严格分层**：`/v1/approvals` HTTP 层 / `state-machine.resolveApproval` / `expireApproval` / `reconcileInflightApprovals` / `timeout-worker` **全部 DB-only**，**不**调 Mastra SDK、**不**消费 stream；`runResumeSchedulerOnce` + `runReconcileIndeterminateOnce`（`run-executor.ts`）是**唯一** SDK 调用与 stream 消费方；超时 worker 仅做 DB-only `expired` 决策登记，由 scheduler 调 `declineToolCall(reason='expired')` 收尾 Run；跨重启 reconciliation 启动一次扫描 + 每 tick 周期扫描，对 inflight Run 调用 `listSuspendedRuns` 严格校验 `runId`/`toolCallId`/`workspaceId`/`threadId`/`resourceId`/`agentId`；W2 approve SDK 失败 → `approved_resume_indeterminate` + `resume_attempts ≤ 3` + reconciler 校验通过后 revert 或 fail-closed Run → failed；前端 `useApprovals` hook + `ApprovalCard` 组件 + SSE `approval-requested` / `approval-resolved` 事件显示在 composer 之上。

阶段 3.0 仅作为前置条件——storage、Tool 公共注册和 ID 参数透传已实现：把 `@mastra/pg` 的 `PostgresStore` 接到了独立 schema `mastra_runtime`，并把全部 Agent 经公开 `new Mastra({ agents })` 注册路径绑定同一 storage；`streamOptions.runId / memory.thread / memory.resource` 已在 stream 调用中真实透传。**跨重启恢复审批 Run 未完成真实 PostgreSQL 端到端验证**。阶段 3.0 **不**实现审批表、审批 API、审批 UI，也不新增演示性高风险 Tool。

阶段 3.1 仅落出 Schema（`tool_policy_rules` / `tool_approval_requests`）与最小 Repository 层（`modules/tool-policy/`）；**不**实现策略评估器、Tool Gateway 接入、审批 API、审批 UI、超时 worker，也不接入运行时——本阶段提交的 PR **不**完成 V2 §7 决策里的"接入 Mastra requireToolApproval + approveToolCall / declineToolCall / resumeStream"路径；阶段 3 总体验收仍未勾选。

### PR-3.0（进行中）—— Durable Agent Runtime 前置

**Files**
- Create: `backend/src/infrastructure/mastra/storage.ts`
- Create: `backend/src/infrastructure/mastra/instance.ts`（薄工厂，承载 `Mastra({...})` 装配）
- Modify: `backend/src/mastra/index.ts`（薄包装，委托 `instance.ts` 工厂）
- Modify: `backend/src/core/agent/runtime.ts`（`streamAgent` 内通过 `getMastraInstance()` 取实例；新增 `_setMastraInstanceForTesting` 测试钩子）
- Modify: `backend/src/core/agent/registry.ts`（`resolvePerRequestAgent` + 测试钩子 `_setPerRequestFactoryOverrideForTesting` / `_clearAgentRegistryForTesting`）
- Modify: `backend/src/core/tool/registry.ts`（`buildGlobalToolMap()`）
- Modify: `backend/src/core/execution/run-executor.ts`（把 `r.id / r.conversation_id / r.workspace_id` 透传到 `streamAgent`）
- Modify: `backend/src/core/skill/discovery.ts`（Skill 名非法时一次性警告 + 跳过）
- Modify: `backend/src/agents/general-chat/agent.ts`、`backend/src/agents/knowledge-base/agent.ts`、`backend/src/agents/_template/agent.ts`（透传 `mastra` 到 `new Agent({..., mastra})`；不再 inline 持有 tools）
- Create: `backend/tests/unit/mastra-storage-config.ts`
- Create: `backend/tests/unit/mastra-bootstrap.ts`
- Create: `backend/tests/unit/stream-agent-identity-mapping.ts`
- Create: `backend/tests/unit/dynamic-tool-resolution.ts`

**架构**
- `infrastructure/mastra/storage.ts` 提供 `createMastraStorage()`，使用 `new PostgresStore({ id: 'mastra-runtime-storage', schemaName: 'mastra_runtime', connectionString })`；Mastra 框架内部表 DDL 由 `@mastra/pg` 官方机制落到独立 schema，与业务 `init.sql` 完全隔离。
- `mastra/index.ts` 与 `infrastructure/mastra/instance.ts` 协作：`createMastraInstance({ storage, agents, tools, withServer, server })` 装配 `new Mastra({...})`；生产路径默认注入 `buildGlobalToolMap()`。`mastra.getStorage()` 返回注入的 PostgresStore；`mastra.getAgent(id)` 命中；`mastra.listTools()` 列出全局 Tool。
- 静态 Agent 构造期（`mastra/index.ts` → `createMastraInstance`）：`definition.factory` 的第三个参数 `mastraInstance` **当前是 `undefined`**——同一进程内的 `mastra` 单例虽存在，但本路径下未被传给 factory。这些静态 Agent 通过 v1 公开 `new Mastra({ agents })` 路径接入同一 storage，**不**依赖 per-request `mastraInstance`。
- per-request Agent（`streamAgent` 内通过 `definition.factory(tools, skills, mastra)` 调用）：`mastraInstance` 由 `runtime.getMastraInstance()` 解析——生产路径走 lazy `await import('mastra/index.js')`；单元测试通过 `_setMastraInstanceForTesting(fake)` 注入 fake，**不**触发 `server/bootstrap.ts` 的副作用（`startRunExecutor()` / `preloadSkillRegistry()` / PG LISTEN 句柄 / Skill 文件系统扫描）。
- 业务 ↔ Mastra 标识映射：`streamAgent` 入参的 `runId / threadId / resourceId` 在 streamOptions 上透传给 v1 公开字段 `runId`（`AgentExecutionOptionsBase.runId`）与 `memory: { thread, resource }`（`AgentMemoryOption`）；参数全缺时跳过对应字段。
- 测试钩子：`_setStaticAgentBuilderForTesting`、`_setStorageFactoryForTesting`、`_resetMastraStorageForTesting`、`_setMastraInstanceForTesting`、`_resetMastraInstanceCacheForTesting`、`_setPerRequestFactoryOverrideForTesting`、`_clearAgentRegistryForTesting`。仅测试可用，生产路径不调。

**约束**
- 不复制、手写、迁移 `@mastra/pg` 内部表 DDL；schema 隔离完全交给官方 `schemaName`。
- 不调用 `__registerMastra` 等 internal API。
- 不引入内存 Map / 前端伪恢复兼容补丁。
- 不升级依赖；不改与本阶段无关模块。
- 单元测试 fixture 必须保持单一进程自然退出（exit 0）；不允许 `process.exit()` 掩盖句柄泄漏。

**阶段 3.0 验收**
- [ ] 后端启动不再出现 "No storage configured on Mastra" 警告——Mastra 装配层已通过 `createMastraStorage()` 把 PostgresStore 注入；缺 `DATABASE_URL` 时**显式抛错**，绝不静默降级到内存替代。
- [ ] `mastra.getStorage()` 返回 `mastra_runtime` schema 上的 PostgresStore（unit 替身注入验证）。
- [ ] 静态 Agent 经 v1 公开 `new Mastra({ agents })` 路径注册；per-request Agent 通过 `streamOptions.runId / memory.thread / memory.resource` 携带业务 ↔ Mastra 标识；**不**调用 `__registerMastra`。
- [ ] `backend npm run typecheck` + `backend npm run test:unit` 通过；`mastra-storage-config.ts` / `mastra-bootstrap.ts` / `stream-agent-identity-mapping.ts` / `dynamic-tool-resolution.ts` 全部合约用例通过。
- [ ] 不启动服务、不连真实 DB；缺 DB 时仅声明未验证项。

**未验证项**（必须保留为「未验证」直至端到端跑通）
- 真实 PostgreSQL 上 `mastra_runtime` schema 的内部 DDL 形态（由 `@mastra/pg` 决定，未启动服务观察）。
- 跨重启恢复：参数已透传不等于"跨重启恢复已实现"；本阶段**未**实际触发"重启 → 列出 suspended runs → 续 Run"流程；属于阶段 3.1+ 验收范围。
- `agent_runs.id / conversations.id / workspaces.id` 与 Mastra snapshot 的同源校验未在真实 PG 上验证。

### PR-3.1（已落地 schema/repository，未接入运行时）—— `tool_policy_rules` / `tool_approval_requests`

**Files**
- Modify: `backend/database/init.sql`（**不**新开 migration 文件；G-2 约束）
- Create: `backend/src/modules/tool-policy/types.ts`
- Create: `backend/src/modules/tool-policy/repository.ts`
- Create: `backend/tests/unit/tool-policy-schema.ts`
- Create: `backend/tests/unit/tool-policy-repository.ts`

**Schema**（与 `backend/database/init.sql` 阶段 3.1 段完全一致；旧草案中的 `tool_call_id UUID`、`requested_payload`、`users(id)`、`'rejected'` 等已废弃字段均不留存）

```sql
CREATE TABLE tool_policy_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_id      TEXT NOT NULL,
  effect       TEXT NOT NULL
                 CHECK (effect IN ('allow', 'deny', 'require_approval')),
  conditions   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by   UUID NOT NULL REFERENCES app_users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tool_policy_rules_workspace_tool_unique UNIQUE (workspace_id, tool_id)
);
CREATE INDEX tool_policy_rules_workspace_idx ON tool_policy_rules(workspace_id);

CREATE TABLE tool_approval_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id         UUID NOT NULL,                          -- 复合 FK 在表底约束中
  tool_id        TEXT NOT NULL,
  tool_call_id   TEXT NOT NULL,                          -- TEXT 而非 UUID（V2 §7）；与 run_id 共同构成审批恢复键
  inputs_hash    TEXT NOT NULL,
  inputs_summary JSONB NOT NULL,                         -- 已脱敏 JSON，调用方负责脱敏
  status         TEXT NOT NULL
                   CHECK (status IN ('pending', 'approved', 'declined', 'expired')),
  requester_id   UUID NOT NULL REFERENCES app_users(id),
  resolver_id    UUID REFERENCES app_users(id),          -- 可空
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,                            -- 可空
  -- 跨 Workspace 完整性：审批请求与所属 Run 在 DB 层强制同 Workspace。
  -- 引用 agent_runs 上的 UNIQUE(id, workspace_id)（见阶段 2 段
  -- agent_runs_id_workspace_unique）；旧的单列 run_id → agent_runs(id)
  -- 外键不再保留，避免两套相互独立的 Run 外键。
  CONSTRAINT tool_approval_requests_run_workspace_fk
    FOREIGN KEY (run_id, workspace_id)
    REFERENCES agent_runs(id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT tool_approval_requests_run_tool_call_unique UNIQUE (run_id, tool_call_id)
  -- 注意：Mastra 1.61 公开 API 的 agent.approveToolCall / agent.declineToolCall
  -- 只接收 runId、可选 toolCallId、reason，**没有**独立可持久化的
  -- suspension token；本表**不**存 suspension_id 列与
  -- UNIQUE(suspension_id) 约束，审批恢复键仅为 (run_id, tool_call_id)。
);
CREATE INDEX tool_approval_requests_workspace_pending_idx
  ON tool_approval_requests(workspace_id, status) WHERE status = 'pending';
CREATE INDEX tool_approval_requests_run_idx
  ON tool_approval_requests(run_id);
CREATE INDEX tool_approval_requests_expires_pending_idx
  ON tool_approval_requests(expires_at) WHERE status = 'pending';
```

**约束**（V2.1 决策；本 PR 严格遵守）
- **不**对 `agent_runs` 新增 `approval_request_id` 列；审批关系单向 `(run_id, workspace_id) → agent_runs(id, workspace_id)` 复合外键（一个 Run 可有多条请求）。
- `tool_call_id` 为 **TEXT**（与 Mastra SDK 的 `toolCallId` 一致），**不**使用 UUID。
- status 枚举为 `pending / approved / declined / expired`，**不**使用 `rejected`（V2 §7 一致）。
- `requester_id` 必填；`resolver_id` 可空（pending 行不存在）。
- `inputs_summary` 强制 NOT NULL，**无**默认值——调用方必须传入"已脱敏"的 JSON；Repository 不写入原始敏感输入。
- **跨 Workspace 完整性（PR-3.1 完整性修复）**：
  - `agent_runs` 持有 `UNIQUE(id, workspace_id)`（约束名 `agent_runs_id_workspace_unique`），与 PK(`id`) 共存，独立索引；
  - `tool_approval_requests` 走复合外键 `FOREIGN KEY (run_id, workspace_id) REFERENCES agent_runs(id, workspace_id) ON DELETE CASCADE`（约束名 `tool_approval_requests_run_workspace_fk`）；
  - 旧的"单列 `run_id` → `agent_runs(id)`"外键不再保留——两套相互独立的 Run FK 已被复合 FK 完全替代；
  - 任何跨 Workspace 写入（INSERT）会被 PG 23503 (foreign_key_violation) 拒绝；Repository 层无需额外前置校验，但**仍**保留所有读取的 `workspace_id` 过滤作为防御性兜底。

**Repository**（`backend/src/modules/tool-policy/repository.ts`）
- 所有 SQL 走参数化（$N），不拼接字符串；全部读取强制 `workspace_id` 过滤。
- `createApprovalRequest(input, executor)`：INSERT；唯一性约束由 DB 兜底（UNIQUE 触发时由后续 PR 决定是返回已存在 row 还是拒绝重试）。
- `getApprovalRequestById(workspaceId, approvalId, executor)`：跨 workspace 一律返回 null（**不**抛错；上游 HTTP 统一映射为 404，避免越权嗅探）。
- `listPendingApprovalRequests(workspaceId, executor)`：仅取 status='pending' 的行；按 `created_at ASC` 排序。
- `resolveApprovalRequest(client, input)`：**原子** UPDATE 带
  `WHERE id=$1 AND workspace_id=$2 AND status='pending'`；1 行 → `resolved`；0 行 → 在同事务内再读一次（仍带 `workspace_id` 过滤）区分 `not_found` / `already_resolved`。**不**切换 `agent_runs.status`、**不**写 SSE、**不**调 Mastra SDK；这些都是 PR-3.3 范围。
- `upsertPolicyRule(input, executor)` / `getPolicyRule(workspaceId, toolId, executor)`：最小基础规则读写；不参与 evaluator 决策。

**验收（本 PR 自身；不勾阶段 3 总体验收）**
- [x] `backend/database/init.sql` 阶段 3.1 段落地，两张表 + 索引 + UNIQUE + CHECK 全部对齐 V2 §7；`backend npm run typecheck` 通过；新增 `tool-policy-schema.ts` / `tool-policy-repository.ts` 两个 fixture 通过。
- [x] 跨 Workspace 完整性修复：`agent_runs` 持有 `UNIQUE(id, workspace_id)`；`tool_approval_requests` 走复合外键 `(run_id, workspace_id) → agent_runs(id, workspace_id)`；旧的单列 FK 已彻底删除；`tool-policy-schema.ts` 8 项新断言（含反向断言）全部通过。
- [ ] **PR-3.1 完成时的历史验收快照**：PR-3.3 / 阶段 3 总体验收在 PR-3.1 完成时仍未开始；阶段 3 总勾选框（Tool 网关、跨 workspace 404、超时、跨重启 Run 恢复）维持空。**这些后续已被 PR-3.3 全部覆盖**：Tool 网关、跨 workspace 404、超时（DB-only + scheduler 收尾）、跨重启 Run 恢复（`runReconcileIndeterminateOnce` + W2 reconciliation）均已落地并通过真实 PostgreSQL 集成测试 107 passed, 0 failed；当前真实状态见下方 Phase 3.3 阶段 3 验收勾选框。

**PR-3.1 完成时的历史未验证项（已由后续 PR 覆盖，仅供历史追溯）**
- Repository 与真实 PostgreSQL 的 SQL 行为（`tools/unit` 仅做 fake-client 合约断言）—— PR-3.3 起 `tests/integration/tool-policy-pg.ts` 在真实 PostgreSQL 上覆盖 repository 全部路径。
- `tool_approval_requests` partial / expires 索引在真实 PG 上的查询计划 —— PR-3.3 起 PG 集成测试在 init.sql 后运行该索引。
- 策略评估器与 Tool Gateway 接入（PR-3.2） —— **已由 PR-3.2 落地**，见下方 PR-3.2 节。
- 审批 API / 审批 UI / SSE `approval-requested` / `approval-resolved` 路径（PR-3.3） —— **已由 PR-3.3 落地**（`/v1/approvals` HTTP API + `ApprovalCard` + `useApprovals` + SSE 事件订阅）；当前唯一未验证的是真实浏览器 + 真实后端 + 真实 SSE 的端到端联调。
- 超时 worker（`tool_approval_requests.expires_at < now()` → `stopped + APPROVAL_EXPIRED`） —— **已被 PR-3.3 替代**：timeout worker 现仅 DB-only 写 `status='expired'` + `resolver_id=system-approval-worker`（`00000000-0000-0000-0000-0000000000a1`），由 `runResumeSchedulerOnce`（`run-executor.ts`）下次 tick 调 `declineToolCall(reason='expired')` 并经 `consumeAgentStream` 真实消费 resume stream 收尾 Run；**不再**经过 `stopped + APPROVAL_EXPIRED` 路径。
- 跨重启 Run 恢复（Mastra `listSuspendedRuns` + `approveToolCall` / `declineToolCall` / `resumeStream`） —— **PR-3.3 已接入对应 SDK 调用路径**（`runReconcileIndeterminateOnce` + W2 reconciliation + `consumeAgentStream` 公共消费）；本机真实 Mastra Core 1.61.0 + DeepSeek 的 approve / decline / timeout 三条 HTTP/SSE 基础路径及 pending 后重启再 approve 已有验证记录，**完整容灾与多实例真实 SDK e2e 尚未验证**。

### PR-3.2（已落地策略评估与可用工具过滤；审批运行时仍未接入）—— Tool Policy Evaluator + Policy-aware Tool Resolver

**Files**
- Create: `backend/src/modules/tool-policy/evaluator.ts`（单 Tool 三态决策）
- Create: `backend/src/modules/tool-policy/resolver.ts`（多 Tool 过滤；`createDefaultResolverContext()` 装配 Tool 注册表 + tool_policy_rules repository）
- Modify: `backend/src/core/agent/runtime.ts`（activeTools 计算从 `resolveToolIds(...,undefined)` 升级为 `resolveAllowedToolIdsForRuntime(...)`；新增 `_setPolicyResolverForTesting` 测试钩子；**不**向 `agent.stream()` 传入 `requireToolApproval`）
- Create: `backend/tests/unit/tool-policy-evaluator.ts`
- Create: `backend/tests/unit/tool-policy-resolver.ts`
- Create: `backend/tests/unit/tool-policy-runtime-filtering.ts`
- Modify: `backend/tests/unit/dynamic-tool-resolution.ts`（注入 stub resolver 维持 calculator / get-current-time 既有 C2 合约）

**架构**
- `evaluator(ctx, { workspaceId, toolId })` 返回三态决策：
   - `forbidden`：Tool 未在服务端注册表 / `requiresRuntime=true` / `openWorld` 缺策略或显式 deny / `deny` 覆盖低风险；
   - `requires-approval`：`destructive=true` 永远走此态（即便 DB 显式 allow 也不降级）；`openWorld` + `require_approval` / 低风险 + `require_approval`；
   - `allowed`：`destructive=false && openWorld=false && requiresRuntime=false` 的 Tool 在显式 allow 或无策略时（仅本地只读走 fail-open）。
- 信任模型：仅服务端 ToolDefinition 元数据与 DB `tool_policy_rules`；**不**信任 Tool execute 入口或 Mastra 工具调用中任何"自报字段"（架构-v2 §0 明确 metadata 仅 UI 提示）。
- `resolver(workspaceId, toolIds, ctx)` 仅返回 `allowed` 子集；输入顺序保留，便于 SSE / 审计对账。
- `runtime.ts` 通过 `resolveAllowedToolIdsForRuntime` 调用 resolver（默认走真实 `createDefaultResolverContext()`，测试可通过 `_setPolicyResolverForTesting` 注入 stub）；本阶段**不**把 `requireToolApproval` 传入 `agent.stream()`——避免产生无 API 可处理的挂起 Run。
- **不**修改 `backend/src/core/runtime/tool-executor.ts`（该文件不存在；本 PR 不创建脱离真实链路的平行执行器，per-request Agent 的 inline tools 仍走现有 `resolveTools(activeToolIds)` 路径兼容上层调用方）。
- **不**修改 calculator / get-current-time / _template 的现有 ToolDefinition；不新增演示性高风险 Tool。

**验收（本 PR 自身；不勾阶段 3 总体验收）**
- [x] `evaluator.ts` 实现 7 类决策（未注册 / requiresRuntime / destructive / openWorld×3 / deny / 低风险×3）；`tool-policy-evaluator.ts` 覆盖全部 7 类。
- [x] `resolver.ts` 仅 `allowed` 入列，保留输入顺序；`tool-policy-resolver.ts` 覆盖允许 / 拒绝 / 未注册 / 空输入 / 显式策略四类。
- [x] `runtime.ts` 接入 resolver；`tool-policy-runtime-filtering.ts` 验证 forbidden / requires-approval Tool 不进 activeTools、allowed Tool 进；capabilities.tools=false 路径 activeTools 字段不出现。
- [x] `backend npm run typecheck` + `npm run test:unit` 通过；现有 dynamic-tool-resolution / stream-agent-identity-mapping / sweeper-transactional 等 fixture 维持原合约。
- [ ] **PR-3.2 完成时的历史验收快照**：PR-3.3（审批 UI + 续 Run + Mastra `requireToolApproval` 接入）/ 阶段 3 总体验收在 PR-3.2 完成时仍未开始；总勾选框（Tool 网关、跨 workspace 404、超时、跨重启 Run 恢复）维持空。**这些后续已被 PR-3.3 全部覆盖**：Tool 网关（`tool-approval-gateway.ts` + `requireToolApproval` 包装层）、跨 workspace 404、超时（DB-only + scheduler `declineToolCall(reason='expired')` + `consumeAgentStream` 收尾）、跨重启 Run 恢复（`runReconcileIndeterminateOnce` + W2 reconciliation）均已落地并通过真实 PostgreSQL 集成测试 107 passed, 0 failed；当前真实状态见下方 Phase 3.3 阶段 3 验收勾选框。

**PR-3.2 完成时的历史未验证项（已由后续 PR 覆盖，仅供历史追溯）**
- `tool_policy_rules` 在真实 PG 上的查询计划（unit 仅做 fake-context 合约断言） —— PR-3.3 起 `tests/integration/tool-policy-pg.ts` 在真实 PostgreSQL 上覆盖 resolver / evaluator 路径。
- `evaluator` 与真实 repository 的端到端 SQL 行为（`require_approval` Tool 在 PR-3.3 接入 Mastra `requireToolApproval` 后才能实测） —— **已由 PR-3.3 实测**：`runtime.ts` 经 Tool Gateway 包装层注入 `requireToolApproval` + 真实 PG 集成测试覆盖 `requires-approval` Tool 入列与 SDK 挂起路径。
- Tool Gateway 完整接入（PR-3.2 范围之外的"具体 Tool execute 前再校验策略"路径） —— **已由 PR-3.3 落地**：`core/agent/tool-approval-gateway.ts` + `requireToolApproval` 包装层在 Tool execute 前完成策略二次校验与审批 row 写入。
- 审批 API / 审批 UI / SSE `approval-requested` / `approval-resolved` 路径（PR-3.3） —— **已由 PR-3.3 落地**（`/v1/approvals` HTTP API + `ApprovalCard` + `useApprovals` + SSE 事件订阅）；当前唯一未验证的是真实浏览器 + 真实后端 + 真实 SSE 的端到端联调（属 PR-3.3 staging e2e 而非功能未实现）。
- 超时 worker（`tool_approval_requests.expires_at < now()` → `stopped + APPROVAL_EXPIRED`） —— **已被 PR-3.3 替代**：timeout worker 现仅 DB-only 写 `status='expired'` + `resolver_id=system-approval-worker`（`00000000-0000-0000-0000-0000000000a1`），由 `runResumeSchedulerOnce`（`run-executor.ts`）下次 tick 调 `declineToolCall(reason='expired')` 并经 `consumeAgentStream` 真实消费 resume stream 收尾 Run；**不再**经过 `stopped + APPROVAL_EXPIRED` 路径。
- 跨重启 Run 恢复（Mastra `listSuspendedRuns` + `approveToolCall` / `declineToolCall` / `resumeStream`） —— **PR-3.3 已接入对应 SDK 调用路径**（`runReconcileIndeterminateOnce` + W2 reconciliation + `consumeAgentStream` 公共消费）；本机真实 Mastra Core 1.61.0 + DeepSeek 的 approve / decline / timeout 三条 HTTP/SSE 基础路径及 pending 后重启再 approve 已有验证记录，**完整容灾与多实例真实 SDK e2e 尚未验证**。

### PR-3.3（已落地）—— 审批 UI + 续 Run + Mastra 审批运行时接入

**Files**
- Create: `backend/src/modules/tool-policy/mastra-facade.ts`（production path 的 Mastra 客户端懒加载 + 工作区注入）
- Create: `backend/src/modules/tool-policy/timeout-worker.ts`（15 秒周期 + 启动一次 reconcile；**DB-only**，不调 SDK）
- Create: `backend/src/server/routes/approvals.ts`（`/v1/approvals` + `/v1/approvals/:id` + `/v1/approvals/:id/resolve`；**HTTP 层不调 SDK**）
- Modify: `backend/src/modules/tool-policy/state-machine.ts`（`expireApproval` / `reconcileInflightApprovals` + DB-only 决策登记；**state-machine 不调 SDK、不消费 stream**）
- Modify: `backend/src/modules/tool-policy/repository.ts`（`getAgentIdByRun` + workspace 隔离 + `listApprovalsPendingReconcile` 含 `resolver_error` 人工介入过滤）
- Modify: `backend/src/core/agent/runtime.ts`（Tool Gateway 注入 `workspaceId` + `requireToolApproval` + `consumeAgentStream` 公共消费）
- Modify: `backend/src/core/execution/run-executor.ts`（`runResumeSchedulerOnce` + `runReconcileIndeterminateOnce`；**唯一 SDK 调用方 + 唯一 stream 消费方**；W2 exhausted 分支同事务写 approval + Run + messages + run-failed 事件）
- Modify: `backend/src/server/bootstrap.ts`（注册 approval routes + 安装 production facade + 启动 timeout worker）
- Create: `frontend/src/types/approval.ts` + `frontend/src/features/chat/useApprovals.ts` + `frontend/src/features/chat/components/ApprovalCard.tsx`
- Modify: `frontend/src/lib/api.ts`（`listApprovals` / `getApproval` / `resolveApproval`）
- Modify: `frontend/src/features/chat/components/AssistantChatWorkspace.tsx`（composer 之上渲染 `ApprovalCard`）
- Modify: `frontend/src/app/App.tsx`（`useApprovals` 与现有 run-stream SSE 共线）

**核心闭环（职责严格分层）**：
- `requireToolApproval` 经 Tool Gateway 注入 `agent.stream()`：只有 policy 决策为 `requires-approval` 的 Tool 调用会触发 Mastra 挂起；其它走原有路径。
- 高风险 Tool execute 前：Mastra 调用 Tool Gateway 包装层 → 写 `tool_approval_requests(status='pending')` + `agent_run_events(type='approval-requested')` + Mastra SDK 通知前端 SSE → 返回挂起。
- 用户在 `/v1/approvals/:id/resolve` POST approve|decline → HTTP handler **只**做 auth / workspace / decision 校验 + 调 `state-machine.resolveApproval`；`resolveApproval` 仅写 DB（`status='approved'` / `'declined'` + `resolver_id` + `resolved_at`），**不**调 Mastra SDK、**不**消费 stream。
- Run Executor scheduler `runResumeSchedulerOnce` 通过 `listApprovalsPendingResume`（扫描 `('approved'|'declined'|'expired') AND mastra_resume_started_at IS NULL`）抢占 → 原子事务推 Run → 'running' + INSERT `run-resumed` 事件 + 写 `mastra_resume_started_at` → 调 `facade.approveToolCall` / `declineToolCall` 拿 `AsyncIterable<unknown>` → `consumeAgentStream` 真实消费 resume stream（首次 Run 与 resume 共享同一消费路径）→ 推 Run 终态 + 写 message checkpoint + SSE 事件。
- 超时：timeout worker 每 15 秒扫 `expires_at < now()` 的 pending 行 → `state-machine.expireApproval` **DB-only** 写 `status='expired'` + `resolver_id=system-approval-worker`（**不**调 SDK、不消费 stream）；scheduler 在下个 tick 通过 `listApprovalsPendingResume` 拾起 `status='expired'` 行 → 调 `declineToolCall(reason='expired')` 收尾 Run。
- 跨重启 + 周期 reconcile：`runReconcileIndeterminateOnce` 扫 `('approved_resume_indeterminate') AND lease_expires_at < now() AND resume_attempts < MAX AND resolver_error NOT LIKE 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_%'`；调 `facade.listSuspendedRuns` fail-closed 校验 `runId`/`toolCallId`/`workspaceId`/`threadId`/`resourceId`/`agentId`；校验通过 → DB-only `revertApprovalForReconcile`（`status='approved'` + 清 `mastra_resume_started_at`），scheduler 自然接管；校验失败 / attempts 耗尽 → fail-closed 写人工介入错误 + Run → failed。
- 不变性：`tool_approval_requests` 仅存脱敏摘要 + SHA-256 hash；恢复键 `(run_id, tool_call_id)`（无 `suspension_id` 字段）；DB 与 Mastra Storage 不在同事务，依赖 saga + lease 单飞 + timeout/reconcile 收敛。
- API：`GET /v1/approvals`（workspace 内全部）、`GET /v1/approvals/:id`（workspace + UUID 校验）、`POST /v1/approvals/:id/resolve`（approve|decline → 409 区分 `APPROVAL_ALREADY_RESOLVED` / `APPROVAL_INFLIGHT`）。
- 前端：`useApprovals` hook 拉列表 + 订阅 SSE `approval-requested` / `approval-resolved`；`ApprovalCard` 渲染 tool 名 / 状态徽标 / 脱敏摘要 / 倒计时 / Approve+Decline 按钮；`AssistantChatWorkspace` 在 composer 之上挂 `pendingApprovals` 列表。

**测试**（**真实 PostgreSQL + FakeAgentFacade / fake stream（涉及 Mastra resume SDK/stream 边界的 PG 集成测试）** —— **完整容灾与多实例真实 SDK e2e 尚未验证**）：
- `backend/tests/unit/tool-policy-schema.ts` + `tool-policy-repository.ts`（schema / FK / UNIQUE / partial 索引 / workspace 隔离 / 原子 resolve；既有）
- `backend/tests/unit/tool-policy-evaluator.ts` + `tool-policy-resolver.ts`（策略三态决策 + activeTools 过滤；既有）
- `backend/tests/unit/dynamic-tool-resolution.ts`（run-time workspaceId 注入；既有）
- `backend/tests/unit/tool-policy-runtime-filtering.ts`（gateway 注入 + Mastra SDK 路径；既有）
- `backend/tests/unit/approvals-route.ts`（路由 UUID 校验 + `rowToView` 映射 + 输入校验 + 当前 `resolveApproval` union 收窄；既有）
- `backend/tests/unit/tool-policy-timeout.ts`（`expireApproval` + `reconcileInflightApprovals` + 当前 DB-only outcome；既有）
- `backend/tests/unit/tool-policy-state-machine.ts`（DB-only `resolveApproval` / `expireApproval` + lease / 终态语义；既有）
- `backend/tests/integration/tool-policy-pg.ts`（**PR-3.3 Replay Fix W2 + Replay Fix attempts-exhausted** —— 真实 PG + FakeAgentFacade / fake stream：(a) waiting_approval 保留 / (b) approve resume stream 消费 → Run → completed / (c) decline / (c-2) expire system-approval-worker / (d) **W2 approve SDK 失败 → approval → `approved_resume_indeterminate` + Run → `waiting_approval` + reconciler 校验通过 revert 让 scheduler 重新接管** / (e) scheduler 原子事务单飞（Run 已不 `waiting_approval` 时跳过） / (f) `listSuspendedRuns` fail-closed（缺 workspaceId/agentId/threadId/resourceId 抛错） / (g) 跨重启 / (h) **3 次 W2 失败 → attempts 耗尽 → `APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED` + Run → failed + 后续多次 tick 不再调 SDK / `listSuspendedRuns`** / (x) `created_by` NULL → 拒绝；**107 passed, 0 failed**）。
- `backend/tests/integration/approval-reconcile-safety.ts`（**PR-3.3.2 reconcile safety —— 已 Codex 实跑通过** —— 真实 PG + FakeAgentFacade）：lease fencing（worker-A claim 后 worker-B 因 `lease_contended` 被拒）/ reconciler backoff（lease 未到期时不被扫到）/ **未注册或非幂等 Tool（`metadata.idempotent !== true`）进入人工介入、不调 SDK、不查 `listSuspendedRuns`** / 原子回滚（`messages` 触发器注入失败 → approval 人工介入标记 + Run → waiting_approval 全量回滚）/ 终态手工介入行永久退出 reconciler 扫描集。
- `backend/tests/integration/executor-terminal-lease-fence.ts`（**PR-3.3.2 terminal lease fence —— 已 Codex 实跑通过** —— 真实 PG + 真实 `runResumeSchedulerOnce` + 注入 deferred `AsyncIterable` 的 FakeAgentFacade）：覆盖 `done` / `stopped` / `error` 三场景独立 seed，每个场景在 stream 落地前手动 UPDATE `lease_owner` 为外部 owner，验证 `completeRun / stopRun / failRun` 的 `lease_owner = WORKER_ID` fence 阻断对应终态写入——`agent_runs.status` NOT in 终态、`messages.status` NOT in 终态、`agent_run_events` 无对应 `run-completed / run-stopped / run-failed`、`approveToolCall` 仍只调用 1 次；三场景均断言对应 `XxxRun 跳过：Run 已终态或当前 worker 已丢失 lease` 日志路径。
- `backend/tests/integration/multi-process-resume.ts` + `multi-process-resume-child.ts`（**PR-3.3.2 multi-process resume —— 已 Codex 实跑通过（9 passed, 0 failed）** —— `fork` 两个独立 Node 子进程 + IPC 同步屏障 + 共享 schema + `sdk_call_log` 跨进程计数器）：`approveToolCall` 总计只调用 1 次、`run-resumed` 事件只写 1 条、Run 收敛到 `completed`、`messages.content` 由赢者 child 写入一次正确结果、子进程 `exit 0`。**Codex 2026-09-07 第一次 review 触发的关键修复**：seed `approved` approval 时填合法 `resolver_id = seedUserId`、全 schema 生命周期 try/finally、watchdog 仅在两 child 都结束后清除、子进程轮询到达截止必须 `exit(3)`、fork .ts 用显式 tsx loader（Windows ESM `--import` 必须 file URL，经 `pathToFileURL` 包装）、ready 前 early-exit 兜底、不打印 DATABASE_URL。**测试使用 FakeAgentFacade，验证 worker 抢占层 + SDK 边界协议；不能被引用为"多实例生产并发 SDK 已验证"。**
- `backend/tests/integration/hard-crash-lease-recovery.ts`（**PR-3.3.2.1 W4 hard-crash sweeper —— 已 Codex 实跑通过（32 passed, 0 failed）** —— 真实 PG + 直接调生产 `runHardCrashApprovalResumeSweeperOnce` 入口）：覆盖 7 项验收：(a) approved + 幂等 Tool → `approved_resume_indeterminate` + Run → `waiting_approval` + 写 `run-resume-reclaimed` 事件；(b) approved + 非幂等 Tool → 人工介入 + Run → `failed` + `APPROVAL_RESUME_RECLAIMED_MANUAL_INTERVENTION_REQUIRED`；(c) attempts 耗尽 → 人工介入 + Run → `failed` + `APPROVAL_RESUME_RECLAIMED_ATTEMPTS_EXHAUSTED`；(d) 普通 running Run 仍走 `LEASE_EXPIRED`；(e) 两个 sweeper 并发 SKIP LOCKED 单飞；(f) 终态后不存在 `approved + started_at NOT NULL + failed LEASE_EXPIRED` 孤儿组合；(g) **跨实例并发**：hard-crash sweeper 与普通 `sweepExpiredLeases` 真并行（`Promise.all`）时，approval-resume Run **不**变 `failed + LEASE_EXPIRED`，依赖普通 sweeper 的 SQL `NOT EXISTS` 排除。

**文档同步**：
- `README.md`：`Tool Approval` 章节（用户视角）
- `docs/architecture.md`：阶段 3.3 / PR-3.3 状态 + 工具元数据真实定位节更新
- `docs/architecture-v2.md`：`approval_request_id` 决策 + `waiting_approval` 释放执行 Lease + Approval resolve 必须调 Mastra approve/decline
- `docs/implementation-plan.md`：本节 + 总体验收勾选

### 阶段 3 验收（映射 V2 §7.4）

- [x] PR-3.0 完成（`@mastra/pg` PostgresStore + runId/thread/resource 透传；跨重启真实 PG 端到端验证仅覆盖 inflight Run reconcile + suspended list，未覆盖完整 approval resume 链路）
- [x] Tool 网关不依赖 `metadata` 自报字段（PR-3.2 已把风险输入集中到 `tool_policy_rules`；PR-3.3 通过 Tool Gateway 包装层 + `requireToolApproval` 走 Mastra 审批流，不再依赖 Tool 自报授权）
- [x] **审批超时自动 reject + Run 由 scheduler 收尾**：`timeout-worker.ts` 每 15 秒扫 `expires_at < now()` 的 pending 行 → `state-machine.expireApproval` 严格 DB-only 写 `status='expired'` + `resolver_id=system-approval-worker`（**不**调 SDK）；scheduler 在下个 tick 通过 `listApprovalsPendingResume` 拾起 `status='expired'` 行 → 调 `facade.declineToolCall(reason='expired')` → `consumeAgentStream` 真实消费 resume stream 推 Run 到 completed（fake stream 给 done）
- [x] 跨 workspace Tool 调用一律 404（PR-3.1 + PR-3.3 共享：Tool Gateway 走 workspace 隔离 + `tool_approval_requests` 走复合外键 `(run_id, workspace_id) → agent_runs(id, workspace_id)`；`resolveApprovalRequest` 强制带 `workspace_id` 过滤）
- [x] 跨重启 Run 恢复：`runReconcileIndeterminateOnce`（`run-executor.ts`）扫 `('approved_resume_indeterminate') AND lease_expires_at < now() AND resume_attempts < MAX AND resolver_error NOT LIKE 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_%'` 的行；先校验 `getToolDefinition(approval.toolId).metadata.idempotent === true`（**非幂等/未注册 Tool 直接 fail-closed 写人工介入 + Run → failed，不查 SDK**），按 `listSuspendedRuns` fail-closed 严格校验 → revert（→ `approved`）/ 校验失败 / 耗尽（→ `failed` + 人工介入错误）；timeout worker 启动期先调一次 `reconcileInflightApprovals`
- [x] **执行器终态 lease fencing**（`run-executor.ts`）：`completeRun / stopRun / failRun` 终态 UPDATE 均带 `WHERE lease_owner = WORKER_ID` fence——迟到 worker 在 lease 被替换后无法覆盖 `agent_runs.status` 终态、`messages.status` 终态或 `agent_run_events.run-completed / run-stopped / run-failed` 事件。生产路径测试：`backend/tests/integration/executor-terminal-lease-fence.ts`（`RUN_PG_TOOL_POLICY=1 RUN_PG_LEASE_FENCE=1`，**已 Codex 实跑通过，`done / stopped / error` 三场景独立 seed 均通过**）。
- [x] **多进程 resume SDK 单飞**（`run-executor.ts::resumeAwaitingRunsOnce`）：两个独立 Node 子进程并发接管同一 approval 时，原子 `UPDATE tool_approval_requests SET mastra_resume_started_at = now() WHERE id = $1 AND mastra_resume_started_at IS NULL RETURNING ...` 保证 `approveToolCall` 在跨进程维度只调用 1 次。多进程生产路径测试：`backend/tests/integration/multi-process-resume.ts` + `multi-process-resume-child.ts`（`RUN_PG_MULTI_PROCESS=1`，**已 Codex 实跑通过（9 passed, 0 failed）**）。**注意：本测试使用 FakeAgentFacade，验证的是 worker 抢占层 + SDK 边界协议，不能被引用为"多实例生产并发 SDK 已验证"。**
- [x] **W4 hard-crash 恢复**（PR-3.3.2.1，`backend/src/core/execution/approval-resume-recovery.ts::sweepExpiredApprovalResumeLeases`）：识别"approval 已写 `mastra_resume_started_at` + Run 持 lease 但 worker 进程被直接杀死"的孤儿现场；按 Tool 元数据 + approval 状态分流（幂等 Tool 转 `approved_resume_indeterminate` + Run → `waiting_approval`；非幂等 / 未注册 Tool 人工介入 + Run → `failed`；declined / expired 硬崩溃 `fail-closed` 不重放）；`SELECT ... FOR UPDATE SKIP LOCKED` 多 sweeper 并发单飞；在普通 `sweepExpiredLeases` **之前**执行。生产路径测试：`backend/tests/integration/hard-crash-lease-recovery.ts`（`RUN_PG_HARD_CRASH_LEASE=1`，**已 Codex 实跑通过（32 passed, 0 failed）**）。

### PR-3.3 Replay Fix（已落地 fake-stream e2e，未做真 SDK e2e）

**根因**：旧版本 `runApprovalSagas` 收 approve/decline 后调 `streamAgent(prompt)` 重发模型请求——既不是真实 resume，也不是 Mastra 1.61 公开 API。

**修法**：
- **职责严格分层**：`/v1/approvals` HTTP 层 / `state-machine.resolveApproval` / `expireApproval` / `reconcileInflightApprovals` / `timeout-worker` **全部 DB-only**——只做身份校验、workspace 隔离、审批决策、超时登记、数据库状态收敛；**不**调 Mastra SDK、**不**消费 stream、不写 Run 终态。`run-executor.ts::runResumeSchedulerOnce` + `runReconcileIndeterminateOnce` 是**唯一** SDK 调用与 stream 消费方。
- `core/agent/runtime.ts` 抽取 `consumeAgentStream(execution, stream)` 公共能力；首次 Run（`agent.stream().fullStream`）与 resume（`agent.approveToolCall()` / `declineToolCall()` 返回的 `AsyncIterable<unknown>`）共用；
- `core/execution/run-executor.ts::runResumeSchedulerOnce` 不再调 `streamAgent(prompt)`，改为：扫描 `listApprovalsPendingResume` → 原子推 Run → 'running' + INSERT `run-resumed` 事件 + 写 `mastra_resume_started_at`（同事务）→ `facade.approveToolCall()` / `declineToolCall()` → `consumeAgentStream` 真实消费 resume stream → 推 Run 终态；
- **W2 approve SDK 抛错 reconciliation**：写入 `approved_resume_indeterminate` + `resume_attempts += 1` + `resolver_error='APPROVE_SDK_INDETERMINATE: …'` + Run 推回 `waiting_approval`（**保留** `mastra_resume_started_at` 阻止 scheduler 立即重扫）；等 lease 到期后由 `runReconcileIndeterminateOnce` 调 `listSuspendedRuns` fail-closed 严格校验 `runId`/`toolCallId`/`workspaceId`/`threadId`/`resourceId`/`agentId`；校验通过 → DB-only `revertApprovalForReconcile`（`status='approved'` + 清 `mastra_resume_started_at`），scheduler 自然接管；校验失败 / `resume_attempts >= MAX_RESUME_ATTEMPTS=3` → fail-closed：保留 `approved_resume_indeterminate` + 保留 `mastra_resume_started_at` + 覆盖 `resolver_error` 为 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED: …` 或 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED: …`；Run → `failed` + 相应 `error_code` + 写 `run-failed` 事件 + `messages.status='failed'`（同事务）。**这些人工介入记录永久退出自动 reconciler 扫描集**（`resume_attempts >= MAX` + `resolver_error NOT LIKE 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_%'` 双重防护）——避免重复 SDK / `listSuspendedRuns` 调用与日志噪声；approval 行、`mastra_resume_started_at`、人工介入错误信息全部留保留供检索。
- `core/execution/run-executor.ts` 导出 `runResumeSchedulerOnce()` / `runReconcileIndeterminateOnce()` 测试入口；
- `tool-policy/state-machine.ts::MastraAgentFacade` 类型改为 `approveToolCall/declineToolCall: (...) => Promise<AsyncIterable<unknown>>`、`listSuspendedRuns: (...) => Promise<SuspendedRunSnapshot[]>`；`listSuspendedRuns` 在 Agent 实例上调用（`agent.listSuspendedRuns({threadId, resourceId, workspaceId, agentId})`），`validateSuspendedRunsSnapshot` 严格校验 `runId/toolCallId/threadId/resourceId`，缺一即 fail-closed 抛错；state-machine 不再有"general-chat 兜底"；
- `database/init.sql` 保持 `requester_id UUID NOT NULL REFERENCES app_users(id)` 与 `resolver_id UUID NOT NULL REFERENCES app_users(id)`；system-initiated 路径走预设 `system-approval-worker` 平台用户 UUID `00000000-0000-0000-0000-0000000000a1`（init.sql 阶段 3.3 段 INSERT 一行 `app_users(username='system-approval-worker')` 支撑）；`repository.createApprovalRequest` 强制 `requesterId` 非空，`agent_runs.created_by` NULL 时拒绝创建；`takeoverInflightLease` 同步写 `mastra_resume_started_at`（避免 takeover 后被 scheduler 再次调度）。
- `server/routes/approvals.ts` HTTP handler **不**再持有 Mastra stream 句柄，**不**调 SDK；`resolveApprovalHandler` 仅做当前 `ResolveApprovalOutcome` (`approved` / `declined` / `not_found` / `already_resolved` / `lease_contended`) 收窄映射，**不**伪造 `sdk_failed` / `lease_lost_during_sdk` 分支。

**验证（2026-09-04）**：
- `cd backend && npm run typecheck`：通过；
- `cd backend && npm run test:unit`：全部通过；
- `cd backend && RUN_PG_TOOL_POLICY=1 npx tsx tests/integration/tool-policy-pg.ts`：**107 passed, 0 failed**；
- `cd frontend && npm run build`：成功（保留既有 chunk-size warning 与 ineffective dynamic import）；
- `git diff --check`：无非空白冲突。

**未验证边界 / Codex 复查点（PR-3.3 staging e2e 待办，非 Phase 4）**：
- 涉及 Mastra resume SDK/stream 边界的 PG 集成测试（`tool-policy-pg.ts` / `multi-process-resume.ts` / `executor-terminal-lease-fence.ts` / `approval-reconcile-safety.ts`）使用 `FakeAgentFacade` / fake stream；`hard-crash-lease-recovery.ts` 直接验证生产 sweeper 的 PostgreSQL 状态收敛（不依赖 facade）。本机真实 Mastra Core 1.61.0 + DeepSeek 的 approve / decline / timeout 三条 HTTP/SSE 基础路径及 pending 后重启再 approve 已有验证记录；建议在 staging 环境以真 SDK + 当前配置的真实 Provider（本机为 DeepSeek）再跑 (a)~(h)；
- `listSuspendedRuns` 在真实 Mastra 返回结构上**尚未**实测（fake 仅在 threadId=`convH.id` 时返回一条匹配快照，`fail-closed` 抛错分支已覆盖）；
- `consumeResumeStream` 的 W2 / W2' / W3 crash window 兜底逻辑已实现并有 fake 失败用例覆盖；W4 hard-crash（worker 进程被直接杀死，JavaScript catch 不执行）由新加的 `sweepExpiredApprovalResumeLeases`（PR-3.3.2.1）按 Tool 元数据分流恢复——`hard-crash-lease-recovery.ts` **已 Codex 实跑通过（32 passed, 0 failed）**；生产端 SDK 异常的具体形态（network error / rate limit / partial response）未做容灾演练；
- **多进程真实 SDK 并发未实测**：`multi-process-resume.ts` **已 Codex 实跑通过（9 passed, 0 failed）**——验证的是 facade 层跨进程资源抢占（原子 `UPDATE ... WHERE mastra_resume_started_at IS NULL` 兜底 + IPC 同步屏障 + 共享 `sdk_call_log` 介质），facade 仍是 fake。多实例生产部署下真实 Mastra SDK 并发去重、SSE 跨实例扇出、PostgresStore lock 行为**仍**未在本 PR 验收——属 PR-3.3 staging e2e 待办。**本测试不能被引用为"多实例生产并发 SDK 已验证"。**
- 执行器终态 lease fencing（`executor-terminal-lease-fence.ts`，覆盖 `done / stopped / error` 三场景独立 seed）**已 Codex 实跑通过**；真实 SDK stream 落地下迟到 worker 的终态写入行为**未**实测，属 PR-3.3 staging e2e 待办。
- W2 reconciliation 的非幂等 / 未注册 Tool 校验已用真实 PG + FakeAgentFacade 验证（`approval-reconcile-safety.ts` **已 Codex 实跑通过**）；真实 SDK `listSuspendedRuns` 在不同返回结构下的 fail-closed 行为**未**实测。
- `system-approval-worker` 平台用户 UUID 在 init.sql 里硬编码；DB init flow 假定 `app_users` 表已 seed；后续如做多环境 provisioning 应抽到 seed script。

### PR-3.3.1（已实现 staging e2e harness，**尚未实际执行**）—— 真实 Mastra SDK + 真实模型 + 真实 HTTP/SSE 验收基建

**Files**
- Create: `backend/src/tools/staging-approval-probe/tool.ts`（零副作用、幂等、`destructive=true` 的 staging-only Tool；`tools/index.ts` 守卫：仅 `ENABLE_STAGING_APPROVAL_PROBE=true` 且 `DEPLOYMENT_PROFILE !== 'production'` 才注册；production 下抛错拒绝启动）
- Create: `backend/src/agents/staging-approval-probe/agent.ts`（专用 e2e Agent；指令**强制**每次 user message 先调一次 `staging-approval-probe`，不得混用 general-chat；`agents/index.ts` 守卫同上）
- Modify: `backend/src/core/agent/runtime.ts`（导出 `resolveApprovalTtlMs()`：默认 `5 * 60_000` ms；仅在 staging 开关 + 非 production 下，`STAGING_APPROVAL_E2E_APPROVAL_TTL_MS` 可覆盖，且严格校验 `1000–300000`）
- Create: `backend/src/scripts/staging-tool-approval-e2e.ts`（staging e2e 脚本：仅 HTTP + SSE；env 守卫；健康检查；`/agents` `/tools` 校验专用 Agent + Probe 已注册；三条场景 approve / decline / timeout；stdout 输出脱敏报告）
- Create: `docs/runbooks/staging-tool-approval-e2e.md`（前置条件 + env + 三条场景期望 + 失败证据 + 清理边界 + 已知限制）

**安全边界**：
- Probe / Agent 默认**不**注册，**不**暴露到 `/agents` 或 `/tools`；
- production 启动被 `tools/index.ts` 与 `agents/index.ts` 双门拒绝（即便设了 `ENABLE_STAGING_APPROVAL_PROBE=true`）；
- TTL 环境变量仅在 staging 开关 + 非 production 下生效，**绝不**影响生产 5 分钟默认；
- 脚本拒绝打印 password / token / `DATABASE_URL` / 模型密钥；
- 脚本只通过 HTTP API + SSE 验证；**不**直接调 state-machine / repository / run-executor / facade；
- 脚本**不** DROP / TRUNCATE / RESET DB；只清理本轮 conversation；**不**删既有用户。

**三条场景执行逻辑**：
- **approve**：登录 → 创建 conversation（agentId=`staging-approval-probe`）→ POST message → SSE 订阅到 `approval-requested` → `POST /v1/approvals/:id/resolve {decision:'approve'}` → SSE 订阅到 `run-completed`；期望 Run `completed`。
- **decline**：同上到 `approval-requested`，改 `decision:'decline'`，期望 Run `failed` 或 `completed`（resume 流语义决定）+ approval `declined`。
- **timeout**：必设 `STAGING_APPROVAL_E2E_APPROVAL_TTL_MS`（1000–300000）；等到 `approval-requested` 后**不** resolve，等 TTL 到期 → timeout worker（15s tick）调 `expireApproval`（resolver_id=system-approval-worker）→ resume scheduler（1s tick）调 `declineToolCall(reason='expired')` → 消费 resume stream → Run 进 `failed`/`completed`；期望 approval `expired` 且 resolver_id 为 system-approval-worker。

**未覆盖边界（明确告诉 Codex 不在 PR-3.3.1 范围）**：
- W2 approve SDK 抛错人为注入；
- 多 backend 实例并发抢占；
- 进程重启 / `recoverSuspendedRunsOnce`；
- 浏览器 UI（`ApprovalCard` 渲染 / `useApprovals` 事件订阅）；
- Provider 网络错误的容灾演练；
- 真实业务副作用（Probe 零副作用、Agent 不允许业务 Skill / KB）；

**Codex 在 staging 执行的验证命令**（脚本本身**不**自动运行）：
```
# 1) 启 staging 后端（一次性）
DEPLOYMENT_PROFILE=demo ENABLE_STAGING_APPROVAL_PROBE=true npm run start

# 2) 三场景 e2e
cd backend
RUN_STAGING_TOOL_APPROVAL_E2E=1 \
STAGING_E2E_BASE_URL=https://staging.xuanshu.example \
STAGING_E2E_USERNAME=staging-e2e-probe \
STAGING_E2E_PASSWORD='<staging_password>' \
STAGING_APPROVAL_E2E_APPROVAL_TTL_MS=30000 \
npx tsx src/scripts/staging-tool-approval-e2e.ts
```

**状态更新（2026-09-04）**：本机真实 PG + Mastra 1.61 + DeepSeek 的三条基础链路及 pending 后进程重启批准已实测。此前“仅 fake”的表述是旧验收基线；故障矩阵和多实例仍待验证。见 [Codex 实测记录](runbooks/2026-09-04-approval-verification.md)。

---

## 阶段 4：异步文档与 RAG（§8.4.1 + §8.4.2 落地期）

**目标**：把当前同步 Document 流程改成异步 Staging → Finalize 管线；RAG 启用时按 §8.4.1 拆 Schema；存量库按 §8.4.2 六步迁移；Outbox + Worker Lease 全部按 V2.3.5 + V2.3.6 落定。

> **PR-4 验证状态（2026-09-11，第二轮 Codex review 后）**：本轮 PR-4.x（PR-4.1 / 4.2 / 4.3）
> **代码已完成**；**真实 PostgreSQL 端到端 18 passed、0 failed**（Core-only 16 + RAG 2）。
> 静态 `npm run typecheck`（backend）+ `npm run build`（frontend）已通过。
> **staging 演练未完成**（仅 4 类边界）：多进程 Worker 真并行 / 真实 MinerU /
> 真实 Embedding Provider HTTP / 浏览器前后端端到端联调。
> 按用户裁决，本轮 PR-4.x 全部以 **`backend/database/init.sql` 单一来源 +
> fresh DB init** 路径落地——**不**创建 `migrations/0008-rag-extensions.sql` /
> `0009-storage-jobs.sql` 等迁移文件；**不**为旧数据库写兼容 / 回填 / 迁移
> 路径（与本计划 G-2 / §5.3 "不维护迁移链；删库重建是接受路径" 完全一致）。
> PR-4.4「存量内联向量迁移」在本轮**已取消**——§8.4.2 六步迁移依赖旧库，
> 本项目模板统一以 init.sql 为起点，存量数据不存在，需要时由维护者按 V2
> §8.4.2 手动跑 init.sql 重建。
> 完整落地清单与未验证项见
> `docs/superpowers/plans/2026-09-10-pr4-async-doc-rag.md`。
>
> **真实 PG 集成测试**（2026-09-11 第二轮整改后重跑）已**18 passed、0 failed**：
>
> - [`backend/tests/integration/pr4-async-doc-rag-core.ts`](../backend/tests/integration/pr4-async-doc-rag-core.ts) — 16 用例；进程以空 `EMBEDDING_API_KEY` 启动，`config.ragEnabled=false`（生产 Core-only 边界）。
> - [`backend/tests/integration/pr4-async-doc-rag-rag.ts`](../backend/tests/integration/pr4-async-doc-rag-rag.ts) — 2 用例；进程以非空无敏感占位 `EMBEDDING_API_KEY` 启动，`config.ragEnabled=true`（生产 RAG 边界）。
> - 两套用例分别以**独立进程**运行，`config.ragEnabled` 由本进程 env 决定，**不**修改生产 `config` 模块；不调用真实 embedding API；不泄露真实 key。沙箱无 PG 时两文件按各自用例数干净 SKIP。

### PR-4.1：RAG 扩展与拆分表启用（Core 模式不引入）

**Files**
- Modify: `backend/database/init.sql`（删除顶层 `CREATE EXTENSION vector`（搬到 bootstrap 顶层 SQL）；新增 `document_ingestion_jobs` / `storage_finalize_jobs` / `storage_deletion_outbox`；`storage_finalize_jobs` / `storage_deletion_outbox` 各加 `processing` 状态 + lease columns；末尾 DO 条件块创建 `embedding_profiles` / `document_embeddings` 及普通过滤索引；**本轮不建 HNSW**）
- Modify: `backend/src/test-utils/schema-init.ts`（`ensureSchema` 接受 `{ ragEnabled: boolean }` 必需参数；first-time 路径同一事务内 `CREATE EXTENSION IF NOT EXISTS vector` 顶层 + `SET LOCAL app.rag_enabled`）
- Modify: `backend/src/scripts/migrate.ts`（显式传 `config.ragEnabled`）
- Modify: `backend/src/config.ts`（`ragEnabled` 由 `EMBEDDING_API_KEY` 派生）
- Modify: `backend/src/modules/documents/service.ts`（`DocumentStatus` 8 态 + `softDeleteDocument` 4 动作单事务 + `findActiveDocumentBySha`）

**Schema**（落地在 `init.sql` 而非 `migrations/`）

- `documents.status` CHECK 改为 8 态（`queued / parsing / chunking / embedding / finalizing / ready / failed / cancelled`）。
- `documents` 新增 `storage_status` / `storage_key` / `sha256` / `total_chunks` / `completed_chunks` / `failure_reason` / `deleted_at` 列；新增 partial unique `documents_dedup_unique_idx`（`workspace_id, knowledge_base_id, sha256` WHERE `deleted_at IS NULL`）。
- `document_chunks` 删除 `embedding vector(2048)` 列；新增 `UNIQUE (document_id, chunk_index)`。
- 三张 Core-only 新表按 V2 §8.1 / §8.2 字段创建；含 lease_owner / lease_expires_at / heartbeat_at / partial unique / pending 索引。`storage_finalize_jobs.status` 加 `processing`；`storage_deletion_outbox` 加 status / lease_owner / lease_expires_at / next_attempt_at 列。
- 末尾 DO 块：`current_setting('app.rag_enabled', true) = 'on'` 才创建 `embedding_profiles` + `document_embeddings` 及普通过滤索引（`document_embeddings_workspace_chunk_idx` / `document_embeddings_profile_chunk_idx`）；**本轮不建 HNSW**——`embedding vector` 是可变维度列，HNSW 必须绑定固定 dimensions 才能 DDL，全局 HNSW 既不可创建、也会把后续切维度卡死；未来如需按 `(profile_id, dimensions)` 建 partial HNSW 属 profile 生命周期职责，本轮不在 init.sql 里做。**vector 扩展**已搬到 bootstrap 顶层 SQL，**不在** DO 块内。

**验证状态**：typecheck 通过；真实 PG 集成测试已落并跑通——见 `pr4-async-doc-rag-core.ts` #1（Core-only 不建 vector / RAG 表）+ `pr4-async-doc-rag-rag.ts` #2（RAG 全建）。两文件分别以空 / 非空 `EMBEDDING_API_KEY` 在独立进程跑，**18 passed、0 failed**（详见本节顶部"真实 PG 集成测试"段）。

### PR-4.2：Staging → Finalize + Storage Outbox（Worker Lease）

**Files**
- Create: `backend/src/infrastructure/storage/document-storage.ts`（接口 + 单例工厂）
- Create: `backend/src/infrastructure/storage/local-storage.ts`（本地 FS：`staging/` 与 `final/` 命名空间隔离 + tmp + rename 原子晋升 + ENOENT 容忍）
- Create: `backend/src/modules/documents/text-splitter.ts`（抽出共享 `splitText`，消除 PR-3 时期 inline TODO）
- Create: `backend/src/modules/documents/jobs-repository.ts`（enqueue / claimNext / heartbeat / transitionIngestionStatus / markFailedTerminal / cancelJobsForDocument；requeue 已在 `transitionIngestionStatus` 内单事务收敛——本轮**不**单独保留 `flushRequeueToQueued` 入口）
- Create: `backend/src/modules/documents/ingestion-worker.ts`（1s tick + 15s heartbeat + 30s lease sweeper；阶段推进 + 退避重试 + Core-only 跳过 embedding）
- Create: `backend/src/modules/documents/storage-workers.ts`（finalize + outbox 两组 worker；**严格 lease fencing + processing 状态机 + 真实退避**）
- Modify: `backend/src/server/bootstrap.ts`（注入 `LocalFsStorage` 单例 + 启动 3 组 worker）
- Modify: `backend/src/server/routes/documents.ts`（POST 改 202，**单事务串 documents + ingestion_jobs + finalize_jobs，23505 catch 触发 dedup-race 重查**；DELETE 改 `softDeleteDocument`）
- Modify: `backend/.gitignore`（忽略 `data/` 与 `backend/data/`；精确反忽略 `backend/src/infrastructure/storage/`）

**实现要点（PR-4.2 整改后）**：
- claim 单事务内 SELECT FOR UPDATE SKIP LOCKED → UPDATE 切 `processing` + lease_owner + lease_expires_at + attempts++；IO 在事务外。
- finalize lease 过期 → sweeper 收回 processing → pending + 5s 退避。
- ingestion claim JOIN documents 加 `deleted_at IS NULL AND storage_status='ready'` 守卫；transitionIngestionStatus 单事务串 job + doc，attempts 单点 ++。
- outbox claim 加 lease + 真实退避 `2^(n-1) × 1s` 封顶 5min；sweeper 按 lease 收回。
- soft delete 4 动作单事务：documents 软删除 + finalize (pending/processing) 取消 + ingestion (active) 取消 + outbox 入队。

**验证状态**：typecheck 通过；真实 PG 集成测试已落并跑通——`pr4-async-doc-rag-core.ts` 含 #3 并发上传 race、#4 ingestion claim storage_pending 不抢、#5 finalize 跨实例并发、#6 finalize lease 过期 sweeper、#7 ingestion transition 事务回滚、#8 soft delete 串联、#9 outbox lease sweeper、#10 outbox 删除成功、#11 requeue attempts 单点 ++、#12 删除后旧 worker 无法 ready、#13 lease 过期 worker 拒绝写 done/failed、#14 finalize 成功 + DB 写回失败 → 二次重试幂等收敛、#16 outbox 两 worker 并发仅一个 remove、#17 ingestion worker 真实跑全链路、#18 transitionIngestionStatus 非 requeue 全路径真实 PG 覆盖。**16 passed、0 failed**（详见本节顶部"真实 PG 集成测试"段）。

### PR-4.3：Async Document 写读切换

**Files**
- Modify: `backend/src/modules/knowledge/rag/retriever.ts`（JOIN `document_embeddings + document_chunks + documents`；按 active profile + `documents.status='ready'` 过滤）
- Modify: `frontend/src/lib/api.ts`（`KnowledgeDocument` 8 态 + 进度字段；新增 `DocumentUploadAck` + `getDocument`）
- Modify: `frontend/src/features/knowledge/components/KnowledgeBaseWorkspace.tsx`（`STATUS_LABEL` 全翻译；中间态显示 `completed/total` 进度文本；失败态显示 `failureReason`；`cancelled` 状态禁用删除）
- Modify: `frontend/src/app/App.tsx`（1.5s 轮询 effect 仅对中间态文档触发；离开 KB 视图或全部终态时清理 timer）

**验证状态**：前端仅 build 通过；浏览器端到端联调留待后续。RAG 检索的 PG 验证依赖 #2 已落测试 fixture；本节顶部"真实 PG 集成测试"段的 **18 passed、0 failed** 涵盖 schema + 后端 worker 协议；**多进程并发恢复 / 真实 embedding provider 接入 / 真实 MinerU 解析失败路径仍待 staging e2e**，不能视为已稳定可用。

### PR-4.4：存量内联向量迁移（§8.4.2 六步）

**状态：已取消**（2026-09-11）。

- **本模板采用 fresh DB**——`backend/database/init.sql` 是 Schema 单一来源。
- **不维护旧库迁移、兼容、回填**（与 G-2 / §5.3 "不维护迁移链；删库重建是接受路径" 一致）。
- 如需 embedding profile 调整，改 `init.sql` + 删库重建即可。
- **V2 §8.4.2 六步迁移保留在 `docs/architecture-v2.md` 作为未来旧库场景参考**，本仓库不再实现。

### 阶段 4 验收（映射 V2 §8.7）

- ✅ **PR-4.1 / PR-4.2 / PR-4.3 已完成**：异步文档管线 + RAG/Core 分层代码已落仓库；真实 PostgreSQL 端到端 **18 passed、0 failed**（Core-only 16 + RAG 2，分别在独立进程运行：`config.ragEnabled` 由本进程 env 决定，调用 `runIngestionWorkerOnce` / `_runFinalizeOnce` / `_runOutboxOnce` / `transitionIngestionStatus` / `getOrCreateActiveEmbeddingProfile` / `createUploadBundle` 等生产入口）。详细 18 用例清单与两套隔离进程说明见 `architecture.md` §7 与 PR-4 顶部验证状态块。
- ⚠️ **Core 模式服务器在一个完全未安装 pgvector 的 PostgreSQL 实例上启动** —— **staging 未验证项**（不在 PR-4.1 / 4.2 / 4.3 真实 PG 18/18 覆盖范围内）。本轮 #1 用例断言 RAG 表不存在 + `app.rag_enabled='off'`，但所属 fixture schema 已 `CREATE EXTENSION vector`，**未**测真实"完全无 pgvector 的 PG 实例 + Core 部署"边界；属剩余 staging 演练边界，**不是**代码缺口。
- ⚠️ **剩余 staging 边界**（仍待演练，**不**视为已稳定可用）：
  - 多进程 Worker 真并行 `FOR UPDATE SKIP LOCKED` 单飞 / heartbeat 续约 / hard-crash sweeper 接管。
  - 真实 MinerU 解析失败 / 网络抖动重试。
  - 真实 Embedding Provider HTTP 接入。
  - 浏览器前后端端到端联调。
- ❌ **不适用**（PR-4.4 已取消，模板走 fresh init，不再作为 PR-4 待办；保留在 V2 §8.4.2 仅作未来旧库场景参考）：
  - ~~§8.4.2 六步迁移 + 7 天回滚窗口全部自动化~~。
  - ~~切读后立即 DROP 列被 SQL 注释显式禁止且 CI 失败~~。
  - ~~旧向量 `provider`/`model` 不可确认时强制重 embed~~。

---

## 阶段 5：模型、评测与生产开放

**目标**：多 Provider 接入 + 评测驱动变更 + `DEPLOYMENT_PROFILE=production` 解锁。

### PR-5.1：评测 Schema 定稿（前置）

**Files**
- Create: `backend/database/migrations/0011-eval-schema.sql`

> 实际未创建此文件——PR-1.2 / PR-1.3 / PR-1.5 已在 `backend/database/init.sql` 单文件中合并落地（见 G-2 / §5.3）。

**Schema**：把 README「评测表为伪 schema」涉及到的所有表定稿（`eval_suites` / `eval_cases` / `eval_runs` / `eval_results`），含 FK、CHECK 与 partial index。**先定稿 Schema 再写 runner**——避免 runner 用临时表然后被推翻重写。

### PR-5.2：评测 Runner + Golden Set 框架

**Files**
- Create: `backend/src/modules/eval/runner.ts`
- Create: `backend/evals/golden/`（手写若干知识库问答 + Tool 风险用例）

### PR-5.3：多 Provider 适配层（OpenAI / Anthropic / Gemini 等）

**Files**
- Modify: `backend/src/infrastructure/llm/registry.ts`
- Create: `backend/src/infrastructure/llm/providers/<provider>.ts` × N
- Modify: README「当前唯一正式启用的 LLM Provider 是 DeepSeek」相关章节
- Create: `frontend/src/features/models/`

**注意**：不再受 Starter 单 Provider 限制；Registry 的拒绝逻辑改为「未注册 provider 在首次解析时报错」而不是「永远只允许 deepseek」。

### PR-5.4：`DEPLOYMENT_PROFILE=production` 解锁条件

**Files**
- Modify: `backend/src/infrastructure/boot/profile.ts`

**解锁条件**：阶段 1～4 全部 PR 合入；CI 全绿；eval golden 全绿。

### 阶段 5 验收（映射 V2 §9.8）

- [ ] 评测表定稿且 FK/CHECK/索引齐全
- [ ] Golden Set 可重放，回归即知
- [ ] `DEPLOYMENT_PROFILE=production` 在全部前置条件满足时不再拒绝启动

---

## 总体验收（映射 V2 §10）

- [ ] V2 §4.2、§5.4、§6.6、§7.4、§8.7、§9.8 全部对应至少一个 PR 验收项
- [ ] 阶段 0 PR-0.1 + PR-4.1 形成 Core/RAG 双向可证
- [ ] Schema 在仓库内可重放：`rm -rf data/postgres && docker compose up -d && npm run migrate`（删库重建路径，详见 §5.3）
- [ ] 全部 CI 门禁在 `.github/workflows/verify.yml` 中可见
- [ ] 全部验收项对应 `architecture-v2.md` 章节指针，可在 PR 描述中追溯

## 验收覆盖矩阵

| V2 章节 | 验收项摘要 | 对应 PR | 阶段 |
|---|---|---|---|
| §4.2 | Schema 唯一来源、checksum 校验、不维护迁移链 | PR-1.2 / PR-1.3 / PR-1.5 | 1 |
| §5.4 | 6 张归属表隔离（含 `document_chunks`）+ Skill 全局目录 | PR-1.2 / PR-1.3 / PR-1.4 / PR-1.5 | 1 |
| §6.6 | 幂等 POST + SSE 续传 + `agent_runs` 生命周期 | PR-2.1 / PR-2.2 / PR-2.3 | 2 |
| §7.4 | Tool 网关 + 审批 + 跨 workspace 404 | PR-3.1 / PR-3.2 / PR-3.3 | 3 |
| §8.7 | Core/RAG 拆分 + 切读顺序 + 不伪造归属（六步迁移为 V2 参考项，本模板走 fresh init，PR-4.4 已取消） | PR-4.1 / PR-4.2 / PR-4.3 | 4 |
| §9.8 | 评测定稿 + 多 Provider + production 解锁 | PR-5.1 / PR-5.2 / PR-5.3 / PR-5.4 | 5 |
| §10 | 总体验收 | 全部 PR 闭合 | 全部 |
