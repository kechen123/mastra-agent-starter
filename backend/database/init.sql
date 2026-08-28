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
