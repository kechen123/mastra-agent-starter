/**
 * local-auth-provider.ts fixture — 纯 HTTP/配置/Origin 路径，不接 DB。
 *
 * 防回归：
 *   - Mastra 调用 `authenticateToken(token, request)` 时，token 通常是空串
 *     （我们只用 Cookie，没有 Authorization 头）。Provider 必须自行从
 *     `mastra_session` Cookie 取 token；找不到时稳定返回 null。
 *   - `authorizeUser` 对 GET 永远放行；POST 必须命中白名单 Origin；
 *     `/auth/login` 始终放行（路由层单独做 Origin 校验）。
 */
import assert from 'node:assert/strict';
import { LocalAuthProvider, extractSessionTokenFromRequest } from '../../src/infrastructure/auth/local-auth-provider.js';
import { setAuthConfigForTesting } from '../../src/infrastructure/auth/request.js';

const provider = new LocalAuthProvider();

function makeRequest(opts: { cookie?: string; origin?: string; method?: string; path?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin) headers.origin = opts.origin;
  return new Request(`http://localhost${opts.path ?? '/conversations'}`, {
    method: opts.method ?? 'GET',
    headers,
  });
}

// 1. authenticateToken: 拿不到 Request 时必须返回 null，不能抛错
{
  // @ts-expect-error: 测试边界
  const user = await provider.authenticateToken('', null);
  assert.equal(user, null, 'null request → null user');
}

// 2. authenticateToken: Cookie 缺失时稳定返回 null（不抛错；不会走到 DB）。
{
  const req = makeRequest({ method: 'GET' });
  const user = await provider.authenticateToken('', req);
  assert.equal(user, null, 'no cookie → null user (no DB hit)');
}

// 2b. 关键安全边界：即使 Mastra 传入了非空 token（Authorization / mastra-token
//     Cookie / apiKey 派生），Provider 也必须忽略，只看 mastra_session Cookie。
//     没有 mastra_session Cookie 时，即使 token 非空也必须返回 null。
{
  const req = makeRequest({ method: 'GET' });
  // 即便 Mastra 把 Authorization 头解析成了 token 传进来，没有 Cookie 也必须失败。
  const user = await provider.authenticateToken('whatever-token-from-auth-header', req);
  assert.equal(user, null, 'bearer-like token without cookie must be rejected (Cookie-only)');
}

// 3. authorizeUser: GET 永远放行
{
  const req = makeRequest({ method: 'GET' });
  const ok = await provider.authorizeUser({ id: 'u', username: 'alice' }, req);
  assert.equal(ok, true, 'GET always allowed');
}

// 4. authorizeUser: POST 必须命中白名单 Origin
{
  setAuthConfigForTesting({ secure: false, ttlDays: 7, allowedOrigin: 'http://localhost:5173' });
  const allowed = makeRequest({ method: 'POST', origin: 'http://localhost:5173' });
  const denied = makeRequest({ method: 'POST', origin: 'http://localhost:9999' });
  const noOrigin = makeRequest({ method: 'POST' });
  assert.equal(await provider.authorizeUser({ id: 'u', username: 'a' }, allowed), true, 'POST allowed when origin matches');
  assert.equal(await provider.authorizeUser({ id: 'u', username: 'a' }, denied), false, 'POST denied when origin mismatches');
  assert.equal(await provider.authorizeUser({ id: 'u', username: 'a' }, noOrigin), false, 'POST denied without Origin');
  setAuthConfigForTesting(null);
}

// 5. authorizeUser: /auth/login 路径（POST）始终放行，由路由层自己再校验 Origin
{
  setAuthConfigForTesting({ secure: false, ttlDays: 7, allowedOrigin: 'http://localhost:5173' });
  const req = makeRequest({ method: 'POST', path: '/auth/login' });
  assert.equal(await provider.authorizeUser({ id: 'u', username: 'a' }, req), true, '/auth/login allowed regardless of origin');
  setAuthConfigForTesting(null);
}

// 5b. authorizeUser: /auth/logout 路径（POST）始终放行；注销必须能清
//     任何状态下的 Cookie（过期/已吊销/篡改），所以即便在 requiresAuth:false
//     下 Provider 也不会再次做 Origin 拦截。Origin 校验由路由层独立兜底。
{
  setAuthConfigForTesting({ secure: false, ttlDays: 7, allowedOrigin: 'http://localhost:5173' });
  const req = makeRequest({ method: 'POST', path: '/auth/logout' });
  assert.equal(await provider.authorizeUser({ id: 'u', username: 'a' }, req), true, '/auth/logout allowed at provider level');
  setAuthConfigForTesting(null);
}

// 6. extractSessionTokenFromRequest 仍能从 Cookie 取 token
{
  assert.equal(extractSessionTokenFromRequest(makeRequest({ cookie: 'mastra_session=xyz' })), 'xyz');
  assert.equal(extractSessionTokenFromRequest(makeRequest({ cookie: 'foo=1' })), null);
}

console.log('  ✓ local-auth-provider fixtures passed');