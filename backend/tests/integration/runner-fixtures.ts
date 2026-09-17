/**
 * Integration runner manifest —— 显式列出"runner-compatible" fixture 列表。
 *
 * 背景：tests/integration/ 目录下有大量历史独立脚本（每个自带 process.exit、
 * 独立闸门、可单独 `npx tsx …` 运行）。它们与"集成 runner 统一编排"互不兼容：
 * 旧脚本顶层 process.exit(0) 会让 runner 进程整体退出，阻断后续 fixture。
 *
 * 为不改动 V1 tracked 脚本（不重写已有提交历史），本 manifest 是 runner 的
 * 唯一可信 fixture 来源：
 *   - runner 仅 `await import()` 本数组中的相对路径；
 *   - 旧脚本仍可 `npx tsx tests/integration/<file>.ts` 独立运行；
 *   - 数组中每个文件**必须**遵守 runner 契约（不调 process.exit / finally
 *     自清理 / 失败 throw 不吞错）。
 *
 * 新增 runner fixture：把文件名追加到本数组，并确认遵守 runner 契约。
 */
export const RUNNER_FIXTURES: ReadonlyArray<string> = [
  // 公网 URL E2E：必须先于 runtime E2E（前者启动 mock 更早、收尾更慢）。
  'sources-url-public-e2e.ts',
  // Daymind Runtime TXT/DOCX/PDF 真实链路
  'sources-citation-runtime-e2e.ts',
  // 本地 URL mock 解析回路（标注为测试替身，不替代生产 URL E2E）
  'sources-url-mock-e2e.ts',
  // PDF parser 端到端（已有）
  'sources-pdf-e2e.ts',
  // 敏感凭据拦截端到端（已有）
  'sources-secret-intercept.ts',
];