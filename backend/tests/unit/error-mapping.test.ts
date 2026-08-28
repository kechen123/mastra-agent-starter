/**
 * server/error-mapping.ts 单元测试。
 *
 * 跑法：`npx tsx tests/unit/error-mapping.test.ts`
 * 也兼容：`npm run test:unit`（tests/unit/run.ts 会遍历本目录所有 .ts）。
 *
 * 关键不变量（PR-1.2/1.3/1.5 §5.1）：
 *   - ResourceNotFoundError 与 CrossWorkspaceAccessError 共享**完全相同**的 404 body；
 *     防止通过 403/404 差异泄漏资源存在性 / 越权状态。
 *   - UserNotFoundError / WorkspaceContextError / WorkspaceIntegrityError → 500
 *     （**不是** 401；这是服务端完整性错误，不是认证失败）。
 *   - InputValidationError → 422 + 原 message 透传。
 *   - 任意其他 Error → 500 兜底。
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mapErrorToResponse } from '../../src/server/error-mapping.js';

// 用 setName hack 构造同名错误（避免 import modules/auth/workspace-context.ts
// 的具体类 —— 那是单元测试隔离 + 防循环依赖的通用做法）。
class FakeNotFound extends Error {
  constructor() {
    super('x');
    this.name = 'ResourceNotFoundError';
  }
}
class FakeCross extends Error {
  constructor() {
    super('x');
    this.name = 'CrossWorkspaceAccessError';
  }
}
class FakeInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputValidationError';
  }
}
class FakeUserNF extends Error {
  constructor() {
    super('x');
    this.name = 'UserNotFoundError';
  }
}
class FakeWsCtx extends Error {
  constructor() {
    super('x');
    this.name = 'WorkspaceContextError';
  }
}
class FakeWsInt extends Error {
  constructor() {
    super('x');
    this.name = 'WorkspaceIntegrityError';
  }
}

test('ResourceNotFoundError → 404 NOT_FOUND', () => {
  const r = mapErrorToResponse(new FakeNotFound());
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error_code: 'NOT_FOUND', message: '资源不存在。' });
});

test('CrossWorkspaceAccessError → 404, body identical to ResourceNotFoundError', () => {
  const a = mapErrorToResponse(new FakeCross());
  const b = mapErrorToResponse(new FakeNotFound());
  assert.equal(a.status, b.status);
  assert.equal(JSON.stringify(a.body), JSON.stringify(b.body));
});

test('InputValidationError → 422 INPUT_VALIDATION_FAILED', () => {
  const r = mapErrorToResponse(new FakeInput('bad input'));
  assert.equal(r.status, 422);
  assert.equal(r.body.error_code, 'INPUT_VALIDATION_FAILED');
  assert.equal(r.body.message, 'bad input');
});

test('UserNotFoundError → 500 (NOT 401)', () => {
  const r = mapErrorToResponse(new FakeUserNF());
  assert.equal(r.status, 500);
  assert.notEqual(r.status, 401);
});

test('WorkspaceContextError → 500', () => {
  assert.equal(mapErrorToResponse(new FakeWsCtx()).status, 500);
});

test('WorkspaceIntegrityError → 500', () => {
  assert.equal(mapErrorToResponse(new FakeWsInt()).status, 500);
});

test('arbitrary Error → 500', () => {
  assert.equal(mapErrorToResponse(new TypeError('boom')).status, 500);
  assert.equal(mapErrorToResponse(new SyntaxError('x')).status, 500);
});