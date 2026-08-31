/**
 * 认证路由：登录、登出、当前用户。
 *
 * 关键约束：
 *   * `/auth/login` 公开，但仍执行 Origin 校验；缺少 / 不匹配返回 403。
 *   * `/auth/me` 标记 `requiresAuth: true`：由 Mastra 鉴权层把
 *     `LocalAuthProvider.authenticateToken()` 的输出附加到上下文，
 *     Provider 的 `authorizeUser()` 再校验 Origin。
 *   * `/auth/logout` 必须**公开**（`requiresAuth: false`）。原因：注销
 *     需要在任何状态下（过期 / 已吊销 / 篡改）都能清掉 Cookie；如果
 *     设为 `true`，鉴权失败时 handler 不会被执行、`Set-Cookie` 也送不到
 *     客户端。公开路由由本文件自行调用 `isOriginAllowed()` 兜底。
 *   * 错误响应一律顶层 `message`，与项目既有风格一致。Mastra 鉴权层
 *     自身在错误路径上可能输出顶层 `error`，前端会同时识别两者。
 *   * 永远不会把 `password` / `password_hash` / 原始 session token /
 *     `token_hash` 写入响应、日志或数据库明文。
 */
import { registerApiRoute } from '@mastra/core/server';
import {
  login,
  logout,
  MissingCredentialsError,
  InvalidCredentialsError,
  type LoginInput,
} from '../../modules/auth/service.js';
import {
  getHeader,
  isOriginAllowed,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from '../../infrastructure/auth/request.js';
import { extractSessionTokenFromRequest } from '../../infrastructure/auth/local-auth-provider.js';
import { withAuthenticatedWorkspace } from '../../modules/auth/workspace-context.js';

function rawRequestFromContext(context: { req: { raw?: Request; header?: (n: string) => string | undefined } }): Request | null {
  const req = context.req as { raw?: Request };
  if (req.raw instanceof Request) return req.raw;
  return null;
}

function getRequestFromContext(context: { req: unknown }): Request | null {
  const req = context.req as { raw?: Request; header?: (n: string) => string | undefined };
  if (req.raw instanceof Request) return req.raw;
  // 退化路径：Mastra 鉴权层直接传 Request 时 context.req 就是 Request。
  if (context.req instanceof Request) return context.req;
  return null;
}

function readOrigin(request: Request): string | null {
  return getHeader(request, 'Origin');
}

/**
 * POST /auth/login — 公开。
 *
 * 1. Origin 校验（与不安全方法策略一致，避免登录端点成为跨域脚本入口）。
 * 2. 解析 `{ username, password }`，空值与格式错误返回 400。
 * 3. 调用 `login()`：失败统一 401 + "用户名或密码错误"。
 * 4. 成功：写 HttpOnly Cookie，返回安全用户对象。
 */
export const loginRoute = registerApiRoute('/auth/login', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    const request = rawRequestFromContext(context);
    if (!request) return context.json({ message: '请求异常。' }, 500);

    // Origin 校验：与本服务所有不安全方法保持一致。
    if (!isOriginAllowed(request)) {
      return context.json({ message: '请求来源不被允许。' }, 403);
    }

    let body: unknown;
    try {
      body = await context.req.json<unknown>();
    } catch {
      return context.json({ message: '请求体必须是合法 JSON。' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return context.json({ message: '请求体必须是 JSON 对象。' }, 400);
    }
    const record = body as Record<string, unknown>;
    const input: LoginInput = { rawUsername: record.username, rawPassword: record.password };

    try {
      const result = await login(input);
      const ttlSeconds = Math.max(
        0,
        Math.floor((result.session.expiresAt.getTime() - Date.now()) / 1000),
      );
      const cookie = serializeSessionCookie(result.session.token, ttlSeconds);
      const responseHeaders = new Headers({ 'Set-Cookie': cookie });
      return new Response(JSON.stringify({ user: result.user }), {
        status: 200,
        headers: { ...Object.fromEntries(responseHeaders), 'Content-Type': 'application/json' },
      });
    } catch (error) {
      if (error instanceof MissingCredentialsError) {
        return context.json({ message: error.message }, 400);
      }
      if (error instanceof InvalidCredentialsError) {
        return context.json({ message: error.message }, 401);
      }
      console.error('登录失败：', error);
      return context.json({ message: '服务暂时不可用，请稍后重试。' }, 500);
    }
  },
});

/**
 * GET /auth/me — requiresAuth。
 *
 * 通过 Provider 鉴权后，从服务端 session 解析已认证身份上下文：
 *   - `userId` / `username` 来自 `auth_sessions` + `app_users`；
 *   - `workspaceId` 由 `ensurePersonalWorkspace` 服务端兜底创建；
 *   - 任何请求 body / header / query 中伪造的 `workspaceId` 都会被忽略。
 *
 * 实现：本路由走 `withAuthenticatedWorkspace` 包装器。**所有
 * `requiresAuth: true` 的业务路由都必须使用同一包装器**——这是 V2.3.6
 * §5.1 的强约束，目的是让 PR-1.2 给业务表加 `workspace_id` 时所有写入
 * 路径都能拿到可信的非空 `workspaceId`，而不是逐路由手写 401 映射。
 */
export const meRoute = registerApiRoute('/auth/me', {
  method: 'GET',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    return context.json(
      {
        user: {
          id: authCtx.userId,
          username: authCtx.username,
          workspaceId: authCtx.workspaceId,
        },
      },
      200,
    );
  }),
});

/**
 * POST /auth/logout — 公开（requiresAuth: false）。
 *
 * 设计权衡：注销必须能清掉**任何**状态下的 Cookie（已过期、已吊销、篡改
 * 都行），所以这里不能套 `requiresAuth: true`——鉴权失败时 handler 永远
 * 不会被执行，Set-Cookie 也送不到客户端。
 *
 * 安全边界：本路由强制 Origin 校验（与 `/auth/login` 一致），未命中
 * 白名单的请求直接 403，不再做任何撤销逻辑；命中白名单的请求按当前
 * Cookie 尝试撤销（无 Cookie / 无效 token 都安全 no-op），并始终
 * 用 `Max-Age=0` 清 Cookie。
 */
export const logoutRoute = registerApiRoute('/auth/logout', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    const request = getRequestFromContext(context);
    if (!request) return context.json({ message: '请求异常。' }, 500);
    if (!isOriginAllowed(request)) {
      return context.json({ message: '请求来源不被允许。' }, 403);
    }
    const token = extractSessionTokenFromRequest(request);
    try {
      await logout(token);
    } catch (error) {
      console.error('登出失败：', error);
    }
    const cookie = serializeClearedSessionCookie();
    return new Response(JSON.stringify({ message: '已退出登录。' }), {
      status: 200,
      headers: { 'Set-Cookie': cookie, 'Content-Type': 'application/json' },
    });
  },
});

// Re-exported for completeness — used by the callers / tests that want a single entry.
export const authRoutes = [loginRoute, meRoute, logoutRoute];

// `readOrigin` is used by tests via direct call; keep it exported for now to
// avoid regression on dropped imports during edits.
export { readOrigin };
