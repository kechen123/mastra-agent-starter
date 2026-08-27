-- 0001-local-auth.sql
--
-- 第一期本地账号密码登录所需的最小数据模型。
--
-- 设计约束：
--   * 只增不改：本迁移不修改任何已有表的列。
--   * username_normalized 唯一约束已经隐含索引；不另建同名索引。
--   * token_hash 唯一约束已经隐含索引；不另建同名索引或 partial 索引。
--   * 只在 auth_sessions(user_id) 建一个二级索引，便于列出某用户历史会话。
--   * 会话查询（auth_sessions 主体）仅命中 token_hash 唯一约束；过期/
--     吊销/禁用过滤由 WHERE 子句执行。
--
-- 不修改 init.sql；本文件是 init.sql（0000-initial-schema）之后的唯一
-- 业务迁移。

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
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id);
