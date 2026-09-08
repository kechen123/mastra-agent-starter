/**
 * Phase 3.2 + PR-3.3 — Policy-aware Tool Resolver 合约测试（离线）。
 *
 * 目标：固定 resolver 的"allowed + requires-approval 都进列；forbidden 不进"
 * 语义——PR-3.3 修订：
 *   - `allowed` 进 activeTools：fast-path 执行；
 *   - `requires-approval` 进 activeTools：执行时由 `requireToolApproval`
 *     回调挂起 + 持久化 approval request + 移 Run 到 waiting_approval；
 *   - `forbidden` 与未注册 永远不进 activeTools（fail-closed）；
 *   - 输入顺序保留，便于 SSE / 审计对账。
 *
 * 不连真实 PG；不连真实 Tool 注册表——通过 fake context 注入。
 *
 * 运行：`cd backend && npx tsx tests/unit/tool-policy-resolver.ts`
 */
import type { ToolDefinition } from '../../src/core/tool/registry.js';
import {
  resolveAllowedToolIds,
} from '../../src/modules/tool-policy/resolver.js';
import type { EvaluatorContext } from '../../src/modules/tool-policy/evaluator.js';

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
    id: overrides.id ?? 'fake',
    displayName: 'fake',
    description: 'fake tool for resolver tests',
    tool: {} as ToolDefinition['tool'],
    metadata: overrides.metadata,
  };
}

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
const openworld = makeTool({
  id: 'openworld',
  metadata: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
    requiresRuntime: false,
  },
});
const calculator = makeTool({
  id: 'calculator',
  metadata: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    requiresRuntime: false,
  },
});
const getCurrentTime = makeTool({
  id: 'get-current-time',
  metadata: {
    readOnly: true,
    destructive: false,
    idempotent: false,
    openWorld: false,
    requiresRuntime: false,
  },
});

const WS = 'ws-resolver-test';

interface FakeCtx {
  ctx: EvaluatorContext;
  getPolicyRuleCalls: string[];
}

function makeCtx(
  registry: Record<string, ToolDefinition>,
  policies: Record<string, 'allow' | 'deny' | 'require_approval' | null>,
): FakeCtx {
  const calls: string[] = [];
  const ctx: EvaluatorContext = {
    getToolDefinition: (id) => registry[id],
    getPolicyRule: async (_ws, toolId) => {
      calls.push(toolId);
      const effect = policies[toolId] ?? null;
      return effect ? { effect } : null;
    },
  };
  return { ctx, getPolicyRuleCalls: calls };
}

console.log('[resolver] 顺序保留 + 仅 allowed 入列');

{
  const { ctx, getPolicyRuleCalls } = makeCtx(
    { calculator, 'get-current-time': getCurrentTime },
    {},
  );
  const ids = await resolveAllowedToolIds(
    WS,
    ['get-current-time', 'calculator'],
    ctx,
  );
  check('返回数组', Array.isArray(ids));
  check('两个低风险 Tool 都入列', ids.length === 2);
  check('保留输入顺序（get-current-time 在 calculator 前）', ids[0] === 'get-current-time' && ids[1] === 'calculator');
  check('getPolicyRule 被调 2 次', getPolicyRuleCalls.length === 2);
}

console.log('\n[resolver] forbidden / requires-approval 不入列');

{
  const { ctx } = makeCtx(
    { calculator, destructive, openworld },
    {
      // calculator 低风险、无策略 → allowed
      // destructive 永远 requires-approval
      // openworld 无策略 → forbidden
    },
  );
  const ids = await resolveAllowedToolIds(
    WS,
    ['calculator', 'destructive', 'openworld'],
    ctx,
  );
  // PR-3.3 — destructive 走 requires-approval：进 activeTools，由
  // runtime requireToolApproval 回调挂起；openworld 走 forbidden 不进。
  check('calculator 入列（allowed）', ids.includes('calculator'));
  check('destructive 入列（requires-approval → 由 runtime 拦截）',
    ids.includes('destructive'));
  check('openworld 不入列（forbidden）', !ids.includes('openworld'));
}

console.log('\n[resolver] 未注册 Tool 不入列 + 不抛错');

{
  const { ctx, getPolicyRuleCalls } = makeCtx(
    { calculator },
    {},
  );
  const ids = await resolveAllowedToolIds(
    WS,
    ['calculator', 'never-registered-tool'],
    ctx,
  );
  check('未注册 Tool 不抛错', true);
  check('未注册 Tool 不入列', !ids.includes('never-registered-tool'));
  check('calculator 仍入列', ids.includes('calculator'));
  check(
    'getPolicyRule 不为未注册 Tool 调用（evaluator 短路）',
    !getPolicyRuleCalls.includes('never-registered-tool'),
  );
}

console.log('\n[resolver] 空输入 + 空 ctx');

{
  const { ctx } = makeCtx({}, {});
  const ids = await resolveAllowedToolIds(WS, [], ctx);
  check('空输入返回空数组', Array.isArray(ids) && ids.length === 0);
}

console.log('\n[resolver] allow / require_approval / deny 显式策略');

{
  // calculator 既可走 allow，也可走 require_approval / deny。
  const { ctx: ctxAllow } = makeCtx({ calculator }, { calculator: 'allow' });
  const idsAllow = await resolveAllowedToolIds(WS, ['calculator'], ctxAllow);
  check('calculator + allow → allowed', idsAllow.includes('calculator'));

  const { ctx: ctxRequire } = makeCtx({ calculator }, { calculator: 'require_approval' });
  const idsRequire = await resolveAllowedToolIds(
    WS,
    ['calculator'],
    ctxRequire,
  );
  // PR-3.3 — calculator + require_approval 进列，由 runtime 拦截。
  check('calculator + require_approval → 入列（runtime 拦截）',
    idsRequire.length === 1 && idsRequire[0] === 'calculator');

  const { ctx: ctxDeny } = makeCtx({ calculator }, { calculator: 'deny' });
  const idsDeny = await resolveAllowedToolIds(WS, ['calculator'], ctxDeny);
  check('calculator + deny → 不入列', idsDeny.length === 0);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;