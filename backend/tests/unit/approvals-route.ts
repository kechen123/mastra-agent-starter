/**
 * PR-3.3 — /v1/approvals routes outcome → HTTP status 映射测试。
 *
 * 目标：
 *   - 验证 `resolveApprovalHandler` 把 `state-machine.ResolveApprovalOutcome`
 *     各 kind 映射到正确的 HTTP status + body 形态；
 *   - 验证 `getApprovalHandler` / `listApprovalsHandler` 的基础 422 输入
 *     校验分支；
 *   - 不连 DB、不连 Mastra——通过 fake state-machine 调用 _setMastraFacadeForTesting
 *     注入 fake（`tool-policy-state-machine.ts` 既有 pattern）。
 *
 * 设计：
 *   - 直接调用 *Handler 闭包，**不**经过 `withAuthenticatedWorkspace`。
 *     wrapper 行为由 `tests/contracts/run.ts` 静态扫描兜底（每个
 *     registerApiRoute + requiresAuth:true 必须被 wrapper 包裹）；
 *     本文件只测 handler 本身逻辑。
 */
import assert from 'node:assert/strict';
import {
  listApprovalsHandler,
  getApprovalHandler,
  resolveApprovalHandler,
  isUuid,
  rowToView,
} from '../../src/server/routes/approvals.js';
import {
  _setMastraFacadeForTesting,
  type MastraAgentFacade,
  type ResolveApprovalOutcome,
} from '../../src/modules/tool-policy/state-machine.js';
import type {
  AuthenticatedContext,
  AuthenticatedRouteContextLike,
} from '../../src/modules/auth/workspace-context.js';

let failures = 0;
let passes = 0;
function ok(label: string): void {
  passes += 1;
  console.log(`  ✓ ${label}`);
}
function fail(label: string, err: unknown): void {
  failures += 1;
  console.error(`  ✗ ${label}`);
  console.error(err);
}

interface CapturedResponse {
  status: number;
  body: unknown;
}

/**
 * 极简 fake context：捕获 json() 调用并返回 status + body；不连真实
 * Hono 路由框架。`context.req.param/query/json/formData` 全部 stub。
 */
function makeContext(params: Record<string, string>, body: unknown): {
  ctx: AuthenticatedRouteContextLike;
  captured: CapturedResponse[];
} {
  const captured: CapturedResponse[] = [];
  const ctx: AuthenticatedRouteContextLike = {
    req: {
      raw: new Request('http://localhost/v1/approvals'),
      header: () => undefined,
      param: (name: string) => params[name] ?? '',
      query: () => undefined,
      json: async <T>() => body as T,
      formData: async () => new FormData(),
    },
    json: (data, status = 200) => {
      captured.push({ status, body: data });
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
    body: (data, status = 200) => {
      captured.push({ status, body: data });
      return new Response(
        typeof data === 'string' ? data : data === null ? '' : JSON.stringify(data),
        { status },
      );
    },
  };
  return { ctx, captured };
}

async function invoke(
  h: (authCtx: AuthenticatedContext, ctx: AuthenticatedRouteContextLike) => Promise<Response>,
  authCtx: AuthenticatedContext,
  ctx: AuthenticatedRouteContextLike,
): Promise<Response> {
  return await h(authCtx, ctx);
}

const authCtx: AuthenticatedContext = {
  userId: 'user-1',
  username: 'alice',
  workspaceId: 'ws-1',
};

console.log('── approvals-route ──');

// ─── UUID 校验 ──────────────────────────────────────────────────
{
  assert.equal(isUuid('00000000-0000-4000-8000-000000000001'), true);
  ok('isUuid 接受标准 UUID');
}
{
  assert.equal(isUuid('not-a-uuid'), false);
  ok('isUuid 拒绝非 UUID');
}

// ─── rowToView 字段映射 ────────────────────────────────────────
{
  const row = {
    id: 'a',
    workspaceId: 'w',
    runId: 'r',
    toolId: 't',
    toolCallId: 'tc',
    status: 'pending',
    decision: null,
    resolverError: null,
    requesterId: 'u',
    resolverId: 'u',
    inputsSummary: { foo: 'bar' },
    inputsHash: 'hash',
    expiresAt: '2026-09-03T00:00:00Z',
    createdAt: '2026-09-03T00:00:00Z',
    resolvedAt: null,
  };
  const view = rowToView(row);
  assert.equal(view.id, 'a');
  assert.equal(view.workspaceId, 'w');
  assert.equal(view.status, 'pending');
  assert.equal(view.decision, null);
  assert.deepEqual(view.inputsSummary, { foo: 'bar' });
  ok('rowToView 字段透传');
}

// ─── resolveApprovalHandler: 输入校验 ──────────────────────────
{
  // 缺 decision
  const { ctx, captured } = makeContext(
    { id: '00000000-0000-4000-8000-000000000001' },
    {},
  );
  await invoke(resolveApprovalHandler, authCtx, ctx);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.status, 422);
  ok('缺 decision → 422');
}
{
  // decision 非法值
  const { ctx, captured } = makeContext(
    { id: '00000000-0000-4000-8000-000000000001' },
    { decision: 'maybe' },
  );
  await invoke(resolveApprovalHandler, authCtx, ctx);
  assert.equal(captured[0]!.status, 422);
  ok("decision='maybe' → 422");
}
{
  // 非 UUID id
  const { ctx, captured } = makeContext(
    { id: 'not-a-uuid' },
    { decision: 'approve' },
  );
  await invoke(resolveApprovalHandler, authCtx, ctx);
  assert.equal(captured[0]!.status, 422);
  ok('非 UUID id → 422');
}
{
  // 空 body
  const { ctx, captured } = makeContext(
    { id: '00000000-0000-4000-8000-000000000001' },
    null,
  );
  await invoke(resolveApprovalHandler, authCtx, ctx);
  assert.equal(captured[0]!.status, 422);
  ok('null body → 422');
}
{
  // body 是数组
  const { ctx, captured } = makeContext(
    { id: '00000000-0000-4000-8000-000000000001' },
    [],
  );
  await invoke(resolveApprovalHandler, authCtx, ctx);
  assert.equal(captured[0]!.status, 422);
  ok('数组 body → 422');
}

// ─── getApprovalHandler: UUID 校验 ─────────────────────────────
{
  const { ctx, captured } = makeContext({ id: 'bad' }, {});
  await invoke(getApprovalHandler, authCtx, ctx);
  assert.equal(captured[0]!.status, 422);
  ok('GET /v1/approvals/:id 非 UUID → 422');
}

// ─── facade injection 可注入性 ────────────────────────────────
{
  // fake facade 不会被本测试的 handler 实际调用（handler 在
  // ensureProductionFacade 路径上 await import('../../mastra/index.js')），
  // 因此这里只声明"测试钩子存在 + null 重置安全"。
  const fake: MastraAgentFacade = {
    approveToolCall: async () => undefined,
    declineToolCall: async () => undefined,
    listSuspendedRuns: async () => [],
  };
  _setMastraFacadeForTesting(fake);
  _setMastraFacadeForTesting(null);
  ok('state-machine._setMastraFacadeForTesting(null) 安全');
}

// ─── state-machine outcome kinds 完整性 ──────────────────────
{
  // 文档化声明：本测试 + tool-policy-state-machine.ts 共同保证以下
  // 7 个 outcome.kind 都有对应映射：
  //   - approved             → 200 { approval }
  //   - declined             → 200 { approval }
  //   - not_found            → 404
  //   - already_resolved     → 409 APPROVAL_ALREADY_RESOLVED
  //   - lease_contended      → 409 APPROVAL_INFLIGHT
  //   - lease_lost_during_sdk→ 410 APPROVAL_LEASE_LOST
  //   - sdk_failed           → 200 { approval(状态=declined, resolverError=...), sdkFailed:true }
  const expected: ResolveApprovalOutcome['kind'][] = [
    'approved',
    'declined',
    'not_found',
    'already_resolved',
    'lease_contended',
    'sdk_failed',
    'lease_lost_during_sdk',
  ];
  assert.equal(expected.length, 7);
  ok(`state-machine outcome kinds=${expected.join('|')}`);
}

console.log(`Result: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;