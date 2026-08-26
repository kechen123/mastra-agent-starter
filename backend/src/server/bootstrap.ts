/**
 * 服务端引导（Server Bootstrap）：运行时在此变成 HTTP 入口。
 * 启动顺序非常关键：
 *
 *   1. Agent / Tool 注册副作用 import。
 *      具体 Agent 与 Tool 放在 `backend/src/agents/` 与 `backend/src/tools/`。
 *      它们的 `index.ts` 在模块加载时调用 `registerAgent()` / `registerTool()`。
 *      在此 import 是它们"被发现"的唯一途径。
 *
 *   2. Skill Registry 预加载。
 *      Skill 注册表由文件系统驱动，同时还要读 `agent_skill_bindings` 表；
 *      预加载可以让首次 `GET /skills` 少一次往返。但每条路由在读取前仍
 *      显式 `await ensureSkillRegistryLoaded()`——正确性不依赖 preload 完成。
 *
 *   3. `initializeApp()` 触发副作用。
 *      任何 `import` 了 `bootstrap.ts` 又 `await initializeApp()` 的模块
 *      （例如想要共享同一条注册路径的 CLI 脚本）会看到缓存后的 init Promise
 *      resolve。这里同步触发是幂等且安全的，详见 `server/init.ts` 契约。
 *
 *   4. 路由注册。
 *      每个路由文件位于 `backend/src/server/routes/`，导出由
 *      `registerApiRoute()` 生成的单个路由对象。路由是纯 handler——
 *      它们 import 自 `core/`、`modules/`、`agents/`、`tools/`、`infrastructure/`，
 *      不在模块加载时注册任何东西。
 *
 * 新增路由：
 *   1. 在 `backend/src/server/routes/<name>.ts` 导出路由。
 *   2. 在下面的 `apiRoutes` 数组中追加。
 *   3. 重启后端服务。
 */
import '../agents/index.js';
import '../tools/index.js';

import { initializeApp } from './init.js';
import { preloadSkillRegistry } from '../core/skill/registry.js';

import { askRoute, stopMessageRoute, regenerateMessageRoute } from './routes/messages/index.js';
import {
  deleteDocumentRoute,
  getDocumentRoute,
  listDocumentsRoute,
  uploadDocumentRoute,
} from './routes/documents.js';
import { capabilitiesRoute } from './routes/capabilities.js';
import { healthRoute, readinessRoute } from './routes/health.js';
import {
  createKnowledgeBaseRoute,
  deleteKnowledgeBaseRoute,
  getKnowledgeBaseRoute,
  listKnowledgeBasesRoute,
  updateKnowledgeBaseRoute,
} from './routes/knowledge-bases.js';
import { agentsRoute } from './routes/agents.js';
import { toolsRoute } from './routes/tools.js';
import {
  listSkillsRoute,
  getSkillRoute,
  searchMarketSkillsRoute,
  listPopularMarketSkillsRoute,
  previewSkillRoute,
  installSkillRoute,
  updateSkillRoute,
  removeSkillRoute,
  bindSkillRoute,
  unbindSkillRoute,
} from './routes/skills.js';
import {
  createConversationRoute,
  deleteConversationRoute,
  getConversationRoute,
  listConversationsRoute,
  updateConversationRoute,
} from './routes/conversations.js';

preloadSkillRegistry();
initializeApp().catch((err) => {
  console.error('initializeApp() rejected:', err);
});

export const apiRoutes = [
  healthRoute,
  readinessRoute,
  askRoute,
  stopMessageRoute,
  regenerateMessageRoute,
  agentsRoute,
  toolsRoute,
  listSkillsRoute,
  getSkillRoute,
  searchMarketSkillsRoute,
  listPopularMarketSkillsRoute,
  previewSkillRoute,
  installSkillRoute,
  updateSkillRoute,
  removeSkillRoute,
  bindSkillRoute,
  unbindSkillRoute,
  listConversationsRoute,
  createConversationRoute,
  getConversationRoute,
  updateConversationRoute,
  deleteConversationRoute,
  listKnowledgeBasesRoute,
  createKnowledgeBaseRoute,
  getKnowledgeBaseRoute,
  updateKnowledgeBaseRoute,
  deleteKnowledgeBaseRoute,
  uploadDocumentRoute,
  listDocumentsRoute,
  getDocumentRoute,
  deleteDocumentRoute,
  capabilitiesRoute,
];
