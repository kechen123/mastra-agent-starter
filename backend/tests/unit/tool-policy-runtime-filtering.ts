/**
 * Phase 3.2 + PR-3.3 — runtime.ts 集成合约测试（离线）。
 *
 * 目标：验证 streamAgent 的 activeTools 路径**真的**接到了 policy
 * resolver 钩子上，且钩子返回的"allowed + requires-approval"列表被原样
 * 塞进 `agent.stream()` 的 streamOptions.activeTools；destructive /
 * openworld / requires-runtime 在 PR-3.3 里：
 *   - destructive（destructive=true + 无策略）→ requires-approval → 进
 *     activeTools + 由 `requireToolApproval` 回调拦截；
 *   - openworld（openWorld=true + 无策略）→ forbidden → **不**进 activeTools；
 *   - requires-runtime（requiresRuntime=true + 无策略）→ forbidden → **不**
 *     进 activeTools。
 *
 * 这里**不**调真实 evaluator：真实 evaluator 需要 ToolDefinition 元数据
 * 与 DB 策略；本 fixture 完全离线，仅验证 runtime ↔ resolver 接线 +
 * requireToolApproval 注入。evaluator 的三态正确性由
 * tool-policy-evaluator.ts 覆盖。
 *
 * 设计：
 *   - 与 dynamic-tool-resolution 共用同一套 fixtures 脚手架（skill
 *     no-op loader / fake mastra / per-request agent override）；
 *   - stub resolver 区分 allowed / requires-approval / forbidden 三态；
 *   - 不 import `src/mastra/index.ts`；
 *   - 不调用 `process.exit()`。
 *
 * Run with: npx tsx tests/unit/tool-policy-runtime-filtering.ts
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

// 触发 agents/tools 注册副作用。
await import('../../src/agents/index.js');
await import('../../src/tools/index.js');

const skillBindings = await import('../../src/core/skill/bindings.js');
skillBindings._setBindingsPoolForTesting(null);

const skillRegistryModule = await import('../../src/core/skill/registry.js');
skillRegistryModule._setSkillRegistryLoaderForTesting(async () => {
  /* no-op */
});

const fakeMastra = { __isFakeMastra: true };
const runtimeModule = await import('../../src/core/agent/runtime.js');
runtimeModule._setMastraInstanceForTesting(fakeMastra);

const agentRegistry = await import('../../src/core/agent/registry.js');
const coreAgentTypes = await import('../../src/core/agent/types.js');
const { resolveDefaultChatModel } = await import(
    '../../src/infrastructure/llm/registry.js'
  );

// 注册 production-like AgentDefinition；factory 走真实 new Agent，
// per-request 由 override 兜底为 stub。
const realFactory: coreAgentTypes.AgentFactory = (): Agent =>
  new Agent({
    id: 'policy-runtime-stub',
    name: 'policy-runtime-stub',
    model: resolveDefaultChatModel(),
    instructions: 'test',
  });

let capturedOptions: Record<string, unknown> | null = null;

interface StubAgent {
  id: string;
  stream: (
    prompt: string,
    options: Record<string, unknown>,
  ) => Promise<{ fullStream: AsyncIterable<unknown> }>;
}

function makeStubAgent(): StubAgent {
  return {
    id: 'policy-runtime-stub',
    async stream(_prompt, options) {
      capturedOptions = options;
      return {
        fullStream: (async function* () {
          /* no chunks */
        })(),
      };
    },
  };
}

const testDefinition: coreAgentTypes.AgentDefinition = {
  id: 'policy-runtime-stub',
  name: 'policy-runtime-stub',
  description: 'policy resolver 集成测试用 stub 探针。',
  toolIds: [
    'calculator',
    'get-current-time',
    'destructive-fake',
    'openworld-fake',
    'requires-runtime-fake',
    'unregistered-fake',
  ],
  capabilities: {
    knowledgeBase: false,
    citations: false,
    tools: true,
    skills: false,
  },
  factory: realFactory,
};
agentRegistry.registerAgent(testDefinition);
agentRegistry._setPerRequestFactoryOverrideForTesting(() =>
  makeStubAgent(),
);

/**
 * Stub resolver：把输入 toolIds 按预定义三态决策集过滤后返回。
 *
 * 这里**不**调真实 evaluator：真实 evaluator 需要 ToolDefinition 元数据
 * 与 DB 策略；本 fixture 完全离线，仅验证 runtime ↔ resolver 接线 +
 * `requireToolApproval` 注入。evaluator / repository 的正确性分别由
 * tool-policy-evaluator.ts 与 tool-policy-repository.ts 覆盖。
 *
 * 决策表（与真实 evaluator 一致）：
 *   - calculator / get-current-time → allowed：进 activeTools；
 *   - destructive-fake → requires-approval：进 activeTools + 触发
 *     requireToolApproval 回调拦截；
 *   - openworld-fake / requires-runtime-fake → forbidden：**不**进
 *     activeTools（fail-closed）；
 *   - unregistered-fake → 静默跳过（resolver 不抛错）。
 */
const REQUIRES_APPROVAL = new Set<string>(['destructive-fake']);
const FORBIDDEN = new Set<string>(['openworld-fake', 'requires-runtime-fake']);
const UNREGISTERED = new Set<string>(['unregistered-fake']);
runtimeModule._setPolicyResolverForTesting(
  async (_workspaceId: string, toolIds: string[]) =>
    toolIds.filter((id) => !FORBIDDEN.has(id) && !UNREGISTERED.has(id)),
);
runtimeModule._setRequireApprovalForTesting(({ toolName }) =>
  Promise.resolve(REQUIRES_APPROVAL.has(toolName)),
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

console.log('[runtime-filter] stub resolver 仅放行 calculator / get-current-time');

await drain(
  streamAgent({
    workspaceId: 'ws-policy-runtime',
    agentId: 'policy-runtime-stub',
    prompt: 'ping',
    abortSignal: makeAbortSignal(),
  }),
);

const opts = capturedOptions ?? {};
const activeTools = opts.activeTools as string[] | undefined;

assert('activeTools 字段出现', Array.isArray(activeTools));
assert('activeTools 含 calculator（allowed）', activeTools?.includes('calculator') === true);
assert(
  'activeTools 含 get-current-time（allowed）',
  activeTools?.includes('get-current-time') === true,
);
// PR-3.3：destructive-fake 走 requires-approval → 进 activeTools，由
// runtime 端 requireToolApproval 回调在 Tool 调用前挂起 + 持久化。
assert(
  'destructive-fake 进 activeTools（requires-approval，由 runtime 拦截）',
  activeTools?.includes('destructive-fake') === true,
);
assert(
  'openworld-fake 不进 activeTools（forbidden）',
  activeTools?.includes('openworld-fake') !== true,
);
assert(
  'requires-runtime-fake 不进 activeTools（forbidden）',
  activeTools?.includes('requires-runtime-fake') !== true,
);
assert(
  'unregistered-fake 不进 activeTools',
  activeTools?.includes('unregistered-fake') !== true,
);
assert('activeTools 长度为 3', activeTools?.length === 3);
assert(
  '顺序保留（calculator 在 get-current-time 前，对应输入顺序）',
  activeTools?.[0] === 'calculator' &&
    activeTools?.[1] === 'get-current-time',
);
// PR-3.3：requireToolApproval 回调被注入 streamOptions。
assert(
  'requireToolApproval 回调已注入',
  typeof opts.requireToolApproval === 'function',
);
if (typeof opts.requireToolApproval === 'function') {
  const fn = opts.requireToolApproval as unknown as (ctx: {
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;
  const approved = await fn({ toolName: 'destructive-fake', args: {} });
  assert('requireToolApproval(destructive) === true', approved === true);
  const fastPath = await fn({ toolName: 'calculator', args: {} });
  assert('requireToolApproval(calculator, fast-path) === false', fastPath === false);
}

// capabilities.tools=false 路径：activeTools 字段不出现。
console.log('\n[runtime-filter] capabilities.tools=false → activeTools 字段不出现');

agentRegistry._clearAgentRegistryForTesting();
agentRegistry.registerAgent({
  ...testDefinition,
  id: 'policy-runtime-stub-off',
  toolIds: ['calculator', 'destructive-fake'],
  capabilities: {
    knowledgeBase: false,
    citations: false,
    tools: false,
    skills: false,
  },
});

capturedOptions = null;
await drain(
  streamAgent({
    workspaceId: 'ws-policy-runtime',
    agentId: 'policy-runtime-stub-off',
    prompt: 'ping',
    abortSignal: makeAbortSignal(),
  }),
);
const optsOff = capturedOptions ?? {};
assert(
  'capabilities.tools=false → activeTools 字段不出现',
  !('activeTools' in optsOff),
);

// 收尾清理。
agentRegistry._clearAgentRegistryForTesting();
await import('../../src/agents/index.js');
agentRegistry._setPerRequestFactoryOverrideForTesting(null);
skillBindings._setBindingsPoolForTesting(null);
runtimeModule._setMastraInstanceForTesting(null);
runtimeModule._setPolicyResolverForTesting(null);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;