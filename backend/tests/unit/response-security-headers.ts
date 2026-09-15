import assert from 'node:assert/strict';
import { applySecurityHeaders } from '../../src/server/security/response-headers.js';

const response = applySecurityHeaders(new Response('ok', {
  headers: { 'content-type': 'text/plain' },
}));

assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
assert.equal(response.headers.get('x-frame-options'), 'DENY');
assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
assert.match(response.headers.get('permissions-policy') ?? '', /camera=\(\)/);
assert.equal(await response.text(), 'ok');

console.log('response-security-headers: 通过');
