import assert from 'node:assert/strict';
import { getSafeRunErrorMessage } from '../../src/core/execution/safe-run-error.js';

assert.equal(
  getSafeRunErrorMessage('PROVIDER_UNAVAILABLE'),
  '生成服务暂时不可用，请稍后重试。',
);
assert.equal(getSafeRunErrorMessage('UNEXPECTED_SECRET_DETAIL'), '生成失败，请稍后重试。');
assert.doesNotMatch(getSafeRunErrorMessage('UNEXPECTED_SECRET_DETAIL'), /UNEXPECTED_SECRET_DETAIL/);

console.log('safe-run-error: 通过');
