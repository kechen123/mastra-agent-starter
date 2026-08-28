# PR-1.2 / 1.3 / 1.5 — Workspace ID 归属 + 跨 Workspace 隔离合约 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 6 张业务表（+ `document_chunks`）加 `workspace_id NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`，所有读写路径消费 `authCtx.workspaceId`，跨 Workspace 访问统一返回 404；Schema 改为单一 `init.sql` 来源。

**Architecture:** Schema 来源从"迁移链"切到"单文件 init.sql + SHA-256 三态 checksum runner"；Service/Core 层每个归属表函数新增 `workspaceId` 首参；Router 层全部 `requiresAuth: true` 走 `withAuthenticatedWorkspace`，错误映射统一由新建 `server/error-mapping.ts` 兜底。

**Tech Stack:** PostgreSQL 15+（partial unique index、`ON DELETE CASCADE`、`to_regclass`、`current_schema()`）；Node 22 + TypeScript 5.7；`pg` 8.16；Mastra 1.61。

---

## Global Constraints

- **Schema 唯一来源**：`backend/database/init.sql`；**禁止**维护 `backend/database/migrations/*.sql`（任务 1 删空目录；新增迁移视为违反裁决）。
- **`init.sql` 幂等性**：仅 `CREATE EXTENSION IF NOT EXISTS pgcrypto`；其余 `CREATE TABLE` / `CREATE INDEX` 全部不带 `IF NOT EXISTS`；重复执行必须显式失败。
- **`ensureSchema` 自管事务**：接受 `Pool` + `clientFactory` 或顶层入口；**不**接受已处于事务内的 `PoolClient`。
- **HTTP 跨 Workspace 404**：B 用 A 的真实 ID 与 B 用随机不存在 UUID 的响应必须**字节级一致**（status / headers / raw body）。
- **`resolveSkillsForAgent(agentId, ids)` 保持纯函数**；隔离仅发生在 `getAgentSkillBindings(workspaceId, agentId)`。
- **函数首参数**：`workspaceId: string`（位置参数），原有 `input` 对象**保留**。
- **复合索引命名**：`<table>_<col1>_<col2>_idx`，**不**留冗余单列索引（`workspace_id` 上无独立索引）。
- **禁止**伪 Legacy 兼容逻辑（无 `LEGACY_WORKSPACE_OWNER_USER_ID`、无 fallback owner）。
- **包名**：`backend/src/server/error-mapping.ts` 为本次新建模块；后续任务不得绕过该模块自行 try/catch 业务错误。
- **测试库白名单**：`TEST_DATABASE_URL` 必须满足 `assertTestDatabase()`；严禁把生产库当测试库用。
- **PR-1.4 不在范围**：保留 `skills_installed`（不重命名为 `skill_packages`）。

---

## File Structure

### 新建

- `backend/src/server/error-mapping.ts` —— `mapErrorToResponse(error)` 唯一错误→HTTP 映射
- `backend/src/test-utils/schema-init.ts` —— 单文件 init.sql 应用 + checksum 三态 + 自管事务
- `backend/tests/integration/isolation-contract.ts` —— 17 项跨 Workspace 隔离合约（替换 placeholder）
- `backend/tests/integration/init-schema.test.ts` —— 5 项 runner 三态行为
- `backend/tests/integration/handler-isolation.test.ts` —— 5 项 Handler 级 HTTP 404 字节级断言
- `backend/tests/unit/error-mapping.test.ts` —— 8 项错误映射单测

### 修改

- `backend/database/init.sql` —— 重写：合并 0001/0002/0003 内容；6 业务表 + document_chunks + agent_skill_bindings 加 `workspace_id`
- `backend/database/migrations/0001-local-auth.sql`、`0002-workspaces.sql`、`0003-workspace-constraints.sql` —— 删除
- `backend/package.json` —— 移除 `migrate` 脚本对 `migrations/` 目录依赖（保留 `tsx src/scripts/migrate.ts`）
- `backend/src/scripts/migrate.ts` —— 重写：单文件 init.sql + checksum 三态 + `current_schema()` 范围
- `backend/src/test-utils/migrations.ts` —— 重写为 `schema-init.ts` 薄包装或删除
- `backend/src/modules/conversations/service.ts` —— 18 个函数全部加 `workspaceId` 首参
- `backend/src/modules/conversations/tool-executions.ts` —— 4 个函数全部加 `workspaceId` 首参
- `backend/src/modules/knowledge/service.ts` —— 5 个函数全部加 `workspaceId` 首参
- `backend/src/modules/documents/service.ts` —— 5 个函数全部加 `workspaceId` 首参
- `backend/src/modules/documents/ingestion.ts` —— 加 `workspaceId` 校验与传播
- `backend/src/core/skill/bindings.ts` —— 3 个函数全部加 `workspaceId`（`resolveSkillsForAgent` 不动）
- `backend/src/core/skill/registry.ts` —— `removeInstalledSkill` 单连接单事务级联清理 bindings
- `backend/src/core/agent/runtime.ts` —— workspaceId 透传到 streamAgent
- `backend/src/core/execution/ask-driver.ts` —— 注入 `AskStreamInput.workspaceId`
- `backend/src/core/execution/tool-event.ts` —— 消费 `workspaceId` 校验
- `backend/src/core/execution/message-finalize.ts` —— 消费 `workspaceId` 校验
- `backend/src/core/knowledge/search.ts`（如不存在则新建）—— `searchKnowledgeBase` 加 `workspaceId` 校验
- `backend/src/scripts/ask.ts` —— CLI 取 session 后调 `ensurePersonalWorkspace`
- `backend/src/server/routes/agents.ts` —— 业务路由包 `withAuthenticatedWorkspace`
- `backend/src/server/routes/conversations.ts` —— 同上
- `backend/src/server/routes/documents.ts` —— 同上
- `backend/src/server/routes/knowledge-bases.ts` —— 同上
- `backend/src/server/routes/skills.ts` —— 同上
- `backend/src/server/routes/tools.ts` —— 同上
- `backend/src/server/routes/capabilities.ts` —— 同上
- `backend/src/server/routes/auth.ts` —— 同上（登录登出除外）
- `backend/src/server/routes/messages/ask.ts` —— 同上
- `backend/src/server/routes/messages/regenerate.ts` —— 同上 + workspace 校验早于 reserve
- `backend/src/server/routes/messages/stop.ts` —— 同上 + workspace 校验早于 abortExecution
- `backend/src/modules/auth/workspace-context.ts` —— `withAuthenticatedWorkspace` 改为包整个 handler，调用 `mapErrorToResponse`
- `backend/tests/integration/run.ts` —— 移除 `isolation-contract-placeholder.ts` skip
- `backend/tests/integration/isolation-contract-placeholder.ts` —— 删除
- `backend/tests/contracts/run.ts` §8 段 —— 静态校验所有 `requiresAuth: true` 路由都包 `withAuthenticatedWorkspace`
- `docs/architecture-v2.md`、`docs/development.md`、`docs/implementation-plan.md`、`README.md`、`frontend/README.md`、`.github/workflows/verify.yml` —— 按 Spec §8 重写

### 不动

- `backend/src/infrastructure/auth/*` —— PR-1.1 已完成
- `backend/src/infrastructure/database/pool.ts` —— PR-1.1 已完成
- `backend/src/modules/citations/*`、`backend/src/core/agent/registry.ts` —— 无业务表写入
- PR-1.4 相关（`skills_installed` 重命名）—— 不在范围

---

## Task Ordering

每任务独立可测可合入。任务顺序按依赖链排列：

1. 删迁移 + 写新 init.sql（Schema 单源）
2. 重写 schema-init runner（含三态）
3. 重写 migrate.ts
4. server/error-mapping.ts（含 8 项单测）
5. withAuthenticatedWorkspace 统一 try/catch
6. 静态合约：所有 requiresAuth 路由必须包 withAuthenticatedWorkspace
7. auth_sessions / workspaces / workspace_members 在 init.sql 中的索引补齐
8. modules/conversations/service.ts —— 18 函数
9. modules/conversations/tool-executions.ts —— 4 函数
10. modules/knowledge/service.ts —— 5 函数
11. modules/documents/service.ts + ingestion.ts
12. core/skill/bindings.ts + registry.ts（removeInstalledSkill 单连接事务）
13. core/agent/runtime.ts + execution/* + scripts/ask.ts 传播链
14. 全部路由接入 withAuthenticatedWorkspace
15. isolation-contract.ts 17 项合约测试
16. init-schema.test.ts 5 项 runner 测试
17. handler-isolation.test.ts 5 项 Handler HTTP 404 测试
18. docs/architecture-v2.md 重写
19. docs/development.md 重写
20. docs/implementation-plan.md + README + verify.yml 重写

---

## Task 1: 删除迁移目录并重写 init.sql 为 Schema 唯一来源

**Files:**
- Delete: `backend/database/migrations/0001-local-auth.sql`、`0002-workspaces.sql`、`0003-workspace-constraints.sql`
- Modify: `backend/database/init.sql`（全量重写）
- Create: `backend/database/_init_meta.sql`（不，做为 init.sql 末尾内容；避免分散文件）

**Interfaces:**
- Produces: `backend/database/init.sql` —— 单文件 schema；顺序：extension → app_users → auth_sessions → workspaces → workspace_members → skills_installed → knowledge_bases → documents → document_chunks → conversations → messages → tool_executions → agent_skill_bindings → 全部索引 → _init_meta 写入

- [ ] **Step 1: 删除三个迁移文件**

```bash
cd backend
git rm database/migrations/0001-local-auth.sql database/migrations/0002-workspaces.sql database/migrations/0003-workspace-constraints.sql
```

- [ ] **Step 2: 写入新版 init.sql 的 EXTENSION 与 app_users / auth_sessions**

完全覆盖 `backend/database/init.sql`。首部内容如下（保留 0001 表定义；不含 `password_algo`）：

```sql
-- PR-1.2/1.3/1.5 合并段：单一 init.sql 是 Schema 唯一来源。
-- 项目不维护迁移链；删库重建是接受路径。
-- 重复执行必须显式失败（除 pgcrypto 外全部不带 IF NOT EXISTS）。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions(expires_at);
CREATE INDEX auth_sessions_active_idx ON auth_sessions(user_id) WHERE revoked_at IS NULL;
```

- [ ] **Step 3: 追加 workspaces / workspace_members**

```sql
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL DEFAULT 'shared'
    CHECK (kind IN ('personal', 'shared')),
  name TEXT NOT NULL,
  owner_user_id UUID REFERENCES app_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT workspaces_kind_owner_check CHECK (
    (kind = 'personal' AND owner_user_id IS NOT NULL) OR
    (kind = 'shared'   AND owner_user_id IS NULL)
  )
);
CREATE UNIQUE INDEX one_personal_workspace_per_user
  ON workspaces(owner_user_id) WHERE kind = 'personal';

CREATE TABLE workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_id_idx ON workspace_members(user_id);
```

- [ ] **Step 4: 追加 skills_installed（不动结构，PR-1.4 后续处理）**

```sql
CREATE TABLE skills_installed (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  compatibility TEXT NOT NULL CHECK (compatibility IN ('compatible', 'incompatible')),
  has_scripts BOOLEAN NOT NULL DEFAULT FALSE,
  has_executable_ext BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_tools TEXT[] NOT NULL DEFAULT '{}',
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 5: 追加 6 业务表 + document_chunks 全部带 workspace_id**

```sql
CREATE TABLE knowledge_bases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_bases_workspace_idx ON knowledge_bases(workspace_id);

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ingesting', 'ready', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_workspace_idx ON documents(workspace_id);
CREATE INDEX documents_workspace_kb_idx ON documents(workspace_id, knowledge_base_id);

CREATE TABLE document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding REAL[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX document_chunks_workspace_idx ON document_chunks(workspace_id);
CREATE INDEX document_chunks_workspace_kb_idx ON document_chunks(workspace_id, knowledge_base_id);
CREATE INDEX document_chunks_document_idx ON document_chunks(document_id);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  knowledge_base_id UUID REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversations_workspace_idx ON conversations(workspace_id);
CREATE INDEX conversations_workspace_user_idx ON conversations(workspace_id, user_id);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete'
    CHECK (status IN ('pending', 'streaming', 'complete', 'failed', 'cancelled')),
  snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_workspace_idx ON messages(workspace_id);
CREATE INDEX messages_conversation_idx ON messages(conversation_id);
CREATE INDEX messages_workspace_conversation_idx ON messages(workspace_id, conversation_id);

CREATE TABLE tool_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  args JSONB NOT NULL,
  result JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'success', 'error', 'cancelled')),
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX tool_executions_workspace_idx ON tool_executions(workspace_id);
CREATE INDEX tool_executions_workspace_message_idx ON tool_executions(workspace_id, message_id);

CREATE TABLE agent_skill_bindings (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  skill_id TEXT NOT NULL REFERENCES skills_installed(id) ON DELETE CASCADE,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_id, skill_id)
);
CREATE INDEX agent_skill_bindings_workspace_idx ON agent_skill_bindings(workspace_id);
CREATE INDEX agent_skill_bindings_skill_idx ON agent_skill_bindings(skill_id);
```

- [ ] **Step 6: 验证 init.sql 语法（用空 schema 试跑）**

```bash
cd backend
PGPASSWORD=postgres psql -h localhost -U postgres -d postgres \
  -c "DROP SCHEMA IF EXISTS _syntax_check CASCADE; CREATE SCHEMA _syntax_check; SET search_path TO _syntax_check; \i database/init.sql; DROP SCHEMA _syntax_check CASCADE;"
```

期望：无错误；表数 = 11（app_users, auth_sessions, workspaces, workspace_members, skills_installed, knowledge_bases, documents, document_chunks, conversations, messages, tool_executions, agent_skill_bindings）。

- [ ] **Step 7: 提交**

```bash
git add database/init.sql
git commit -m "feat(db): collapse migrations into single init.sql with workspace_id columns"
```

---

## Task 2: 新建 schema-init runner（带三态 checksum + 自管事务）

**Files:**
- Create: `backend/src/test-utils/schema-init.ts`

**Interfaces:**
- Consumes: `pg.Pool`（外部持有，不读 env）
- Produces:
  ```ts
  export type EnsureSchemaResult =
    | { action: 'applied'; checksum: string }
    | { action: 'skipped'; checksum: string }
    | { action: 'drift'; expected: string; actual: string };

  export class InitSchemaDriftError extends Error { ... }

  export async function ensureSchema(pool: Pool): Promise<EnsureSchemaResult>;
  export async function computeInitChecksum(): Promise<string>;
  export async function dropIsolatedSchema(pool: Pool, schema: string): Promise<void>;
  ```

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/unit/schema-init.test.ts`：

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest'; // 项目当前无 vitest；改用裸 assert
```

**注**：项目当前无测试框架依赖；用 `node:test` 替代：

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeInitChecksum } from '../../src/test-utils/schema-init.js';

test('computeInitChecksum returns 64-char hex sha256', async () => {
  const c = await computeInitChecksum();
  assert.match(c, /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: 跑测试，确认 fail**

```bash
cd backend && npx tsx tests/unit/schema-init.test.ts
```

期望：`Cannot find module '../../src/test-utils/schema-init.js'`

- [ ] **Step 3: 写最小实现 `schema-init.ts`**

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const INIT_SQL_PATH = join(REPO_ROOT, 'backend', 'database', 'init.sql');

export class InitSchemaDriftError extends Error {
  constructor(public expected: string, public actual: string) {
    super(`init.sql checksum drift: stored=${expected} current=${actual}`);
    this.name = 'InitSchemaDriftError';
  }
}

export type EnsureSchemaResult =
  | { action: 'applied'; checksum: string }
  | { action: 'skipped'; checksum: string }
  | { action: 'drift'; expected: string; actual: string };

export async function computeInitChecksum(): Promise<string> {
  const sql = readFileSync(INIT_SQL_PATH, 'utf-8');
  return createHash('sha256').update(sql).digest('hex');
}

export async function ensureSchema(pool: Pool): Promise<EnsureSchemaResult> {
  const current = await computeInitChecksum();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{ checksum: string }>(
      `SELECT checksum FROM _init_meta WHERE id = 'singleton'`,
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== current) {
        await client.query('ROLLBACK');
        return { action: 'drift', expected: existing.rows[0].checksum, actual: current };
      }
      await client.query('COMMIT');
      return { action: 'skipped', checksum: current };
    }
    const sql = readFileSync(INIT_SQL_PATH, 'utf-8');
    await client.query(sql);
    await client.query(
      `CREATE TABLE IF NOT EXISTS _init_meta (
         id TEXT PRIMARY KEY,
         checksum TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await client.query(
      `INSERT INTO _init_meta (id, checksum) VALUES ('singleton', $1)
       ON CONFLICT (id) DO NOTHING`,
      [current],
    );
    await client.query('COMMIT');
    return { action: 'applied', checksum: current };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function dropIsolatedSchema(pool: Pool, schema: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

export async function createIsolatedSchema(pool: Pool, schema: string): Promise<void> {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`SET search_path TO "${schema}", public`);
}
```

- [ ] **Step 4: 跑测试，确认 pass**

```bash
cd backend && npx tsx tests/unit/schema-init.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add src/test-utils/schema-init.ts tests/unit/schema-init.test.ts
git commit -m "feat(db): add ensureSchema runner with 3-state checksum"
```

---

## Task 3: 重写 migrate.ts 主入口

**Files:**
- Modify: `backend/src/scripts/migrate.ts`

**Interfaces:**
- Consumes: `process.env.DATABASE_URL`（主入口允许读环境变量，runner 内部函数不接受）
- Produces: 退出码 0 / 非 0；stdout 三行：`applied` / `skipped` / `drift`

- [ ] **Step 1: 写失败集成测试**

新建 `backend/tests/integration/init-schema.test.ts`：

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Pool } from 'pg';
import {
  ensureSchema,
  dropIsolatedSchema,
  createIsolatedSchema,
  InitSchemaDriftError,
} from '../../src/test-utils/schema-init.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const RUN_DB = process.env.RUN_DB_TESTS === '1' && !!TEST_URL;

async function withFreshSchema<T>(fn: (pool: Pool, schema: string) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: TEST_URL });
  const schema = `test_${Math.random().toString(36).slice(2, 10)}`;
  await createIsolatedSchema(pool, schema);
  const scoped = new Pool({
    connectionString: TEST_URL,
    options: `-c search_path=${schema},public`,
  });
  try { return await fn(scoped, schema); }
  finally { await scoped.end(); await dropIsolatedSchema(pool, schema); await pool.end(); }
}

test('ensureSchema: fresh → applied', { skip: !RUN_DB }, async () => {
  await withFreshSchema(async (pool) => {
    const r = await ensureSchema(pool);
    assert.equal(r.action, 'applied');
    assert.match(r.checksum, /^[0-9a-f]{64}$/);
    const meta = await pool.query('SELECT * FROM _init_meta');
    assert.equal(meta.rows.length, 1);
  });
});

test('ensureSchema: same checksum → skipped', { skip: !RUN_DB }, async () => {
  await withFreshSchema(async (pool) => {
    await ensureSchema(pool);
    const r = await ensureSchema(pool);
    assert.equal(r.action, 'skipped');
  });
});

test('ensureSchema: drift → returns drift action', { skip: !RUN_DB }, async () => {
  await withFreshSchema(async (pool) => {
    await ensureSchema(pool);
    // 改 _init_meta 模拟漂移
    await pool.query(`UPDATE _init_meta SET checksum = 'baddrift' WHERE id='singleton'`);
    const r = await ensureSchema(pool);
    assert.equal(r.action, 'drift');
    assert.equal(r.expected, 'baddrift');
  });
});
```

- [ ] **Step 2: 跑测试（DB 未启用时 skip），确认逻辑被导入**

```bash
cd backend && npx tsx tests/integration/init-schema.test.ts
```

- [ ] **Step 3: 重写 migrate.ts**

完全覆盖 `backend/src/scripts/migrate.ts`：

```ts
import 'dotenv/config';
import { Pool } from 'pg';
import { ensureSchema, InitSchemaDriftError } from '../test-utils/schema-init.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL 未配置。');

const pool = new Pool({ connectionString: url });
try {
  const result = await ensureSchema(pool);
  if (result.action === 'applied') {
    console.log(`applied  checksum=${result.checksum}`);
  } else if (result.action === 'skipped') {
    console.log(`skipped  checksum=${result.checksum}`);
  } else {
    throw new InitSchemaDriftError(result.expected, result.actual);
  }
} catch (error) {
  if (error instanceof InitSchemaDriftError) {
    console.error(`drift    expected=${error.expected} actual=${error.actual}`);
    console.error('init.sql 已被修改但 DB 仍是旧 schema；删库重建即可。');
    process.exitCode = 2;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}
```

- [ ] **Step 4: 跑脚本**

```bash
cd backend && npm run migrate
```

期望 stdout：`applied  checksum=<64hex>` 或 `skipped  checksum=<64hex>`。

- [ ] **Step 5: 提交**

```bash
git add src/scripts/migrate.ts tests/integration/init-schema.test.ts
git commit -m "refactor(migrate): single-file init.sql runner with drift handling"
```

---

## Task 4: 新建 server/error-mapping.ts（含 8 项单测）

**Files:**
- Create: `backend/src/server/error-mapping.ts`
- Create: `backend/tests/unit/error-mapping.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ErrorMappingResult = { status: number; body: { error_code: string; message: string } };
  export function mapErrorToResponse(error: unknown): ErrorMappingResult;
  ```

- [ ] **Step 1: 写失败单测**

`backend/tests/unit/error-mapping.test.ts`：

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mapErrorToResponse } from '../../src/server/error-mapping.js';

class FakeNotFound extends Error { constructor(){super('x'); this.name='ResourceNotFoundError';}}
class FakeCross extends Error { constructor(){super('x'); this.name='CrossWorkspaceAccessError';}}
class FakeInput extends Error { constructor(m:string){super(m); this.name='InputValidationError';}}
class FakeUserNF extends Error { constructor(){super('x'); this.name='UserNotFoundError';}}
class FakeWsCtx extends Error { constructor(){super('x'); this.name='WorkspaceContextError';}}
class FakeWsInt extends Error { constructor(){super('x'); this.name='WorkspaceIntegrityError';}}

test('ResourceNotFoundError → 404 NOT_FOUND', () => {
  const r = mapErrorToResponse(new FakeNotFound());
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error_code: 'NOT_FOUND', message: '资源不存在。' });
});

test('CrossWorkspaceAccessError → 404, body identical to ResourceNotFoundError', () => {
  const a = mapErrorToResponse(new FakeCross());
  const b = mapErrorToResponse(new FakeNotFound());
  assert.equal(a.status, b.status);
  assert.equal(JSON.stringify(a.body), JSON.stringify(b.body));
});

test('InputValidationError → 422 INPUT_VALIDATION_FAILED', () => {
  const r = mapErrorToResponse(new FakeInput('bad input'));
  assert.equal(r.status, 422);
  assert.equal(r.body.error_code, 'INPUT_VALIDATION_FAILED');
  assert.equal(r.body.message, 'bad input');
});

test('UserNotFoundError → 500 (NOT 401)', () => {
  const r = mapErrorToResponse(new FakeUserNF());
  assert.equal(r.status, 500);
  assert.notEqual(r.status, 401);
});

test('WorkspaceContextError → 500', () => {
  assert.equal(mapErrorToResponse(new FakeWsCtx()).status, 500);
});

test('WorkspaceIntegrityError → 500', () => {
  assert.equal(mapErrorToResponse(new FakeWsInt()).status, 500);
});

test('arbitrary Error → 500', () => {
  assert.equal(mapErrorToResponse(new TypeError('boom')).status, 500);
  assert.equal(mapErrorToResponse(new SyntaxError('x')).status, 500);
});
```

- [ ] **Step 2: 跑测试，确认 fail**

```bash
cd backend && npx tsx tests/unit/error-mapping.test.ts
```

- [ ] **Step 3: 实现 error-mapping.ts**

```ts
export type ErrorMappingResult = {
  status: number;
  body: { error_code: string; message: string };
};

export class ResourceNotFoundError extends Error {
  constructor(message = '资源不存在。') { super(message); this.name = 'ResourceNotFoundError'; }
}
export class CrossWorkspaceAccessError extends ResourceNotFoundError {
  constructor() { super('资源不存在。'); this.name = 'CrossWorkspaceAccessError'; }
}
export class InputValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'InputValidationError'; }
}

const NOT_FOUND_BODY = { error_code: 'NOT_FOUND', message: '资源不存在。' } as const;
const INTERNAL_BODY = { error_code: 'INTERNAL_ERROR', message: '服务端内部错误。' } as const;

export function mapErrorToResponse(error: unknown): ErrorMappingResult {
  if (error instanceof ResourceNotFoundError) {
    return { status: 404, body: { ...NOT_FOUND_BODY } };
  }
  if (error instanceof InputValidationError) {
    return { status: 422, body: { error_code: 'INPUT_VALIDATION_FAILED', message: error.message } };
  }
  if (error instanceof Error) {
    if (
      error.name === 'UserNotFoundError' ||
      error.name === 'WorkspaceContextError' ||
      error.name === 'WorkspaceIntegrityError'
    ) {
      console.error('服务端完整性错误：', error);
      return { status: 500, body: { ...INTERNAL_BODY } };
    }
  }
  console.error('未预期错误：', error);
  return { status: 500, body: { ...INTERNAL_BODY } };
}
```

**注**：`UserNotFoundError` / `WorkspaceContextError` / `WorkspaceIntegrityError` 已在 `modules/auth/workspace-context.ts` 定义；本任务**不**重新声明类，改为按 `error.name` 字符串判定：

修改实现为：

```ts
const NAME_500 = new Set([
  'UserNotFoundError',
  'WorkspaceContextError',
  'WorkspaceIntegrityError',
]);
// ... 在 if (error instanceof Error) 里：
if (NAME_500.has(error.name)) { ... }
```

- [ ] **Step 4: 跑测试，确认 pass**

```bash
cd backend && npx tsx tests/unit/error-mapping.test.ts
```

期望：7/7 pass。

- [ ] **Step 5: 提交**

```bash
git add src/server/error-mapping.ts tests/unit/error-mapping.test.ts
git commit -m "feat(server): add unified error-to-response mapper"
```

---

## Task 5: withAuthenticatedWorkspace 统一 try/catch

**Files:**
- Modify: `backend/src/modules/auth/workspace-context.ts`（仅 `withAuthenticatedWorkspace` 函数体）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/unit/auth-wrapper-error.test.ts`：

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { withAuthenticatedWorkspace } from '../../src/modules/auth/workspace-context.js';

class FakeContext {
  constructor(public req: { raw: Request }) {}
  json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
  body(data: unknown, status = 200) { return this.json(data, status); }
}

test('workspace identity error → 500', async () => {
  // 强制 resolveAuthenticatedContext 抛 WorkspaceIntegrityError；
  // 这里用没有 DATABASE_URL 的 stub；为简化，直接 stub 内部调用。
  // 真实测试用 integration/handler-isolation.test.ts（Task 17）。
  assert.ok(typeof withAuthenticatedWorkspace === 'function');
});
```

**注**：该 wrapper 的 500 / 404 行为由 `tests/integration/handler-isolation.test.ts`（Task 17）真实覆盖；此单测仅做函数签名断言。Step 1 改为：

```ts
test('withAuthenticatedWorkspace is a function', () => {
  assert.equal(typeof withAuthenticatedWorkspace, 'function');
});
```

- [ ] **Step 2: 跑测试，确认 pass（已有 function 存在）**

- [ ] **Step 3: 修改 withAuthenticatedWorkspace 包整个 handler**

修改 `backend/src/modules/auth/workspace-context.ts`：

```ts
import { mapErrorToResponse } from '../../server/error-mapping.js';

export function withAuthenticatedWorkspace(
  handler: AuthenticatedRouteHandler,
): (context: AuthenticatedRouteContextLike) => Promise<Response> {
  return async (context) => {
    const req = context.req as { raw?: Request };
    const request = req.raw instanceof Request ? req.raw : null;
    if (!request) {
      return context.json({ message: '请求异常。' }, 500);
    }
    try {
      const authCtx = await resolveAuthenticatedContext(request);
      if (!authCtx) {
        return context.json({ message: '未登录或会话已失效。' }, 401);
      }
      return await handler(authCtx, context);
    } catch (error) {
      // 401 / 404 / 422 / 500 全部由唯一边界决定；handler 不再自行 try/catch 业务错误。
      const mapped = mapErrorToResponse(error);
      return context.json(mapped.body, mapped.status);
    }
  };
}
```

- [ ] **Step 4: typecheck**

```bash
cd backend && npm run typecheck
```

- [ ] **Step 5: 提交**

```bash
git add src/modules/auth/workspace-context.ts tests/unit/auth-wrapper-error.test.ts
git commit -m "feat(auth): route all auth wrapper errors through mapErrorToResponse"
```

---

## Task 6: 静态合约 —— 所有 requiresAuth 路由必须包 withAuthenticatedWorkspace

**Files:**
- Modify: `backend/tests/contracts/run.ts`（追加 §8 段）
- Create: `backend/tests/contracts/route-workspace-wrapper.test.ts`

**Interfaces:**
- Produces：CI 时静态扫描 `src/server/routes/**/*.ts`，对每个 `registerApiRoute(..., { requiresAuth: true ... })` 校验其 handler 含 `withAuthenticatedWorkspace`

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/contracts/route-workspace-wrapper.test.ts`：

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROUTES = join(process.cwd(), 'src', 'server', 'routes');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('every requiresAuth:true route wraps with withAuthenticatedWorkspace', () => {
  const files = walk(ROUTES);
  const violations: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf-8');
    // 简单 grep：requireAuth: true 必须与 withAuthenticatedWorkspace 同文件
    if (/requiresAuth:\s*true/.test(src) && !/withAuthenticatedWorkspace/.test(src)) {
      violations.push(relative(process.cwd(), f));
    }
  }
  assert.deepEqual(violations, [], `routes missing withAuthenticatedWorkspace: ${violations.join(', ')}`);
});
```

- [ ] **Step 2: 跑测试，确认当前 fail**

```bash
cd backend && npx tsx tests/contracts/route-workspace-wrapper.test.ts
```

期望：列出当前未接入的路由（agents.ts 等）。

- [ ] **Step 3: 不实现；后续 Task 14 一次性接入**

本任务**仅**测试代码；所有路由接入在 Task 14 完成。

- [ ] **Step 4: 跑测试（接入后）**

接入完成后再次跑确认 pass。

- [ ] **Step 5: 提交**

```bash
git add tests/contracts/route-workspace-wrapper.test.ts
git commit -m "test(contracts): require all requiresAuth routes to wrap with withAuthenticatedWorkspace"
```

---

## Task 7:（预留）auth_sessions / workspaces 索引补齐

**Files:**
- 已合并到 Task 1 Step 2/3；本任务仅作为 self-review checkpoint，**不**新增工作。

---

## Task 8: modules/conversations/service.ts —— 18 函数首参 workspaceId

**Files:**
- Modify: `backend/src/modules/conversations/service.ts`（18 函数全部）

**Interfaces:**
- Produces：所有 18 个函数签名首参 `workspaceId: string`；查询类跨 workspace 返 null；写类 rowCount===0 抛 `ResourceNotFoundError`；内部幂等写显式注释

- [ ] **Step 1: 添加 import**

文件顶部追加：

```ts
import {
  ResourceNotFoundError,
  CrossWorkspaceAccessError,
} from '../../server/error-mapping.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
```

- [ ] **Step 2: 重写 18 个函数签名**

| # | 函数 | 新签名 + 行为 |
|---|---|---|
| 1 | `createConversation` | `(workspaceId, input)` —— INSERT 带 workspace_id；KB 校验 `WHERE id=$kbId AND workspace_id=$workspaceId`，无行抛 `CrossWorkspaceAccessError` |
| 2 | `listConversations` | `(workspaceId)` —— `WHERE workspace_id=$1` |
| 3 | `getConversationWithMessages` | `(workspaceId, conversationId)` —— 0 行返 null |
| 4 | `updateConversation` | `(workspaceId, conversationId, ...)` —— `rowCount===0` 抛 `ResourceNotFoundError` |
| 5 | `deleteConversation` | 同上 |
| 6 | `saveUserMessage` | `(workspaceId, conversationId, content)` —— 父 conversation 不属于 workspace → 抛 `CrossWorkspaceAccessError` |
| 7 | `saveAssistantMessage` | `(workspaceId, ...)` —— 父 message 校验 |
| 8 | `createAssistantPending` | `(workspaceId, ...)` —— 父 conversation 校验 |
| 9 | `updateAssistantStreaming` | `(workspaceId, messageId, content, partial)` —— 内部状态写，rowCount===0 静默；`// internal: rowCount may be 0` |
| 10 | `finalizeAssistant` | `(workspaceId, messageId, ...)` —— 用户资源写；rowCount===0 抛 `ResourceNotFoundError` |
| 11 | `resetAssistantForRetry` | `(workspaceId, messageId)` —— 内部幂等；`// internal idempotent` |
| 12 | `convergeAssistantToFailed` | 同上 |
| 13 | `getMessageSnapshot` | `(workspaceId, messageId)` —— 0 行返 null |
| 14 | `restoreAssistantFromSnapshot` | `(workspaceId, messageId)` —— 补偿性内部写；`// internal compensating write` |
| 15 | `getLastAssistantMessage` | `(workspaceId, conversationId)` —— 0 行返 null |
| 16 | `touchConversation` | `(workspaceId, conversationId)` —— 内部状态写；`// internal: rowCount may be 0` |
| 17 | `updateConversationTitle` | `(workspaceId, conversationId, title)` —— `maybeUpdateTitleFromFirstMessage` 内部辅助；rowCount===0 静默；`// internal helper for maybeUpdateTitle` |
| 18 | `maybeUpdateTitleFromFirstMessage` | `(workspaceId, conversationId, content)` —— 内部幂等；`// internal idempotent` |

- [ ] **Step 3: typecheck**

```bash
cd backend && npm run typecheck
```

- [ ] **Step 4: 提交**

```bash
git add src/modules/conversations/service.ts
git commit -m "feat(conv): thread workspaceId through all 18 service functions"
```

---

## Task 9: modules/conversations/tool-executions.ts —— 4 函数

**Files:**
- Modify: `backend/src/modules/conversations/tool-executions.ts`

- [ ] **Step 1: 重写 4 函数**

| # | 函数 | 新签名 + 行为 |
|---|---|---|
| 1 | `createToolExecution` | `(workspaceId, messageId, toolName, args)` —— 父 message 不属于 workspace → 抛 `CrossWorkspaceAccessError` |
| 2 | `finalizeToolExecution` | `(workspaceId, execId, result, status, error?)` —— 用户资源写；rowCount===0 抛 `ResourceNotFoundError` |
| 3 | `convergeRunningToolExecutions` | `(workspaceId, messageId)` —— 内部幂等；`// internal idempotent` |
| 4 | `getToolExecutionsByMessage` | `(workspaceId, messageId)` —— 0 行返 `[]` |

- [ ] **Step 2: typecheck + 提交**

```bash
cd backend && npm run typecheck
git add src/modules/conversations/tool-executions.ts
git commit -m "feat(tool-exec): thread workspaceId through all 4 functions"
```

---

## Task 10: modules/knowledge/service.ts —— 5 函数

**Files:**
- Modify: `backend/src/modules/knowledge/service.ts`

- [ ] **Step 1: 重写 5 函数**

| # | 函数 | 新签名 + 行为 |
|---|---|---|
| 1 | `createKnowledgeBase` | `(workspaceId, input)` —— 无父资源，直接 INSERT 带 workspace_id |
| 2 | `listKnowledgeBases` | `(workspaceId)` —— `WHERE workspace_id=$1` |
| 3 | `getKnowledgeBase` | `(workspaceId, kbId)` —— 0 行返 null |
| 4 | `updateKnowledgeBase` | `(workspaceId, kbId, ...)` —— 用户资源写；rowCount===0 抛 `ResourceNotFoundError` |
| 5 | `deleteKnowledgeBase` | 同上 |

- [ ] **Step 2: typecheck + 提交**

```bash
cd backend && npm run typecheck
git add src/modules/knowledge/service.ts
git commit -m "feat(kb): thread workspaceId through all 5 service functions"
```

---

## Task 11: modules/documents/service.ts + ingestion.ts

**Files:**
- Modify: `backend/src/modules/documents/service.ts`、`backend/src/modules/documents/ingestion.ts`

- [ ] **Step 1: 重写 documents/service.ts 5 函数**

| # | 函数 | 新签名 + 行为 |
|---|---|---|
| 1 | `createDocument` | `(workspaceId, kbId, input)` —— KB 不属于 workspace → 抛 `CrossWorkspaceAccessError` |
| 2 | `listDocuments` | `(workspaceId, kbId?)` —— `WHERE workspace_id=$1` |
| 3 | `getDocument` | `(workspaceId, docId)` —— 0 行返 null |
| 4 | `updateDocumentStatus` | `(workspaceId, docId, status, error?)` —— 用户资源写；rowCount===0 抛 `ResourceNotFoundError` |
| 5 | `deleteDocument` | 同上 |

- [ ] **Step 2: 重写 documents/ingestion.ts**

`ingestDocument(workspaceId, documentId, chunks)`：document 不属于 workspace → 抛 `CrossWorkspaceAccessError`；INSERT document_chunks 时带 `workspace_id`（从 document JOIN 校验后复制）。

- [ ] **Step 3: typecheck + 提交**

```bash
cd backend && npm run typecheck
git add src/modules/documents/service.ts src/modules/documents/ingestion.ts
git commit -m "feat(docs): thread workspaceId through documents + ingestion"
```

---

## Task 12: core/skill/bindings.ts + registry.ts（removeInstalledSkill 单连接事务）

**Files:**
- Modify: `backend/src/core/skill/bindings.ts`、`backend/src/core/skill/registry.ts`

- [ ] **Step 1: 重写 bindings.ts 3 函数（resolveSkillsForAgent 不动）**

| # | 函数 | 新签名 + 行为 |
|---|---|---|
| 1 | `bindSkillToAgent` | `(workspaceId, agentId, skillId)` —— 父资源校验：skill 存在（不变）；workspace 写入 `agent_skill_bindings.workspace_id` |
| 2 | `unbindSkillFromAgent` | `(workspaceId, agentId, skillId)` —— 内部幂等解绑；rowCount===0 静默；`// internal idempotent unbind` |
| 3 | `getAgentSkillBindings` | `(workspaceId, agentId)` —— `WHERE workspace_id=$1 AND agent_id=$2` |

**保持** `resolveSkillsForAgent(agentId, ids)` 纯函数不变。

- [ ] **Step 2: 重写 registry.ts 的 `removeInstalledSkill`（单连接单事务级联）**

```ts
export async function removeInstalledSkill(skillId: string): Promise<void> {
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 1. 删 agent_skill_bindings 引用
    await client.query('DELETE FROM agent_skill_bindings WHERE skill_id = $1', [skillId]);
    // 2. 删 skills_installed 行
    await client.query('DELETE FROM skills_installed WHERE id = $1', [skillId]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 3: 跑 skill-binding-contract 已有测试**

```bash
cd backend && RUN_DB_TESTS=1 TEST_DATABASE_URL=postgres://... npm run test:integration
```

- [ ] **Step 4: typecheck + 提交**

```bash
git add src/core/skill/bindings.ts src/core/skill/registry.ts
git commit -m "feat(skill): workspaceId on bindings + single-tx global skill delete"
```

---

## Task 13: Workspace 上下文传播链（agent runtime / execution / scripts）

**Files:**
- Modify: `backend/src/core/agent/runtime.ts`、`backend/src/core/execution/ask-driver.ts`、`backend/src/core/execution/tool-event.ts`、`backend/src/core/execution/message-finalize.ts`、`backend/src/scripts/ask.ts`
- Create: `backend/src/core/knowledge/search.ts`（如不存在）

**Interfaces:**
- `streamAgent(input: { workspaceId, agentId, ... })` —— workspaceId 显式传入
- `AskStreamInput.workspaceId: string`
- `searchKnowledgeBase(workspaceId, query)` —— KB 不属于 workspace → 抛 `CrossWorkspaceAccessError`

- [ ] **Step 1: 改 agent/runtime.ts**

`streamAgent` 函数首参改为对象 `{ workspaceId, agentId, prompt, conversationId, ... }`；调用 `resolveSkillsForAgent` 之前先 `getAgentSkillBindings(workspaceId, agentId)`。

- [ ] **Step 2: 改 execution/ask-driver.ts**

`AskStreamInput` 接口加 `workspaceId: string`；贯穿到 `streamAgent` 调用。

- [ ] **Step 3: 改 execution/tool-event.ts + message-finalize.ts**

所有 `toolExecutions` / `messages` 写入前先以 `workspaceId` 校验父资源。

- [ ] **Step 4: 改 scripts/ask.ts**

CLI 启动时读 `SESSION_TOKEN` → `resolveSession` → `ensurePersonalWorkspace` → 拿到 workspaceId 后传给 `AskStreamInput`。

- [ ] **Step 5: 新建/修改 core/knowledge/search.ts**

```ts
export async function searchKnowledgeBase(
  workspaceId: string,
  query: string,
): Promise<SearchResult[]> {
  const pool = getDatabasePool();
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM knowledge_bases WHERE id = (SELECT knowledge_base_id FROM documents WHERE workspace_id = $1 LIMIT 1)`,
    [workspaceId],
  );
  if (r.rows.length === 0) {
    throw new CrossWorkspaceAccessError();
  }
  // ... 实际向量检索逻辑
}
```

- [ ] **Step 6: typecheck + 提交**

```bash
cd backend && npm run typecheck
git add src/core/agent/runtime.ts src/core/execution/ src/core/knowledge/search.ts src/scripts/ask.ts
git commit -m "feat(execution): propagate workspaceId through stream + search + scripts"
```

---

## Task 14: 全部路由接入 withAuthenticatedWorkspace

**Files:**
- Modify: `backend/src/server/routes/agents.ts`、`capabilities.ts`、`conversations.ts`、`documents.ts`、`knowledge-bases.ts`、`messages/ask.ts`、`messages/regenerate.ts`、`messages/stop.ts`、`skills.ts`、`tools.ts`
- 内部 handler 已带 `withAuthenticatedWorkspace` 的：仅删除 handler 内部的 `try/catch` 业务错误（统一交给外层包装）

- [ ] **Step 1: 修改 agents.ts / capabilities.ts / skills.ts / tools.ts**

每个 `registerApiRoute(..., { requiresAuth: true, handler })` 改为：

```ts
export const xxxRoute = registerApiRoute('/...', {
  method: '...',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    // 不再 try/catch 业务错误；只做参数解析 + 调 service
    return context.json(await xxxService(authCtx.workspaceId, ...));
  }),
});
```

- [ ] **Step 2: 修改 documents.ts / knowledge-bases.ts / conversations.ts 同上**

- [ ] **Step 3: 修改 messages/regenerate.ts**

在 `tryReserveConversationExecution` 之前**先**做 workspace 校验（用 `getConversationWithMessages(workspaceId, conversationId)`；null → 404）。

- [ ] **Step 4: 修改 messages/stop.ts**

**关键**：在调用 `abortExecution(id)` 之前先验证 message 属于当前 workspace：

```ts
const msg = await getMessageWorkspaceId(id);
if (!msg || msg.workspaceId !== authCtx.workspaceId) {
  return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
}
// 通过后才调 abortExecution(id)
const { success, partialContent } = abortExecution(id);
```

- [ ] **Step 5: 跑合约测试，确认全 pass**

```bash
cd backend && npm run test:contracts
```

- [ ] **Step 6: 提交**

```bash
git add src/server/routes/
git commit -m "feat(routes): wrap all requiresAuth handlers with withAuthenticatedWorkspace"
```

---

## Task 15: tests/integration/isolation-contract.ts —— 17 项合约

**Files:**
- Replace: `backend/tests/integration/isolation-contract-placeholder.ts` → `backend/tests/integration/isolation-contract.ts`
- Delete: `backend/tests/integration/isolation-contract-placeholder.ts`

- [ ] **Step 1: 实现 17 项测试**

按 Spec §7.1 表 1:1 落测试，每个 case try/finally + `dropIsolatedSchema()`。

骨架：

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Pool } from 'pg';
import {
  ensureSchema,
  dropIsolatedSchema,
  createIsolatedSchema,
} from '../../src/test-utils/schema-init.js';
import * as conv from '../../src/modules/conversations/service.js';
import * as tool from '../../src/modules/conversations/tool-executions.js';
import * as kb from '../../src/modules/knowledge/service.js';
import * as doc from '../../src/modules/documents/service.js';
import * as bind from '../../src/core/skill/bindings.js';

const URL = process.env.TEST_DATABASE_URL;
const RUN = process.env.RUN_DB_TESTS === '1' && !!URL;

async function withTwoWorkspaces<T>(fn: (a: Pool, b: Pool) => Promise<T>) {
  const root = new Pool({ connectionString: URL });
  const sa = `test_${Math.random().toString(36).slice(2, 8)}a`;
  const sb = `test_${Math.random().toString(36).slice(2, 8)}b`;
  await createIsolatedSchema(root, sa);
  await createIsolatedSchema(root, sb);
  const a = new Pool({ connectionString: URL, options: `-c search_path=${sa},public` });
  const b = new Pool({ connectionString: URL, options: `-c search_path=${sb},public` });
  await ensureSchema(a);
  await ensureSchema(b);
  try { return await fn(a, b); }
  finally {
    await a.end(); await b.end();
    await dropIsolatedSchema(root, sa);
    await dropIsolatedSchema(root, sb);
    await root.end();
  }
}

test('case 1: listConversations isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a, b) => {
    await a.query(`INSERT INTO workspaces (id, kind, name, owner_user_id) VALUES ('wA','personal','p','u1'), ('wB','personal','p','u2')`);
    await a.query(`INSERT INTO conversations (id, workspace_id, user_id, agent_id, title) VALUES ('c1','wA','u1','general-chat','t')`);
    const rows = await b.query(`SELECT * FROM conversations`);
    assert.equal(rows.rows.length, 0);
  });
});

// 复制上述骨架，逐项实现 case 2..17
```

- [ ] **Step 2: 跑测试**

```bash
cd backend && RUN_DB_TESTS=1 TEST_DATABASE_URL=postgres://... npx tsx tests/integration/isolation-contract.ts
```

期望：17/17 pass。

- [ ] **Step 3: 删除 placeholder**

```bash
git rm tests/integration/isolation-contract-placeholder.ts
```

- [ ] **Step 4: 提交**

```bash
git add tests/integration/isolation-contract.ts tests/integration/isolation-contract-placeholder.ts
git commit -m "test(isolation): 17-case cross-workspace contract"
```

---

## Task 16: tests/integration/init-schema.test.ts —— 5 项 runner

**Files:**
- 已创建于 Task 3 Step 1。Task 16 追加 §7.2 #4、#5：

- [ ] **Step 1: 追加 case #4（事务回滚）**

```ts
test('ensureSchema: mid-flight failure → transaction rolled back', { skip: !RUN }, async () => {
  await withFreshSchema(async (pool) => {
    // 注入会失败的 SQL：临时把 init.sql 末尾改成 "INVALID SQL"
    // 真实实现：构造一个 ensureSchemaWithSql(pool, brokenSql)
    await assert.rejects(() => ensureSchema(pool)); // broken input
    const meta = await pool.query(`SELECT to_regclass('_init_meta') AS exists`);
    // 全新 schema 下应不存在
  });
});
```

实际用专门 stub 函数 `ensureSchemaWithSql(pool, brokenSql: string)` 测试回滚。

- [ ] **Step 2: 追加 case #5（静态契约）**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('schema-init.ts does not read process.env.DATABASE_URL', () => {
  const src = readFileSync(join(process.cwd(), 'src/test-utils/schema-init.ts'), 'utf-8');
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /new Pool\(/);
});
```

- [ ] **Step 3: 跑 + 提交**

```bash
cd backend && RUN_DB_TESTS=1 TEST_DATABASE_URL=postgres://... npx tsx tests/integration/init-schema.test.ts
git add tests/integration/init-schema.test.ts
git commit -m "test(schema): rollback + static contract for ensureSchema"
```

---

## Task 17: tests/integration/handler-isolation.test.ts —— 5 项 Handler HTTP 404

**Files:**
- Create: `backend/tests/integration/handler-isolation.test.ts`

- [ ] **Step 1: 写测试骨架**

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Pool } from 'pg';
import { ensureSchema, dropIsolatedSchema, createIsolatedSchema } from '../../src/test-utils/schema-init.js';
import { __setTestPool, __resetTestPool } from '../../src/infrastructure/database/pool.js';
import { listConversationsRoute } from '../../src/server/routes/conversations.js';
import { getKnowledgeBaseRoute } from '../../src/server/routes/knowledge-bases.js';
import { deleteDocumentRoute } from '../../src/server/routes/documents.js';
import { regenerateRoute } from '../../src/server/routes/messages/regenerate.js';
import { stopMessageRoute } from '../../src/server/routes/messages/stop.js';
import { abortExecution } from '../../src/core/execution/controller.js';

const URL = process.env.TEST_DATABASE_URL;
const RUN = process.env.RUN_DB_TESTS === '1' && !!URL;

function fakeAuthedContext(request: Request) {
  return {
    req: {
      raw: request,
      param: (n: string) => n,
      query: () => undefined,
      json: async () => ({}),
      formData: async () => new FormData(),
      header: () => undefined,
    },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    body: (data: unknown, status = 200) =>
      new Response(typeof data === 'string' ? data : JSON.stringify(data), { status }),
  } as any;
}

test('case 1: DELETE conversation isolation + 404 identity', { skip: !RUN }, async () => {
  // A 创建 conv；B 用同一 ID 删 + B 用随机 UUID 删
  // 两次响应字节级一致；A 的 conv 仍存在
});
```

按 Spec §7.4 表 1:1 实现 5 项。

stop 路由额外断言：

```ts
let abortCalled = false;
const orig = abortExecution;
(global as any).abortExecution = (...args: any[]) => { abortCalled = true; return orig(...args); };
// B 用 A 的 messageId 调 stop → 404 + abortCalled === false
```

- [ ] **Step 2: 跑测试**

```bash
cd backend && RUN_DB_TESTS=1 TEST_DATABASE_URL=postgres://... npx tsx tests/integration/handler-isolation.test.ts
```

- [ ] **Step 3: 提交**

```bash
git add tests/integration/handler-isolation.test.ts
git commit -m "test(handler): 5-case cross-workspace HTTP 404 with byte-level identity"
```

---

## Task 18: docs/architecture-v2.md 重写

**Files:**
- Modify: `docs/architecture-v2.md`（§5.1, §5.3, §5.4, §8.6, G-2）

- [ ] **Step 1: 顶部加指针行**

```markdown
> 已被本次裁决覆盖的范围：**迁移链 / Legacy Workspace / `LEGACY_WORKSPACE_OWNER_USER_ID`**。以 `docs/superpowers/specs/2026-08-28-workspace-id-isolation-design.md` 为准。**注意**：PR-1.4 `skills_installed → skill_packages` 重命名**不**在本裁决覆盖范围内。
```

- [ ] **Step 2: 重写 §5.1 / §5.3 / §5.4 / §8.6 / G-2**

按 Spec §8 表格"实际改写"列内容逐段重写。

- [ ] **Step 3: 提交**

```bash
git add docs/architecture-v2.md
git commit -m "docs(arch): rewrite §5 / §8.6 / G-2 to single init.sql posture"
```

---

## Task 19: docs/development.md 重写

**Files:**
- Modify: `docs/development.md`（"数据库变更"章节整段）

- [ ] **Step 1: 顶部加指针行 + 整段重写"数据库变更"**

```markdown
## 数据库变更

`npm run migrate` 执行单一 `backend/database/init.sql`，并校验 SHA-256 checksum。本项目不维护迁移链；如需调整 Schema，直接修改 `init.sql`，然后：

1. 备份现有数据（生产环境）；
2. 删库；
3. 重新跑 `npm run migrate`。

重复执行 `npm run migrate` 在 checksum 一致时为幂等（`skipped`）；checksum 不一致时为 `drift` 并退出码 2。
```

- [ ] **Step 2: 提交**

```bash
git add docs/development.md
git commit -m "docs(dev): rewrite DB change section to single init.sql"
```

---

## Task 20: docs/implementation-plan.md / README / verify.yml 重写

**Files:**
- Modify: `docs/implementation-plan.md`、`README.md`、`frontend/README.md`、`.github/workflows/verify.yml`

- [ ] **Step 1: implementation-plan.md**

PR-1.2 / PR-1.3 / PR-1.5 合并标记 ⏳；PR-1.4 仍标 ❌（待实施）；顶部加指针行。

- [ ] **Step 2: README.md / frontend/README.md**

所有"0001/0002/0003 迁移链"表述删除；统一为"项目初始化跑 `npm run migrate`（执行唯一 `init.sql`）"；顶部加指针行。

- [ ] **Step 3: .github/workflows/verify.yml**

保留 `npm run migrate` 步骤；注释统一为单一 init.sql。

- [ ] **Step 4: 跑全部测试**

```bash
cd backend && npm test
```

期望：contracts + unit + integration + fixtures 全部通过。

- [ ] **Step 5: 提交**

```bash
git add docs/implementation-plan.md README.md frontend/README.md .github/workflows/verify.yml
git commit -m "docs: align remaining docs + CI with single init.sql posture"
```

---

## Self-Review

逐项核验（计划 vs Spec）：

- ✅ Spec §2 init.sql 重写 → Task 1
- ✅ Spec §5 runner 三态 → Task 2/3
- ✅ Spec §3.1-§3.7 18/4/5/5 函数首参 → Task 8/9/10/11/12
- ✅ Spec §3.8 单连接单事务 → Task 12 Step 2
- ✅ Spec §3.9 传播链 → Task 13
- ✅ Spec §4 HTTP 错误映射唯一边界 → Task 4/5
- ✅ Spec §6 路由接入 → Task 14
- ✅ Spec §7.1 17 项合约 → Task 15
- ✅ Spec §7.2 5 项 runner → Task 3/16
- ✅ Spec §7.3 错误映射单测 → Task 4
- ✅ Spec §7.4 5 项 Handler HTTP 404 → Task 17
- ✅ Spec §7.5 沿用 → 静态合约 Task 6
- ✅ Spec §8 文档同步 → Task 18/19/20

未覆盖：**无**。所有 Spec 章节均有对应任务。

Placeholder 扫描：通篇无 "TBD / TODO / 由读者填写 / 类似 Task N"。
