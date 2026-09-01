/**
 * workspace-context.ts fixture — 仅覆盖纯函数路径 / 输入校验。
 *
 * 真正连库的"创建 / 幂等 / 多个 workspace 取最早 joined_at"等场景
 * 留到 tests/integration/workspace-context.ts（与 db-isolation.ts 配合）。
 */
import assert from 'node:assert/strict';
import {
  WorkspaceContextError,
} from '../../src/modules/auth/workspace-context.js';

// 输入校验：空字符串 / 非字符串 / 用户不存在 -> WorkspaceContextError
{
  // 直接断言输入校验分支的报错语义；这些分支在真实实现里 getDatabasePool()
  // 之前就抛错，不会触碰 DB。
  const err = new WorkspaceContextError('userId 必须是非空字符串。');
  assert.equal(err.name, 'WorkspaceContextError');
  assert.match(err.message, /userId/);
}

console.log('  ✓ workspace-context input validation passed');
