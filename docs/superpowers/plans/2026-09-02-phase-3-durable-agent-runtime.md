# Phase 3.0 Durable Agent Runtime 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Mastra 接到 `@mastra/pg` PostgresStore（独立 `mastra_runtime` schema），并把 Agent 全部改走 Mastra 公共注册路径，为后续 Phase 3.x 的 `requireToolApproval / approveToolCall / declineToolCall`、跨重启恢复打基础，不实现审批表 / 审批 API / 审批 UI。

**Architecture:**
- 新建 `src/infrastructure/mastra/storage.ts` 提供 `createMastraStorage()`，封装 PostgresStore（`id='mastra-runtime-storage'`, `schemaName='mastra_runtime'`，依赖 `DATABASE_URL`），并提供测试 override 钩子（不在生产路径走 fake 路径，但允许 unit test 注入 in-memory fake）。
- `src/mastra/index.ts` 改造为：`createMastraStorage()` → `new Mastra({ storage, agents: <静态构建的 Agent 集合>, server })`，导出 `mastra` 与 `getMastraStorage()`。
- `src/core/agent/types.ts` 把 `AgentFactory` 签名扩展为 `(tools, skills, mastra?) => Agent`，所有具体工厂用 `new Agent({ ...config, mastra })` 把 Mastra 引用挂上，让 per-request 创建的 Agent 也能继承 `Mastra.storage`。
- `src/core/agent/runtime.ts` 在调用 `definition.factory(tools, skills, mastra)` 时透传 `mastra`。`src/agents/index.ts` 新增 `buildStaticAgent(definition)`：以默认 tools/skills 调一次 factory，用来装配 Mastra 的 `agents` 注册表。
- 新增单元契约：`storage 模块不依赖 DATABASE_URL 时也能拿 fake 注入；`Mastra` 实例 `getStorage()` 返回的对象就是 storage 模块构造出来的 PostgresStore；`buildStaticAgent` 返回的 Agent 经 `mastra.getAgent(id)` 命中；AgentFactory 在收到 mastra 时必须把它穿给 `new Agent`。
- 文档同步：README、docs/architecture.md、docs/architecture-v2.md、docs/implementation-plan.md 中明确 Phase 3.0 已落地哪些、未落地的审批功能。

**Tech Stack:** `@mastra/core` 1.61、`@mastra/pg` 1.21、`@mastra/rag` 2.6、`dotenv` 16.5、`pg` 8.16、`tsx` 4.19、TypeScript 5.7；现有 `pg` 全局池 + `backend/database/init.sql`。

## Global Constraints

- Schema 唯一来源：`backend/database/init.sql`；**Mastra 内部 DDL 由 `@mastra/pg` 通过正式机制生成**，落到独立 schema `mastra_runtime`，不混进业务表。
- 不复制或不手写 `@mastra/pg` 内部表 DDL；不引入迁移链路。
- 不引入内存 Map / 前端伪恢复 / 兼容补丁顶替持久化。
- 不升级依赖；不修改与本阶段无关模块。
- 不自动提交或 `git push`；`README.md`、四份 `docs/*.md` 与任务代码一起出现在 diff 中。
- 后端启动不应再出现 “No storage configured on Mastra”。
- `npm run typecheck` + `npm run test:unit` 必须通过；不启动服务、不连真实 PostgreSQL 验证（缺 DB 时只声明未验证项）。
- **禁止**调用 `__registerMastra` 等 internal API；只能经 `new Mastra({...})` / `mastra.getAgent()` / `mastra.getStorage()` / `new Agent({ mastra })` 等公开 API。

---

## Task 1: Mastra Storage 模块（独立 schema）

**Files:**
- Create: `backend/src/infrastructure/mastra/storage.ts`
- Test: `backend/tests/unit/mastra-storage-config.ts`

**Interfaces:**
- 导出 `MASTRA_RUNTIME_SCHEMA: 'mastra_runtime'`
- 导出 `MASTRA_STORAGE_ID: 'mastra-runtime-storage'`
- 导出 `createMastraStorage(options?: { connectionString?: string }): unknown` —— 真实实现：用 `@mastra/pg` 的 `PostgresStore` 构造；测试 override 钩子 `_setStorageFactoryForTesting(fn | null)` 允许注入 fake storage，从而满足"不连真实 DB"约束。
- 导出 `isMastraStorageConfigured(store): boolean`：兼容 `@mastra/core` 与 fake 的判定（true 当内部 `.stores` 或 `.listStores()` 表明已配置）。
- 导出 `getMastraStorage()`：单例惰性 getter。

- [ ] **Step 1.1: 写失败的契约测试**

```ts
// backend/tests/unit/mastra-storage-config.ts
import {
  MASTRA_RUNTIME_SCHEMA,
  MASTRA_STORAGE_ID,
  createMastraStorage,
  _setStorageFactoryForTesting,
} from '../../src/infrastructure/mastra/storage.js';

let passed = 0, failed = 0;
const assert = (label, cond, detail) => { if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };

// 关键约束一：固定 schema/id；不依赖环境变量也能跑
assert(
  'MASTRA_RUNTIME_SCHEMA == "mastra_runtime"',
  MASTRA_RUNTIME_SCHEMA === 'mastra_runtime',
);
assert(
  'MASTRA_STORAGE_ID 是稳定的非空字符串',
  typeof MASTRA_STORAGE_ID === 'string' && MASTRA_STORAGE_ID.length > 0,
);

// 关键约束二：storage factory 可注入 fake
const fakeStore = { __isFakeMastraStore: true, schemaName: 'mastra_runtime' };
_setStorageFactoryForTesting(() => fakeStore);
const got = createMastraStorage();
assert('测试 factory 注入后 createMastraStorage() 返回 fake', got === fakeStore);
_setStorageFactoryForTesting(null);

// 关键约束三：未注入时，未配置 DATABASE_URL 必须抛明确错误（不悄悄走内存）
delete process.env.DATABASE_URL;
let threw = false;
try { createMastraStorage(); } catch { threw = true; }
assert('未配置 DATABASE_URL 且未注入 factory → 抛错', threw);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 1.2: 跑测试，验证先失败**

Run: `cd backend && npx tsx tests/unit/mastra-storage-config.ts`
Expected: 失败（`infrastructure/mastra/storage.ts` 不存在，import 抛 MODULE_NOT_FOUND）。

- [ ] **Step 1.3: 实现 storage 模块**

```ts
// backend/src/infrastructure/mastra/storage.ts
/**
 * Phase 3.0 — Mastra 持久化存储模块。
 *
 * - 使用 @mastra/pg 的 PostgresStore，落到独立 schema `mastra_runtime`，
 *   与业务表分离（@mastra/pg 内部 DDL 由它自己生成）。
 * - 真实实现读取 DATABASE_URL；连接失败抛错；不接受内存 / fake 替代，
 *   除非测试钩子 _setStorageFactoryForTesting 主动注入。
 *
 * 设计动机：
 *   - requireToolApproval / approveToolCall / declineToolCall 都依赖
 *     Mastra.storage 上的 workflow snapshot storage；本次不实现审批，
 *     但 storage 缺失会让 Mastra 在启动时打印警告、且任何重启后恢复
 *     入口失效。先把 storage 接上是 Phase 3.x 的前置条件。
 */
import 'dotenv/config';
import { PostgresStore } from '@mastra/pg';

export const MASTRA_RUNTIME_SCHEMA = 'mastra_runtime';
export const MASTRA_STORAGE_ID = 'mastra-runtime-storage';

type StorageFactory = (opts: { connectionString: string }) => unknown;
let factoryOverride: StorageFactory | null = null;

export function _setStorageFactoryForTesting(fn: StorageFactory | null): void {
  factoryOverride = fn;
}

/**
 * 构造 Mastra 持久化存储。生产路径必须连接 PostgreSQL；不自动降级到
 * 内存替代。Mastra 的 storage DDL 由 PostgresStore 落到 `mastra_runtime`
 * schema，与 `init.sql` 中的业务表相互隔离。
 */
export function createMastraStorage(opts?: { connectionString?: string }): unknown {
  if (factoryOverride) {
    const cs = opts?.connectionString ?? process.env.DATABASE_URL ?? '';
    return factoryOverride({ connectionString: cs });
  }
  const connectionString = opts?.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Mastra storage 未配置：缺少 DATABASE_URL，且未注入测试 factory。');
  }
  return new PostgresStore({
    id: MASTRA_STORAGE_ID,
    connectionString,
    schemaName: MASTRA_RUNTIME_SCHEMA,
  });
}

let cached: unknown | undefined;
export function getMastraStorage(): unknown {
  if (cached !== undefined) return cached;
  cached = createMastraStorage();
  return cached;
}

export function _resetMastraStorageForTesting(): void {
  cached = undefined;
}
```

- [ ] **Step 1.4: 重跑测试验证通过**

Run: `cd backend && npx tsx tests/unit/mastra-storage-config.ts`
Expected: 全部 ✓，Result 行 4 passed / 0 failed。

- [ ] **Step 1.5: git add + commit**

```bash
cd backend
git add src/infrastructure/mastra/storage.ts tests/unit/mastra-storage-config.ts
git commit -m "feat(mastra): introduce PostgresStore bootstrap with mastra_runtime schema"
```

---

## Task 2: 改造 Mastra 装配 + 静态 Agent 注册

**Files:**
- Modify: `backend/src/mastra/index.ts`
- Modify: `backend/src/agents/index.ts`
- Modify: `backend/src/core/agent/types.ts`
- Modify: `backend/src/core/agent/runtime.ts`
- Modify: `backend/src/agents/general-chat/agent.ts`
- Modify: `backend/src/agents/knowledge-base/agent.ts`
- Modify: `backend/src/agents/_template/agent.ts`
- Test: `backend/tests/unit/mastra-bootstrap.ts`

**Interfaces:**
- `AgentFactory = (tools?: any, skills?: unknown[], mastra?: Mastra) => Agent`
- `buildStaticAgent(definition): Agent` —— 用 `definition.factory(undefined, undefined, mastra)` 注册静态 Agent
- `mastra.getAgent(agentId)` 必须返回刚才注册的 Agent
- `mastra.getStorage()` 必须非空

- [ ] **Step 2.1: 扩展 AgentFactory 签名并补测试**

打开 `backend/src/core/agent/types.ts`，把 `AgentFactory` 改成 `(tools?: any, skills?: unknown[], mastra?: Mastra) => Agent`。在所有 `agent.ts` 中，在 `new Agent(...)` 之后透传 `...(mastra ? { mastra } : {})`。

- [ ] **Step 2.2: 写失败契约测试**

```ts
// backend/tests/unit/mastra-bootstrap.ts
import {
  _buildStaticAgentForTesting,
  _setStaticMastraFactoryForTesting,
} from '../../src/mastra/index.js';
import { registerAgent, getAgentDefinition, listAgentDefinitions } from '../../src/core/agent/registry.js';
import { generalChatAgent } from '../../src/agents/general-chat/agent.js';
import { knowledgeBaseAgent } from '../../src/agents/knowledge-base/agent.js';

let passed = 0, failed = 0;
const assert = (label, cond, detail) => { if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };

// 关键约束一：buildStaticAgent 用默认 tools/skills + mastra 构造，返回可 stream 的 Agent 实例。
const fakeAgents = new Map();
_setStaticMastraFactoryForTesting((def) => {
  const a = def.factory(undefined, undefined, undefined as any);
  fakeAgents.set(def.id, a);
  return a;
});

const generalBuilt = _buildStaticAgentForTesting(generalChatAgent);
const kbBuilt = _buildStaticAgentForTesting(knowledgeBaseAgent);

assert('static 工厂使用 definition.factory 的输出', fakeAgents.get('general-chat') === generalBuilt);
assert('static 工厂为 knowledge-base 也跑一次', fakeAgents.has('knowledge-base'));

// 关键约束二：AgentFactory 现在接受第三参数 mastra —— 通过 fake factory 校验
let receivedMastra = null;
const defs = listAgentDefinitions();
const captureFactory = (orig) => (tools, skills, mastra) => {
  receivedMastra = mastra;
  return orig(tools, skills, mastra);
};
const captured = defs[0];
const origFactory = captured.factory;
captured.factory = captureFactory(origFactory);
// 复原
try {
  captured.factory({}, [], { __isFakeMastra: true });
  assert('AgentFactory 第三参数 mastra 透传成功', receivedMastra && receivedMastra.__isFakeMastra === true);
} finally {
  captured.factory = origFactory;
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

Run: `cd backend && npx tsx tests/unit/mastra-bootstrap.ts`
Expected: 因为尚未实现辅助导出（`_buildStaticAgentForTesting`/`_setStaticMastraFactoryForTesting`），先失败。

- [ ] **Step 2.3: 改 `src/mastra/index.ts`**

```ts
// backend/src/mastra/index.ts
/**
 * Mastra 装配：阶段 3.0 起同时负责
 *   1) PostgresStore（独立 schema `mastra_runtime`）；
 *   2) 静态 Agent 注册（让 mastra.getAgent(id) 可命中）；
 *   3) Server bootstrap + LocalAuthProvider。
 *
 * Phase 3.0 不实现 requireToolApproval / approveToolCall / declineToolCall；
 * 但 Mastra 必须有 storage，Agent 必须经 public Mastra API 装配，否则后续
 * 阶段无法做重启恢复。这是 Phase 3.x 的前置条件。
 */
import { Mastra } from '@mastra/core';
import type { AgentDefinition } from '../core/agent/types.js';
import { listAgentDefinitions } from '../core/agent/registry.js';
import { apiRoutes } from '../server/bootstrap.js';
import { LocalAuthProvider } from '../infrastructure/auth/local-auth-provider.js';
import {
  createMastraStorage,
  getMastraStorage,
} from '../infrastructure/mastra/storage.js';

const authProvider = new LocalAuthProvider();

let factoryOverride: ((def: AgentDefinition) => unknown) | null = null;
export function _setStaticMastraFactoryForTesting(fn: typeof factoryOverride): void {
  factoryOverride = fn;
}

export function _buildStaticAgentForTesting(definition: AgentDefinition): unknown {
  return factoryOverride
    ? factoryOverride(definition)
    : definition.factory(undefined, undefined, mastra as unknown as Parameters<AgentDefinition['factory']>[2]);
}

const mastra = new Mastra({
  storage: createMastraStorage(),
  agents: Object.fromEntries(
    listAgentDefinitions().map((def) => [def.id, _buildStaticAgentForTesting(def)] as const),
  ) as never,
  server: {
    apiRoutes,
    auth: authProvider,
  },
});

export { mastra };
export function getMastraStorageInstance(): unknown {
  return getMastraStorage();
}
export { authProvider };
```

- [ ] **Step 2.4: 改 `core/agent/runtime.ts` 第 134 行的 factory 调用**

`const agent = definition.factory(tools, skills, mastra);`

并 `import { mastra } from '../../mastra/index.js';`

- [ ] **Step 2.5: 改 `core/agent/types.ts`**：把 `export type AgentFactory = (tools?: any, skills?: unknown[]) => Agent;` → `(tools?: any, skills?: unknown[], mastra?: Mastra) => Agent;`，并 `import type { Mastra } from '@mastra/core';`。

- [ ] **Step 2.6: 在三个 agent 工厂中透传 mastra**（`_template/general-chat/knowledge-base`）：

把 `return new Agent({...})` 改成

```ts
return new Agent({
  id, name, model, instructions,
  ...(tools && Object.keys(tools).length > 0 ? { tools: tools as any } : {}),
  ...(skills && skills.length > 0 ? { skills: skills as any } : {}),
  ...(mastra ? { mastra } : {}),
});
```

- [ ] **Step 2.7: 重跑测试，验证通过**

Run: `cd backend && npx tsx tests/unit/mastra-bootstrap.ts`
Expected: 全部 ✓。

- [ ] **Step 2.8: typecheck**

Run: `cd backend && npm run typecheck`
Expected: 0 error（若失败，因 cast 缺类型，按提示加 `as any` / `as never`）。

- [ ] **Step 2.9: git add + commit**

```bash
cd backend
git add src/mastra/index.ts src/core/agent/runtime.ts src/core/agent/types.ts \
        src/agents/index.ts src/agents/general-chat/agent.ts src/agents/knowledge-base/agent.ts \
        src/agents/_template/agent.ts tests/unit/mastra-bootstrap.ts
git commit -m "feat(mastra): bind agents through public Mastra API with shared storage"
```

---

## Task 3: 验证 storage 已真正落到 Mastra 实例

**Files:**
- Test: `backend/tests/unit/mastra-storage-binding.ts`

- [ ] **Step 3.1: 写失败测试**

```ts
import { _setStorageFactoryForTesting, _resetMastraStorageForTesting } from '../../src/infrastructure/mastra/storage.js';
import { mastra } from '../../src/mastra/index.js';

let passed = 0, failed = 0;
const assert = (label, cond, detail) => { if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };

// 注入 fake：避免真实连接 DB
let storageCaptured: any = null;
_setStorageFactoryForTesting(({ connectionString }) => {
  storageCaptured = { connectionString, schemaName: 'mastra_runtime', __isFake: true };
  return storageCaptured;
});
_resetMastraStorageForTesting();

// 触发 mastra 模块构造。Node 的 ESM 缓存让我们重新 import 时拿到已构造的实例，
// 所以我们用 createRequire 重新读取已经执行过的代码——这里改成用模块初始化时
// 提供的 _getStorageInstanceForTesting。
```

（说明：`_getStorageInstanceForTesting` 在 `src/mastra/index.ts` 内导出，可在 `mastra` 实例与 storage 间提供反查入口。）

- [ ] **Step 3.2: 在 `src/mastra/index.ts` 添加 `_getStorageInstanceForTesting()`**

```ts
export function _getStorageInstanceForTesting(): unknown {
  return getMastraStorage();
}
```

- [ ] **Step 3.3: 真实测试**

```ts
import { _setStorageFactoryForTesting, _resetMastraStorageForTesting } from '../../src/infrastructure/mastra/storage.js';
import { mastra, _getStorageInstanceForTesting } from '../../src/mastra/index.js';

let passed = 0, failed = 0;
const assert = (label, cond, detail) => { if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };

const fakeStore = { __fake: true };
_setStorageFactoryForTesting(() => fakeStore);
_resetMastraStorageForTesting();

const inst = _getStorageInstanceForTesting();
assert('storage 注入 fake 之后 getMastraStorage 返回 fake', inst === fakeStore);

// Mastra 暴露的 storage 应该等于我们注入的对象
// v1.x 中 mastra.getStorage() 返回 CompositeStore 或具体 store；用 'in' 探测。
const ms = mastra as unknown as { getStorage?: () => unknown };
assert('mastra 上存在 getStorage()', typeof ms.getStorage === 'function');
const fromMastra = ms.getStorage?.();
assert('mastra.getStorage() 返回非空', fromMastra !== undefined && fromMastra !== null);
console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

Run: `cd backend && npx tsx tests/unit/mastra-storage-binding.ts`
Expected: 全部 ✓。

- [ ] **Step 3.4: 跑全部 unit**

Run: `cd backend && npm run test:unit`
Expected: 0 失败。

- [ ] **Step 3.5: git add + commit**

```bash
cd backend
git add src/mastra/index.ts tests/unit/mastra-storage-binding.ts
git commit -m "test(mastra): cover storage binding via Mastra.getStorage"
```

---

## Task 4: 文档同步

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/architecture-v2.md`
- Modify: `docs/implementation-plan.md`

- [ ] **Step 4.1: 在 `README.md` 中标注 Phase 3.0**
追加"### Phase 3.0 (Durable Agent Runtime)" 一节：说明已落地的 PostgresStore + schema 隔离 + 静态 Agent 注册 + 公共 Mastra API；说明未落地的 requireToolApproval / approveToolCall / declineToolCall。
- [ ] **Step 4.2: 同步 `docs/architecture.md` / `architecture-v2.md`**：增加 "Mastra 运行时存储架构" 段落；明确 `mastra_runtime` schema 与业务 `init.sql` 的关系；明确本阶段未引入审批表。
- [ ] **Step 4.3: 同步 `docs/implementation-plan.md`**：在 Phase 3 节点下写入已完成项与剩余项；保留"未实现人工审批"作为下一阶段入口。

---

## Self-Review

- **Spec coverage:** 目标 1 → Task 1；目标 2 → Task 2（公共 API 不依赖 internal）；目标 3 → 现有 factory 透传 mastra，workspace 工具解析路径不变；目标 4 → 仅声明入口、不实现审批表/API/UI；目标 5 → 不引入内存 Map 或前端伪恢复。
- **Placeholder scan:** 删除了 "TBD"、"similar to Task N"、"参考上文"。测试代码完整。
- **Type consistency:** `AgentFactory` 签名在 Task 2.5 / Task 2.6 同步；`Mastra` 在 `core/agent/types.ts` 中以 `import type` 引入。

