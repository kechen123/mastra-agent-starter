# V2 实施计划（阶段 0～5 / PR 切片）

> **本版本已被本次裁决覆盖**：迁移链 / 增量迁移 / `LEGACY_WORKSPACE_OWNER_USER_ID` ——以 `docs/superpowers/specs/2026-08-28-workspace-id-isolation-design.md` §5 为准。PR-1.2 / PR-1.3 / PR-1.4 / PR-1.5 已合并落地。

> **状态：基于 V2.3.6（2026-08-28）** —— `architecture-v2.md` 已升版至 V2.3.6，五项定向修正全部落定（含 §8.4.1 Core/RAG Schema 边界与 §8.4.2 存量内联向量迁移）。本文档据此拆解阶段 0～5 的 PR 切片。**仍为文档/计划阶段，不进入代码开发。**

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
- **RAG 启用时**才创建 `vector` 扩展 + `embedding_profiles` + `document_embeddings` + HNSW 索引。
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

**目标**：Tool 的 `metadata` 不再只是 UI 提示，而是接入身份 + 租户校验 + 审批工作流；高风险 Tool 调用在 `awaiting_approval` 状态暂停。

### PR-3.1：`tool_approvals` / `tool_policy_rules` Schema

**Files**
- Create: `backend/database/migrations/0007-tool-policy.sql`

> 实际未创建此文件——PR-1.2 / PR-1.3 / PR-1.5 已在 `backend/database/init.sql` 单文件中合并落地（见 G-2 / §5.3）。

**Schema**
```sql
CREATE TABLE tool_policy_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  tool_name TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny','require_approval')),
  conditions JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE tool_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_call_id UUID NOT NULL,
  requested_payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  approver_user_id UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### PR-3.2：Tool 执行网关接入身份 + 策略评估

**Files**
- Modify: `backend/src/core/runtime/tool-executor.ts`（注入 `workspaceId` 与 `userId`）
- Create: `backend/src/modules/tool-policy/evaluator.ts`

**测试**：destructive / openWorld / requiresRuntime 三类 Tool 的策略路径。

### PR-3.3：审批 UI + 续 Run

**Files**
- Create: `frontend/src/features/tool-approvals/`
- Modify: 前端 `AssistantChatWorkspace`（订阅 `awaiting_approval` 状态 → 渲染审批面板）

### 阶段 3 验收（映射 V2 §7.4）

- [ ] Tool 网关不依赖 `metadata` 自报字段
- [ ] 审批超时自动 reject + Run 进入 `failed`
- [ ] 跨 workspace Tool 调用一律 404

---

## 阶段 4：异步文档与 RAG（§8.4.1 + §8.4.2 落地期）

**目标**：把当前同步 Document 流程改成异步 Staging → Finalize 管线；RAG 启用时按 §8.4.1 拆 Schema；存量库按 §8.4.2 六步迁移；Outbox + Worker Lease 全部按 V2.3.5 + V2.3.6 落定。

### PR-4.1：RAG 扩展与拆分表启用（Core 模式不引入）

**Files**
- Create: `backend/database/migrations/0008-rag-extensions.sql`

> 实际未创建此文件——PR-1.2 / PR-1.3 / PR-1.5 已在 `backend/database/init.sql` 单文件中合并落地（见 G-2 / §5.3）。

**Schema**
```sql
CREATE EXTENSION IF NOT EXISTS vector;
-- 其余 RAG 表已在 PR-1.3 创建，此处不重复
```

**注意**：本期**只创建扩展**。RAG-only 安装从此 PR 开始可工作；Core-only 安装到本 PR 仍不依赖 pgvector（PR-0.1 的承诺维持）。

**测试**：Core-only 沙盒（无此迁移）跑 `SELECT extname FROM pg_extension` 不含 `vector`。

### PR-4.2：Staging → Finalize + Storage Outbox（Worker Lease）

**Files**
- Create: `backend/database/migrations/0009-storage-jobs.sql`（`document_ingestion_jobs` / `storage_finalize_jobs` / `storage_deletion_outbox`）

> 实际未创建此文件——PR-1.2 / PR-1.3 / PR-1.5 已在 `backend/database/init.sql` 单文件中合并落地（见 G-2 / §5.3）。
- Modify: 文档上传路径切到 staging
- Create: `backend/src/workers/finalize-worker.ts`

**实现要点**：严格按 V2.3.5 SQL + V2.3.6 §8.7 租约判据；Step B 走权威状态四分支（cancelled/软删 → Outbox；其它 → 不删）；TTL GC 仅扫 staging 命名空间。

**测试**：包含第 1 项所述全部边界测试（Step B 影响 0 行四分类、TTL GC 不删 finalKey、Outbox 重试幂等）。

### PR-4.3：Async Document 写读切换

**Files**
- Modify: 文档查询路径（pending 文档仍可读，但前端用 ready/processing 标签渲染）

**测试**：上传后立即查询 → `processing`；轮询 → 切到 `ready`。

### PR-4.4：存量内联向量迁移（§8.4.2 六步）

**Files**
- Create: `backend/database/migrations/0010-legacy-embeddings-migration.sql`

> 实际未创建此文件——PR-1.2 / PR-1.3 / PR-1.5 已在 `backend/database/init.sql` 单文件中合并落地（见 G-2 / §5.3）。
- （已撤销）应用层 migration runner 与 §5.3 / G-2 "不维护迁移链" 冲突；如需 embedding profile 调整，改 init.sql + 删库重建

**步骤**（按 §8.4.2 顺序，逐 PR 子任务）：
- Step 1：`CREATE EXTENSION` + 插入 Legacy Profile (`status='migrating', is_active=false`)
- Step 2：判定函数（环境变量 + 维度匹配）
- Step 3：`INSERT INTO document_embeddings SELECT ... ON CONFLICT DO NOTHING`
- Step 4：四项校验 SQL（`legacy_vectors` / `migrated_vectors` / `uncovered_chunks` / `dimension_mismatch` / `hash_mismatch`）
- Step 5：`UPDATE embedding_profiles SET status='active', is_active=true WHERE id=:pid;`（**唯一切换点**）
- Step 6：7 天回滚窗口，每日重新校验，全部通过后才 `ALTER TABLE document_chunks DROP COLUMN embedding;`

**测试**：
- 维度不匹配 → Step 2 直接拒搬迁，要求重 embed
- 维度匹配但 `content_hash` 不匹配 → Step 4 报错，禁止切读
- 切读后回滚 → `is_active=false` 且旧列重获读取权重

### 阶段 4 验收（映射 V2 §8.7）

- [ ] Core 模式启动不需要 pgvector（PR-4.1 不应用时仍可工作）
- [ ] §8.4.2 六步迁移 + 7 天回滚窗口全部自动化
- [ ] 切读后立即 DROP 列被 SQL 注释显式禁止且 CI 失败
- [ ] 旧向量 `provider`/`model` 不可确认时强制重 embed

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
| §8.7 | Core/RAG 拆分 + 六步迁移 + 切读顺序 + 不伪造归属 | PR-4.1 / PR-4.2 / PR-4.4 | 4 |
| §9.8 | 评测定稿 + 多 Provider + production 解锁 | PR-5.1 / PR-5.2 / PR-5.3 / PR-5.4 | 5 |
| §10 | 总体验收 | 全部 PR 闭合 | 全部 |
