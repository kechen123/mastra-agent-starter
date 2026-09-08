/**
 * Phase 3.2 — Tool Policy Evaluator 决策矩阵合约测试（离线）。
 *
 * 目标：固定 evaluator 对以下 7 类输入的判定语义，未来若有人
 * 误改 evaluator（例：把"低风险默认 allowed"误改成"缺策略
 * forbidden"），CI 立刻挂掉。
 *
 * 覆盖：
 *   - C1: destructive + allow 仍 requires-approval（**不**降级）；
 *   - C2: openWorld + 无策略 → forbidden（fail-closed）；
 *   - C3: openWorld + allow → allowed；
 *   - C4: requiresRuntime + 任意 → forbidden；
 *   - C5: deny 覆盖一切（即使 Tool 是低风险 + 无破坏性）；
 *   - C6: 低风险 + 无策略 → allowed（calculator / get-current-time
 *         的现实行为；本测试用 fake registry 模拟即可）；
 *   - C7: 未注册 Tool → forbidden（不抛错）。
 *
 * 不连真实 PG，不启动 server / Mastra；纯异步函数调用。
 *
 * 运行：`cd backend && npx tsx tests/unit/tool-policy-evaluator.ts`
 */
import type { ToolDefinition } from '../../src/core/tool/registry.js';
import {
  evaluateToolPolicy,
  type EvaluatorContext,
} from '../../src/modules/tool-policy/evaluator.js';

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function makeTool(overrides: Partial<ToolDefinition> & {
  metadata: ToolDefinition['metadata'];
}): ToolDefinition {
  return {
    id: overrides.id ?? 'fake-tool',
    displayName: 'fake',
    description: 'fake tool for evaluator tests',
    tool: {} as ToolDefinition['tool'],
    metadata: overrides.metadata,
  };
}

interface RecordedCall {
  workspaceId: string;
  toolId: string;
}

interface FakeRegistry {
  byId: Record<string, ToolDefinition | undefined>;
  calls: RecordedCall[];
}

interface FakePolicyRepo {
  byKey: Record<string, 'allow' | 'deny' | 'require_approval' | null>;
  calls: RecordedCall[];
}

function makeCtx(
  reg: FakeRegistry,
  repo: FakePolicyRepo,
): EvaluatorContext {
  return {
    getToolDefinition: (id) => {
      reg.calls.push({ workspaceId: '(none)', toolId: id });
      return reg.byId[id];
    },
    getPolicyRule: async (workspaceId, toolId) => {
      repo.calls.push({ workspaceId, toolId });
      const effect = repo.byKey[`${workspaceId}::${toolId}`];
      return effect ? { effect } : null;
    },
  };
}

const lowRisk = makeTool({
  id: 'low-risk',
  metadata: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    requiresRuntime: false,
  },
});
const destructive = makeTool({
  id: 'destructive',
  metadata: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: false,
    requiresRuntime: false,
  },
});
const openWorld = makeTool({
  id: 'openworld',
  metadata: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
    requiresRuntime: false,
  },
});
const requiresRuntime = makeTool({
  id: 'requires-runtime',
  metadata: {
    readOnly: true,
    destructive: false,
    idempotent: false,
    openWorld: false,
    requiresRuntime: true,
  },
});

const WS = 'ws-evaluator-test';

// ─── C1: destructive + allow → requires-approval ───────────────────────
console.log('[evaluator] C1: destructive + allow 仍 requires-approval');

{
  const reg: FakeRegistry = { byId: { destructive }, calls: [] };
  const repo: FakePolicyRepo = {
    byKey: { [`${WS}::destructive`]: 'allow' },
    calls: [],
  };
  const d = await evaluateToolPolicy(makeCtx(reg, repo), {
    workspaceId: WS,
    toolId: 'destructive',
  });
  check('decision.kind === "requires-approval"', d.kind === 'requires-approval');
  if (d.kind === 'requires-approval') {
    check('reason 提及 destructive', /destructive/i.test(d.reason));
  }
  check(
    '即便策略是 allow，destructive 也不降级为 allowed',
    d.kind !== 'allowed',
  );
}

// ─── C2: openWorld + 无策略 → forbidden ────────────────────────────────
console.log('\n[evaluator] C2: openWorld + 无策略 forbidden（fail-closed）');

{
  const reg: FakeRegistry = { byId: { openworld: openWorld }, calls: [] };
  const repo: FakePolicyRepo = { byKey: {}, calls: [] };
  const d = await evaluateToolPolicy(makeCtx(reg, repo), {
    workspaceId: WS,
    toolId: 'openworld',
  });
  check('decision.kind === "forbidden"', d.kind === 'forbidden');
  check('不抛错，仅返回决策', true);
}

// ─── C3: openWorld + allow → allowed ──────────────────────────────────
console.log('\n[evaluator] C3: openWorld + allow → allowed');

{
  const reg: FakeRegistry = { byId: { openworld: openWorld }, calls: [] };
  const repo: FakePolicyRepo = {
    byKey: { [`${WS}::openworld`]: 'allow' },
    calls: [],
  };
  const d = await evaluateToolPolicy(makeCtx(reg, repo), {
    workspaceId: WS,
    toolId: 'openworld',
  });
  check('decision.kind === "allowed"', d.kind === 'allowed');
}

// ─── C4: requiresRuntime + 任意 → forbidden ────────────────────────────
console.log('\n[evaluator] C4: requiresRuntime 永远 forbidden');

{
  const reg: FakeRegistry = { byId: { 'requires-runtime': requiresRuntime }, calls: [] };
  const repo: FakePolicyRepo = {
    byKey: { [`${WS}::requires-runtime`]: 'allow' },
    calls: [],
  };
  const d = await evaluateToolPolicy(makeCtx(reg, repo), {
    workspaceId: WS,
    toolId: 'requires-runtime',
  });
  check('requiresRuntime + allow 仍 forbidden', d.kind === 'forbidden');
}
{
  // 即便不查策略行（allow 都没配置），依然 forbidden。
  const reg: FakeRegistry = { byId: { 'requires-runtime': requiresRuntime }, calls: [] };
  const repo: FakePolicyRepo = { byKey: {}, calls: [] };
  const d = await evaluateToolPolicy(makeCtx(reg, repo), {
    workspaceId: WS,
    toolId: 'requires-runtime',
  });
  check('requiresRuntime + 无策略也 forbidden', d.kind === 'forbidden');
}

// ─── C5: deny 覆盖一切（即使低风险）───────────────────────────────────
console.log('\n[evaluator] C5: deny 覆盖一切');

{
  const reg: FakeRegistry = { byId: { 'low-risk': lowRisk }, calls: [] };
  const repo: FakePolicyRepo = {
    byKey: { [`${WS}::low-risk`]: 'deny' },
    calls: [],
  };
  const d = await evaluateToolPolicy(makeCtx(reg, repo), {
    workspaceId: WS,
    toolId: 'low-risk',
  });
  check('低风险 + deny → forbidden', d.kind === 'forbidden');
}

// ─── C6: 低风险 + 无策略 → allowed（calculator 的现实行为）───────────
console.log('\n[evaluator] C6: 低风险 + 无策略 → allowed（fail-open 仅本地只读）');

{
  const reg: FakeRegistry = { byId: { 'low-risk': lowRisk }, calls: [] };
  const repo: FakePolicyRepo = { byKey: {}, calls: [] };
  const d = await evaluateToolPolicy(makeCtx(reg, repo), {
    workspaceId: WS,
    toolId: 'low-risk',
  });
  check('低风险 + 无策略 → allowed', d.kind === 'allowed');
}
{
  const reg: FakeRegistry = { byId: { 'low-risk': lowRisk }, calls: [] };
  const repo: FakePolicyRepo = {
    byKey: { [`${WS}::low-risk`]: 'require_approval' },
    calls: [],
  };
  const d = await evaluateToolPolicy(makeCtx(reg, repo), {
    workspaceId: WS,
    toolId: 'low-risk',
  });
  check('低风险 + require_approval → requires-approval', d.kind === 'requires-approval');
}
{
  const reg: FakeRegistry = { byId: { 'low-risk': lowRisk }, calls: [] };
  const repo: FakePolicyRepo = {
    byKey: { [`${WS}::low-risk`]: 'allow' },
    calls: [],
  };
  const d = await evaluateToolPolicy(makeCtx(reg, repo), {
    workspaceId: WS,
    toolId: 'low-risk',
  });
  check('低风险 + allow → allowed', d.kind === 'allowed');
}

// ─── C7: 未注册 Tool → forbidden（不抛错）──────────────────────────────
console.log('\n[evaluator] C7: 未注册 Tool → forbidden');

{
  const reg: FakeRegistry = { byId: {}, calls: [] };
  const repo: FakePolicyRepo = { byKey: {}, calls: [] };
  const d = await evaluateToolPolicy(makeCtx(reg, repo), {
    workspaceId: WS,
    toolId: 'not-registered',
  });
  check('未注册 → forbidden（不抛错）', d.kind === 'forbidden');
  check(
    'getPolicyRule 不被调用（短路）',
    repo.calls.length === 0,
  );
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;