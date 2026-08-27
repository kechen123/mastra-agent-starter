/**
 * 会话存储 / 查询 / 撤销。
 *
 * 数据库只保存原始 token 的 SHA-256 哈希；原始 token 仅写入 Cookie。
 *
 * Phase 1 **不** 维护 `last_seen_at`：每次请求不写、SSE 长连接也不写，
 * 避免高频写入放大。该列在 schema 里保留是为后续阶段（观测、闲置超时）
 * 预留，避免现在写迁移、之后还要写迁移。
 *
 * 本模块是纯 DB IO；HTTP / Cookie 相关的解析由 `request.ts` 负责。
 */
import { createHash, randomBytes } from 'node:crypto';
import { getDatabasePool } from '../database/pool.js';

export interface AuthUser {
  id: string;
  username: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

export interface ResolvedSession {
  sessionId: string;
  user: AuthUser;
  expiresAt: Date;
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export const SESSION_TOKEN_BYTES = 32;

export class SessionNotFoundError extends Error {
  constructor() {
    super('会话不存在。');
    this.name = 'SessionNotFoundError';
  }
}

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateSessionInput {
  userId: string;
  ttlDays: number;
}

/**
 * 创建一个新会话并返回原始 token。
 * 调用方负责：把 token 写入 HttpOnly Cookie、把 expiresAt 同步到 Cookie 的 Max-Age。
 * 数据库只保存 hash。
 */
export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  if (!Number.isInteger(input.ttlDays) || input.ttlDays <= 0) {
    throw new Error('ttlDays 必须是正整数。');
  }
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + input.ttlDays * 24 * 60 * 60 * 1000);
  await getDatabasePool().query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [input.userId, tokenHash, expiresAt],
  );
  return { token, expiresAt };
}

/**
 * 用原始 token 解析当前会话：必须存在、未撤销、未过期、所属用户未禁用。
 * 不更新 `last_seen_at`。
 */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  if (typeof token !== 'string' || token.length === 0) return null;
  const tokenHash = hashSessionToken(token);
  const result = await getDatabasePool().query<SessionRow & { username: string; disabled_at: Date | null }>(
    `SELECT s.id, s.user_id, s.token_hash, s.expires_at, s.revoked_at, s.created_at,
            u.username, u.disabled_at
       FROM auth_sessions s
       JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.disabled_at IS NULL
      LIMIT 1`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    sessionId: row.id,
    expiresAt: row.expires_at,
    user: { id: row.user_id, username: row.username },
  };
}

/**
 * 撤销单个会话（按 token hash）。如果 token 无效，不报错。
 */
export async function revokeSessionByToken(token: string): Promise<void> {
  if (typeof token !== 'string' || token.length === 0) return;
  const tokenHash = hashSessionToken(token);
  await getDatabasePool().query(
    `UPDATE auth_sessions
        SET revoked_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL`,
    [tokenHash],
  );
}

export async function findUserByUsernameNormalized(normalizedUsername: string): Promise<
  | { id: string; username: string; passwordHash: string; disabledAt: Date | null }
  | null
> {
  const result = await getDatabasePool().query<{
    id: string;
    username: string;
    password_hash: string;
    disabled_at: Date | null;
  }>(
    `SELECT id, username, password_hash, disabled_at
       FROM app_users
      WHERE username_normalized = $1
      LIMIT 1`,
    [normalizedUsername],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    disabledAt: row.disabled_at,
  };
}

export async function findUserById(id: string): Promise<AuthUser | null> {
  const result = await getDatabasePool().query<{ id: string; username: string }>(
    `SELECT id, username
       FROM app_users
      WHERE id = $1
        AND disabled_at IS NULL
      LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, username: row.username };
}
