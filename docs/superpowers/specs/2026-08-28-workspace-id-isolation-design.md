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
CREATE INDEX document_chunks_workspace_kb_idx
  ON document_chunks(workspace_id, knowledge_base_id);
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

### 3.0 适用范围（修正 §3.1 表述过宽）

本节"必须接受 `workspaceId`"的覆盖范围：

**包含**：
- 任何**读写 6 张归属表**（`conversations` / `knowledge_bases` / `documents` / `document_chunks` / `tool_executions` / `agent_skill_bindings`）的函数；
- 任何**通过 `messages.conversation_id` 间接归属**的 message 函数（JOIN `conversations.workspace_id` 校验）；
- 任何**经 ask / regenerate / stop 链路**触发的执行器（`streamAgent`、`AskStreamInput`、`tool-event.ts`、`message-finalize.ts`、`searchKnowledgeBase` 等）。

**不包含**（不在本节范围内）：
- 认证 / 健康检查（`/auth/*`、`/healthz`、`/readyz`）—— 无 workspace 维度；
- **全局 Skill 目录** `skills_installed` —— 全局共享；删除走 `removeInstalledSkill` 全局级联（§3.8）；
- Provider Registry、Tool Definition 等代码级全局注册。

### 3.1 通用规则

1. **所有访问 Workspace 归属表及其子资源的函数**首参数为 `workspaceId: string`（位置参数）；**保留**原有 `input` 对象不变；
2. **跨 Workspace 访问**（按函数语义区分）：
   - **查询**（GET 类，如 `getConversation`、`getDocument`、`getMessageSnapshot`）：读不到 → 返回 `null`；**不**抛错；
   - **用户资源操作**（POST/PATCH/DELETE 类，如 `updateConversation`、`deleteDocument`、`finalizeAssistant`）：`rowCount === 0` → 抛 `ResourceNotFoundError`；父资源 JOIN 校验失败 → 抛 `CrossWorkspaceAccessError`；
   - **内部幂等终态写入**（如 `resetAssistantForRetry`、`convergeAssistantToFailed`、`convergeRunningToolExecutions`）：允许 0 行影响；**必须**在函数体内显式注释 `// internal idempotent: rowCount may be 0`；
3. **路由层错误映射**（详见 §4）：
   - `ResourceNotFoundError` / `CrossWorkspaceAccessError` → 404
   - 其他 → 500
4. **Skill 隔离调用顺序**：`getAgentSkillBindings(workspaceId, agentId)` → `resolveSkillsForAgent(agentId, skillIds)`（`resolveSkillsForAgent` 保持纯函数）。
5. **ask / regenerate / stop 链路**必须显式传递 `workspaceId`（详见 §3.10 传播链）。

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
const client = await pool.connect();
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

### 3.9 Workspace 上下文传播链（链路必须显式传 `workspaceId`）

下列调用方**当前**直接读 / 写归属表但**未**按 workspace 过滤；本次必须把 `workspaceId` 显式补进链路。`ask / regenerate / stop` 链路是热路径，缺一不可。

```text
ask / regenerate 路由 handler
  ├─ AskStreamInput { workspaceId, conversationId, messageId, content, citations }
  │     └─ streamAgent(workspaceId, agentId, input)
  │           ├─ searchKnowledgeBase(workspaceId, knowledgeBaseId, options)
  │           │     └─ document_chunks 按 (workspace_id, knowledge_base_id) 查询
  │           ├─ Tool Gateway：所有 Tool 调用通过 tool-event Sink 上报
  │           │     └─ tool-event.ts Sink.appendToolCall(workspaceId, ...)
  │           ├─ message-finalize.ts：终态写入
  │           │     └─ finalizeAssistant(workspaceId, messageId, content, citations)
  │           └─ conversation/touchConversation(workspaceId, conversationId)
  └─ tool-executions Service（createToolExecution → finalizeToolExecution）
```

**逐点修订清单**：

| 文件 / 函数 | 当前问题 | 修订 |
|---|---|---|
| `backend/src/server/routes/agents.ts` | 直接读 `agent_skill_bindings`，未按 workspace 过滤 | 调用 `getAgentSkillBindings(workspaceId, agentId)` 替代直接 SELECT |
| `backend/src/server/routes/messages/regenerate.ts` | 直接按 messageId 读 / 写 message | 通过 `getMessageSnapshot(workspaceId, messageId)` / `restoreAssistantFromSnapshot(workspaceId, ...)` 走 JOIN 校验 |
| `backend/src/server/routes/messages/stop.ts` | 直接按 messageId / conversationId 更新 Run 状态 | 走 `convergeAssistantToFailed(workspaceId, messageId)` / `convergeRunningToolExecutions(workspaceId, conversationId)` |
| `modules/knowledge/rag/retriever.ts`（`searchKnowledgeBase`） | 无 `workspaceId` | 首参数 `(workspaceId, knowledgeBaseId, options)`；查询 `document_chunks WHERE workspace_id=$1 AND knowledge_base_id=$2` |
| `core/agent/runtime.ts`（`streamAgent`） / `AskStreamInput` | 类型不传 `workspaceId` | `streamAgent(workspaceId, agentId, input)`；`AskStreamInput.workspaceId: string` |
| `core/execution/tool-event.ts`（Sink） | 写入 tool_calls 时无 workspace 归属 | `appendToolCall(workspaceId, runId, toolCall)` |
| `core/execution/message-finalize.ts`（Finalizer） | 直接 `UPDATE messages` 无 workspace 校验 | `finalizeAssistant(workspaceId, messageId, content, citations)` |
| `backend/src/scripts/ask.ts`（CLI 调试） | 调用 `streamAgent`，需 workspaceId | 由用户参数 `--workspace <id>` 传入；或先 `ensurePersonalWorkspace(userId)` 拿到；测试桩默认注入 |

**注册环节**：`withAuthenticatedWorkspace` 包装器当前已注入 `authCtx.workspaceId`；上述链路内的所有 Service / Runtime 调用必须接 `workspaceId`，**不得**通过 `body.workspaceId` / `?workspaceId=` / `X-Workspace-Id` 等客户端字段获取。

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
| **无有效 Session**（包装器层面 `resolveAuthenticatedContext` 返回 null） | 401 | `{ error_code: 'UNAUTHENTICATED', message: '未登录或会话已失效。' }` |
| `ResourceNotFoundError`（Service 抛 / 用户触发的 UPDATE/DELETE `rowCount === 0`） | 404 | `{ error_code: 'NOT_FOUND', message: '资源不存在。' }` |
| `CrossWorkspaceAccessError` | 404 | `{ error_code: 'NOT_FOUND', message: '资源不存在。' }`（与未授权访问同响应；不暴露存在性） |
| `InputValidationError` | 422 | `{ error_code: 'INPUT_VALIDATION_FAILED', message }` |
| `WorkspaceContextError` / `UserNotFoundError` / `WorkspaceIntegrityError` / DB 错误 | **500** | 不暴露内部细节；记录 `security_events` / 日志 |

**严格区分**：
- **401 仅**用于"无有效 Session"。`UserNotFoundError`（用户被禁用 / 删除）、`WorkspaceContextError`（Personal Workspace 缺失 / 数据约束破坏）、`WorkspaceIntegrityError` 都是服务端完整性问题，**不**伪装为未登录 —— 这是 PR-1.1 落地约束；
- **403 禁止** —— 跨 workspace 访问统一 404，避免暴露资源存在性。

### 4.3 后台幂等操作

下列函数允许 `rowCount === 0` 且**不**抛错，但必须在函数体内注释：

```ts
// internal idempotent: rowCount may be 0 (background convergence / terminal state writes)
```

涉及函数：`resetAssistantForRetry` / `convergeAssistantToFailed` / `convergeRunningToolExecutions`。
**不**适用于用户请求触发的 UPDATE / DELETE（如 `updateConversation`、`deleteDocument`、`finalizeAssistant`）—— 这些 0 行必须抛 `ResourceNotFoundError`。

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
 *   - 首次（`current_schema()._init_meta` 不存在）→ 单事务执行 init.sql + INSERT _init_meta；
 *   - 已初始化且 checksum 一致 → skipped；
 *   - 已初始化但 checksum 漂移 → 抛 InitSchemaDriftError（**不**返回 action='drift'）。
 *
 * 事务边界：自管 BEGIN / COMMIT / ROLLBACK；不接受已处于事务内的 PoolClient。
 *
 * Schema 限定：`SELECT to_regclass(format('%I._init_meta', current_schema()))`，
 * 配合 `SET search_path` 时仍只在当前 schema 检测元数据表，**不**误读 public / 其他 schema。
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
| 首次（`current_schema()._init_meta` 不存在） | BEGIN → 执行 init.sql → INSERT `_init_meta` → COMMIT | `action: 'applied'` | 0 |
| 已初始化 + checksum 一致 | SELECT `current_schema()._init_meta.checksum` 比对 | `action: 'skipped'` | 0 |
| 已初始化 + checksum 漂移 | 抛 `InitSchemaDriftError` | — | 非 0 |
| 任何 SQL 错误 | ROLLBACK；删除部分表与 `_init_meta` 同时回滚 | 抛错 | 非 0 |

**Schema 限定细则**：所有 `_init_meta` 引用都必须按 `format('%I._init_meta', current_schema())` 形式限定；`SELECT _init_meta` 这种不限定 schema 的写法在测试 schema + public 并存时会误读 public 表，必须禁止。

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
| 9 | A 的 documentId；B 调用 `getDocument` / `updateDocumentStatus` / `deleteDocument` | `getDocument` → null（查询函数）；`updateDocumentStatus` → 抛 `ResourceNotFoundError`（用户资源写）；`deleteDocument` → 抛 `ResourceNotFoundError` |
| 10 | A 的 documentId；B `ingestDocument`（document_chunks 写入） | 抛错 |
| 11 | A 的 messageId；B `getToolExecutionsByMessage` | 0 行 |
| 12 | A 的 conversationId；B `createToolExecution`（伪 messageId 仍指向 A 的 message） | 抛错 |
| 13 | A 的 executionId；B `finalizeToolExecution` | 0 行（**user-triggered** UPDATE；抛 `ResourceNotFoundError`） |
| 14 | 同一 `(agentId, skillId)` 分别 `bindSkillToAgent(A, ...)` 与 `bindSkillToAgent(B, ...)` | 两行共存 |
| 15 | A 调 `bindSkillToAgent`；B 调 `getAgentSkillBindings` | B 不见 A 的绑定 |
| 16 | `removeInstalledSkill(id)` → 验证 `agent_skill_bindings WHERE skill_id=id` | 0 行（无孤儿） |
| 17 | 删除 workspace A → A 的全部资源级联清理 | DB 验证 A 的 `conversations` / `documents` / `messages` / `document_chunks` / `tool_executions` / `agent_skill_bindings` / `knowledge_bases` / `workspace_members` 均为 0 行 |

**§3.1 契约 → 测试期望映射表**（每个 Service 函数显式标注）：

| 函数 | 类别 | 期望 |
|---|---|---|
| `getConversation` / `getDocument` / `getKnowledgeBase` / `getMessageSnapshot` 等 | 查询 | 跨 workspace 返回 `null`；不抛错 |
| `listConversations` / `listDocuments` / `listKnowledgeBases` / `getAgentSkillBindings` / `getToolExecutionsByMessage` | 列表查询 | 跨 workspace 返回空数组 |
| `updateConversation` / `deleteConversation` / `updateKnowledgeBase` / `deleteKnowledgeBase` / `updateDocumentStatus` / `deleteDocument` / `finalizeAssistant` / `finalizeToolExecution` | 用户资源操作 | 跨 workspace 抛 `ResourceNotFoundError` |
| `saveUserMessage` / `saveAssistantMessage` / `createAssistantPending` / `createDocument` / `createToolExecution` / `bindSkillToAgent` | JOIN 父资源校验 | 父资源 workspace 不匹配 → 抛 `CrossWorkspaceAccessError` |
| `resetAssistantForRetry` / `convergeAssistantToFailed` / `convergeRunningToolExecutions` | 内部幂等终态写入 | 允许 0 行；**显式** `// internal idempotent` 注释 |

每个 case 必须 try/finally + `dropIsolatedSchema()`。

### 7.2 `tests/integration/init-schema.test.ts`（新建）

每个 case **独立新建 schema** + try/finally + `dropIsolatedSchema()`；**不**嵌套 `withIsolatedSchema` 的外层事务（§5 主入口不接受已事务 client）。

| # | 用例 | 期望 |
|---|---|---|
| 1 | 全新 schema；首次调 `ensureSchema` | `action: 'applied'`；`_init_meta` + 全部业务表存在 |
| 2 | 同 checksum 重调 | `action: 'skipped'`；DB 不变 |
| 3 | 改 init.sql 内容（构造漂移）再调 | 抛 `InitSchemaDriftError`；DB 不变 |
| 4 | 首次执行中途失败（注入一个错误 SQL 片段） → 抛错后 | 事务完整回滚；`_init_meta` 与全部业务表均不存在（**用全新空 schema** 验证） |
| 5 | 验证 `runProjectInit` / `ensureSchema` **只使用注入 client**，不读 `process.env.DATABASE_URL` | 静态契约测试 / DI 单测：grep `ensureSchema` 函数体内无 `process.env` / `new Pool(` 引用；测试桩传 client 即可运行，不依赖默认连接串 |

### 7.3 错误映射单元测试（`tests/unit/error-mapping.test.ts`，新建）

| # | 用例 | 期望 |
|---|---|---|
| 1 | `ResourceNotFoundError` → 路由映射 | 404 `{ error_code: 'NOT_FOUND', message: '资源不存在。' }` |
| 2 | `CrossWorkspaceAccessError` → 路由映射 | 404，与 #1 **响应体完全一致**（字节级断言） |
| 3 | `InputValidationError` → 路由映射 | 422 `{ error_code: 'INPUT_VALIDATION_FAILED', message }` |
| 4 | `UserNotFoundError` → 路由映射 | **500**，**不**映射为 401（响应体不暴露内部细节） |
| 5 | `WorkspaceContextError` → 路由映射 | **500**，**不**映射为 401 |
| 6 | `WorkspaceIntegrityError` → 路由映射 | **500** |
| 7 | 任意其它 `Error` → 路由映射 | 500 |

### 7.4 Handler 级跨 Workspace 404 集成测试（`tests/integration/handler-isolation.test.ts`，新建）

**不**依赖 Service 单测；**必须**启动真实 `withAuthenticatedWorkspace` 包装器 + 真实路由 handler，对比 Workspace A 持有与 Workspace B 持有时 HTTP 响应体字节级一致。

每个 case：两个隔离 workspace（A、B）；A 创建资源；B 用同一资源 ID 发请求。

| # | 资源类型 | 路由 | B 请求 | 期望响应 |
|---|---|---|---|---|
| 1 | conversation | `GET /api/conversations/:id`（或等价 handler） | 404 `{ error_code: 'NOT_FOUND', message: '资源不存在。' }` |
| 2 | knowledge_base | `GET /api/knowledge-bases/:id` | 同上 |
| 3 | document | `GET /api/documents/:id` | 同上 |
| 4 | message | `GET /api/conversations/:id/messages`（B 持有的 conversationId 但 messageId 来自 A） | 同上 |
| 5 | （额外）conversation | `DELETE /api/conversations/:id`（B 用 A 的 id） | 同上 |
| 6 | （额外）document | `PATCH /api/documents/:id`（B 用 A 的 id） | 同上 |

**字节级断言**：B 的 404 响应体**与** A 调真实资源不存在的 404 响应体**完全一致**（包括 `error_code` / `message` / JSON 字段顺序）。任何差异（消息文案不同、暴露存在性的痕迹）都直接挂测试。

### 7.5 沿用测试

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
| `docs/development.md` § 数据库变更 | 删除"按序应用 migrations/*.sql"表述；改为"`npm run migrate` 执行单一 `init.sql` 并校验 SHA-256；不维护迁移链；如需调整 Schema，修改 `init.sql` 后删库重建即可"。与本 spec §2 / §5 完全对齐；旧"迁移编号 0001/0002/0003"段落整段删除。 |
| `docs/implementation-plan.md` | PR-1.2 + PR-1.3 合并为单 PR；PR-1.4 **不**标记完成；PR-1.5 待本 PR 范围**完整**实现后才标完成 |
| `README.md` / `frontend/README.md` | "项目初始化跑 `npm run migrate`（执行唯一 `init.sql`）"；不再提 0001/0002/0003 或迁移链 |
| `.github/workflows/verify.yml` | 保留 `npm run migrate` 步骤；表述统一 |

**历史修订记录保留原则**：任何**已存档**的修订日志（`docs/implementation-plan.md` 历史段、`docs/architecture-v2.md` 历史快照、commit message 历史）**保持原样**；**不**回溯改写。仅在每个文件的**当前生效小节顶部**标注一行：

> 已被本次单一 init.sql 裁决覆盖：迁移链 / Legacy Workspace / `LEGACY_WORKSPACE_OWNER_USER_ID` / PR-1.4 重命名 — 详见 `docs/superpowers/specs/2026-08-28-workspace-id-isolation-design.md`。

让读者一眼看到"该文档的过时表述已经被裁决覆盖、以 Spec 为准"，同时保留审计轨迹。

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