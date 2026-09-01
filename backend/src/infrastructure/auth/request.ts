/**
 * 与 HTTP 请求 / Cookie / Origin 相关的纯函数助手。
 *
 * 这些函数只解析字符串、拼装 Set-Cookie 值；不写日志、不抛出含敏感信息
 * 的异常。`MastraAuthProvider` 与登录路由均复用这些函数。
 */
import type { HonoRequestLike } from '@mastra/core/auth';

export const SESSION_COOKIE_NAME = 'mastra_session';
export const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

interface AuthCookieConfig {
  secure: boolean;
  ttlDays: number;
  allowedOrigin: string;
}

export function resolveAuthConfig(): AuthCookieConfig {
  const rawSecure = process.env.AUTH_COOKIE_SECURE ?? 'false';
  const secure = rawSecure.toLowerCase() === 'true';
  const rawTtl = process.env.AUTH_SESSION_TTL_DAYS ?? '7';
  const ttlDays = Number(rawTtl);
  if (!Number.isInteger(ttlDays) || ttlDays <= 0) {
    throw new Error('AUTH_SESSION_TTL_DAYS 必须是正整数。');
  }
  const allowedOrigin = process.env.AUTH_ALLOWED_ORIGIN ?? 'http://localhost:5173';
  return { secure, ttlDays, allowedOrigin };
}

/**
 * 从 Mastra 的 `MastraAuthRequest`（`Request | HonoRequestLike`）中读取
 * 任意请求头。优先取 fetch `Request`，因为后端路由上下文就是标准 Request。
 */
export function getHeader(request: Request | HonoRequestLike, name: string): string | null {
  if (request instanceof Request) {
    return request.headers.get(name);
  }
  if (request.raw instanceof Request) {
    return request.raw.headers.get(name);
  }
  if (request.headers instanceof Headers) {
    return request.headers.get(name);
  }
  if (request.headers && typeof request.headers === 'object') {
    const record = request.headers as Record<string, string | string[] | undefined>;
    const value = record[name.toLowerCase()] ?? record[name];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }
  if (typeof request.header === 'function') {
    return request.header(name) ?? null;
  }
  return null;
}

/**
 * 解析 Cookie 头中名为 `name` 的值；不存在则返回 null。Cookie 以
 * `; ` 分隔。
 */
export function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex);
    if (key !== name) continue;
    const rawValue = trimmed.slice(eqIndex + 1);
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
}

/**
 * 构造 Set-Cookie 字符串。固定 `HttpOnly` / `Path=/` / `SameSite=Strict`；
 * `Secure` 跟随配置；`Max-Age` 等于会话剩余秒数。
 */
export function serializeSessionCookie(token: string, ttlSeconds: number): string {
  const secure = getResolvedAuthConfig().secure;
  const flags = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(ttlSeconds))}`,
  ];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

export function serializeClearedSessionCookie(): string {
  const secure = getResolvedAuthConfig().secure;
  const flags = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

/**
 * Origin 白名单：精确匹配 `AUTH_ALLOWED_ORIGIN`。
 * 缺省 `http://localhost:5173`。
 */
export function isOriginAllowed(request: Request | HonoRequestLike): boolean {
  const allowed = getResolvedAuthConfig().allowedOrigin;
  const origin = getHeader(request, 'Origin');
  if (!origin) return false;
  return origin === allowed;
}

/**
 * 判断当前请求方法是否需要 Origin 校验。
 */
export function isUnsafeMethod(method: string | null | undefined): boolean {
  if (!method) return false;
  return UNSAFE_METHODS.has(method.toUpperCase());
}

export function getRequestMethod(request: Request | HonoRequestLike): string | null {
  if (request instanceof Request) return request.method;
  if (request.raw instanceof Request) return request.raw.method;
  if (typeof (request as { method?: unknown }).method === 'string') {
    return (request as { method: string }).method;
  }
  return null;
}

export function getRequestPath(request: Request | HonoRequestLike): string {
  if (request instanceof Request) {
    return new URL(request.url).pathname;
  }
  if (request.raw instanceof Request) {
    return new URL(request.raw.url).pathname;
  }
  const url = (request as { url?: unknown }).url;
  if (typeof url === 'string') {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }
  return '';
}

export function getWebRequest(request: Request | HonoRequestLike): Request | null {
  if (request instanceof Request) return request;
  if (request.raw instanceof Request) return request.raw;
  return null;
}

/**
 * 借鉴 config 工具：避免在测试中频繁替换整个 process.env 时遗漏字段，
 * 调用方可在测试里 `setAuthConfigForTesting`。
 */
let override: Partial<AuthCookieConfig> | null = null;
export function setAuthConfigForTesting(overrideValue: Partial<AuthCookieConfig> | null): void {
  override = overrideValue;
}

export function getResolvedAuthConfig(): AuthCookieConfig {
  const base = resolveAuthConfig();
  if (!override) return base;
  return { ...base, ...override };
}
