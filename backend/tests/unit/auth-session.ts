/**
 * session.ts fixture — 仅覆盖纯函数 / crypto 路径，不接入 PostgreSQL。
 *
 * 完整的 DB 集成流程由 contracts/run.ts 中的路由契约扫描兜底。
 */
import assert from 'node:assert/strict';
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_TOKEN_BYTES,
} from '../../src/infrastructure/auth/session.js';

// token 长度与字符表
{
  const t = generateSessionToken();
  assert.equal(typeof t, 'string', 'token is string');
  assert.equal(t.length > 0, true);
  // 32 字节 base64url 至少 43 字符，且只含合法字符
  assert.equal(t.length >= 43, true, `token len ${t.length}`);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
}

// 不同 token 不同 hash
{
  const a = generateSessionToken();
  const b = generateSessionToken();
  assert.notEqual(a, b);
  const ha = hashSessionToken(a);
  const hb = hashSessionToken(b);
  assert.notEqual(ha, hb);
  assert.match(ha, /^[0-9a-f]{64}$/, 'sha256 hex length');
}

// hash 对同一 token 稳定
{
  const t = generateSessionToken();
  assert.equal(hashSessionToken(t), hashSessionToken(t));
}

// SESSION_TOKEN_BYTES 暴露供外部参考
{
  assert.equal(SESSION_TOKEN_BYTES, 32);
}

console.log('  ✓ session tokens fixtures passed');
