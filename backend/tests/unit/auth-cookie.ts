/**
 * request.ts fixture — Cookie 序列化、Origin 校验、Header 读取。
 *
 * 不连数据库；只覆盖纯函数路径。
 */
import assert from 'node:assert/strict';
import {
  parseCookie,
  serializeSessionCookie,
  serializeClearedSessionCookie,
  getHeader,
  parseCookie as _parseCookie,
  isOriginAllowed,
  isUnsafeMethod,
  getRequestMethod,
  getRequestPath,
  SESSION_COOKIE_NAME,
  setAuthConfigForTesting,
} from '../../src/infrastructure/auth/request.js';

// 解析 Cookie
{
  assert.equal(parseCookie('mastra_session=abc123', 'mastra_session'), 'abc123');
  assert.equal(parseCookie('a=1; mastra_session=hello; b=2', 'mastra_session'), 'hello');
  assert.equal(parseCookie('a=1; b=2', 'mastra_session'), null);
  assert.equal(parseCookie('', 'mastra_session'), null);
  assert.equal(parseCookie(null, 'mastra_session'), null);
}

// getHeader 兼容 fetch Request / Hono 风格对象
{
  const req = new Request('http://localhost/', { headers: { cookie: 'mastra_session=x' } });
  assert.equal(getHeader(req, 'Cookie'), 'mastra_session=x');
  const honoLike = { headers: { cookie: 'mastra_session=y', other: '1' } };
  // Hono 风格：headers 是普通对象，header() 提供备选
  assert.equal(getHeader(honoLike, 'Cookie'), 'mastra_session=y');
}

// 序列化 Cookie：必含 HttpOnly / Path=/ / SameSite=Strict
{
  setAuthConfigForTesting({ secure: false, ttlDays: 7, allowedOrigin: 'http://localhost:5173' });
  const cookie = serializeSessionCookie('token123', 60 * 60 * 24 * 7);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=/);
  assert.doesNotMatch(cookie, /\bSecure\b/);
  // Secure 关闭时不应出现 Secure 标志
  assert.equal(cookie.startsWith(`${SESSION_COOKIE_NAME}=token123`), true);

  setAuthConfigForTesting({ secure: true, ttlDays: 7, allowedOrigin: 'http://localhost:5173' });
  const cookieSecure = serializeSessionCookie('token123', 60 * 60 * 24 * 7);
  assert.match(cookieSecure, /\bSecure\b/);

  setAuthConfigForTesting(null);
}

// 清 Cookie：Max-Age=0
{
  setAuthConfigForTesting({ secure: false, ttlDays: 7, allowedOrigin: 'http://localhost:5173' });
  const cleared = serializeClearedSessionCookie();
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /HttpOnly/);
  assert.match(cleared, /SameSite=Strict/);
  assert.match(cleared, /Path=\//);
  setAuthConfigForTesting(null);
}

// Origin 校验
{
  const make = (origin: string | null) =>
    new Request('http://localhost/api/x', { method: 'POST', headers: origin ? { origin } : {} });
  setAuthConfigForTesting({ secure: false, ttlDays: 7, allowedOrigin: 'http://localhost:5173' });
  assert.equal(isOriginAllowed(make('http://localhost:5173')), true, '匹配白名单');
  assert.equal(isOriginAllowed(make('http://localhost:5174')), false, '端口不一致拒绝');
  assert.equal(isOriginAllowed(make('https://localhost:5173')), false, '协议不一致拒绝');
  assert.equal(isOriginAllowed(make(null)), false, '缺少 Origin 拒绝');
  setAuthConfigForTesting(null);
}

// unsafe 方法
{
  assert.equal(isUnsafeMethod('GET'), false);
  assert.equal(isUnsafeMethod('HEAD'), false);
  assert.equal(isUnsafeMethod('OPTIONS'), false);
  assert.equal(isUnsafeMethod('POST'), true);
  assert.equal(isUnsafeMethod('PATCH'), true);
  assert.equal(isUnsafeMethod('PUT'), true);
  assert.equal(isUnsafeMethod('DELETE'), true);
}

// getRequestMethod / getRequestPath
{
  const req = new Request('http://example.com/api/foo', { method: 'POST' });
  assert.equal(getRequestMethod(req), 'POST');
  assert.equal(getRequestPath(req), '/api/foo');
}

// 防回归：parseCookie 重导出
{
  assert.equal(_parseCookie('mastra_session=z', 'mastra_session'), 'z');
}

console.log('  ✓ request.ts (cookie / origin) fixtures passed');
