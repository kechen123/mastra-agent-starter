/**
 * 本地账号密码登录 Provider。
 *
 * 继承 `MastraAuthProvider`，提供：
 *   * `authenticateToken(_token, request)`：**忽略** Mastra 传入的 token，
 *     只从 `mastra_session` Cookie 取原始 token，按 SHA-256 hash 查
 *     `auth_sessions`，未吊销、未过期、用户未禁用才返回 AuthUser。Mastra
 *     在调用前会从 Authorization 头 / `mastra-token` Cookie / `?apiKey=`
 *     抽取 token，但本项目**只接受** `mastra_session` Cookie，必须屏蔽
 *     任何上游注入的 token 形回退路径。
 *   * `authorizeUser(user, request)`：所有已认证用户放行；对 POST/PATCH/PUT/DELETE
 *     校验 `Origin` 是否命中 `AUTH_ALLOWED_ORIGIN`。
 *
 * 本 Provider **不** 接受 Authorization Header、API Key 等其它回退方式；
 * 只信任 `mastra_session` Cookie。这是规范要求。
 */
import { MastraAuthProvider } from '@mastra/core/auth';
import { resolveSession, type AuthUser } from './session.js';
import {
  getHeader,
  getRequestMethod,
  getRequestPath,
  isOriginAllowed,
  isUnsafeMethod,
  parseCookie,
  SESSION_COOKIE_NAME,
} from './request.js';

export class LocalAuthProvider extends MastraAuthProvider<AuthUser> {
  async authenticateToken(_token: string, request: Request): Promise<AuthUser | null> {
    // 关键安全边界：忽略 Mastra 上游传入的 token（包括 Authorization 头
    // / `mastra-token` Cookie / `?apiKey=` 的任何派生），只从 Cookie 头
    // 取 `mastra_session` 原始 token。任何带有 Authorization Bearer 但缺
    // 少 Cookie 的请求必须直接认证失败。
    if (!request || typeof request !== 'object') return null;
    const sessionToken = extractSessionTokenFromRequest(request);
    if (!sessionToken) return null;
    const session = await resolveSession(sessionToken);
    if (!session) return null;
    return session.user;
  }

  async authorizeUser(_user: AuthUser, request: Request): Promise<boolean> {
    if (!request || typeof request !== 'object') return true;
    // 公开鉴权路由：路径层已自行做 Origin 校验，Provider 直接放行。
    // 列表与 `tests/contracts/run.ts` 的 ROUTE_AUTH_ALLOWLIST 保持一致。
    const path = getRequestPath(request);
    if (path === '/auth/login' || path === '/auth/logout') return true;
    const method = getRequestMethod(request);
    if (!isUnsafeMethod(method)) return true;
    return isOriginAllowed(request);
  }
}

/**
 * 从 Request 的 Cookie 头读取 `mastra_session` 的原始 token；
 * 该函数被 Provider 与 routes/auth.ts 复用。
 */
export function extractSessionTokenFromRequest(request: Request): string | null {
  if (!request || typeof request !== 'object') return null;
  const cookieHeader = getHeader(request, 'Cookie');
  return parseCookie(cookieHeader, SESSION_COOKIE_NAME);
}
