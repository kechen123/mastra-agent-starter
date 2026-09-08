/**
 * Phase 3.1 — Tool Policy / Approval Repository 契约测试（离线）。
 *
 * 目标：用 fake client（query capture）拦截 Repository 实际发往 pg
 * 的 SQL 与参数，断言：
 *   - 所有 SQL 走参数化（$N），不拼接字符串；
 *   - 全部读取强制带 workspace_id 过滤；
 *   - 原子 resolve 的 UPDATE 必带
 *     `WHERE id=$1 AND workspace_id=$2 AND status='pending'`；
 *   - 0 行更新后 fallback SELECT 同样强制 workspace_id 过滤；
 *   - 不向 inputs_summary 写入原始敏感输入（仅接收调用方传入的"已
 *     脱敏 JSON"字符串）。
 *
 * 不连真实 PostgreSQL、不启动服务、不使用真实密钥。
 *
 * 运行：`cd backend && npx tsx tests/unit/tool-policy-repository.ts`
 */

interface CapturedQuery {
  text: string;
  params: unknown[];
  /** 返回该 query 的 row / rowCount；由 fixture 预设。 */
  scriptedRows: unknown[];
  scriptedRowCount: number;
}

interface FakeClient {
  queries: CapturedQuery[];
  /** 下一个 query 应该返回的 rows；调用前 push 入队。 */
  scriptNext(rows: unknown[], rowCount?: number): void;
  query<R = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * PG 的 query() 既接受单条 SQL（无 params），也接受配置对象 / prepared 形式。
 * Repository 用的是 `executor.query(text, params)`，因此 fake 只实现这一种
 * 签名即可。
 */
function makeFakeClient(): FakeClient {
  const queues: { rows: unknown[]; rowCount: number }[] = [];
  return {
    queries: [],
    scriptNext(rows: unknown[], rowCount?: number): void {
      queues.push({ rows, rowCount: rows.length === 0 ? 0 : (rowCount ?? rows.length) });
    },
    async query<R>(text: string, params: unknown[] = []): Promise<{
      rows: R[];
      rowCount: number | null;
    }> {
      const next = queues.shift();
      if (!next) {
        throw new Error(
          `fake client 未预设返回值: ${text.split('\n')[0]?.slice(0, 80)}…`,
        );
      }
      // Repository 内依赖 `rows[0]` 与 `rowCount`；两者都按 preset 给。
      const captured: CapturedQuery = {
        text,
        params,
        scriptedRows: next.rows,
        scriptedRowCount: next.rowCount,
      };
      this.queries.push(captured);
      return {
        rows: next.rows as R[],
        rowCount: next.rowCount,
      };
    },
  };
}

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

const repo = await import('../../src/modules/tool-policy/repository.js');

// ─── C1: createApprovalRequest 参数化 + workspace 过滤 ──────────────
console.log('[tool-policy-repository] C1: createApprovalRequest');

{
  const fake = makeFakeClient();
  fake.scriptNext([
    {
      id: '00000000-0000-0000-0000-000000000001',
      workspace_id: 'ws-1',
      run_id: '00000000-0000-0000-0000-000000000010',
      tool_id: 'send-email',
      tool_call_id: 'tc-1',
      inputs_hash: 'h1',
      inputs_summary: { to: 'a***@example.com' },
      status: 'pending',
      requester_id: '00000000-0000-0000-0000-000000000100',
      resolver_id: null,
      expires_at: new Date('2030-01-01T00:00:00Z'),
      created_at: new Date('2026-09-03T00:00:00Z'),
      resolved_at: null,
    },
  ]);
  const row = await repo.createApprovalRequest(
    {
      workspaceId: 'ws-1',
      runId: '00000000-0000-0000-0000-000000000010',
      toolId: 'send-email',
      toolCallId: 'tc-1',
      inputsHash: 'h1',
      inputsSummary: { to: 'a***@example.com' }, // 已是脱敏摘要
      requesterId: '00000000-0000-0000-0000-000000000100',
      expiresAt: new Date('2030-01-01T00:00:00Z').toISOString(),
    },
    fake,
  );
  const q = fake.queries[0]!;
  check('仅发 1 条 SQL', fake.queries.length === 1);
  check(
    'SQL 用参数化占位符（$1..$8），不拼接字符串',
    /INSERT INTO\s+tool_approval_requests/i.test(q.text) &&
      /\$1[\s\S]*\$2[\s\S]*\$8/.test(q.text) &&
      !/'ws-1'|"ws-1"/.test(q.text),
  );
  check(
    'INSERT **不**再写入 suspension_id 列',
    !/INSERT INTO\s+tool_approval_requests[\s\S]*suspension_id/i.test(q.text),
  );
  check(
    'params[0] 是 workspaceId',
    q.params[0] === 'ws-1',
  );
  check(
    'params[5] 是 inputsSummary 序列化的字符串（已脱敏 JSON）',
    q.params[5] === JSON.stringify({ to: 'a***@example.com' }),
  );
  check(
    '**不**把原始 sensitive inputs 直接写进 params',
    !String(q.params[5]).includes('original-secret-payload'),
  );
  check(
    'status 默认写入 pending',
    /'pending'/i.test(q.text),
  );
  check('row.id 透传', row.id === '00000000-0000-0000-0000-000000000001');
  check(
    'row.inputsSummary 是 PG 读回的 JSONB 对象',
    typeof row.inputsSummary === 'object' &&
      (row.inputsSummary as { to?: string }).to === 'a***@example.com',
  );
}

// ─── C2: getApprovalRequestById 强制 workspace 过滤 ──────────────────
console.log('\n[tool-policy-repository] C2: getApprovalRequestById workspace 过滤');

{
  const fake = makeFakeClient();
  fake.scriptNext([
    {
      id: 'appr-1',
      workspace_id: 'ws-1',
      run_id: 'run-1',
      tool_id: 'send-email',
      tool_call_id: 'tc-1',
      inputs_hash: 'h1',
      inputs_summary: {},
      status: 'pending',
      requester_id: 'user-1',
      resolver_id: null,
      expires_at: new Date('2030-01-01T00:00:00Z'),
      created_at: new Date('2026-09-03T00:00:00Z'),
      resolved_at: null,
    },
  ]);
  const row = await repo.getApprovalRequestById('ws-1', 'appr-1', fake);
  const q = fake.queries[0]!;
  check('找到 → 返回 row', row !== null && row.id === 'appr-1');
  check(
    'SELECT 带 WHERE id = $1 AND workspace_id = $2',
    /SELECT[\s\S]+FROM\s+tool_approval_requests[\s\S]+WHERE\s+id\s*=\s*\$1\s+AND\s+workspace_id\s*=\s*\$2/i.test(
      q.text,
    ),
  );
  check('params[0]=id, params[1]=workspaceId', q.params[0] === 'appr-1' && q.params[1] === 'ws-1');
}

{
  const fake = makeFakeClient();
  fake.scriptNext([]); // 0 rows：跨 workspace / 不存在
  const row = await repo.getApprovalRequestById('ws-2', 'appr-other', fake);
  check('未找到 → 返回 null', row === null);
  const q = fake.queries[0]!;
  check(
    '跨 workspace 查询仍然带 workspace_id 过滤（不抛错）',
    /workspace_id\s*=\s*\$2/i.test(q.text) && q.params[1] === 'ws-2',
  );
}

// ─── C3: resolveApprovalRequest 命中路径 ─────────────────────────────
console.log('\n[tool-policy-repository] C3: resolveApprovalRequest 命中 pending');

{
  const fake = makeFakeClient();
  // UPDATE 返回 1 行；Repository 路径下不再跑 fallback SELECT。
  fake.scriptNext(
    [
      {
        id: 'appr-1',
        workspace_id: 'ws-1',
        run_id: 'run-1',
        tool_id: 'send-email',
        tool_call_id: 'tc-1',
        inputs_hash: 'h1',
        inputs_summary: {},
        status: 'approved',
        requester_id: 'user-1',
        resolver_id: 'user-2',
        expires_at: new Date('2030-01-01T00:00:00Z'),
        created_at: new Date('2026-09-03T00:00:00Z'),
        resolved_at: new Date('2026-09-03T01:00:00Z'),
      },
    ],
    1,
  );
  const result = await repo.resolveApprovalRequest({
    workspaceId: 'ws-1',
    approvalId: 'appr-1',
    resolverId: 'user-2',
    decision: 'approved',
  }, fake);
  check('返回 kind=resolved', result.kind === 'resolved');
  if (result.kind === 'resolved') {
    check(
      'row.status=approved, row.resolverId=user-2, row.resolvedAt 不为 null',
      result.row.status === 'approved' &&
        result.row.resolverId === 'user-2' &&
        result.row.resolvedAt !== null,
    );
  }
  const q = fake.queries[0]!;
  check(
    'UPDATE 强制带 WHERE id=$1 AND workspace_id=$2 AND status=\'pending\'',
    /UPDATE\s+tool_approval_requests[\s\S]+WHERE\s+id\s*=\s*\$1\s+AND\s+workspace_id\s*=\s*\$2\s+AND\s+status\s*=\s*'pending'/i.test(
      q.text,
    ),
  );
  check(
    'params = [approvalId, workspaceId, decision, resolverId]',
    q.params[0] === 'appr-1' &&
      q.params[1] === 'ws-1' &&
      q.params[2] === 'approved' &&
      q.params[3] === 'user-2',
  );
  check(
    '命中路径只发 1 条 SQL（不做 fallback SELECT）',
    fake.queries.length === 1,
  );
}

// ─── C4: resolveApprovalRequest 0 行 → fallback SELECT 区分状态 ──────
console.log('\n[tool-policy-repository] C4: 0 行更新走 fallback 判定');

{
  const fake = makeFakeClient();
  fake.scriptNext([], 0); // UPDATE 0 行
  fake.scriptNext([{ status: 'approved' }]); // fallback SELECT 找到且 status≠pending
  const result = await repo.resolveApprovalRequest({
    workspaceId: 'ws-1',
    approvalId: 'appr-1',
    resolverId: 'user-2',
    decision: 'approved',
  }, fake);
  check('返回 kind=already_resolved', result.kind === 'already_resolved');
  if (result.kind === 'already_resolved') {
    check(
      'currentStatus=approved',
      result.currentStatus === 'approved',
    );
  }
  check('共发 2 条 SQL', fake.queries.length === 2);
  const fallback = fake.queries[1]!;
  check(
    'fallback SELECT 仍带 workspace_id 过滤',
    /SELECT\s+status[\s\S]+WHERE\s+id\s*=\s*\$1\s+AND\s+workspace_id\s*=\s*\$2/i.test(
      fallback.text,
    ) &&
      fallback.params[0] === 'appr-1' &&
      fallback.params[1] === 'ws-1',
  );
}

{
  const fake = makeFakeClient();
  fake.scriptNext([], 0); // UPDATE 0 行
  fake.scriptNext([]); // fallback SELECT 0 行：行不存在（其它 workspace 或 id 错）
  const result = await repo.resolveApprovalRequest({
    workspaceId: 'ws-1',
    approvalId: 'appr-other',
    resolverId: 'user-2',
    decision: 'declined',
  }, fake);
  check('返回 kind=not_found（跨 workspace / 不存在统一隐藏）', result.kind === 'not_found');
}

// ─── C5: listPendingApprovalRequests 强制 workspace 过滤 ─────────────
console.log('\n[tool-policy-repository] C5: listPendingApprovalRequests');

{
  const fake = makeFakeClient();
  fake.scriptNext([]);
  const rows = await repo.listPendingApprovalRequests('ws-1', fake);
  check('返回空数组', Array.isArray(rows) && rows.length === 0);
  const q = fake.queries[0]!;
  check(
    'WHERE workspace_id=$1 AND status=\'pending\'（ORDER BY created_at ASC）',
    /workspace_id\s*=\s*\$1[\s\S]+status\s*=\s*'pending'[\s\S]+ORDER BY\s+created_at\s+ASC/i.test(
      q.text,
    ),
  );
  check('params[0]=workspaceId', q.params[0] === 'ws-1');
}

// ─── C6: tool_policy_rules 最小 Repository ───────────────────────────
console.log('\n[tool-policy-repository] C6: tool_policy_rules 最小 Repo');

{
  const fake = makeFakeClient();
  fake.scriptNext([
    {
      id: 'pol-1',
      workspace_id: 'ws-1',
      tool_id: 'send-email',
      effect: 'require_approval',
      conditions: { maxAmount: { currency: 'USD', value: 100 } },
      created_by: 'user-1',
      created_at: new Date('2026-09-03T00:00:00Z'),
      updated_at: new Date('2026-09-03T00:00:00Z'),
    },
  ]);
  const row = await repo.upsertPolicyRule(
    {
      workspaceId: 'ws-1',
      toolId: 'send-email',
      effect: 'require_approval',
      conditions: { maxAmount: { currency: 'USD', value: 100 } },
      createdBy: 'user-1',
    },
    fake,
  );
  const q = fake.queries[0]!;
  check(
    'upsert 走 ON CONFLICT (workspace_id, tool_id) DO UPDATE',
    /INSERT INTO\s+tool_policy_rules[\s\S]+ON CONFLICT\s*\(\s*workspace_id\s*,\s*tool_id\s*\)[\s\S]+DO UPDATE/i.test(
      q.text,
    ),
  );
  check(
    'params[0..3] = workspaceId, toolId, effect, conditions-json-string',
    q.params[0] === 'ws-1' &&
      q.params[1] === 'send-email' &&
      q.params[2] === 'require_approval' &&
      q.params[3] === JSON.stringify({
        maxAmount: { currency: 'USD', value: 100 },
      }),
  );
  check('row.effect 透传', row.effect === 'require_approval');
}

{
  const fake = makeFakeClient();
  fake.scriptNext([]);
  const row = await repo.getPolicyRule('ws-1', 'no-such-tool', fake);
  check('未找到 → 返回 null', row === null);
  const q = fake.queries[0]!;
  check(
    'getPolicyRule 同样带 workspace_id 过滤',
    /workspace_id\s*=\s*\$1[\s\S]+tool_id\s*=\s*\$2/i.test(q.text),
  );
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
