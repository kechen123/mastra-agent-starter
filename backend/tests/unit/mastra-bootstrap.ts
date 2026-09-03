/**
 * Mastra 装配契约测试（离线，不连真实 DB）。
 *
 * Phase 3.0 修订要点：
 *  - 测试**不**再静态 import `src/mastra/index.ts`：该模块会在加载期
 *    import `server/bootstrap.ts`，触发 `preloadSkillRegistry()` 与
 *    `startRunExecutor()`，进而引入 Skill 文件系统扫描与 PG LISTEN 句柄。
 *  - 本 fixture 改走 `infrastructure/mastra/instance.ts` 的
 *    `createMastraInstance()` 工厂：它不依赖 server / Skill / run executor，
 *    只负责"装配 Mastra"，可以独立测。
 *
 * 保护的具体契约：
 *  - C1：`createMastraInstance({ storage })` 产物的 `getStorage()` 必须
 *    返回 storage 模块构造的对象（无 internal API 介入）。
 *  - C2：`createMastraInstance({ agents })` 产物的 `getAgent(agentId)` 必须
 *    对每个 `registerAgent()` 过的定义返回非空 Agent。
 *  - C3：`createMastraInstance()` 默认注入 `buildGlobalToolMap()`，
 *    即 `mastra.tools` 包含全部已注册 Tool（Phase 3.0 "Tool 走 Mastra
 *    公共注册路径"）。
 *  - C4：注入的 static agent override 通过 `_setStaticAgentBuilderForTesting`
 *    在工厂构造前生效——意味着测试替身可以替换实际 Agent 工厂。
 *
 * 加载策略：先注入 storage factory + 静态 Agent 替身，再调用
 * `createMastraInstance()` 工厂。**不**导入 `src/mastra/index.ts`。
 *
 * Run with: npx tsx tests/unit/mastra-bootstrap.ts
 */

let passed = 0;
let failed = 0;
function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// 1) 先注入 storage factory 替身；这一步必须在 createMastraStorage 之前。
//
// `Mastra` 构造期会调用 `storage.__setLogger(...)`；我们的 fake 必须实现
// 该钩子，否则 Mastra 构造直接抛 TypeError。`storage.stores` 是可选属性，
// 跳过即可；生产路径走真实 PostgresStore，它必然实现这些 hooks。
const storageModule = await import(
  '../../src/infrastructure/mastra/storage.js'
);
let storageCaptured: unknown = null;
storageModule._setStorageFactoryForTesting((opts) => {
  storageCaptured = {
    __isFake: true,
    connectionString: opts.connectionString,
    schemaName: 'mastra_runtime',
    __setLogger(logger: unknown) {
      // 真实 PostgresStore 会把 logger 接到自己的内部 logger。
      // fake 这里只保留引用，方便 contract 测试断言"收到了 logger"。
      (storageCaptured as { _capturedLogger?: unknown })._capturedLogger = logger;
    },
    __setTelemetry() {},
    init() {
      return Promise.resolve();
    },
  };
  return storageCaptured;
});
storageModule._resetMastraStorageForTesting();

// 2) 触发 /src/agents/index.ts 的 registerAgent 副作用 import；
//    /src/tools/index.ts 的 registerTool 副作用 import 同样要触发。
//
// 注意：上层的 fixture 可能在收尾时调用过 `_clearAgentRegistryForTesting()`，
// 即便 import 已缓存也不会重新执行 side effect；这里通过**显式重新
// 注册**来确保 general-chat / knowledge-base 一定在表中。
await import('../../src/agents/index.js');
await import('../../src/tools/index.js');
const agentRegistryModule = await import('../../src/core/agent/registry.js');
const { generalChatAgent } = await import('../../src/agents/general-chat/agent.js');
const { knowledgeBaseAgent } = await import(
  '../../src/agents/knowledge-base/agent.js'
);
// `registerAgent` 内部对重复 id 抛错；先 try/catch 吞掉重复注册。
try {
  agentRegistryModule.registerAgent(generalChatAgent);
} catch {
  /* 已注册；幂等 */
}
try {
  agentRegistryModule.registerAgent(knowledgeBaseAgent);
} catch {
  /* 已注册；幂等 */
}
const toolRegistryModule = await import('../../src/core/tool/registry.js');
const defs = agentRegistryModule.listAgentDefinitions();
const globalToolMap = toolRegistryModule.buildGlobalToolMap();

assert(
  'registerAgent 副作用导入生效',
  defs.length >= 2,
  `实际 ${defs.length} 个 Agent`,
);
const ids = defs.map((d) => d.id).sort();
assert(
  `注册表包含 general-chat 与 knowledge-base；实际 ${JSON.stringify(ids)}`,
  ids.includes('general-chat') && ids.includes('knowledge-base'),
);
assert(
  'buildGlobalToolMap() 包含 calculator 与 get-current-time',
  Object.keys(globalToolMap).includes('calculator') &&
    Object.keys(globalToolMap).includes('get-current-time'),
);

// 3) 通过 instance.ts 工厂构造 Mastra；不 import src/mastra/index.ts。
//
// 静态 Agent 替身：v1 的 `new Mastra({ agents })` 构造期与异步收尾
// 会调用每个 agent 的多个内部钩子，并在 addAgent 期调用若干公开方法。
// 这是 v1 框架内部行为，不等同于"我们的代码调用 internal API"——本
// fixture 的本意是测"我们的代码不调用 internal API"，所以替身仅
// 提供 no-op / 空集合 让构造期不抛 TypeError。
function makeAgentStub(id: string): unknown {
  const stub: Record<string, unknown> = {
    id,
    name: id,
    description: id,
    __isStaticPlaceholder: true,
    __setLogger() {},
    __setTelemetry() {},
    __registerPrimitives() {},
    __registerMastra() {},
    __setTools() {},
    __getStaticAgents() {
      return undefined;
    },
    __hasSubAgentsConfigured() {
      return false;
    },
    __getGoalConfig() {
      return undefined;
    },
    __getDrainPendingSignals() {
      return () => [];
    },
    __listLLMRequestProcessors() {
      return Promise.resolve([]);
    },
    __setDeclaredSchedules() {},
    __updateInstructions() {},
    __updateModel() {},
    __resetToOriginalModel() {},
    __getEditorConfig() {
      return undefined;
    },
    __getOverridableFields() {
      return {};
    },
    __markStoredVersionApplied() {},
    __setMemory() {},
    __setPubSub() {},
    __setWorkspace() {},
    __fork() {
      return makeAgentStub(id);
    },
    getConfiguredProcessorIds() {
      return Promise.resolve({ input: [], output: [] });
    },
    getConfiguredProcessorWorkflows() {
      return Promise.resolve([]);
    },
    listScorers() {
      return Promise.resolve({});
    },
    listTools() {
      return Promise.resolve({});
    },
    getChannels() {
      return null;
    },
    getDescription() {
      return id;
    },
    getName() {
      return id;
    },
    getInstructions() {
      return '';
    },
    getModel() {
      return undefined;
    },
    getLLM() {
      return undefined;
    },
    getMemory() {
      return undefined;
    },
    getVoice() {
      return undefined;
    },
    getDefaultGenerateOptions() {
      return {};
    },
    getDefaultStreamOptions() {
      return {};
    },
    getDefaultVNextGenerateOptions() {
      return {};
    },
    getDefaultVNextStreamOptions() {
      return {};
    },
  };
  return stub;
}

const instanceModule = await import(
  '../../src/infrastructure/mastra/instance.js'
);
const mastra = instanceModule.createMastraInstance({});
const fakeStoreInstance = mastra.getStorage?.();
console.log('\n[mastra-bootstrap] storage 注入');

// C1
assert(
  'mastra.getStorage() 返回的对象不是 undefined',
  fakeStoreInstance !== undefined && fakeStoreInstance !== null,
);
assert(
  'mastra.getStorage() 返回的是 storage 模块 capture 的对象',
  fakeStoreInstance === storageCaptured ||
    (fakeStoreInstance && (fakeStoreInstance as { __isFake?: boolean }).__isFake === true),
);
assert(
  'mastra.getStorage() 返回的对象 schemaName 是 mastra_runtime',
  (fakeStoreInstance as { schemaName?: string } | null)?.schemaName === 'mastra_runtime',
);

console.log('\n[mastra-bootstrap] Agent 注册');

// C2 — 仅断言 production Agent IDs 在；测试 stub 可能在其它 fixture 注入。
for (const wantedId of ['general-chat', 'knowledge-base']) {
  const got = mastra.getAgent(wantedId);
  assert(
    `mastra.getAgent("${wantedId}") 返回的对象非空`,
    got !== undefined && got !== null,
  );
  assert(
    `mastra.getAgent("${wantedId}").id === "${wantedId}"`,
    (got as unknown as { id?: string })?.id === wantedId,
  );
}

console.log('\n[mastra-bootstrap] Tool 全局注册');

// C3 — 通过 v1 公开 API `mastra.listTools()` 取 Tool 字典。
// 不使用私有字段；v1 stable 把 tool 注册表仅通过 listTools / getTool /
// getToolById 暴露。
const mastraTools: Record<string, unknown> | undefined =
  typeof mastra.listTools === 'function'
    ? ((mastra as unknown as { listTools(): Record<string, unknown> | undefined })
        .listTools() as Record<string, unknown>)
    : undefined;
assert(
  'mastra.listTools() 返回字典',
  typeof mastraTools === 'object' && mastraTools !== null,
);
assert(
  'mastra.listTools() 包含 calculator（Phase 3.0: Tool 走 Mastra 公共注册）',
  !!mastraTools && 'calculator' in mastraTools,
);
assert(
  'mastra.listTools() 包含 get-current-time',
  !!mastraTools && 'get-current-time' in mastraTools,
);

console.log('\n[mastra-bootstrap] 工厂可注入 static agent override');

// C4：override 必须在下次 createMastraInstance() 之前注入；实例化后
//     mastra.getAgent(id) 命中的应是 override 返回的占位。
const overrideIdCaptured: string[] = [];
instanceModule._setStaticAgentBuilderForTesting((def) => {
  overrideIdCaptured.push(def.id);
  return makeAgentStub(def.id);
});
const mastra2 = instanceModule.createMastraInstance({});
assert(
  'override 后构造的 mastra 仍能 getAgent(general-chat)',
  mastra2.getAgent('general-chat') !== undefined,
);
assert(
  'override 返回的对象被 mastra2 暴露',
  ((mastra2.getAgent('general-chat') as unknown as { __isStaticPlaceholder?: boolean })
    .__isStaticPlaceholder) === true,
);
assert(
  'override 调用次数等于当前注册 Agent 数',
  overrideIdCaptured.length === defs.length,
);
// 收尾：清理 override，避免泄漏到其它 fixture。
instanceModule._setStaticAgentBuilderForTesting(null);
storageModule._setStorageFactoryForTesting(null);

console.log(`\nResult: ${passed} passed, ${failed} failed`);

/**
 * 全局收尾：阻止 run-executor / LISTEN bus 的句柄把 Node 进程挂住。
 *
 * 本 fixture 不应触发真实 bus（已避免 import `src/mastra/index.ts`），
 * 但作为兜底仍跑一遍 stop。即便没 start 过，bus.stop() 是 no-op。
 */
async function globalTeardown(): Promise<void> {
  try {
    const { stopRunExecutor } = await import(
      '../../src/core/execution/run-executor.js'
    );
    await stopRunExecutor();
  } catch {
    /* ignore */
  }
  try {
    const { getLiveDeltaBus } = await import(
      '../../src/modules/runs/live-delta-bus.js'
    );
    await getLiveDeltaBus().stop();
  } catch {
    /* ignore */
  }
  try {
    const { getRunEventsBus } = await import(
      '../../src/modules/runs/run-events-bus.js'
    );
    await getRunEventsBus().stop();
  } catch {
    /* ignore */
  }
}

try {
  await globalTeardown();
} catch {
  /* ignore */
}

if (failed > 0) process.exitCode = 1;
