/**
 * 认证服务：登录、登出、读取当前用户。
 *
 * 关键不变量：
 *   * 登录失败统一返回 `InvalidCredentialsError`；不区分用户不存在、密码错误、
 *     用户被禁用。这是用户名枚举防护。
 *   * 用户不存在或被禁用时也跑一次等价 scrypt，避免明显的时序差异。
 *   * 安全用户对象仅 `{ id, username }`。
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

export interface SafeUser {
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

export async function login(input: LoginInput): Promise<LoginSuccess> {
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
  const { ttlDays } = getResolvedAuthConfig();
  const session = await createSession({ userId: user.id, ttlDays });
  return {
    user: { id: user.id, username: user.username },
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

export async function resolveCurrentUser(rawToken: string | null | undefined): Promise<SafeUser | null> {
  const resolved = await resolveSession(typeof rawToken === 'string' ? rawToken : '');
  if (!resolved) return null;
  return { id: resolved.user.id, username: resolved.user.username };
}

export async function getUserById(id: string): Promise<SafeUser | null> {
  const user = await findUserById(id);
  if (!user) return null;
  return { id: user.id, username: user.username };
}

export type { AuthUser };
