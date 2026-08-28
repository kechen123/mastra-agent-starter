# Workspace ID 归属 + 跨 Workspace 隔离合约设计稿

> **状态**：草案，待用户 review。
> **日期**：2026-08-28
> **作者**：Claude（brainstorming skill 产出）
> **适用范围**：xuanshu-agent backend；合并原 `implementation-plan.md` PR-1.2 / PR-1.3 / PR-1.5 范围；**不**包含 PR-1.4（`skills_installed → skill_packages` 重命名）。
> **核心理念**：单一 `init.sql` 是 Schema 唯一来源；项目不维护迁移链；删库重建是接受路径。

---

## 1. 背景与目标

### 1.1 现状（PR-1.1 已落地）

- `workspaces` / `workspace_members` 表已建立（含 `kind`、Personal/Shared CHECK、partial unique）；
- `ensurePersonalWorkspace(userId)` + DB partial unique 提供并发安全；
- `resolveAuthenticatedContext(request)` 返回 `{ userId, username, workspaceId }`（`workspaceId` 始终非空）；
- `withAuthenticatedWorkspace(handler)` 包装器已就位；
- `/auth/me` 已接入包装器。

### 1.2 本次范围

把以下三件事一次性合并实现（原计划拆为 PR-1.2 / PR-1.3 / PR-1.5 三 PR）：

1. **PR-1.2 等价**：6 张业务表加 `workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`；
2. **PR-1.3 等价**：`document_chunks.workspace_id`；
3. **PR-1.5 等价**：跨 Workspace 读 / 写 / 删除路径全部带 `workspace_id`；隔离合约测试覆盖 17 项场景；跨 Workspace HTTP 语义统一为 404。

### 1.3 不在本次范围

- PR-1.4（`skills_installed → skill_packages` 重命名）—— 留待后续 PR；
- 阶段 4 / 阶段 5 内容（RAG 拆分、Tool Policy Gateway、Idempotency-Key 等）；
- Legacy Workspace 回填、`LEGACY_WORKSPACE_OWNER_USER_ID` 环境变量 —— 用户是唯一操作者，删库重建即可。

### 1.4 关键约束（来自用户裁决）

- **G-2 改写**：`backend/database/init.sql` 是 Schema 唯一来源；项目不维护迁移链；
- **`ensureSchema` 自管事务**：不接受已处于事务内的 PoolClient；
- **`resolveSkillsForAgent` 保持纯函数**：隔离仅发生在 `getAgentSkillBindings(workspaceId, agentId)`；
- **HTTP 语义统一**：跨 Workspace 404；UPDATE/DELETE `rowCount === 0` 抛资源不存在；后台幂等操作显式标注；
- **索引命名**：去除冗余单列索引，仅留前缀复合索引。

---

## 2. Schema 设计（`backend/database/init.sql`）

### 2.1 建表顺序（外键依赖）

```text
pgcrypto（CREATE EXTENSION IF NOT EXISTS pgcrypto）
→ app_users
→ auth_sessions
→ workspaces
→ workspace_members
→ skills_installed
→ knowledge_bases
→ documents
→ document_chunks
→ conversations
→ messages
→ tool_executions
→ agent_skill_bindings
→ 全部索引
→ _init_meta
```

**幂等性约束**：仅 `pgcrypto` 用 `IF NOT EXISTS`；其余 `CREATE TABLE` / `CREATE INDEX` 全部不带 `IF NOT EXISTS`；重复执行必须显式失败，避免静默结构漂移。

### 2.2 表定义

| 表 | 关键变更 |
|---|---|
| `app_users` | 与 `0001-local-auth.sql` **完全一致**：`username`、`username_normalized TEXT NOT NULL UNIQUE`、`password_hash`、`disabled_at`、`created_at`、`updated_at`。**不**包含 `password_algo`（代码未使用）。 |
| `auth_sessions` | 与 `0001-local-auth.sql` 完全一致：`user_id`、`token_hash TEXT NOT NULL UNIQUE`、`expires_at`、`revoked_at`、`last_seen_at`、`created_at`。 |
| `workspaces` | V2.3.6 §5.1 终态：`kind TEXT NOT NULL DEFAULT 'shared' CHECK (kind IN ('personal','shared'))`、`owner_user_id`、`CHECK ((kind='personal' AND owner_user_id IS NOT NULL) OR (kind='shared' AND owner_user_id IS NULL))`；`one_personal_workspace_per_user` partial unique。 |
| `workspace_members` | `(workspace_id, user_id)` 主键，`role IN ('owner','admin','member')`。 |
| `skills_installed` | 与原 `init.sql` **完全一致**（PR-1.4 不动）。 |
| `knowledge_bases` | `+workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE` |
| `documents` | `+workspace_id` |
| `document_chunks` | `+workspace_id` |
| `conversations` | `+workspace_id` |
| `tool_executions` | `+workspace_id` |
| `agent_skill_bindings` | `+workspace_id`；PK = `(workspace_id, agent_id, skill_id)`（三元组） |
| `messages` | 不加 `workspace_id`（通过 `conversation_id → conversations.workspace_id` 间接归属；JOIN 校验） |

### 2.3 索引（建表后统一）

```sql
CREATE INDEX workspace_members_user_id_idx ON workspace_members(user_id);
CREATE INDEX skills_installed_source_idx   ON skills_installed(source);

CREATE INDEX knowledge_bases_workspace_updated_idx
  ON knowledge_bases(workspace_id, updated_at DESC);
CREATE INDEX documents_workspace_kb_idx
  ON documents(workspace_id, knowledge_base_id);
CREATE INDEX document_chunks_workspace_document_idx
  ON document_chunks(workspace_id, document_id, chunk_index);
CREATE INDEX conversations_workspace_updated_idx
  ON conversations(workspace_id, updated_at DESC);
CREATE INDEX tool_executions_workspace_conversation_idx
  ON tool_executions(workspace_id, conversation_id);
CREATE INDEX tool_executions_workspace_message_idx
  ON tool_executions(workspace_id, message_id);
CREATE INDEX messages_conversation_id_created_at_idx
  ON messages(conversation_id, created_at);
CREATE INDEX auth_sessions_user_id_idx     ON auth_sessions(user_id);
```

**删除**（init.sql 现状中存在但被前缀复合索引取代的单列冗余索引）：
- `documents_knowledge_base_id_idx`
- `document_chunks_knowledge_base_id_idx`
- `document_chunks_document_id_idx`
- `conversations_agent_id_idx`
- `tool_executions_conversation_id_idx` / `tool_executions_message_id_idx` / `tool_executions_tool_id_idx` / `tool_executions_status_idx`
- `messages_conversation_id_idx`

### 2.4 元数据表（runner 必需）

```sql
CREATE TABLE _init_meta (
  id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.5 删除的迁移文件

- `backend/database/migrations/0001-local-auth.sql`
- `backend/database/migrations/0002-workspaces.sql`
- `backend/database/migrations/0003-workspace-constraints.sql`

`backend/database/migrations/` 目录保留为空。

---

## 3. Service / Core 完整契约

### 3.1 通用规则

1. **每个 DB 函数**第一个参数为 `workspaceId: string`（位置参数）；**保留**原有 `input` 对象不变；
2. **跨 Workspace 访问**：
   - 读不到 → 返回 `null`；
   - UPDATE / DELETE 受用户请求触发且 `rowCount === 0` → 抛 `ResourceNotFoundError`；
   - JOIN 校验失败 → 抛 `CrossWorkspaceAccessError`；
3. **后台幂等操作**（`convergeRunningToolExecutions`、`convergeAssistantToFailed`、`resetAssistantForRetry` 等）允许 0 行影响；**必须**在函数体内显式注释 `// internal idempotent: rowCount may be 0`；
4. **路由层错误映射**：
   - `ResourceNotFoundError` → 404 `{ error_code: 'NOT_FOUND', message }`
   - `CrossWorkspaceAccessError` → 404 `{ error_code: 'NOT_FOUND', message: '资源不存在。' }`（与未授权访问相同响应，避免泄露存在性）
   - 其他 → 500
5. **Skill 隔离调用顺序**：`getAgentSkillBindings(workspaceId, agentId)` → `resolveSkillsForAgent(agentId, skillIds)`（`resolveSkillsForAgent` 保持纯函数）。

### 3.2 `modules/conversations/service.ts` —— 18 个函数

| # | 函数 | 签名 |
|---|---|---|
| 1 | `createConversation` | `(workspaceId, input: CreateConversationInput)` |
| 2 | `listConversations` | `(workspaceId)` |
| 3 | `getConversationWithMessages` | `(workspaceId, conversationId)` |
| 4 | `updateConversation` | `(workspaceId, conversationId, input)` |
| 5 | `deleteConversation` | `(workspaceId, conversationId)` |
| 6 | `saveUserMessage` | `(workspaceId, conversationId, content)` |
| 7 | `saveAssistantMessage` | `(workspaceId, conversationId, content)` |
| 8 | `createAssistantPending` | `(workspaceId, conversationId)` |
| 9 | `updateAssistantStreaming` | `(workspaceId, messageId, content, citations)` —— `UPDATE messages SET ... FROM conversations c WHERE m.id=$2 AND c.workspace_id=$1` |
| 10 | `finalizeAssistant` | `(workspaceId, messageId, content, citations)` —— JOIN 校验 |
| 11 | `resetAssistantForRetry` | `(workspaceId, messageId)` —— JOIN 校验；显式 idempotent |
| 12 | `convergeAssistantToFailed` | `(workspaceId, messageId)` —— JOIN 校验；显式 idempotent |
| 13 | `getMessageSnapshot` | `(workspaceId, messageId)` —— JOIN 校验 |
| 14 | `restoreAssistantFromSnapshot` | `(workspaceId, messageId, content, citations)` —— JOIN 校验 |
| 15 | `getLastAssistantMessage` | `(workspaceId, conversationId)` |
| 16 | `touchConversation` | `(workspaceId, conversationId)` |
| 17 | `updateConversationTitle` | `(workspaceId, conversationId, title)` |
| 18 | `maybeUpdateTitleFromFirstMessage` | `(workspaceId, conversationId, content)` |

### 3.3 `modules/conversations/tool-executions.ts` —— 4 个函数

| # | 函数 | 签名 |
|---|---|---|
| 1 | `createToolExecution` | `(workspaceId, conversationId, messageId, toolId, input)` —— INSERT 带 workspace_id；校验 conversation / message 均同 workspace |
| 2 | `finalizeToolExecution` | `(workspaceId, executionId, output, status, errorCode?)` |
| 3 | `convergeRunningToolExecutions` | `(workspaceId, conversationId)` —— internal idempotent: rowCount may be 0 |
| 4 | `getToolExecutionsByMessage` | `(workspaceId, messageId)` |

### 3.4 `modules/knowledge/service.ts` —— 5 个函数

| # | 函数 | 签名 |
|---|---|---|
| 1 | `listKnowledgeBases` | `(workspaceId)` |
| 2 | `createKnowledgeBase` | `(workspaceId, input: CreateKnowledgeBaseInput)` |
| 3 | `getKnowledgeBase` | `(workspaceId, id)` |
| 4 | `updateKnowledgeBase` | `(workspaceId, id, input)` |
| 5 | `deleteKnowledgeBase` | `(workspaceId, id)` |

### 3.5 `modules/documents/service.ts` —— 5 个函数

| # | 函数 | 签名 |
|---|---|---|
| 1 | `createDocument` | `(workspaceId, input: CreateDocumentInput)` —— 校验 `kb.workspace_id = workspaceId` |
| 2 | `listDocuments` | `(workspaceId, kbId)` |
| 3 | `getDocument` | `(workspaceId, id)` |
| 4 | `updateDocumentStatus` | `(workspaceId, id, status, error?)` |
| 5 | `deleteDocument` | `(workspaceId, id)` |

### 3.6 `modules/documents/ingestion.ts`

| 函数 | 签名 |
|---|---|
| `ingestDocument` | `(workspaceId, input: IngestDocumentInput)` —— 内部校验 `documents.workspace_id = workspaceId`；INSERT document_chunks 全部带 workspace_id |

### 3.7 `core/skill/bindings.ts` —— 3 个函数（`resolveSkillsForAgent` 不变）

| # | 函数 | 签名 |
|---|---|---|
| 1 | `bindSkillToAgent` | `(workspaceId, agentId, skillId)` —— INSERT ON CONFLICT 适配三元 PK |
| 2 | `unbindSkillFromAgent` | `(workspaceId, agentId, skillId)` —— DELETE WHERE 三个键 |
| 3 | `getAgentSkillBindings` | `(workspaceId, agentId)` —— 返回 skillId[] |

**`resolveSkillsForAgent(agentId, ids)`** 保持纯函数；调用方先 `getAgentSkillBindings(workspaceId, agentId)` 拿到 skillIds 后再传入。

### 3.8 `core/skill/registry.ts`

`removeInstalledSkill(id)` 必须单连接单事务：

```ts
const client = pool.connect();
try {
  await client.query('BEGIN');
  await client.query('DELETE FROM agent_skill_bindings WHERE skill_id = $1', [id]);
  await client.query('DELETE FROM skills_installed WHERE id = $1', [id]);
  await client.query('COMMIT');
} catch (err) {
  try { await client.query('ROLLBACK'); } catch {}
  throw err;
} finally {
  client.release();
}
```

不允许通过连续 `pool.query()` 假装事务；这是删除全局 Skill 的全局级联，**不**属于跨 Workspace 越权。

---

## 4. HTTP 语义统一

### 4.1 用户请求触发路径

```text
HTTP 请求
  → withAuthenticatedWorkspace(handler)
  → resolveAuthenticatedContext(request)
  → { userId, username, workspaceId }    [ workspaceId 始终非空 ]
  → handler(authCtx, ctx)
  → Service / Core 函数（首参 workspaceId）
  → 异常 → 路由错误映射
```

### 4.2 错误映射表

| 异常 | HTTP 状态 | 响应体 |
|---|---|---|
| `ResourceNotFoundError`（Service 抛 / UPDATE/DELETE rowCount===0） | 404 | `{ error_code: 'NOT_FOUND', message: '资源不存在。' }` |
| `CrossWorkspaceAccessError` | 404 | `{ error_code: 'NOT_FOUND', message: '资源不存在。' }`（与未授权访问同响应） |
| `WorkspaceContextError` / `UserNotFoundError` | 401 | `{ error_code: 'UNAUTHENTICATED', message: '未登录或会话已失效。' }` |
| `InputValidationError` | 422 | `{ error_code: 'INPUT_VALIDATION_FAILED', message }` |
| 其他 | 500 | 不暴露内部细节 |

**禁止** 403 —— 避免暴露资源存在性。

### 4.3 后台幂等操作

下列函数允许 `rowCount === 0` 且**不**抛错，但必须在函数体内注释：

```ts
// internal idempotent: rowCount may be 0 (background convergence / terminal state writes)
```

涉及函数：`resetAssistantForRetry` / `convergeAssistantToFailed` / `convergeRunningToolExecutions`。

---

## 5. Runner 设计（`src/scripts/migrate.ts`）

### 5.1 核心函数

```ts
// src/scripts/migrate.ts
export class InitSchemaDriftError extends Error {
  constructor(public readonly stored: string, public readonly current: string) {
    super(`init.sql 与已应用版本不一致：stored=${stored} current=${current}`);
    this.name = 'InitSchemaDriftError';
  }
}

export type EnsureSchemaResult =
  | { action: 'applied'; checksum: string }
  | { action: 'skipped'; checksum: string };

/**
 * 应用 init.sql 或校验 checksum。
 *
 * 行为：
 *   - 首次（_init_meta 不存在）→ 单事务执行 init.sql + INSERT _init_meta；
 *   - 已初始化且 checksum 一致 → skipped；
 *   - 已初始化但 checksum 漂移 → 抛 InitSchemaDriftError（**不**返回 action='drift'）。
 *
 * 事务边界：自管 BEGIN / COMMIT / ROLLBACK；不接受已处于事务内的 PoolClient。
 */
export async function ensureSchema(
  client: PoolClient,
  initSql: string,
  checksum: string,
): Promise<EnsureSchemaResult>;
```

### 5.2 主入口

```ts
// src/scripts/migrate.ts 主流程
const sql = readFileSync('backend/database/init.sql', 'utf-8');
const checksum = createHash('sha256').update(sql).digest('hex');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const client = await pool.connect();
  try {
    const out = await ensureSchema(client, sql, checksum);
    console.log(`migrate: ${out.action} (checksum=${checksum.slice(0, 8)}…)`);
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
```

### 5.3 三态语义

| 当前状态 | 操作 | 结果 | 进程退出 |
|---|---|---|---|
| 首次（`_init_meta` 不存在） | BEGIN → 执行 init.sql → INSERT `_init_meta` → COMMIT | `action: 'applied'` | 0 |
| 已初始化 + checksum 一致 | SELECT `_init_meta.checksum` 比对 | `action: 'skipped'` | 0 |
| 已初始化 + checksum 漂移 | 抛 `InitSchemaDriftError` | — | 非 0 |
| 任何 SQL 错误 | ROLLBACK；删除部分表与 `_init_meta` 同时回滚 | 抛错 | 非 0 |

### 5.4 `src/test-utils/migrations.ts` 改造

- **删除** `through` 选项；
- **删除** `database/migrations/*.sql` 扫描；
- **新增** `runProjectInit(client, initSql, checksum)`：薄壳，调用 `ensureSchema`；
- 测试用例传入已隔离 schema 的 `client`（**不**通过 `withIsolatedSchema` 嵌套事务包裹 `ensureSchema`）。

---

## 6. 路由改造

### 6.1 全部 `requiresAuth: true` 路由接入包装器

```text
backend/src/server/routes/auth.ts
backend/src/server/routes/agents.ts
backend/src/server/routes/capabilities.ts
backend/src/server/routes/conversations.ts
backend/src/server/routes/knowledge-bases.ts
backend/src/server/routes/documents.ts
backend/src/server/routes/messages/ask.ts
backend/src/server/routes/messages/regenerate.ts
backend/src/server/routes/messages/stop.ts
backend/src/server/routes/skills.ts
backend/src/server/routes/tools.ts
```

每个 `registerApiRoute(...)` 调用，把原先直接定义的 `handler` 改为 `withAuthenticatedWorkspace(async (authCtx, ctx) => { ... })`，handler 内 Service 调用第一个参数传 `authCtx.workspaceId`。

**不**通过 `tools.ts` 写 `tool_executions`（写入在 `modules/conversations/tool-executions.ts`）。

### 6.2 错误映射中间件

新增（或合并到现有错误处理）：

```ts
function mapServiceErrorToResponse(error: unknown, ctx): Response {
  if (error instanceof ResourceNotFoundError || error instanceof CrossWorkspaceAccessError) {
    return ctx.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
  }
  if (error instanceof InputValidationError) {
    return ctx.json({ error_code: 'INPUT_VALIDATION_FAILED', message: error.message }, 422);
  }
  throw error;  // 500 默认路径
}
```

### 6.3 合约测试（沿用 `tests/contracts/run.ts` §8）

所有 `requiresAuth: true` 路由 handler 必须以 `withAuthenticatedWorkspace` 起始；CI 强制。覆盖范围扩大至 11 个路由文件。

---

## 7. 测试设计

### 7.1 `tests/integration/isolation-contract.ts`（替换 placeholder）

隔离 schema 内创建两个 workspace，依次验证：

| # | 用例 | 期望 |
|---|---|---|
| 1 | A 创建 conversation；B `listConversations` | B 看到 0 行 |
| 2 | A 的 conversationId；B `getConversationWithMessages` | null |
| 3 | A 的 conversationId；B `updateConversation` / `deleteConversation` | 抛 `ResourceNotFoundError` |
| 4 | A 的 conversationId；B `saveUserMessage` | 抛 `CrossWorkspaceAccessError` |
| 5 | A 的 messageId；B `updateAssistantStreaming` / `finalizeAssistant` / `resetAssistantForRetry` / `convergeAssistantToFailed` | JOIN 影响 0 行 / null |
| 6 | A 的 messageId；B `getMessageSnapshot` / `restoreAssistantFromSnapshot` | null |
| 7 | A 的 conversationId；B `touchConversation` / `updateConversationTitle` / `maybeUpdateTitleFromFirstMessage` | 0 行 / 标题未变 |
| 8 | A 的 kbId；B 给自己的 document 指定 A 的 kbId `createDocument` | 抛 `CrossWorkspaceAccessError` |
| 9 | A 的 documentId；B `getDocument` / `updateDocumentStatus` / `deleteDocument` | null / 0 行 / false |
| 10 | A 的 documentId；B `ingestDocument`（document_chunks 写入） | 抛错 |
| 11 | A 的 messageId；B `getToolExecutionsByMessage` | 0 行 |
| 12 | A 的 conversationId；B `createToolExecution`（伪 messageId 仍指向 A 的 message） | 抛错 |
| 13 | A 的 executionId；B `finalizeToolExecution` | 0 行 |
| 14 | 同一 `(agentId, skillId)` 分别 `bindSkillToAgent(A, ...)` 与 `bindSkillToAgent(B, ...)` | 两行共存 |
| 15 | A 调 `bindSkillToAgent`；B 调 `getAgentSkillBindings` | B 不见 A 的绑定 |
| 16 | `removeInstalledSkill(id)` → 验证 `agent_skill_bindings WHERE skill_id=id` | 0 行（无孤儿） |
| 17 | 删除 workspace A → A 的全部资源级联清理 | DB 验证 A 的 conversations/documents/messages/chunks/tool_executions/bindings 均为 0 行 |

每个 case 必须 try/finally + `dropIsolatedSchema()`。

### 7.2 `tests/integration/init-schema.test.ts`（新建）

每个 case **独立新建 schema** + try/finally + `dropIsolatedSchema()`；**不**嵌套 `withIsolatedSchema` 的外层事务。

| # | 用例 | 期望 |
|---|---|---|
| 1 | 全新 schema；首次调 `ensureSchema` | `action: 'applied'`；`_init_meta` + 全部业务表存在 |
| 2 | 同 checksum 重调 | `action: 'skipped'`；DB 不变 |
| 3 | 改 init.sql 内容（构造漂移）再调 | 抛 `InitSchemaDriftError`；DB 不变 |
| 4 | 首次执行中途失败（注入一个错误 SQL 片段） → 抛错后 | 事务完整回滚；`_init_meta` 与全部业务表均不存在（**用全新空 schema** 验证） |
| 5 | 不连接默认 `DATABASE_URL`（测试用注入 client） | 验证 main entry 不通过 `new Pool(process.env.DATABASE_URL)` 误连 |

### 7.3 沿用测试

- `tests/integration/workspace-context.ts` —— **39 项**（PR-1.1 已通过；保持）；不重复计算
- `tests/unit/workspace-context.ts` —— 单元测试覆盖 `ensurePersonalWorkspace`；**独立计数**
- `tests/contracts/run.ts` §8 —— 全部 `requiresAuth: true` 路由以 `withAuthenticatedWorkspace` 起始

---

## 8. 文档同步

| 文档 | 修改 |
|---|---|
| `docs/architecture-v2.md` §5.1 | 不再提"迁移编号"；明确"init.sql 单文件包含 workspaces / workspace_members 与 6 张业务表 workspace_id" |
| 同上 §5.3 | 删除"迁移顺序 8 步"；改为"删除数据库 + 跑 `npm run migrate` 一步到位"；删除 Legacy Workspace 段；删除 `LEGACY_WORKSPACE_OWNER_USER_ID` |
| 同上 §5.4 | 验收项合并为：本节列出的"两个 workspace 跨租户读写隔离"测试清单（17 项） |
| 同上 §8.6 | 改写为"`init.sql` 是 Schema 唯一来源；`npm run migrate` 执行 init.sql + 校验 checksum；不维护迁移链" |
| 同上 G-2 | 改写为"`init.sql` 是 Schema 唯一来源；`npm run migrate` 通过 checksum 防漂移；无迁移链" |
| `docs/implementation-plan.md` | PR-1.2 + PR-1.3 合并为单 PR；PR-1.4 **不**标记完成；PR-1.5 待本 PR 范围**完整**实现后才标完成 |
| `README.md` / `frontend/README.md` | "项目初始化跑 `npm run migrate`（执行唯一 `init.sql`）"；不再提 0001/0002/0003 或迁移链 |
| `.github/workflows/verify.yml` | 保留 `npm run migrate` 步骤；表述统一 |

---

## 9. 阶段标签

| 标签 | 状态 |
|---|---|
| PR-1.1 workspace 与会话身份上下文 | ✅ 已合并（PR-1.1 关闭） |
| PR-1.2 + PR-1.3 + PR-1.5 合并段 | ⏳ 本 spec 落地后标记完成 |
| PR-1.4 `skills_installed → skill_packages` | ❌ **不**标记完成（Schema 仍是 skills_installed）；留待后续 PR |
| 阶段 1 验收（V2 §5.4） | ⏳ 待隔离合约测试 17 项 + 跨 Workspace 404 全部通过后标记完成 |

---

## 10. 验收清单

- [ ] `backend/database/init.sql` 单文件包含全部表 + 索引 + 约束
- [ ] `backend/database/migrations/0001/0002/0003.sql` 已删除；目录为空
- [ ] 6 张业务表 `workspace_id NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`
- [ ] `agent_skill_bindings` PK = `(workspace_id, agent_id, skill_id)`
- [ ] 全部 `requiresAuth: true` 路由接入 `withAuthenticatedWorkspace`（CI §8 合约通过）
- [ ] `tests/integration/isolation-contract.ts` 17 项全过
- [ ] `tests/integration/init-schema.test.ts` 5 项全过（含漂移 / 回滚）
- [ ] 跨 Workspace HTTP 404 统一；UPDATE/DELETE `rowCount === 0` 抛 `ResourceNotFoundError`
- [ ] 后台幂等操作显式注释
- [ ] `resolveSkillsForAgent` 保持纯函数
- [ ] `removeInstalledSkill` 单连接单事务清理 bindings + skills_installed
- [ ] `npm run migrate` 三态正确（applied / skipped / 漂移抛错）
- [ ] `docs/architecture-v2.md` §5.1 / §5.3 / §5.4 / §8.6 / G-2 同步
- [ ] `docs/implementation-plan.md` PR 段同步
- [ ] `README.md` / `frontend/README.md` 表述统一