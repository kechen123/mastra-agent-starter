/**
 * Phase 3.0 — Dynamic Tool Resolution 契约测试（离线）。
 *
 * 保护的具体契约：
 *  - C1：`buildGlobalToolMap()` 包含 `tools/index.ts` 注册全部 Tool
 *        （calculator / get-current-time），并以 `{ id → tool }` 字典
 *        形态返回。
 *  - C2：当 Agent 的 `toolIds` 列表非空时，`streamAgent` 传给
 *        `agent.stream()` 的 `activeTools` 字段就是该列表。
 *  - C3：当 Agent 的 `toolIds` 为空 / 未声明时，`activeTools` 字段
 *        **不**出现在 streamOptions（避免空数组意外禁用全部 tool）。
 *  - C4：当 Agent 的 `capabilities.tools === false` 时，`activeTools`
 *        字段也不出现（capabilities 是事实层的"开/关"，先于 toolIds 计算）。
 *  - C5：`resolveToolIds(['calculator','unknown-id'], undefined)` 会
 *        跳过未注册 id（返回 ['calculator']）。
 *
 * 设计：
 *   - 通过 `_setPerRequestFactoryOverrideForTesting` 注入一个会
 *     捕获 stream 选项的 stub Agent；stub 不会被写进 Agent 注册表，
 *     也不会污染生产 `Mastra({ agents })` 的构造。
 *   - 通过 `_setMastraInstanceForTesting(fakeMastra)` 注入 fake Mastra
 *     实例——streamAgent 不再触发 `await import('mastra/index.js')`，
 *     进而**不**触发 `server/bootstrap.ts` 的 `startRunExecutor()` /
 *     `preloadSkillRegistry()` / PG LISTEN 句柄 / Skill 文件系统扫描。
 *   - 本 fixture **不** import `src/mastra/index.ts`。
 *   - 不调用 `process.exit()`：让 Node 在事件循环空时自然退出。
 *
 * Run with: npx tsx tests/unit/dynamic-tool-resolution.ts
 */
import { Agent } from '@mastra/core/agent';

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

console.log('[dynamic-tool-resolution] C1: buildGlobalToolMap 形态');

// 先把工具副作用 import 触发起来。
const toolRegistryModule = await import('../../src/core/tool/registry.js');
await import('../../src/tools/index.js');

const globalToolMap = toolRegistryModule.buildGlobalToolMap();
assert(
  '返回类型是字典',
  typeof globalToolMap === 'object' && globalToolMap !== null,
);
assert(
  '包含 calculator',
  'calculator' in globalToolMap,
);
assert(
  '包含 get-current-time',
  'get-current-time' in globalToolMap,
);
assert(
  '每个 entry 是一个对象（tool 实例）',
  typeof globalToolMap.calculator === 'object' &&
    globalToolMap.calculator !== null,
);

// C5
const filtered = toolRegistryModule.resolveToolIds(
  ['calculator', 'unknown-id', 'get-current-time'],
  undefined,
);
assert(
  'resolveToolIds 跳过未注册 id',
  filtered.includes('calculator') &&
    filtered.includes('get-current-time') &&
    !filtered.includes('unknown-id'),
);

console.log('\n[dynamic-tool-resolution] C2/C3/C4: streamAgent 的 activeTools');

const skillBindings = await import('../../src/core/skill/bindings.js');
skillBindings._setBindingsPoolForTesting(null);

const skillRegistryModule = await import('../../src/core/skill/registry.js');
// 用 no-op loader 替换生产 loader：runtime 内部 `ensureSkillRegistryLoaded()`
// 不再触发文件系统扫描 / DB hydration；本 fixture 完全离线运行。
skillRegistryModule._setSkillRegistryLoaderForTesting(async () => {
  /* no-op */
});

let capturedOptions: Record<string, unknown> | null = null;

interface StubAgent {
  id: string;
  stream: (
    prompt: string,
    options: Record<string, unknown>,
  ) => Promise<{
    fullStream: AsyncIterable<unknown>;
  }>;
}

function makeStubAgent(): StubAgent {
  return {
    id: 'dynamic-tool-stub',
    async stream(_prompt: string, options: Record<string, unknown>) {
      capturedOptions = options;
      return {
        // v1 公开 stream 形态：`fullStream` 是异步可迭代对象本身，
        // 不是 generator 方法；runtime 用 `for await (chunk of stream.fullStream)`。
        fullStream: (async function* () {
          /* 不发任何 chunk；runtime 自然走 done */
        })(),
      };
    },
  };
}

// 注入 fake Mastra 实例——本 fixture 不连接真实 PostgresStore，也不
// 触发 server/bootstrap；`_setMastraInstanceForTesting` 拦截
// `runtime.getMastraInstance()` 的解析，让 fake 透传给 stub agent
// factory 的第三个参数。**不** import src/mastra/index.ts。
const runtimeModule = await import('../../src/core/agent/runtime.js');
const fakeMastra = { __isFakeMastra: true, schemaName: 'mastra_runtime' };
runtimeModule._setMastraInstanceForTesting(fakeMastra);

// 注册两个测试用 AgentDefinition（C3 / C4），它们的 factory 走真实
// `new Agent({...})`；per-request 由 override 兜底为 stub。
const coreAgentTypes = await import('../../src/core/agent/types.js');
const agentRegistry = await import('../../src/core/agent/registry.js');
const resolveDefaultChatModel = (await import(
  '../../src/infrastructure/llm/registry.js'
)).resolveDefaultChatModel;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const realFactory: coreAgentTypes.AgentFactory = (): Agent =>
  new Agent({
    id: 'dynamic-tool-test',
    name: 'dynamic-tool-test',
    model: resolveDefaultChatModel(),
    instructions: 'test',
  });

const emptyToolsDefinition: coreAgentTypes.AgentDefinition = {
  id: 'dynamic-tool-stub',
  name: 'tool resolution empty',
  description: 'capabilities.tools=true 但 toolIds 为空',
  toolIds: [],
  capabilities: {
    knowledgeBase: false,
    citations: false,
    tools: true,
    skills: false,
  },
  factory: realFactory,
};
agentRegistry.registerAgent(emptyToolsDefinition);

const toolsOffDefinition: coreAgentTypes.AgentDefinition = {
  id: 'dynamic-tool-stub-off',
  name: 'tool resolution off',
  description: 'capabilities.tools=false，toolIds 即便存在也不算算',
  toolIds: ['calculator'],
  capabilities: {
    knowledgeBase: false,
    citations: false,
    tools: false,
    skills: false,
  },
  factory: realFactory,
};
agentRegistry.registerAgent(toolsOffDefinition);

// 注册 production-like AgentDefinition with toolIds 非空（C2）。
// 复用 general-chat 的 factory 即可——它的 toolIds 是
// ['calculator', 'get-current-time']。
const generalChat = (await import('../../src/agents/general-chat/agent.js'))
  .generalChatAgent;
// 用一个新 id 避免与已有 production 冲突；factory 与 production 一致。
const toolsOnDefinition: coreAgentTypes.AgentDefinition = {
  ...generalChat,
  id: 'dynamic-tool-stub-on',
  // 让 factory 创建时把 id 同步到 Agent 本身；否则 Agent 仍带 'general-chat'。
  factory: ((_tools, _skills, _mastra) =>
    new Agent({
      id: 'dynamic-tool-stub-on',
      name: 'dynamic-tool-stub-on',
      model: resolveDefaultChatModel(),
      instructions: 'test',
    })) as coreAgentTypes.AgentFactory,
  toolIds: ['calculator', 'get-current-time'],
  capabilities: {
    knowledgeBase: false,
    citations: false,
    tools: true,
    skills: false,
  },
};
agentRegistry.registerAgent(toolsOnDefinition);

// 通过 per-request override 让 streamAgent 拿到 stub agent。
agentRegistry._setPerRequestFactoryOverrideForTesting(() =>
  makeStubAgent(),
);

const { streamAgent } = runtimeModule;

function makeAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

async function drain(
  it: AsyncGenerator<unknown, void, unknown>,
): Promise<void> {
  while (!(await it.next()).done) {
    /* drain */
  }
}

console.log('\n  C2: toolIds 非空 → activeTools 出现');
capturedOptions = null;
await drain(
  streamAgent({
    workspaceId: 'ws-tool-test',
    agentId: 'dynamic-tool-stub-on',
    prompt: 'ping',
    abortSignal: makeAbortSignal(),
  }),
);
const optsWithTools = capturedOptions ?? {};
const activeTools = optsWithTools.activeTools as string[] | undefined;
assert(
  'activeTools 字段出现',
  Array.isArray(activeTools),
);
assert(
  'activeTools 包含 calculator',
  activeTools?.includes('calculator') === true,
);
assert(
  'activeTools 包含 get-current-time',
  activeTools?.includes('get-current-time') === true,
);

console.log('\n  C3: toolIds 空 → activeTools 字段不出现');
capturedOptions = null;
await drain(
  streamAgent({
    workspaceId: 'ws-tool-test',
    agentId: 'dynamic-tool-stub',
    prompt: 'ping',
    abortSignal: makeAbortSignal(),
  }),
);
const optsEmpty = capturedOptions ?? {};
assert(
  'toolIds 空 → activeTools 字段不出现（C3：避免空数组意外禁用）',
  !('activeTools' in optsEmpty),
);

console.log('\n  C4: capabilities.tools=false → activeTools 不出现');
capturedOptions = null;
await drain(
  streamAgent({
    workspaceId: 'ws-tool-test',
    agentId: 'dynamic-tool-stub-off',
    prompt: 'ping',
    abortSignal: makeAbortSignal(),
  }),
);
const optsOff = capturedOptions ?? {};
assert(
  'capabilities.tools=false → activeTools 不出现（C4）',
  !('activeTools' in optsOff),
);

// 收尾清理：清空注册表 + 重新触发 production 注册 + 收尾其它 hook。
agentRegistry._clearAgentRegistryForTesting();
await import('../../src/agents/index.js');
agentRegistry._setPerRequestFactoryOverrideForTesting(null);
skillBindings._setBindingsPoolForTesting(null);
runtimeModule._setMastraInstanceForTesting(null);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;