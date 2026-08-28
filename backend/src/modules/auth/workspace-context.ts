/**
 * Workspace 上下文：把当前登录用户绑到 Personal Workspace（V2.3.6 §5.1）。
 *
 * 关键不变量：
 *   1. 每个用户最多 1 个 `kind='personal'` 的 Workspace（DB partial unique
 *      `one_personal_workspace_per_user` 强保证）。
 *   2. `ensurePersonalWorkspace(userId)` 并发幂等：使用
 *      `INSERT ... ON CONFLICT (owner_user_id) WHERE kind='personal' DO NOTHING
 *      RETURNING id` + 兜底 SELECT。两个并发事务最多创建 1 行；不会出现两个
 *      Personal Workspace。
 *   3. `Shared Workspace` 不能被 `ensurePersonalWorkspace` 误命中：
 *      SELECT 路径必须显式带 `kind='personal' AND owner_user_id=:userId`，
 *      不能再用"成员加入时间最早的一条"推断。
 *   4. 已存在 Personal Workspace 但 `workspace_members` owner 行缺失时，
 *      自动在事务内补齐（成员写入走 `ON CONFLICT DO NOTHING`，对重复调用
 *      天然幂等）。
 *   5. 失败语义：
 *      - `UserNotFoundError`：用户不存在或被禁用；
 *      - 其他错误（断连、约束冲突等）直接向上抛；不得伪装为 `null`。
 *   6. Personal Workspace 名称不含密码、Token、用户敏感信息；统一为
 *      `'personal'`。
 *
 * 类型契约：
 *   - 函数接受 `Pool | PoolClient`；运行时按是否带 `release` 区分。
 *   - `PoolClient`（事务上下文）：直接复用调用方的事务边界。
 *   - `Pool`（无事务上下文）：本函数自管 `BEGIN/COMMIT/ROLLBACK`。
 *   - 不再做"靠 any 强转掩盖 connect 调用"的隐式假设。
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { extractSessionTokenFromRequest } from '../../infrastructure/auth/local-auth-provider.js';
import { resolveSession } from '../../infrastructure/auth/session.js';
import { mapErrorToResponse } from '../../server/error-mapping.js';

/** Personal Workspace 的统一 display name。 */
const PERSONAL_WORKSPACE_NAME = 'personal';

/** 既能与 Pool 也能与 PoolClient 协作的 query 桥。 */
type Executor = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};
type ClientWithTx = PoolClient & Executor;

/** pg 的 query 重载无法直接用 generic；这里统一收口到一行。 */
async function execQuery<R extends QueryResultRow = QueryResultRow>(
  exec: Executor,
  sql: string,
  params?: unknown[],
): Promise<{ rows: R[] }> {
  const result = await exec.query(sql, params);
  return { rows: result.rows as R[] };
}

function isPoolClient(value: Pool | PoolClient): value is PoolClient {
  return typeof (value as Partial<PoolClient>).release === 'function';
}

function asExecutor(value: Pool | PoolClient): Executor {
  if (isPoolClient(value)) {
    return value as ClientWithTx;
  }
  // Pool 也带 .query：直接当作 executor 用。
  return value as unknown as Executor;
}

export class WorkspaceContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceContextError';
  }
}

export class UserNotFoundError extends WorkspaceContextError {
  constructor(userId: string) {
    super(`用户不存在：${userId}`);
    this.name = 'UserNotFoundError';
  }
}

export class WorkspaceIntegrityError extends WorkspaceContextError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceIntegrityError';
  }
}

interface UserRow {
  id: string;
}

interface WorkspaceRow {
  id: string;
}

/**
 * 为一个用户确保存在 Personal Workspace（V2.3.6 §5.1 强约束）。
 *
 * 行为：
 *   - 拿到 `{ userId, workspaceId }`，其中 `workspaceId` **始终**非空。
 *   - 同一 userId 多次调用幂等：DB partial unique + ON CONFLICT 保证。
 *   - 不会把 Shared Workspace 当成 Personal。
 *
 * 失败语义：
 *   - `UserNotFoundError`：用户不存在或被禁用；
 *   - `WorkspaceIntegrityError`：DB 状态与 V2.3.6 不变量冲突（如 Personal
 *     Workspace 缺失 owner 成员行且补齐失败）；
 *   - 其他错误原样向上抛，绝不包装成 `null`。
 */
export async function ensurePersonalWorkspace(
  userId: string,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<{ userId: string; workspaceId: string }> {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new WorkspaceContextError('userId 必须是非空字符串。');
  }

  if (isPoolClient(executor)) {
    return runEnsure(userId, executor);
  }
  const client = await executor.connect();
  try {
    await client.query('BEGIN');
    const result = await runEnsure(userId, client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // 连接已断，ROLLBACK 也会失败；忽略。
    }
    throw error;
  } finally {
    client.release();
  }
}

async function runEnsure(
  userId: string,
  client: ClientWithTx,
): Promise<{ userId: string; workspaceId: string }> {
  // 1. 用户存在性
  const userRow = await execQuery<UserRow>(
    client,
    'SELECT id FROM app_users WHERE id = $1 AND disabled_at IS NULL',
    [userId],
  );
  if (userRow.rows.length === 0) {
    throw new UserNotFoundError(userId);
  }

  // 2. 并发安全的 INSERT：partial unique `one_personal_workspace_per_user`
  //    保证同一 userId 不会创建两个 Personal Workspace。
  //    RETURNING 在冲突时不会返回行——这是兜底 SELECT 的触发条件。
  const inserted = await execQuery<WorkspaceRow>(
    client,
    `INSERT INTO workspaces (kind, name, owner_user_id)
     VALUES ('personal', $1, $2)
     ON CONFLICT (owner_user_id) WHERE kind = 'personal' DO NOTHING
     RETURNING id`,
    [PERSONAL_WORKSPACE_NAME, userId],
  );
  let workspaceId = inserted.rows[0]?.id;

  // 3. 兜底 SELECT：另一个事务可能先于本事务创建好了；用显式
  //    `kind='personal' AND owner_user_id=:userId` 过滤，绝不命中 Shared。
  if (!workspaceId) {
    const found = await execQuery<WorkspaceRow>(
      client,
      `SELECT id
         FROM workspaces
        WHERE kind = 'personal' AND owner_user_id = $1`,
      [userId],
    );
    workspaceId = found.rows[0]?.id;
  }

  if (!workspaceId) {
    // 既 INSERT 没成功，SELECT 也找不到——DB 状态被破坏。
    // 真实失败语义：直接抛错，不允许返回 null。
    throw new WorkspaceIntegrityError(
      `无法为用户 ${userId} 解析 Personal Workspace：DB 状态不一致。`,
    );
  }

  // 4. 补齐 owner 成员行。
  //    - 行不存在 → INSERT；
  //    - 行存在但 role!='owner' → DO UPDATE 把 role 修正为 'owner'
  //      （Personal Workspace 的 owner 成员行 role 必须是 'owner'，这是
  //      V2.3.6 §5.1 的不变量；用 DO NOTHING 反而会保留错误角色）；
  //    - 行存在且 role='owner' → WHERE 子句过滤，零更新；
  //    这条 INSERT/UPDATE 在 partial unique + workspace_members 主键保护下
  //    对重复调用天然幂等。
  await client.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner')
     ON CONFLICT (workspace_id, user_id) DO UPDATE
       SET role = 'owner'
       WHERE workspace_members.role <> 'owner'`,
    [workspaceId, userId],
  );

  return { userId, workspaceId };
}

/**
 * 包一层：保证 fn 一定拿到一个 `workspaceId`；调用方不必处理初始化边界。
 */
export async function withPersonalWorkspace<T>(
  userId: string,
  fn: (ctx: { userId: string; workspaceId: string }) => Promise<T>,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<T> {
  const ctx = await ensurePersonalWorkspace(userId, executor);
  return await fn(ctx);
}

/**
 * 读取用户 Personal Workspace ID；不存在或不是 personal 形态则抛错。
 *
 * 与 `ensurePersonalWorkspace` 的差别：本函数**不**新建。供"已经走过
 * ensure 路径的下游"使用（不依赖 ensure 的副作用）。
 */
export async function resolvePersonalWorkspaceId(
  userId: string,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<string> {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new WorkspaceContextError('userId 必须是非空字符串。');
  }
  const exec = asExecutor(executor);
  const row = await execQuery<WorkspaceRow>(
    exec,
    `SELECT id
       FROM workspaces
      WHERE kind = 'personal' AND owner_user_id = $1`,
    [userId],
  );
  const first = row.rows[0];
  if (!first) {
    throw new WorkspaceContextError(
      `用户 ${userId} 尚未绑定 Personal Workspace。`,
    );
  }
  return first.id;
}

/**
 * 当前用户可见的 workspace 列表。Personal 永远在首位。
 * 供前端"切换 workspace" UI 使用；本 PR-1.1 阶段每用户仅 1 个 Personal，
 * 不会出现 Shared。
 */
export async function listWorkspacesForUser(
  userId: string,
  executor: Pool | PoolClient = getDatabasePool(),
): Promise<Array<{ id: string; name: string; kind: 'personal' | 'shared'; role: string; joinedAt: Date }>> {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new WorkspaceContextError('userId 必须是非空字符串。');
  }
  const exec = asExecutor(executor);
  const { rows } = await execQuery<{
    id: string;
    name: string;
    kind: 'personal' | 'shared';
    role: string;
    joined_at: Date;
  }>(
    exec,
    `SELECT w.id, w.name, w.kind, m.role, m.joined_at
       FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = $1 AND w.deleted_at IS NULL
      ORDER BY (w.kind = 'personal') DESC, m.joined_at ASC`,
    [userId],
  );
  return rows.map((row: { id: string; name: string; kind: 'personal' | 'shared'; role: string; joined_at: Date }) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    role: row.role,
    joinedAt: row.joined_at,
  }));
}

/**
 * 已认证身份上下文（V2.3.6 §5.1）。
 *
 * 这是路由层**唯一**允许读取 workspaceId 的入口。
 * 路由不应该从 `body.workspaceId` / `?workspaceId=...` /
 * `X-Workspace-Id` 头等任何客户端字段直接拿 ID——本函数会忽略这些字段，
 * 仅依赖 `mastra_session` Cookie 解析出的服务端 session。
 */
export interface AuthenticatedContext {
  userId: string;
  username: string;
  workspaceId: string;
}

/**
 * 从 HTTP 请求解析已认证身份上下文。
 *
 * 行为契约：
 *   - 没有有效 session（无 Cookie / token 失效 / 用户被禁用）→ 返回 `null`。
 *     路由层应映射为 401，由 `requiresAuth: true` 兜底。
 *   - 有有效 session → 调用 `ensurePersonalWorkspace` 拿到非空 `workspaceId`，
 *     构造 `AuthenticatedContext` 返回。
 *   - 真实错误（DB 断连、约束冲突、UserNotFound）→ 直接向上抛；
 *     路由层映射 500，**绝不**降级为 `null` 或 `workspaceId=undefined`。
 *   - 显式忽略 `X-Workspace-Id` / `?workspaceId=` / `body.workspaceId`
 *     等任何客户端字段。伪造请求覆盖不到服务端上下文。
 *
 * 路由使用：
 *   - **推荐**走 `withAuthenticatedWorkspace(handler)` 包装器，由它统一
 *     解析 401 / 注入上下文。
 *   - 直接调用本函数的场景极少（主要给 server middleware / 单元测试用）。
 *   ```ts
 *   const ctx = await resolveAuthenticatedContext(request);
 *   if (!ctx) return context.json({ message: '未登录' }, 401);
 *   // ctx.workspaceId 一定非空；business logic 直接用。
 *   ```
 */
export async function resolveAuthenticatedContext(
  request: Request,
): Promise<AuthenticatedContext | null> {
  // 显式忽略任何客户端传入的 workspaceId —— 防止伪造 / 越权。
  // 该步骤不读取任何 header / query / body；仅依赖 session 解析。
  // 真实错误向上抛；session 不存在 → null。
  const token = extractSessionTokenFromRequest(request);
  const resolved = await resolveSession(typeof token === 'string' ? token : '');
  if (!resolved) return null;

  // ensurePersonalWorkspace 会把 WorkspaceContextError 之外的真实错误
  // 继续向上抛；这里不吞错。
  const { workspaceId } = await ensurePersonalWorkspace(resolved.user.id);
  return {
    userId: resolved.user.id,
    username: resolved.user.username,
    workspaceId,
  };
}

/**
 * `Mastra` 路由 handler 接受的 context 形状（仅声明本文件用到的子集）。
 *
 * 注册路由时 `registerApiRoute(path, { handler })` 的 handler 形参就是这个
 * `context`。我们用 structural type 而不是 import Mastra 内部类型，避免
 * 与版本耦合。
 *
 * 字段集是故意写得**宽于**实际需要：Mastra 的真实 context 还包含
 * `req.param / req.query / req.json / req.formData` 以及 `context.body`，
 * 但这些字段在不同版本的类型签名上略有差异；包装器只用到 `req.raw` 与
 * `context.json`，下游 handler 则需要完整子集。
 * 这里采用 required 字段 + 兜底返回 `undefined` 的方式，让所有路由文件
 * 继续用自己已有的 Mastra 类型推论，同时仍能被 `withAuthenticatedWorkspace`
 * 包装。
 */
export interface AuthenticatedRouteContextLike {
  req: {
    raw?: Request;
    header?: (n: string) => string | undefined;
    // Mastra 的真实签名：`param` 命中路由占位符时返回 string；
    // 未命中时返回 undefined。我们用 string 与下游兼容。
    param: (name: string) => string;
    query: (name: string) => string | undefined;
    json: <T = unknown>() => Promise<T>;
    formData: () => Promise<FormData>;
    body?: unknown;
  };
  json: (data: unknown, status?: number) => Response;
  body: (data: unknown, status?: number) => Response;
}

/**
 * 已认证路由 handler：拿到非空 workspaceId 后再做业务。
 */
export type AuthenticatedRouteHandler = (
  ctx: AuthenticatedContext,
  context: AuthenticatedRouteContextLike,
) => Promise<Response>;

/**
 * 把受保护路由 handler 包一层：自动 resolveAuthenticatedContext、自动 401。
 *
 * 所有 requiresAuth: true 的业务路由都必须经过本包装器 — 这是 V2.3.6
 * §5.1 的强制约束。逐路由手写 resolveAuthenticatedContext + 401 映射会
 * 出现漂移（/auth/me 写了、其他路由漏写），后续 PR-1.2 给业务表加
 * workspace_id 时所有写入路径就会找不到可信上下文。
 *
 * 静态合约保证：本约束不靠口头约定。tests/contracts/run.ts 第 8 节会扫描
 * 所有 server/routes 下 TS 文件，对每一个 requiresAuth 为 true 的
 * registerApiRoute(...) 校验其 handler 是否以 withAuthenticatedWorkspace
 * 起始。漏配一个就 CI 红，且不允许把 requiresAuth 改成 false 来蒙混
 * — 后者另有 §7 静态检查兜底。
 *
 * 行为：
 *   - 无 session / token 失效 → 401 { message: '未登录或会话已失效。' }；
 *   - 有 session → 调用 ensurePersonalWorkspace 注入非空 workspaceId；
 *   - 真实错误（DB 断连、约束冲突、UserNotFound）→ 继续向上抛。
 *
 * 用法（完整示例见 §8 静态合约测试）：
 *   handler: withAuthenticatedWorkspace(async (auth, context) => {...})
 *
 * 测试边界：withAuthenticatedWorkspace 只覆盖 handler 内部行为。
 * meRoute.handler(fakeContext) 这种 Handler 级集成测试能验证包装器 +
 * handler 契约，但不验证 Mastra 路由匹配、LocalAuthProvider middleware
 * 链或 HTTP 框架层。完整 E2E 必须启动 mastra dev 或 mastra start
 * 并命中真实端口。
 */
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

// 抑制 unused 警告；QueryResultRow 在文件其他地方用到时再暴露。
export type { QueryResultRow };
