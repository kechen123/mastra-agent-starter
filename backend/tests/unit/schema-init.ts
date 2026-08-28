/**
 * schema-init.ts fixture — 校验 `computeInitChecksum` 返回 64 位小写 hex sha256。
 *
 * 不连数据库：本测试只覆盖文件 checksum 计算路径（`ensureSchema` / `dropIsolatedSchema`
 * 等需要真实 pool 的接口留给集成测试）。
 *
 * 运行：`cd backend && npx tsx tests/unit/schema-init.ts`
 */
import assert from 'node:assert/strict';
import { computeInitChecksum } from '../../src/test-utils/schema-init.js';

// computeInitChecksum 必须返回 64 位小写 hex（即 sha256 的标准 hex 输出）。
{
  const checksum = await computeInitChecksum();
  assert.equal(typeof checksum, 'string', 'checksum 应为字符串');
  assert.equal(
    checksum.length,
    64,
    `checksum 长度应为 64，实际 ${checksum.length}`,
  );
  assert.match(
    checksum,
    /^[0-9a-f]{64}$/,
    'checksum 必须全部由小写十六进制字符组成',
  );
}

// 重复调用必须返回稳定结果（同样输入同样输出）。
{
  const a = await computeInitChecksum();
  const b = await computeInitChecksum();
  assert.equal(a, b, 'computeInitChecksum 必须对相同输入返回相同输出');
}

console.log('  ✓ schema-init checksum invariant passed');
