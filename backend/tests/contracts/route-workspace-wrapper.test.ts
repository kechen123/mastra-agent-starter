/**
 * 静态合约：所有 `requiresAuth: true` 的路由必须用 `withAuthenticatedWorkspace`
 * 包裹其 handler。
 *
 * 设计动机：
 *   PR-1.2 给业务表加 `workspace_id` 列后，所有写入路径必须能从统一入口
 *   拿到可信的 `workspaceId`（不取自请求体、不被请求体覆写）。如果个别
 *   路由漏掉 `withAuthenticatedWorkspace` 包装，PR-1.2 只能"逐路由补洞"，
 *   与 PR-1.1 "先把壳装齐" 的初衷相违。
 *
 * 检查方式：
 *   粗粒度文本扫描 src/server/routes 下所有 .ts 文件：只要某路由文件既出现
 *   `requiresAuth: true` 又未出现 `withAuthenticatedWorkspace`，就视为
 *   违反。后续 Task 14 接入所有路由后此测试转绿。
 *
 *   真正逐路由解析 `handler: <expr>` 表达式、并校验"以 withAuthenticatedWorkspace
 *   起始"的精细检查位于 `tests/contracts/run.ts` §8（与 §7 业务受保护路由
 *   计数互为校验闸门）。本文件作为"每文件至少有一次引用"的快速兜底。
 *
 * 运行：
 *   cd backend && npx tsx tests/contracts/route-workspace-wrapper.test.ts
 *
 * 预期：
 *   Task 6 提交时多数路由尚未接入，应列出 `violations`（exit code != 0）。
 *   Task 14 完成后 `violations` 为空，exit code = 0。
 */

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// 必须从 backend/ 目录执行（与 run.ts §8 保持一致基准），否则找不到 routes。
const ROUTES = join(process.cwd(), 'src', 'server', 'routes');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = walk(ROUTES);
const violations: string[] = [];
for (const f of files) {
  const src = readFileSync(f, 'utf-8');
  // 同文件内同时出现 `requiresAuth: true` 与 `withAuthenticatedWorkspace` 才视为通过。
  // 只看 "true"，跳过 `requiresAuth: false`；只匹配字面量 `true`（前后允许空白）。
  if (/requiresAuth:\s*true/.test(src) && !/withAuthenticatedWorkspace/.test(src)) {
    violations.push(relative(process.cwd(), f));
  }
}

assert.deepEqual(
  violations,
  [],
  `routes missing withAuthenticatedWorkspace: ${violations.join(', ')}`,
);
