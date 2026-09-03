/**
 * Phase 3.0 — `streamAgent` 业务 ↔ Mastra 标识映射契约测试（离线）。
 *
 * 保护的具体契约：
 *  - C1：当调用方提供 `runId / threadId / resourceId` 时，streamAgent
 *        必须把它们透传到 `agent.stream()` 的 streamOptions。
 *  - C2：`runId` 必须直接落在 `AgentExecutionOptionsBase.runId`（v1 公开
 *        字段，参见 `@mastra/core/agent.types.d.ts`）。
 *  - C3：`threadId` / `resourceId` 必须落到 `memory.thread / memory.resource`
 *        （v1 公开 API；当前业务 Agent 未配置 memory，但 streamOptions
 *        仍然按公开字段传入，由 v1 在执行期处理）。
 *  - C4：当 `threadId` / `resourceId` 仅缺一（含两者皆缺）时，
 *        `memory` 字段**不**进入 streamOptions——避免半填充。
 *  - C5：三个字段同时缺省时，streamAgent 仍允许运行（向后兼容），
 *        但 streamOptions 不含 `runId` 也不含 `memory`。
 *
 * 设计：
 *   - 用一个"假 Agent"stub：拦截 `agent.stream()` 调用并把传过来的
 *     options 暴露给本 fixture 断言；
 *   - 通过 `_setPerRequestFactoryOverrideForTesting` 注入 stub，避免
 *     把 stub 写进 Agent 注册表（否则 `Mastra({ agents })` 单例构造
 *     会被 stub 缺乏的若干方法如 `listScorers` 拖失败）；
 *   - 通过 `_setMastraInstanceForTesting(fakeMastra)` 注入 fake Mastra
 *     实例——streamAgent 不再触发 `await import('mastra/index.js')`，
 *     进而**不**触发 `server/bootstrap.ts` 的 `startRunExecutor()` /
 *     `preloadSkillRegistry()` / PG LISTEN 句柄 / Skill 文件系统扫描。
 *   - 本 fixture **不** import `src/mastra/index.ts`，也**不**触碰
 *     真实 PostgresStore / 真实 LLM Provider。运行单测时进程不应出现
 *     "Run executor 已启动" / "LISTEN channel" / "Skill preload" 日志。
 *   - 不调用 `process.exit()`：让 Node 在事件循环空时自然退出；若
 *     留下未释放句柄，进程应挂住以暴露问题。
 *
 * Run with: npx tsx tests/unit/stream-agent-identity-mapping.ts
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

// 1) 触发 agents/index.js 注册副作用 + tools/index.js 注册副作用。
//
// 注意：仅注册 `AgentDefinition`（内存 Map），不构造真实 `new Agent(...)`，
// 也**不**触发 server/bootstrap / Mastra 单例 / Skill 预加载。
await import('../../src/agents/index.js');
await import('../../src/tools/index.js');

const skillBindings = await import('../../src/core/skill/bindings.js');
skillBindings._setBindingsPoolForTesting(null);

const skillRegistryModule = await import('../../src/core/skill/registry.js');
// 用 no-op loader 替换生产 loader：runtime 内部 `ensureSkillRegistryLoaded()`
// 不再触发文件系统扫描 / DB hydration；本 fixture 完全离线运行。
skillRegistryModule._setSkillRegistryLoaderForTesting(async () => {
  /* no-op */
});

let capturedOptions: Record<string, unknown> | null = null;
let capturedPrompt: string | null = null;

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
    id: 'identity-mapping-stub',
    async stream(prompt: string, options: Record<string, unknown>) {
      capturedOptions = options;
      capturedPrompt = prompt;
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

// 2) 注入 fake Mastra 实例——本 fixture 不连接真实 PostgresStore，也不
//    触发 server/bootstrap；`_setMastraInstanceForTesting` 拦截
//    `runtime.getMastraInstance()` 的解析，让 fake 透传给 stub agent
//    factory 的第三个参数。**不** import src/mastra/index.ts。
const runtimeModule = await import('../../src/core/agent/runtime.js');
const fakeMastra = { __isFakeMastra: true, schemaName: 'mastra_runtime' };
runtimeModule._setMastraInstanceForTesting(fakeMastra);

// 3) 通过 per-request override 让 streamAgent 拿到 stub agent
//    （**不污染** agent 注册表；不污染生产 Mastra 单例的 agents）。
//
// 但 streamAgent 会先 `getAgentDefinition(agentId)` 校验定义是否存在，
// 所以注册表里仍需要一个真实 AgentDefinition。我们注册一个
// production-like 的：factory 真实构造 `new Agent(...)`（让生产 Mastra
// 单例构造通过），per-request 由 override 兜底为 stub。
const agentRegistry = await import('../../src/core/agent/registry.js');
const coreAgentTypes = await import('../../src/core/agent/types.js');
const { Agent } = await import('@mastra/core/agent');
const resolveDefaultChatModel = (await import(
  '../../src/infrastructure/llm/registry.js'
)).resolveDefaultChatModel;
const realFactory: coreAgentTypes.AgentFactory = (): Agent =>
  new Agent({
    id: 'identity-mapping-stub',
    name: 'identity-mapping-stub',
    model: resolveDefaultChatModel(),
    instructions: 'test',
  });
const testDefinition: coreAgentTypes.AgentDefinition = {
  id: 'identity-mapping-stub',
  name: 'identity-mapping-stub',
  description: '标识映射测试用 stub 探针。',
  toolIds: [],
  capabilities: {
    knowledgeBase: false,
    citations: false,
    tools: false,
    skills: false,
  },
  factory: realFactory,
};
agentRegistry.registerAgent(testDefinition);
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

console.log('[stream-agent-identity-mapping] 三个字段都提供 → 必须透传');

await drain(
  streamAgent({
    workspaceId: 'ws-test-001',
    agentId: 'identity-mapping-stub',
    prompt: 'ping',
    abortSignal: makeAbortSignal(),
    runId: 'run-uuid-001',
    threadId: 'conv-uuid-001',
    resourceId: 'ws-test-001',
  }),
);

const opts1 = capturedOptions ?? {};
assert(
  'streamOptions.runId === run-uuid-001',
  opts1.runId === 'run-uuid-001',
);
assert(
  'streamOptions.memory.thread === conv-uuid-001',
  (opts1.memory as { thread?: string } | undefined)?.thread === 'conv-uuid-001',
);
assert(
  'streamOptions.memory.resource === ws-test-001',
  (opts1.memory as { resource?: string } | undefined)?.resource ===
    'ws-test-001',
);

console.log(
  '\n[stream-agent-identity-mapping] 只缺 threadId / resourceId → memory 不应出现',
);

capturedOptions = null;
await drain(
  streamAgent({
    workspaceId: 'ws-test-001',
    agentId: 'identity-mapping-stub',
    prompt: 'ping',
    abortSignal: makeAbortSignal(),
    runId: 'run-uuid-002',
    // threadId / resourceId 都缺
  }),
);

const opts2 = capturedOptions ?? {};
assert('runId 仍透传', opts2.runId === 'run-uuid-002');
assert(
  'memory 字段不存在（C4：缺一即不构造）',
  !('memory' in opts2),
);

console.log('\n[stream-agent-identity-mapping] 三个字段都缺 → 完全无标识');

capturedOptions = null;
await drain(
  streamAgent({
    workspaceId: 'ws-test-001',
    agentId: 'identity-mapping-stub',
    prompt: 'ping',
    abortSignal: makeAbortSignal(),
  }),
);
const opts3 = capturedOptions ?? {};
assert('runId 字段不出现', !('runId' in opts3));
assert('memory 字段不出现', !('memory' in opts3));

console.log('\n[stream-agent-identity-mapping] abortSignal 透传');

assert(
  'streamOptions.abortSignal 是 AbortSignal 实例',
  opts3.abortSignal instanceof AbortSignal,
);

console.log('\n[stream-agent-identity-mapping] prompt 透传');

// runtime 会在 prompt 上包一层 `User: ...` / `Assistant: ...` 历史；
// capabilities.knowledgeBase=false 且 history 为空时，buildPrompt 把
// 当前 user 内容包成 `User: <prompt>`。所以这里断言包含原始 prompt。
assert(
  'agent.stream() 收到的 prompt 包含原始 prompt',
  typeof capturedPrompt === 'string' && capturedPrompt.includes('ping'),
);

// 收尾清理：清空注册表 + 重新触发 production 注册 + 收尾其它 hook。
agentRegistry._clearAgentRegistryForTesting();
await import('../../src/agents/index.js');
agentRegistry._setPerRequestFactoryOverrideForTesting(null);
skillBindings._setBindingsPoolForTesting(null);
runtimeModule._setMastraInstanceForTesting(null);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;