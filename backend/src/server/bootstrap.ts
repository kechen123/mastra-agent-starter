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
import { startRunExecutor } from '../core/execution/run-executor.js';

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
import { loginRoute, meRoute, logoutRoute } from './routes/auth.js';
import {
  createConversationV2AlphaRoute,
  createMessageV2AlphaRoute,
  getConversationV2AlphaRoute,
  streamRunEventsV2AlphaRoute,
  stopMessageV2AlphaRoute,
  createConversationV1Route,
  createMessageV1Route,
  getConversationV1Route,
  streamRunEventsV1Route,
  stopMessageV1Route,
} from './routes/v2alpha/index.js';

preloadSkillRegistry();
initializeApp().catch((err) => {
  console.error('initializeApp() rejected:', err);
});

// Run executor 单进程启动；模块级 globalThis flag 保证幂等。
startRunExecutor().catch((err) => {
  console.error('startRunExecutor() rejected:', err);
});

/**
 * 给旧根路径响应（/ask、/conversations*、/messages/*）附加 V2 §9.5.1
 * 兼容窗口所需的 Deprecation / Sunset / Link 头。新 API 路由
 * （/v1/v2alpha、/v1）不携带这些头。
 */
const LEGACY_DEPRECATION_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Deprecation', 'true'],
  ['Sunset', '2027-02-01'],
  ['Link', '</v1/v2alpha>; rel="successor-version"'],
];

// 给旧根路径响应附加 V2 §9.5.1 兼容窗口所需的弃用响应头。
// 直接走 registerApiRoute 重新挂一个 path/method 完全相同、handler 包裹
// 的路由；这样既保留原 Hono Handler 签名、requiresAuth、middleware 等
// 元数据，又不会被错误的泛型擦除。
import { registerApiRoute } from '@mastra/core/server';
import type { ApiRoute } from '@mastra/core/server';

function withDeprecationHeaders(route: ApiRoute): ApiRoute {
  // ApiRoute 是 HonoApiRoute | SchemaApiRoute；这里只读本项目实际用到的字段。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = route as any;
  const originalHandler: (c: unknown, ...rest: unknown[]) => Promise<Response> | Response =
    typeof r.handler === 'function' ? r.handler : () => Promise.resolve(new Response(null, { status: 500 }));
  const wrappedHandler: typeof originalHandler = async (context, ...rest) => {
    const response = await Promise.resolve(originalHandler(context, ...rest));
    try {
      for (const [name, value] of LEGACY_DEPRECATION_HEADERS) {
        response.headers.append(name, value);
      }
    } catch {
      // immutable / locked headers: ignore — Mastra 在 setupHeaders 已下发过 header。
    }
    return response;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return registerApiRoute(r.path as any, {
    method: r.method,
    handler: wrappedHandler as unknown as (c: any) => Response | Promise<Response>,
    ...(r.requiresAuth === true ? { requiresAuth: true } : {}),
    ...(r.requiresAuth === false ? { requiresAuth: false } : {}),
    ...(r.middleware !== undefined && r.middleware !== null ? { middleware: r.middleware } : {}),
    ...(r.openapi !== undefined && r.openapi !== null ? { openapi: r.openapi } : {}),
    ...(r.cors !== undefined && r.cors !== null ? { cors: r.cors } : {}),
  }) as ApiRoute;
}

const askRouteDeprecated = withDeprecationHeaders(askRoute);
const stopMessageRouteDeprecated = withDeprecationHeaders(stopMessageRoute);
const regenerateMessageRouteDeprecated = withDeprecationHeaders(regenerateMessageRoute);
const createConversationRouteDeprecated = withDeprecationHeaders(createConversationRoute);
const deleteConversationRouteDeprecated = withDeprecationHeaders(deleteConversationRoute);
const getConversationRouteDeprecated = withDeprecationHeaders(getConversationRoute);
const listConversationsRouteDeprecated = withDeprecationHeaders(listConversationsRoute);
const updateConversationRouteDeprecated = withDeprecationHeaders(updateConversationRoute);

export const apiRoutes = [
  healthRoute,
  readinessRoute,
  loginRoute,
  meRoute,
  logoutRoute,
  askRouteDeprecated,
  stopMessageRouteDeprecated,
  regenerateMessageRouteDeprecated,
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
  listConversationsRouteDeprecated,
  createConversationRouteDeprecated,
  getConversationRouteDeprecated,
  updateConversationRouteDeprecated,
  deleteConversationRouteDeprecated,
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
  // V2 入口（阶段 2 主用；阶段 3 之后切 v1，v2alpha 删除）
  createConversationV2AlphaRoute,
  createMessageV2AlphaRoute,
  getConversationV2AlphaRoute,
  streamRunEventsV2AlphaRoute,
  stopMessageV2AlphaRoute,
  createConversationV1Route,
  createMessageV1Route,
  getConversationV1Route,
  streamRunEventsV1Route,
  stopMessageV1Route,
];
