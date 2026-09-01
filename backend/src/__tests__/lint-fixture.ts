/**
 * lint-fixture —— PR-0.2 门禁验证用 fixture。
 *
 * 该文件被故意写成「未 await Promise」，用于断言 `@typescript-eslint/no-floating-promises: error`
 * 规则在 `npm run lint` 中真的会拒绝通过。
 *
 * 工作流：
 *   1. 取消下方 `void` 前缀 → `npm run lint` 应报 `no-floating-promises` 错误并退出非 0
 *   2. 重新加回 `void` → `npm run lint` 通过、CI 绿灯
 *
 * 该文件不参与 typecheck/test 的功能验证，只作为 lint 规则烟雾测试。
 */
async function fireAndForget(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

void fireAndForget();
