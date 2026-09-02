/**
 * Idempotency-Key repository（architecture-v2.md §6.2）：
 *   - POST 必须带 `Idempotency-Key: <uuid>`，缺 / 非法 → 422；
 *   - 同一 (workspace_id, user_id, key) + 同 fingerprint → 返回原 response；
 *   - 同一 key + 不同 fingerprint → 409 IDEMPOTENCY_KEY_REUSED；
 *   - 24h TTL 由 `expires_at` 字段驱动。
 *   - 同 (ws, user, key) 并发同 fingerprint：必须只有一次副作用，全部请求
 *     都返回同一稳定响应（V2 §6.2 + §6.4）；用 advisory_xact_lock 串行化。
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getDatabasePool } from '../../infrastructure/database/pool.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 稳定指纹：canonical JSON(method + path + body) 的 sha256。
 * 字段顺序按对象 key 字典序序列化，避免相同内容不同 key 顺序产生不同指纹。
 */
export function fingerprintRequest(method: string, path: string, body: unknown): string {
  const canonical = canonicalize({
    method: method.toUpperCase(),
    path,
    body: body ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }
  return JSON.stringify(String(value));
}

export interface IdempotencyHit {
  status: number;
  body: unknown;
}
export interface IdempotencyMiss {
  reason: 'not_found';
}
export interface IdempotencyMismatch {
  reason: 'mismatch';
}

export async function lookupIdempotency(
  args: {
    workspaceId: string;
    userId: string;
    key: string;
    fingerprint: string;
  },
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<IdempotencyHit | IdempotencyMiss | IdempotencyMismatch> {
  // 与"占位行"兼容：response_status / response_body 可能为 NULL。
  const r = await executor.query<{
    request_fingerprint: string;
    response_status: number | null;
    response_body: unknown | null;
    completed_at: string | null;
    expires_at: string;
  }>(
    `SELECT request_fingerprint, response_status, response_body, completed_at, expires_at
       FROM idempotency_keys
      WHERE workspace_id = $1 AND user_id = $2 AND key = $3`,
    [args.workspaceId, args.userId, args.key],
  );
  const row = r.rows[0];
  if (!row) return { reason: 'not_found' };
  if (new Date(row.expires_at).getTime() < now()) {
    return { reason: 'not_found' };
  }
  if (row.request_fingerprint !== args.fingerprint) {
    return { reason: 'mismatch' };
  }
  if (row.completed_at === null || row.response_status === null || row.response_body === null) {
    // 占位行（另一个事务尚未提交其响应）；用 caller 自行处理
    // —— 此函数保留旧行为（视作 not_found），让 caller 走 claimOrLookup
    // 路径再获取串行化保证。
    return { reason: 'not_found' };
  }
  return {
    status: row.response_status,
    body: row.response_body,
  };
}

export type ClaimResult =
  | { claimed: true }
  | { claimed: false; hit: IdempotencyHit }
  | { claimed: false; mismatch: true }
  | { claimed: false; missing: true };

/**
 * 在调用方事务内"串行化声明 / 命中 / 失配"。
 *
 * 三步（必须同事务）：
 *   1. pg_advisory_xact_lock(hashtext(ws:user:key))：阻塞式串行化并发同 key 请求；
 *   2. SELECT 已存在行：
 *      - 不存在 → 占位 INSERT（response_status/response_body=NULL）；
 *      - 已存在且 completed_at 不为空 → 直接返回 cached；
 *      - 已存在且 fingerprint 不同 → 返回 mismatch；
 *      - 已存在但 completed_at 为空（理论上同事务锁下不应再撞上）→ 视为本事务"声明成功"继续。
 *   3. advisory lock 在事务结束时自动释放。
 *
 * 调用方拿到 `claimed: true` 后可安全地执行副作用，最后调用 `finalizeIdempotency`
 * 把响应写入占位行并设置 completed_at。
 */
export async function claimOrLookupIdempotency(
  client: PoolClient,
  args: {
    workspaceId: string;
    userId: string;
    key: string;
    fingerprint: string;
    ttlMs?: number;
  },
): Promise<ClaimResult> {
  const lockKey = `${args.workspaceId}:${args.userId}:${args.key}`;
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);

  const r = await client.query<{
    request_fingerprint: string;
    response_status: number | null;
    response_body: unknown | null;
    completed_at: string | null;
    expires_at: string;
  }>(
    `SELECT request_fingerprint, response_status, response_body, completed_at, expires_at
       FROM idempotency_keys
      WHERE workspace_id = $1 AND user_id = $2 AND key = $3`,
    [args.workspaceId, args.userId, args.key],
  );
  const row = r.rows[0];
  if (!row) {
    const expiresAt = new Date(now() + (args.ttlMs ?? TTL_MS)).toISOString();
    await client.query(
      `INSERT INTO idempotency_keys (
         workspace_id, user_id, key, request_fingerprint,
         response_status, response_body, expires_at, completed_at
       ) VALUES ($1, $2, $3, $4, NULL, NULL, $5, NULL)
       ON CONFLICT (workspace_id, user_id, key) DO NOTHING`,
      [args.workspaceId, args.userId, args.key, args.fingerprint, expiresAt],
    );
    return { claimed: true };
  }
  if (new Date(row.expires_at).getTime() < now()) {
    // 已过期：把占位行覆盖成本事务的 fingerprint，避免误判命中。
    const expiresAt = new Date(now() + (args.ttlMs ?? TTL_MS)).toISOString();
    await client.query(
      `UPDATE idempotency_keys
          SET request_fingerprint = $4,
              response_status = NULL,
              response_body = NULL,
              completed_at = NULL,
              expires_at = $5
        WHERE workspace_id = $1 AND user_id = $2 AND key = $3`,
      [args.workspaceId, args.userId, args.key, args.fingerprint, expiresAt],
    );
    return { claimed: true };
  }
  if (row.request_fingerprint !== args.fingerprint) {
    return { claimed: false, mismatch: true };
  }
  if (
    row.completed_at === null ||
    row.response_status === null ||
    row.response_body === null
  ) {
    // 仍为占位；理论上 advisory lock 串行化后不应再撞上；但保险起见视作本事务继续。
    return { claimed: true };
  }
  return {
    claimed: false,
    hit: { status: row.response_status, body: row.response_body },
  };
}

/**
 * 把响应写入占位行并标记 completed_at。
 * 调用方必须在与副作用 / 占位声明同一事务内调用。
 */
export async function finalizeIdempotency(
  client: PoolClient,
  args: {
    workspaceId: string;
    userId: string;
    key: string;
    responseStatus: number;
    responseBody: unknown;
  },
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
        SET response_status = $4,
            response_body = $5::jsonb,
            completed_at = now()
      WHERE workspace_id = $1
        AND user_id = $2
        AND key = $3`,
    [
      args.workspaceId,
      args.userId,
      args.key,
      args.responseStatus,
      JSON.stringify(args.responseBody),
    ],
  );
}

/**
 * 旧 storeIdempotency：保留为"INSERT 形式"快捷路径；新代码应使用
 * `claimOrLookupIdempotency` + `finalizeIdempotency`，因为旧路径在并发
 * 同 key 场景下会产生两次副作用。
 */
export async function storeIdempotency(
  client: PoolClient,
  args: {
    workspaceId: string;
    userId: string;
    key: string;
    fingerprint: string;
    responseStatus: number;
    responseBody: unknown;
    ttlMs?: number;
  },
): Promise<void> {
  const expiresAt = new Date(now() + (args.ttlMs ?? TTL_MS)).toISOString();
  await client.query(
    `INSERT INTO idempotency_keys (
       workspace_id, user_id, key, request_fingerprint,
       response_status, response_body, expires_at, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
     ON CONFLICT (workspace_id, user_id, key) DO NOTHING`,
    [
      args.workspaceId,
      args.userId,
      args.key,
      args.fingerprint,
      args.responseStatus,
      JSON.stringify(args.responseBody),
      expiresAt,
    ],
  );
}

function now(): number {
  return Date.now();
}