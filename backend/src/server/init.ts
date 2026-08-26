/**
 * 幂等的应用初始化器（组合层 / Composition Layer）。
 *
 * 具体 Agent、具体 Tool 以及 Skill 注册表都"生活在 Core 之外"。
 * 它们通过副作用 import 接入系统：
 *   - `backend/src/agents/index.ts` 在加载时调用 `registerAgent()`
 *   - `backend/src/tools/index.ts`  在加载时调用 `registerTool()`
 *   - `backend/src/core/skill/registry.ts` 按需读取文件系统 + DB
 *
 * 如果这些副作用没有触发，`getAgentDefinition('general-chat')` 会返回
 * `undefined`，`npm run ask` 也会提示"Agent 不存在"。
 *
 * HTTP 服务路径（`server/bootstrap.ts`）在文件顶部静态 import 了上述模块，
 * 所以 Mastra 启动时会自动跑这些副作用；但 CLI 脚本与测试无法依赖这点，
 * 它们必须显式调用 `initializeApp()`（或在调用 Runtime 之前先
 * `await ensureSkillRegistryLoaded()`）。
 *
 * 本模块就是负责这份接线的组合层。**它刻意放在 `server/` 而非 `core/`**：
 * - `core/` 框架无关，绝不能依赖具体 Agent / Tool / Skill。
 * - 任何需要触发 Extensions 层（Mastra 适配器、CLI 脚本、集成测试）的模块
 *   都从这里 import `initializeApp`。
 *
 * 契约：
 *   - 幂等：并发或重复调用返回同一个 Promise。
 *   - 仅当 Agent、Tool 与 Skill Registry 全部就绪后才 resolve。
 *   - 正常路径不抛错，失败通过返回的 Promise 暴露给调用方自行决定。
 */
import { ensureSkillRegistryLoaded, preloadSkillRegistry } from '../core/skill/registry.js';

let initPromise: Promise<void> | null = null;

export function initializeApp(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }
  initPromise = (async () => {
    await import('../agents/index.js');
    await import('../tools/index.js');
    preloadSkillRegistry();
    await ensureSkillRegistryLoaded();
  })();
  return initPromise;
}

/**
 * 仅测试使用的 reset 钩子，让 fixture 在每个场景前回到干净状态。
 * 不在 barrel 中再 export，直接按路径调用即可。
 */
export function _resetAppInitializerForTesting(): void {
  initPromise = null;
}