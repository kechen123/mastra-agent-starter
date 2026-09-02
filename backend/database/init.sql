-- PR-1.2/1.3/1.5 合并段：单一 init.sql 是 Schema 唯一来源。
-- 项目不维护迁移链；删库重建是接受路径。
-- 重复执行必须显式失败（除 pgcrypto 外全部不带 IF NOT EXISTS）。
--
-- ────────────────────────────────────────────────────────────────────
-- 阶段 2 追加段（architecture-v2.md §6.2/§6.3/§6.5）
-- 开发阶段每次 schema 变更均删库重建；本文件只描述全新数据库的目标结构，
-- 不维护旧库兼容、数据回填或迁移路径。除非用户明确要求，不得在此加入兼容分支。
-- ────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

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

-- 全局 Skill 包目录：代码与校验和在所有 Workspace 间共享。
CREATE TABLE skill_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL,
  -- PR-1.2 关闭审查整改：原声明为 `source_ref`（与 registry.ts / market.ts
  -- 实际写入的 `location` 不一致）；改回 `location`（磁盘上的目录路径）。
  location TEXT NOT NULL,
  -- compatibility 取值集合对齐 SkillDefinition['compatibility']
  -- （discovery.ts:29 / compatibility.ts:68-97 / registry.ts:218-225）。
  -- 实际运行值包含 'compatible' / 'requires-runtime'，'unsupported' /
  -- 'unknown' 保留给后续阶段（analyzeCompatibility 返回这两种之一时
  -- 也会写到这里 —— 与类型签名保持一致）。
  compatibility TEXT NOT NULL CHECK (compatibility IN ('compatible', 'requires-runtime', 'unsupported', 'unknown')),
  has_scripts BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  allowed_tools TEXT[] NOT NULL DEFAULT '{}',
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  -- PR-1.2 关闭审查整改：原声明 `title` + `source`（未使用），与
  -- documents-service.ts:36-46 / 73-78 / 115-119 实际读写的 `name` /
  -- `type` / `size` 不一致；改回业务运行时真正使用的列。
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  -- status 取值集合对齐 DocumentStatus（documents-service.ts:7）：
  --   'uploaded' | 'parsing' | 'chunking' | 'embedding' |
  --   'completed' | 'failed'。原声明 `'pending'/'ingesting'/'ready'/...`
  -- 与 Service 实际写入的 'uploaded' / 'parsing' 等不符。
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'parsing', 'chunking', 'embedding', 'completed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_workspace_kb_idx ON documents(workspace_id, knowledge_base_id);

CREATE TABLE document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(2048),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX document_chunks_workspace_kb_idx ON document_chunks(workspace_id, knowledge_base_id);
CREATE INDEX document_chunks_document_idx ON document_chunks(document_id);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  knowledge_base_id UUID REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  -- PR-1.2 关闭审查整改：原声明 `last_message_at`（无任何代码读 / 写），
  -- 而 conversations-service.ts:57, 81, 188, 309, 397, 408, 410, 421
  -- 全部按 `updated_at` 推进（touchConversation / updateConversation），
  -- 删除 / 更新路径会因列不存在而报 "column does not exist"。补
  -- `updated_at`，删除未使用的 `last_message_at`。
  -- 进一步收敛：createConversation 实际只写入可信 workspaceId 与会话字段，
  -- 不写 user_id（conversations 归属由 workspace_id 单维度承担）。
  -- 删除 user_id 列 + conversations_workspace_user_idx；改为
  -- workspace 维度索引，对齐 listConversations ORDER BY updated_at DESC。
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversations_workspace_updated_idx
  ON conversations(workspace_id, updated_at DESC);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  -- PR-1.2 关闭审查整改：原声明 `snapshot JSONB`（无任何 Service 引用），
  -- 而 conversations-service.ts:95, 247-254, 271-275, 298-303, 349-352,
  -- 375-380, 386-391 全部按 `citations JSONB` 读写。
  -- 改回 Service 真正读写的 `citations`，删除未使用的 `snapshot`。
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- status 取值集合对齐 Service 实际写入：
  --   - 'pending'（createAssistantPending / resetAssistantForRetry）
  --   - 'streaming'（updateAssistantStreaming / Service 默认推进）
  --   - 'completed'（saveUserMessage 默认 / finalizeAssistant）
  --   - 'stopped'（finalizeAssistant 用户中断路径）
  --   - 'failed'（convergeAssistantToFailed / 收尾清理）
  -- 原声明 `'pending'/'streaming'/'complete'/'failed'/'cancelled'` 与
  -- Service 写入的 'completed' / 'stopped' 不符，INSERT 会因 CHECK 拒绝。
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'streaming', 'completed', 'stopped', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
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
CREATE INDEX tool_executions_workspace_message_idx ON tool_executions(workspace_id, message_id);

CREATE TABLE agent_skill_bindings (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  skill_id TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_id, skill_id)
);
CREATE INDEX agent_skill_bindings_skill_idx ON agent_skill_bindings(skill_id);

-- Workspace 对全局 Skill 的启用状态。绑定与实际运行均受它约束。
CREATE TABLE workspace_skills (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, skill_id)
);
CREATE INDEX workspace_skills_skill_idx ON workspace_skills(skill_id);

-- ════════════════════════════════════════════════════════════════════
-- 阶段 2 追加段：服务端 Draft Conversation + 持久化 Run + SSE 事件
-- 协议依据：docs/architecture-v2.md §6.2 / §6.3 / §6.4 / §6.5
-- 本段与前文一致：仅面向全新初始化数据库，重复执行应显式失败。
-- ════════════════════════════════════════════════════════════════════

-- 1. conversations：增加 draft/active 状态、创建人、标题占位。
ALTER TABLE conversations
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active'));
ALTER TABLE conversations
  ADD COLUMN created_by UUID REFERENCES app_users(id) ON DELETE SET NULL;
CREATE INDEX conversations_status_updated_idx
  ON conversations(workspace_id, status, updated_at DESC);

-- 2. messages：增加 current_run_id，允许初始 NULL（draft 上首条消息后
-- 由 POST /conversations/:id/messages 在单事务内回填）。
ALTER TABLE messages
  ADD COLUMN current_run_id UUID;

-- 3. agent_runs：阶段 2 核心表。按 architecture-v2.md §决策 4 落地：
--    - status 仅允许 queued / running / waiting_approval /
--      completed / stopped / failed；
--    - created_by FK → app_users(id)；assistant_message_id → messages(id)；
--    - lease_owner / lease_expires_at / heartbeat_at：60s Lease + 15s
--      心跳协议；
--    - request_id 与每条 API 请求的 X-Request-ID 对齐；
--    - 部分唯一索引：同会话同一时刻仅 1 个活跃 Run。
CREATE TABLE agent_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id      UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  assistant_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id             TEXT NOT NULL,
  provider             TEXT NOT NULL,
  model                TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
                          'queued', 'running', 'waiting_approval',
                          'completed', 'stopped', 'failed'
                        )),
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd   NUMERIC(10,6) NOT NULL DEFAULT 0,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  error_code           TEXT,
  parent_run_id        UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  request_id           TEXT NOT NULL,
  lease_owner          TEXT,
  lease_expires_at     TIMESTAMPTZ,
  heartbeat_at         TIMESTAMPTZ,
  created_by           UUID NOT NULL REFERENCES app_users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_run_per_conversation
  ON agent_runs(conversation_id)
  WHERE status IN ('queued', 'running', 'waiting_approval');
CREATE INDEX agent_runs_workspace_idx
  ON agent_runs(workspace_id, created_at DESC);
CREATE INDEX agent_runs_message_idx
  ON agent_runs(assistant_message_id);
CREATE INDEX agent_runs_status_idx
  ON agent_runs(status)
  WHERE status IN ('queued', 'running', 'waiting_approval');
CREATE INDEX agent_runs_lease_expiry_idx
  ON agent_runs(lease_expires_at)
  WHERE status IN ('queued', 'running');

-- messages 先于 agent_runs 建表，因此在此追加反向外键。
ALTER TABLE messages
  ADD CONSTRAINT messages_current_run_id_fk
  FOREIGN KEY (current_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;
CREATE INDEX messages_current_run_id_idx
  ON messages(current_run_id) WHERE current_run_id IS NOT NULL;

-- 4. agent_run_events：事件 IDENTITY 全局 BIGINT，run 内按 id 升序；
--    阶段 2 事件类型以 architecture-v2.md §决策 4 表为准，至少覆盖
--    run-queued / run-started / content-checkpoint / run-completed /
--    run-failed / run-stopped（其余类型允许预声明但本阶段不主动写）。
CREATE TABLE agent_run_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN (
                 'run-queued',
                 'run-started',
                 'content-checkpoint',
                 'tool-call-started',
                 'tool-call-completed',
                 'approval-requested',
                 'approval-resolved',
                 'run-completed',
                 'run-stopped',
                 'run-failed'
               )),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_run_events_run_idx
  ON agent_run_events(run_id, id);
CREATE INDEX agent_run_events_workspace_idx
  ON agent_run_events(workspace_id, id);

-- 5. idempotency_keys：POST 命令的稳定响应缓存。
--    - TTL 24h，V2 §6.2；
--    - PK = (workspace_id, user_id, key)；同一 Workspace / 用户 / key 的
--      重复 POST 必须返回原始 201/202 JSON，不重新触发副作用；
--    - request_fingerprint = sha256(canonical_json(method + path + body))；
--      同一 key 不同 fingerprint → 409 IDEMPOTENCY_KEY_REUSED。
CREATE TABLE idempotency_keys (
  key                  TEXT NOT NULL,
  workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  request_fingerprint  TEXT NOT NULL,
  -- 阶段 2 §6.2：占位行（response_status/response_body 为 NULL）作为并发 claim
  -- 的 token；只有最终 commit 后才 UPDATE 写入实际响应。允许 NULL 是因为占位
  -- 行的语义是"我正在生成响应"，不是"响应已就绪"。
  response_status      INTEGER NULL,
  response_body        JSONB NULL,
  expires_at           TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, user_id, key)
);
-- 仅响应已写入（completed_at NOT NULL）的行视为已就绪；占位行不进索引。
CREATE INDEX idempotency_keys_completed_idx
  ON idempotency_keys(workspace_id, user_id, key)
  WHERE completed_at IS NOT NULL;
CREATE INDEX idempotency_keys_expires_idx
  ON idempotency_keys(expires_at);
