import assert from 'node:assert/strict';
import { sanitizeLinkTarget } from './safe-url.js';

assert.equal(sanitizeLinkTarget('https://example.com/docs'), 'https://example.com/docs');
assert.equal(sanitizeLinkTarget('http://localhost:4111/docs'), 'http://localhost:4111/docs');
assert.equal(sanitizeLinkTarget('/docs/one'), '/docs/one');
assert.equal(sanitizeLinkTarget('../docs'), '../docs');
assert.equal(sanitizeLinkTarget('#section'), '#section');

for (const unsafe of [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,unsafe',
  'vbscript:msgbox(1)',
  'http://example.com',
  '//example.com/path',
  '\\example.com\\path',
  'java\u0000script:alert(1)',
]) {
  assert.equal(sanitizeLinkTarget(unsafe), null, unsafe);
}

console.log('safe-url: 通过');
