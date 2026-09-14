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
-- PR-4.1 §8.4.1（整改）：Core Schema 不创建 `vector` 扩展；RAG 启用时由
-- `schema-init.ts` / `migrate.ts` 在 init 事务内、init.sql 跑之前以
-- **顶层 SQL** 形式 `CREATE EXTENSION IF NOT EXISTS vector`（DO 块内
-- 不允许该操作；必须放在受控的 bootstrap 路径上）。同步在同一事务内
-- `SET LOCAL app.rag_enabled = 'on' | 'off'`，让文件末尾的 RAG 条件块
-- 读到正确状态。Core-only 部署完全不需要 pgvector；fresh-init 仅决定
-- 一次 Core 或 RAG 形态，之后不再无迁移切换。

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
  -- PR-4.1：状态机切到 8 态（queued / parsing / chunking / embedding /
  --   finalizing / ready / failed / cancelled）。`finalizing` 与 `ready`
  --   是 PR-4.2 ingestion worker 收敛路径新增；`cancelled` 由软删除事务
  --   写。其余语义不变。
  -- storage_status 描述对象存储侧生命周期：uploaded → storage_pending
  --   → ready / storage_failed。`ready` 是 ingestion worker 拾取的前置
  --   条件。Core 与 RAG 都用 storage_status（不依赖 vector 扩展）。
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'parsing', 'chunking', 'embedding', 'finalizing', 'ready', 'failed', 'cancelled')),
  storage_status TEXT NOT NULL DEFAULT 'storage_pending'
    CHECK (storage_status IN ('storage_pending', 'ready', 'storage_failed')),
  -- 终态 finalKey（与 V2 §8.1 一致：DB 直接落 finalKey，stagingKey 仅
  -- 存在于 `storage_finalize_jobs`）。worker 不会通过 documents 读到
  -- stagingKey，避免"finalize 后 DB 指针失效"的旧矛盾。
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  -- 真实进度（仅当 total_chunks > 0 时可信）。Worker 在 chunking 阶段
  -- 写 total_chunks；embedding 阶段每写完一个 chunk 就 completed_chunks++。
  -- 前端用 completed/total 渲染；不计算 percent，避免前端假百分比。
  total_chunks INTEGER NOT NULL DEFAULT 0,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  failure_reason TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_workspace_kb_idx ON documents(workspace_id, knowledge_base_id);
CREATE INDEX documents_storage_status_idx ON documents(workspace_id, storage_status)
  WHERE deleted_at IS NULL;
-- PR-4.1 §8.1：去重粒度 (workspace_id, knowledge_base_id, sha256) 部分
-- 唯一索引，软删除行不阻塞重传。partial 让 `deleted_at IS NULL` 行唯一；
-- 30 天后维护者硬删软删除行释放唯一约束历史。
CREATE UNIQUE INDEX documents_dedup_unique_idx
  ON documents(workspace_id, knowledge_base_id, sha256)
  WHERE deleted_at IS NULL;
-- ingestion worker 抢占 SQL 的核心索引：仅扫描 ready + 未删除文档。
CREATE INDEX documents_status_progress_idx
  ON documents(status, updated_at DESC)
  WHERE deleted_at IS NULL AND status IN ('queued','parsing','chunking','embedding','finalizing');

CREATE TABLE document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- PR-4.1 §8.4.1：`embedding` 列**已迁出** document_chunks。
  --   RAG 向量改由独立的 `document_embeddings`（受 RAG 块门控）持有，
  --   Core Schema 启动不需要 `vector` 扩展。
  --   同一 chunk 可对应多个 profile 的向量（在 document_embeddings 上）。
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
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
  -- run_id 在 agent_runs 建表后再追加外键（见本文件下方 ALTER TABLE）。
  -- 允许 NULL：legacy sink 在缺乏 agent_runs 关联时仍可记录审计行；NULL
  -- 行由 `tool_executions_null_run_unique` 部分唯一索引兜底，避免
  -- UNIQUE(workspace_id, run_id, tool_call_id) 在 NULL run_id 下失效。
  run_id UUID,
  -- Mastra toolCallId：在 workspace + run + message 维度稳定唯一。
  -- SSE / Mastra / approval resume / 历史恢复 / 前端卡片都用这个 ID。
  -- 仅 fresh-DB 路径生效：不提供迁移 / backfill；既有库按需手动补列。
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args JSONB NOT NULL,
  result JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'success', 'error', 'cancelled')),
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT tool_executions_call_unique UNIQUE (workspace_id, run_id, tool_call_id)
);
CREATE INDEX tool_executions_workspace_message_idx ON tool_executions(workspace_id, message_id);
CREATE INDEX tool_executions_call_idx ON tool_executions(tool_call_id);

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
  -- PR-UI-1.0.5 F1 修复：每个 Run 必须显式记录它响应的 user message。
  -- 原因：`messages.created_at` 在同一事务内由 PG `now()` 锁定为同一值，
  -- 因此不能依赖 created_at 排序来反查 user/assistant 配对；rebuild 类需求
  -- （regenerate、resume、cross-instance 兜底）需要一个稳定 FK。
  -- regenerate service 直接读取目标 assistant 对应 Run 的 user_message_id，
  -- 不再依赖时序启发式。
  user_message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
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
-- 阶段 3.1 追加（PR-3.1 完整性修复）：
-- 让 agent_runs 同时按 (id, workspace_id) 唯一，便于下游表（典型如
-- tool_approval_requests）走"复合外键 (run_id, workspace_id) →
-- agent_runs(id, workspace_id)"在数据库层强制审批请求与所属 Run
-- 同 Workspace；这条 UNIQUE 与 PK(id) 是两个独立的索引，互不冲突。
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_id_workspace_unique
  UNIQUE (id, workspace_id);

-- messages 先于 agent_runs 建表，因此在此追加反向外键。
ALTER TABLE messages
  ADD CONSTRAINT messages_current_run_id_fk
  FOREIGN KEY (current_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;
CREATE INDEX messages_current_run_id_idx
  ON messages(current_run_id) WHERE current_run_id IS NOT NULL;

-- tool_executions 同样在 agent_runs 之前建表；run_id 字段预留为无 FK 的 UUID，
-- 在此追加正式外键 + 对 NULL run_id 的部分唯一索引（PR-review Item 1 / 5）：
--   - 正常路径：UNIQUE(workspace_id, run_id, tool_call_id) 已覆盖；
--   - legacy sink（run_id = NULL）场景需要单独的 NULL-safe 唯一约束，否则
--     PostgreSQL 默认允许同一 (workspace, NULL, tool_call_id) 重复入库，
--     触发历史重复落盘。
ALTER TABLE tool_executions
  ADD CONSTRAINT tool_executions_run_fk
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX tool_executions_null_run_unique
  ON tool_executions(workspace_id, tool_call_id)
  WHERE run_id IS NULL;

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
                 'tool-call-failed',
                 'approval-requested',
                 'approval-resolved',
                 'run-resumed',
                 'run-resume-reclaimed',
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

-- ════════════════════════════════════════════════════════════════════
-- 阶段 3.1 追加段：Tool Policy / Approval Schema
-- 协议依据：docs/architecture-v2.md §7
-- 本段仅创建 Schema 与基础约束；本阶段不实现 Tool Gateway、策略
-- 评估器、审批 API、审批 UI、超时 worker 或跨重启恢复 Run。
-- ────────────────────────────────────────────────────────────────────

-- 1. tool_policy_rules：每个 (workspace_id, tool_id) 仅允许一条基础规则
--    （effect='allow' / 'deny' / 'require_approval'）。
--    created_by 必填（V2.3 决策：策略的来源可追溯，不允许 NULL）。
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
  CONSTRAINT tool_policy_rules_workspace_tool_unique
    UNIQUE (workspace_id, tool_id)
);
CREATE INDEX tool_policy_rules_workspace_idx
  ON tool_policy_rules(workspace_id);

-- 2. tool_approval_requests：单 Run 内同一 tool_call_id 仅一条请求
--    （幂等重试同 tool_call）；审批恢复键为 (run_id, tool_call_id)，
--    与 Mastra 1.61 公共 API 的 agent.approveToolCall / declineToolCall
--    签名对齐——它们只接受 runId、可选 toolCallId、reason，**没有**
--    独立可持久化的 suspension token。
--
--    PR-3.3.0 扩展：可恢复动作状态机。
--    status 取值集合（PR-3.3 起）：
--      - 'pending'      ：新建待审批；
--      - 'approving'    ：已被 API / Worker 抢占，正在调用 Mastra
--                          agent.approveToolCall（中间态，重复调用
--                          仅取一个）；
--      - 'declining'    ：已被 API / Worker 抢占，正在调用 Mastra
--                          agent.declineToolCall（同上）；
--      - 'approved'     ：Mastra approve 调用成功 + 恢复消费已启动；
--      - 'declined'     ：Mastra decline 调用成功；
--      - 'expired'      ：超时 Worker 收敛（同时停 Run 并写
--                          run-stopped/run-failed）。
--    requester_id 必填；resolver_id 由 resolve 时回填。
--    inputs_summary 仅存"已脱敏"摘要；原始敏感输入不进库。
--
--    可恢复性字段：
--      decision               ：抢占时写入 'approved' | 'declined'，
--                                决定后续调用哪个 Mastra SDK；让重试路径
--                                不依赖外部信号（避免 DB 与 Mastra 不一致）。
--      resolver_id            ：抢占时同时回填（API 抢占时为当前用户；
--                                超时收敛时为 NULL——以 resolver_error
--                                'APPROVAL_EXPIRED' 区分）。
--      resolver_error         ：SDK 调用失败时写，最后一次失败的 reason；
--                                让重试路径可读上次失败原因。
--      mastra_call_started_at / mastra_call_completed_at
--                              ：SDK 调用的边界时间戳——started_at 与
--                                completed_at 用于发现"调用挂起"（两
--                                者差超过阈值时由超时 worker 强制收敛）。
--      lease_owner / lease_expires_at
--                              ：抢占 lease，与 agent_runs 同款 60s +
--                                心跳协议；抢占动作带 lease 后才允许
--                                进行 Mastra SDK 调用。
CREATE TABLE tool_approval_requests (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- run_id 保留单列索引用途；跨 Workspace 完整性靠下面的
  -- tool_approval_requests_run_workspace_fk 复合外键强制。
  run_id                    UUID NOT NULL,
  tool_id                   TEXT NOT NULL,
  tool_call_id              TEXT NOT NULL,
  inputs_hash               TEXT NOT NULL,
  inputs_summary            JSONB NOT NULL,
  status                    TEXT NOT NULL
                              CHECK (status IN (
                                'pending', 'approving', 'declining',
                                'approved', 'approved_resume_indeterminate',
                                'declined', 'expired'
                              )),
  -- PR-3.3 修订：requester_id / resolver_id 恢复为 NOT NULL FK。
  -- 真实审计可追溯：每条审批请求的发起者 / 终结者必须对应一个
  -- app_users 行；系统发起（超时 / 续 Run）使用 app_users 中预设的
  -- `system-approval-worker` 用户（disabled_at NOT NULL，禁止登录），
  -- 不允许写 NULL 来跳过审计。
  requester_id              UUID NOT NULL REFERENCES app_users(id),
  resolver_id               UUID NOT NULL REFERENCES app_users(id),
  mastra_resume_started_at  TIMESTAMPTZ,
  -- PR-3.3 Replay Fix：approve SDK 调用结果不确定时进入 reconciliation
  -- 重试计数；reconciler 扫描条件包含 `resume_attempts < MAX`，
  -- 超限后转人工介入。
  resume_attempts           INT NOT NULL DEFAULT 0,
  decision                  TEXT
                              CHECK (decision IS NULL OR decision IN ('approved', 'declined')),
  resolver_error            TEXT,
  mastra_call_started_at    TIMESTAMPTZ,
  mastra_call_completed_at  TIMESTAMPTZ,
  lease_owner               TEXT,
  lease_expires_at          TIMESTAMPTZ,
  expires_at                TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at               TIMESTAMPTZ,
  -- 复合外键：审批请求与所属 Run 在数据库层强制同 Workspace。
  -- 引用 agent_runs 上的 UNIQUE(id, workspace_id)（见阶段 2 段
  -- agent_runs_id_workspace_unique）；旧的单列 run_id → agent_runs(id)
  -- 外键不再保留，避免两套相互独立的 Run 外键。
  CONSTRAINT tool_approval_requests_run_workspace_fk
    FOREIGN KEY (run_id, workspace_id)
    REFERENCES agent_runs(id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT tool_approval_requests_run_tool_call_unique
    UNIQUE (run_id, tool_call_id)
);
-- Workspace 收件箱部分索引：pending 状态才有 inbox 路径。
CREATE INDEX tool_approval_requests_workspace_pending_idx
  ON tool_approval_requests(workspace_id, status)
  WHERE status = 'pending';
CREATE INDEX tool_approval_requests_run_idx
  ON tool_approval_requests(run_id);
-- 过期 worker 扫描路径（阶段 3.3+ 验收范围，本阶段不实现）。
CREATE INDEX tool_approval_requests_expires_pending_idx
  ON tool_approval_requests(expires_at)
  WHERE status = 'pending';
-- 单飞索引：同一 (run_id, tool_call_id) 在中间态 (approving/declining)
-- 最多一条；防止两个并发 resolve / Worker 同时跑 Mastra SDK 调用。
CREATE UNIQUE INDEX tool_approval_requests_run_tool_call_inflight_unique
    ON tool_approval_requests(run_id, tool_call_id)
    WHERE status IN ('approving', 'declining');
-- Lease 扫描索引：超时 worker 用 status + lease_expires_at 找挂起的
-- SDK 调用（started_at 已写但 completed_at 为空 + lease 已过期）。
CREATE INDEX tool_approval_requests_lease_idx
    ON tool_approval_requests(lease_expires_at)
    WHERE status IN ('approving', 'declining');
-- PR-3.3 Replay Fix：reconciler 扫描索引——按 lease_expires_at 找
-- `approved_resume_indeterminate` 行（approve SDK 抛错后等待恢复检查）。
CREATE INDEX tool_approval_requests_indeterminate_idx
    ON tool_approval_requests(lease_expires_at)
    WHERE status = 'approved_resume_indeterminate';

-- 本阶段不向 agent_runs 增加 approval_request_id 列（V2.1 决策：
-- 审批只走 (run_id, workspace_id) → agent_runs(id, workspace_id) 单向复合外键；
-- 单 Run 可挂多条请求，单值外键不成立）。
--
-- 跨 Workspace 完整性：tool_approval_requests.run_id 与 workspace_id
-- 通过复合外键 (run_id, workspace_id) → agent_runs(id, workspace_id)
-- 强制同 Workspace（agent_runs 持有 UNIQUE(id, workspace_id) 兜底）；
-- 任何跨 Workspace 写入都会被 PG 23503 (foreign_key_violation) 拒绝。

-- ────────────────────────────────────────────────────────────────────
-- 阶段 3.3 追加段（PR-3.3 平台系统执行者身份）：
-- 协议依据：docs/architecture-v2.md §7 + §9 决策
-- 本段落地的不变量：
--   1. `tool_approval_requests.requester_id` 与 `resolver_id` **NOT NULL** FK
--      → app_users(id)。任何审批请求的发起者 / 终结者都必须对应一个真实
--      用户行；NULL 不允许（避免审计盲区）。
--   2. 预留平台服务用户 `app_users(username='system-approval-worker')` 作为
--      系统动作的真实身份——超时收敛（`expireApproval`）的 resolver_id
--      写该用户 UUID，**不**允许用 NULL 跳过 FK 约束。
--      该用户的 `disabled_at` 恒为非空——禁止任何业务路径用其登录，
--      仅供内部审计追溯。
--   3. 正常用户发起的审批必须使用 `agent_runs.created_by`——如果
--      `agent_runs.created_by IS NULL`，Repository 层**拒绝创建**审批
--      请求（不允许写 NULL 进 requester_id）。
-- 重要：本段是**新追加段**，与上方阶段 3.1 段共存；不允许用 ALTER
-- 重写阶段 3.1 表结构。删库重建时 init.sql 必须按顺序执行。
-- ────────────────────────────────────────────────────────────────────

-- 1. 平台服务用户（system-approval-worker）：作为 SDK 调用 / 超时收敛 /
--    跨重启接管 / 续 Run 触发动作的 resolver_id / requester_id 真实身份。
--    username 唯一约束要求 normalized 也唯一，故使用固定 lowercase 串。
--    该行的存在性由"是否记录可审计身份"决定——**禁止**用 ALL-ZERO UUID
--    或任何不存在的 UUID 触发外键错误。
INSERT INTO app_users (id, username, username_normalized, password_hash, disabled_at)
VALUES (
  '00000000-0000-0000-0000-0000000000a1',
  'system-approval-worker',
  'system-approval-worker',
  '!disabled-no-login!',
  now()
)
ON CONFLICT (username_normalized) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════
-- 阶段 4 追加段：异步文档管线（PR-4.2 ingestion job + storage outbox）
-- 协议依据：docs/architecture-v2.md §8.1 / §8.2 / §8.7
-- 本段落地的不变量：
--   1. 上传请求 202 立即返回 `documentId` + `jobId`，不阻塞网络/embedding。
--   2. ingestion worker 通过 `FOR UPDATE SKIP LOCKED` 抢占同一时刻
--      只有一个 active job（partial unique）。
--   3. Worker 进程崩溃后 lease 自然过期；下一轮 worker 接管。
--   4. 软删除事务串联 4 个动作（documents / outbox / finalize_jobs /
--      ingestion_jobs），任意失败回滚整事务。
--   5. 删除走 outbox 持久重试 + 幂等 deleteObject；finalKey 必须最终清零。
--   6. Core Schema 启动不需要 `vector` 扩展；RAG 启用由末尾条件块判断。
-- ────────────────────────────────────────────────────────────────────

-- 1. document_ingestion_jobs：异步 ingestion 的核心状态机。
--    status 与 documents.status 同步（worker 推进时同事务写两份）。
--    lease_owner / lease_expires_at / heartbeat_at：120s lease + 15s
--    心跳；next_attempt_at + attempts + max_attempts 负责失败退避。
--    partial unique：同一 document 同一时刻只允许一个 active job。
CREATE TABLE document_ingestion_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN (
                      'queued', 'parsing', 'chunking', 'embedding',
                      'finalizing', 'ready', 'failed', 'cancelled'
                    )),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  lease_owner     TEXT,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at    TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_code      TEXT,
  error_detail    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX document_ingestion_jobs_queue_idx
  ON document_ingestion_jobs(next_attempt_at)
  WHERE status IN ('queued', 'failed') AND attempts < max_attempts;
CREATE UNIQUE INDEX one_active_ingestion_per_document
  ON document_ingestion_jobs(document_id)
  WHERE status IN ('queued', 'parsing', 'chunking', 'embedding', 'finalizing');
CREATE INDEX document_ingestion_jobs_lease_idx
  ON document_ingestion_jobs(lease_expires_at)
  WHERE status IN ('queued', 'parsing', 'chunking', 'embedding', 'finalizing');

-- 2. storage_finalize_jobs：上传 → finalKey 的 finalize worker 队列。
--    staging_key 仅存在于本表（V2.3.2 关键不变式），进程崩溃后重试
--    worker 仍可定位 staging 对象。final_key 即 documents.storage_key。
--    处理失败重试超过 max_attempts=5 → status='failed'。
--    PR-4.2 §8.1（整改）：'processing' 是 worker 抢占后的瞬态；partial
--    unique 与 lease_idx 都要把 'pending' + 'processing' 同时纳入 —
--    'processing' 行已持有 lease，sweeper 才能据此识别"孤儿抢占"并回收。
CREATE TABLE storage_finalize_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  staging_key     TEXT NOT NULL,
  final_key       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner     TEXT,
  lease_expires_at TIMESTAMPTZ,
  -- PR-4 第二轮 Codex 整改（2026-09-11）：long IO（rename 跨 GB 对象）
  -- 必须有 heartbeat；否则 lease 在 IO 期间过期会被 sweeper 错误收回。
  heartbeat_at    TIMESTAMPTZ,
  last_error      TEXT,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_finalize_per_document
  ON storage_finalize_jobs(document_id)
  WHERE status IN ('pending', 'processing');
CREATE INDEX storage_finalize_jobs_retry_idx
  ON storage_finalize_jobs(next_attempt_at)
  WHERE status = 'pending' AND attempts < max_attempts;
CREATE INDEX storage_finalize_jobs_lease_idx
  ON storage_finalize_jobs(lease_expires_at)
  WHERE status = 'processing';

-- 3. storage_deletion_outbox：删除走 outbox 持久重试。
--    document_id 用 SET NULL 而非 CASCADE，避免硬删 document 把
--    未处理的 outbox 带走（导致 storage 对象永远不被清理）。
--    TTL GC 仅枚举 staging 命名空间，**不能**兜底 finalKey 对象；
--    只有 outbox worker 的持久重试能保证 finalKey 最终被清零。
--    PR-4.2 §8.1（整改）：原表只有 processed_at + attempts；现在加上
--    status / lease_owner / lease_expires_at / next_attempt_at 让 outbox
--    也有严格 lease fencing + 真实退避（避免 attempts 消耗过快）。
--    'processing' = worker 抢占中（lease 持有）；'pending' = 等下次 tick。
CREATE TABLE storage_deletion_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key     TEXT NOT NULL,
  document_id     UUID REFERENCES documents(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner     TEXT,
  lease_expires_at TIMESTAMPTZ,
  -- PR-4 第二轮 Codex 整改（2026-09-11）：storage.remove 是远端 S3/
  -- Azure blob API 调用，需要 heartbeat；与 finalize 一致设计。
  heartbeat_at    TIMESTAMPTZ,
  last_error      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX storage_deletion_outbox_pending_idx
  ON storage_deletion_outbox(next_attempt_at)
  WHERE status = 'pending' AND attempts < max_attempts;
CREATE INDEX storage_deletion_outbox_lease_idx
  ON storage_deletion_outbox(lease_expires_at)
  WHERE status = 'processing';
CREATE INDEX storage_deletion_outbox_document_idx
  ON storage_deletion_outbox(document_id)
  WHERE processed_at IS NULL;

-- 表级元数据：供 psql、数据库 IDE 和 schema inspection 直接查询。
COMMENT ON TABLE app_users IS '应用本地认证用户账号。';
COMMENT ON TABLE auth_sessions IS '登录会话及其撤销和过期状态。';
COMMENT ON TABLE workspaces IS '数据隔离、资源归属和成员协作的工作区。';
COMMENT ON TABLE workspace_members IS '工作区成员关系及其角色。';
COMMENT ON TABLE skill_packages IS '已登记或已安装的 Skill 包元数据。';
COMMENT ON TABLE knowledge_bases IS '工作区内的知识库容器。';
COMMENT ON TABLE documents IS '知识库文档及其解析、存储和处理状态。';
COMMENT ON TABLE document_chunks IS '文档切块及其检索和引用元数据。';
COMMENT ON TABLE conversations IS '聊天会话及其所选 Agent 和知识库配置。';
COMMENT ON TABLE messages IS '会话消息、生成状态、引用数据和当前 Run 关联。';
COMMENT ON TABLE tool_executions IS '模型 Tool 调用的审计记录和执行状态；tool_call_id 是跨实时与历史视图的稳定调用标识。';
COMMENT ON TABLE agent_skill_bindings IS 'Agent 与 Skill 包的绑定关系。';
COMMENT ON TABLE workspace_skills IS '工作区启用的 Skill 包及其配置。';
COMMENT ON TABLE agent_runs IS '异步 Agent Run 的持久化状态、租约和执行上下文。';
COMMENT ON TABLE agent_run_events IS '可回放的 Agent Run 事件流，不保存高频实时文本增量。';
COMMENT ON TABLE idempotency_keys IS '写操作的幂等请求键及其缓存响应。';
COMMENT ON TABLE tool_policy_rules IS '工作区维度的 Tool 调用策略规则。';
COMMENT ON TABLE tool_approval_requests IS '需要人工审批的 Tool 调用请求及其恢复状态。';
COMMENT ON TABLE document_ingestion_jobs IS '文档解析、切块和向量化的异步任务。';
COMMENT ON TABLE storage_finalize_jobs IS '文档入库后对象存储定稿的异步补偿任务。';
COMMENT ON TABLE storage_deletion_outbox IS '文档删除时对象存储清理的可靠 outbox 任务。';

-- ════════════════════════════════════════════════════════════════════
-- 阶段 4 RAG 条件块（PR-4.1 §8.4.1 / §8.4.2 / §8.5）
--   - 由 `migrate.ts` 启动期 `SET LOCAL app.rag_enabled = 'on'` 后跑。
--   - Core-only 部署不执行此块 → `vector` 扩展、`embedding_profiles`、
--     `document_embeddings` 全部不存在。
--   - 检测方式：`current_setting('app.rag_enabled', true) = 'on'`；
--     缺省为 off（与 Core 默认一致），不抛错。
--   - 同一脚本既支持 fresh init，又支持 RAG 模块后启用（删库重建路径
--     仍由用户手动触发，本脚本不引入迁移链）。
-- ────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF current_setting('app.rag_enabled', true) IS DISTINCT FROM 'on' THEN
    RAISE NOTICE 'PR-4 RAG 块跳过：app.rag_enabled != on（Core-only 模式）';
    RETURN;
  END IF;

  RAISE NOTICE 'PR-4 RAG 块启用：创建 embedding_profiles + document_embeddings（vector 扩展已在 bootstrap 顶层创建）';

  -- 1) embedding_profiles：每个 Workspace 拥有若干 profile，标记哪个
  --    是当前激活的（用于 RAG 检索）。后续要切换 Provider / Model /
  --    dimensions：创建新 profile，激活新 + 失活旧，再触发存量向量
  --    重 embedding。**禁止**伪造旧向量归属。
  EXECUTE $E$
    CREATE TABLE embedding_profiles (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider    TEXT NOT NULL,
      model       TEXT NOT NULL,
      dimensions  INTEGER NOT NULL CHECK (dimensions > 0),
      version     TEXT NOT NULL DEFAULT 'v1',
      status      TEXT NOT NULL DEFAULT 'inactive'
                    CHECK (status IN ('active','inactive','migrating','legacy')),
      is_active   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, provider, model, version)
    );
  $E$;
  -- partial unique：同一 workspace 最多一个 active profile
  EXECUTE $E$
    CREATE UNIQUE INDEX one_active_embedding_profile_per_workspace
      ON embedding_profiles(workspace_id) WHERE is_active = TRUE;
  $E$;
  EXECUTE $E$
    COMMENT ON TABLE embedding_profiles IS '工作区的 Embedding Provider 和模型配置，以及当前激活的 Profile。';
  $E$;

  -- 3) document_embeddings：每个 chunk 可以有多个 profile 的向量。
  --    chunk_id 维度唯一（chunk 已 uniq on (document_id, chunk_index)）。
  --    content_hash 用于切读时校验"同 chunk 同 hash 才覆盖"语义。
  --    profile 切换时通过新 profile 重 embedding + UPSERT 完成。
  EXECUTE $E$
    CREATE TABLE document_embeddings (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_id     UUID NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
      profile_id   UUID NOT NULL REFERENCES embedding_profiles(id) ON DELETE CASCADE,
      embedding    vector NOT NULL,
      dimensions   INTEGER NOT NULL CHECK (dimensions > 0),
      content_hash TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (chunk_id, profile_id)
    );
  $E$;
  -- 跨 workspace 完整性 + 检索路径加速索引
  EXECUTE $E$
    CREATE INDEX document_embeddings_workspace_chunk_idx
      ON document_embeddings(workspace_id, chunk_id);
  $E$;

  -- 4) 普通过滤索引：精确检索阶段用（`<=>` 全表 scan + LIMIT）。
  --    **不再**在 init.sql 里建通用 HNSW 索引：`embedding vector` 是
  --    可变维度列，HNSW 必须绑定固定 dimensions 才能 DDL；一个全局
  --    HNSW 既不可创建、也会把后续切维度卡死。后续 HNSW 由 profile
  --    生命周期在维度固定后按 (profile_id, dimensions) 建 partial
  --    index（PR-4.3+ 待办，本轮不做）。
  EXECUTE $E$
    CREATE INDEX document_embeddings_profile_chunk_idx
      ON document_embeddings(profile_id, chunk_id);
  $E$;
  EXECUTE $E$
    COMMENT ON TABLE document_embeddings IS '文档切块在指定 Embedding Profile 下的向量及版本信息。';
  $E$;

  RAISE NOTICE 'PR-4 RAG 块完成：embedding_profiles + document_embeddings 已建（无全局 HNSW）';
END
$$;
