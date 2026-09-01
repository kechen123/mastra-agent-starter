/**
 * 认证服务：登录、登出、读取当前用户。
 *
 * 关键不变量（V2.3.6 §5.1）：
 *   * 登录失败统一返回 `InvalidCredentialsError`；不区分用户不存在、密码错误、
 *     用户被禁用。这是用户名枚举防护。
 *   * 用户不存在或被禁用时也跑一次等价 scrypt，避免明显的时序差异。
 *   * `SafeUser` 是**已认证身份上下文**：包含 `id`、`username`、**非空**
 *     `workspaceId`（V2.3.6 §5.1）。任何把 `workspaceId` 设计为长期可空
 *     的契约都视为违反。
 *   * 登录顺序固定：密码校验成功 → `ensurePersonalWorkspace()` →
 *     `createSession()`。Workspace 初始化失败时绝不创建新 Session，
 *     避免遗留"有效 Session 但 workspaceId 缺失"的悬空状态。
 *   * `resolveCurrentUser` 对已认证请求自动 `ensurePersonalWorkspace`，
 *     保证 `/auth/me` 等接口总能返回非空 workspaceId；断连 / 约束冲突
 *     等真实错误继续向上抛，绝不伪装成"未登录"或 `workspaceId=null`。
 *   * 不在日志、错误对象、返回值中输出 `password_hash`、原始 token 或
 *     `token_hash`。
 */
import {
  createSession,
  findUserById,
  findUserByUsernameNormalized,
  resolveSession,
  revokeSessionByToken,
  type AuthUser,
  type CreatedSession,
} from '../../infrastructure/auth/session.js';
import {
  InvalidPasswordError,
  hashPassword,
  verifyPassword,
} from '../../infrastructure/auth/password.js';
import {
  InvalidUsernameError,
  normalizeUsername,
} from '../../infrastructure/auth/username.js';
import { getResolvedAuthConfig } from '../../infrastructure/auth/request.js';
import {
  ensurePersonalWorkspace,
  UserNotFoundError,
  WorkspaceContextError,
  WorkspaceIntegrityError,
} from './workspace-context.js';

export class InvalidCredentialsError extends Error {
  constructor() {
    super('用户名或密码错误。');
    this.name = 'InvalidCredentialsError';
  }
}

export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingCredentialsError';
  }
}

/**
 * 已认证身份上下文（V2.3.6 §5.1）：
 *   * `workspaceId` **始终**非空——本类型只在 `ensurePersonalWorkspace`
 *     成功之后才被构造。
 *   * 适用于 `/auth/login` 与 `/auth/me` 响应；不适合"只查用户"的纯查询
 *     场景（那种场景用 `PublicUser`）。
 */
export interface SafeUser {
  id: string;
  username: string;
  workspaceId: string;
}

/**
 * 仅包含"用户是谁"的轻量视图，不携带 workspace 上下文。
 * 适用于只读 / 不需要 workspace 归属的内部调用（例如给审批流读 user
 * profile）。**不要**在 HTTP 响应里直接使用本类型——响应必须用 SafeUser
 * 表达已认证身份。
 */
export interface PublicUser {
  id: string;
  username: string;
}

export interface LoginSuccess {
  user: SafeUser;
  session: CreatedSession;
}

export interface LoginInput {
  rawUsername: unknown;
  rawPassword: unknown;
}

/**
 * 校验用户名与密码字段本身是否填好；未填好抛 `MissingCredentialsError`，
 * 由路由层映射为 400。密码长度 / 用户名规范化的二次校验统一抛
 * `InvalidCredentialsError`，避免信息泄露。
 */
function parseLoginInput(input: LoginInput): { username: string; password: string } {
  if (typeof input.rawUsername !== 'string' || input.rawUsername.length === 0) {
    throw new MissingCredentialsError('请输入用户名与密码。');
  }
  if (typeof input.rawPassword !== 'string' || input.rawPassword.length === 0) {
    throw new MissingCredentialsError('请输入用户名与密码。');
  }
  let normalized: string;
  try {
    normalized = normalizeUsername(input.rawUsername);
  } catch (err) {
    if (err instanceof InvalidUsernameError) {
      throw new MissingCredentialsError(err.message);
    }
    throw err;
  }
  if (input.rawPassword.length < 12 || input.rawPassword.length > 128) {
    throw new InvalidCredentialsError();
  }
  return { username: normalized, password: input.rawPassword };
}

export interface LoginDeps {
  /** 默认实现 = `ensurePersonalWorkspace`；测试可注入失败实现。 */
  ensurePersonalWorkspace: (
    userId: string,
  ) => Promise<{ userId: string; workspaceId: string }>;
  /** 默认实现 = `createSession`；测试可注入 spy 验证调用次数。 */
  createSession: (args: { userId: string; ttlDays: number }) => Promise<CreatedSession>;
}

const DEFAULT_LOGIN_DEPS: LoginDeps = {
  ensurePersonalWorkspace,
  createSession,
};

/**
 * 登录入口。
 *
 * 默认依赖：`ensurePersonalWorkspace` + `createSession`。测试场景下可
 * 注入 `LoginDeps`，例如验证"ensure 抛错时不创建 Session"——这是 V2.3.6
 * §5.1 的强约束（不留悬空 Session）。
 *
 * 顺序硬固定：密码校验成功 → `ensurePersonalWorkspace()` → `createSession()`。
 * `ensure` 失败时绝不进入 `createSession`，避免遗留"有效 Session 但
 * workspaceId 缺失"的悬空状态。
 */
export async function login(
  input: LoginInput,
  deps: LoginDeps = DEFAULT_LOGIN_DEPS,
): Promise<LoginSuccess> {
  const { username, password } = parseLoginInput(input);
  const user = await findUserByUsernameNormalized(username);
  if (!user) {
    // 时序对齐：跑一次等价 hash 后再返回错误。
    try {
      hashPassword(password);
    } catch (err) {
      if (err instanceof InvalidPasswordError) {
        // 长度异常已在 parseLoginInput 拦截；此处为防御性 fallback。
      }
    }
    throw new InvalidCredentialsError();
  }
  if (user.disabledAt) {
    // 仍然跑一次 verify 以维持时序。
    verifyPassword(password, user.passwordHash);
    throw new InvalidCredentialsError();
  }
  const ok = verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw new InvalidCredentialsError();
  }

  // 顺序：先 ensurePersonalWorkspace，再 createSession。
  // - ensure 失败时（包括断连、约束冲突、用户消失）不会进入 createSession，
  //   也就不会留下"有效 Session 但 workspaceId 缺失"的悬空状态；
  // - ensure 成功后 userId 一定对应有效 Personal Workspace，SafeUser 契约
  //   才能被安全构造。
  const { workspaceId } = await deps.ensurePersonalWorkspace(user.id);
  const { ttlDays } = getResolvedAuthConfig();
  const session = await deps.createSession({ userId: user.id, ttlDays });
  return {
    user: { id: user.id, username: user.username, workspaceId },
    session,
  };
}

/**
 * 登出：按原始 token 撤销当前会话。token 不存在时也安全地 no-op（让调用方
 * 仍能清除 Cookie）。
 */
export async function logout(rawToken: string | null | undefined): Promise<void> {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return;
  await revokeSessionByToken(rawToken);
}

/**
 * 把 session token 解析成"已认证身份上下文"。
 *
 * 行为：
 *   - 无 token / token 失效 → `null`（路由层映射 401）。
 *   - token 有效 → 自动 `ensurePersonalWorkspace`；保证返回 `SafeUser` 的
 *     `workspaceId` 非空。
 *   - 真实错误（DB 断连、约束冲突、用户被并发删除导致 UserNotFound 等）
 *     直接向上抛，由路由层映射 500——绝不允许降级为 `workspaceId=null` 或
 *     假装"未登录"。
 */
export async function resolveCurrentUser(rawToken: string | null | undefined): Promise<SafeUser | null> {
  const resolved = await resolveSession(typeof rawToken === 'string' ? rawToken : '');
  if (!resolved) return null;
  const { workspaceId } = await ensurePersonalWorkspace(resolved.user.id);
  return {
    id: resolved.user.id,
    username: resolved.user.username,
    workspaceId,
  };
}

/**
 * 仅按 ID 取 user profile，**不**承担 workspace 上下文。
 *
 * 适用：
 *   - 后台 / 审批流等"只查用户"的场景；
 *   - 调用方若需要 workspaceId，请改走 `resolveCurrentUser` 或
 *     `ensurePersonalWorkspace`。
 */
export async function getUserById(id: string): Promise<PublicUser | null> {
  const user = await findUserById(id);
  if (!user) return null;
  return { id: user.id, username: user.username };
}

// 重新导出，便于调用方在 `service.ts` 一处拿到所有 workspace 错误类。
export { UserNotFoundError, WorkspaceContextError, WorkspaceIntegrityError };

export type { AuthUser };
