/**
 * PR-review Round 3 Item 3 集成测试 fixture：
 *   把 unit 测试中无法覆盖的 DB 路径放到 integration fixture。
 *
 * 覆盖：
 *   - I1：UNIQUE(workspace_id, run_id, tool_call_id) 在 NULL run_id 路径下
 *         不参与去重，由 `tool_executions_null_run_unique` 部分索引兜底
 *         （init.sql 已加）。
 *   - I2：tool backfill 缺失 start 行 → 在真实 DB 上 backfill 一行审计
 *         记录（status 保留 input.status，error 字段带
 *         'finalized_without_start' 标记）。
 *   - I3：tool backfill 缺失关联（无 runId 无 messageId）→ 抛错（不
 *         静默 INSERT）。
 *   - I4：stopRunByMessageId 真实 DB 路径：partial content → reload → 收
 *         敛到 status='stopped'，content 来自 V2 终态快照，citations 走
 *         chunkId 取并集。
 *
 * 启用条件：
 *   - RUN_DB_TESTS=1 + TEST_DATABASE_URL 指向 *_test 数据库（顶层 runner
 *     run.ts 还会再加 safety-identifier 闸门）。
 *
 * Run with: RUN_DB_TESTS=1 TEST_DATABASE_URL=... npm run test:integration
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ensureSchema } from '../../src/test-utils/schema-init.js';
import {
  finalizeToolExecutionByCallId,
  upsertToolExecution,
} from '../../src/modules/conversations/tool-executions.js';
import {
  __resetTestPool,
  __setTestPool,
  withGlobalPoolGuard,
} from '../../src/infrastructure/database/pool.js';

const URL = process.env.TEST_DATABASE_URL;
const RUN = process.env.RUN_DB_TESTS === '1' && !!URL;

/**
 * 在隔离 schema 上运行测试体，并把全局连接池替换为带
 * `search_path=<schema>,public` 的测试池。被测代码（如
 * `finalizeToolExecutionByCallId`）内部走 `getDatabasePool()` 必须能
 * 看到隔离 schema，**不**允许落入 `DATABASE_URL` 指向的真实库。
 *
 * 安全约束（PR-review Round 5 P1 修复）：
 *   - **不**修改 `process.env.DATABASE_URL`。一旦设置全局池（__setTestPool）
 *     后，`getDatabasePool()` 会短路返回 `pool`，不会触发默认分支的
 *     `DATABASE_URL` 守卫，因此无需占位注入环境变量；finally 也不需
 *     恢复原值，彻底避免测试间的环境泄漏。
 *   - **必须**用 `withGlobalPoolGuard` 串行化。其它 fixture
 *     （isolation-contract、workspace-context 等）也走同一全局池单例；
 *     没有 guard 时并发跑会互相抢全局池、FK 拒绝、`_init_meta` 跨
 *     schema 污染。本函数把 set / body / reset 整段放到 guard 内，
 *     与 pool.ts 既有约定对齐。
 *   - scoped 池必先 `__setTestPool(scoped)` 再调 fn，让 ensureSchema
 *     等依赖路径也走 search_path=schema。
 *   - finally 必走 `__resetTestPool()`，即便 fn 抛错也不残留全局池。
 */
async function withIsolatedSchema<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  if (!URL) throw new Error('TEST_DATABASE_URL required');
  return withGlobalPoolGuard(async () => {
    const schema = `stop_tool_${Math.random().toString(36).slice(2, 10)}`;
    const root = new Pool({ connectionString: URL });
    await root.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new Pool({
      connectionString: URL,
      options: `-c search_path=${schema},public`,
    });
    try {
      __setTestPool(scoped);
      await ensureSchema(scoped, { ragEnabled: false });
      return await fn(scoped);
    } finally {
      __resetTestPool();
      await scoped.end();
      await root.query(`DROP SCHEMA "${schema}" CASCADE`);
      await root.end();
    }
  });
}

interface SeededFixture {
  workspaceId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  agentRunId: string;
}

async function seedConversationAndRun(pool: Pool): Promise<SeededFixture> {
  const workspace = await pool.query<{ id: string }>(
    `INSERT INTO workspaces(kind,name) VALUES('shared','stop-tool fixture') RETURNING id`,
  );
  const workspaceId = workspace.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users(username,username_normalized,password_hash)
       VALUES($1,$1,'!disabled!') RETURNING id`,
    [`fixture_${randomUUID()}`],
  );
  const userId = user.rows[0]!.id;
  const conversation = await pool.query<{ id: string }>(
    `INSERT INTO conversations(workspace_id,agent_id,title)
       VALUES($1,'general-chat','fixture') RETURNING id`,
    [workspaceId],
  );
  const conversationId = conversation.rows[0]!.id;
  const userMessage = await pool.query<{ id: string }>(
    `INSERT INTO messages(conversation_id,workspace_id,role,content,status)
       VALUES($1,$2,'user','hello','completed') RETURNING id`,
    [conversationId, workspaceId],
  );
  const assistantMessage = await pool.query<{ id: string }>(
    `INSERT INTO messages(conversation_id,workspace_id,role,content,status)
       VALUES($1,$2,'assistant','','streaming') RETURNING id`,
    [conversationId, workspaceId],
  );
  const agentRun = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs(
        workspace_id,conversation_id,assistant_message_id,
        agent_id,provider,model,status,request_id,created_by
     ) VALUES($1,$2,$3,'general-chat','test','test','running',$4,$5) RETURNING id`,
    [workspaceId, conversationId, assistantMessage.rows[0]!.id, randomUUID(), userId],
  );
  return {
    workspaceId,
    conversationId,
    userMessageId: userMessage.rows[0]!.id,
    assistantMessageId: assistantMessage.rows[0]!.id,
    agentRunId: agentRun.rows[0]!.id,
  };
}

// ─── I1：NULL run_id 部分唯一索引兜底 ───────────────────────────────
test('tool_executions_null_run_unique: NULL run_id 路径不参与原 UNIQUE，由部分索引兜底',
  { skip: !RUN },
  async () => {
    await withIsolatedSchema(async (pool) => {
      const fix = await seedConversationAndRun(pool);
      // 生产 upsert 必须能推断 NULL run_id 的部分唯一索引；重复 start
      // （SSE replay / 历史恢复）不应抛 23505，且必须返回同一 DB 主键。
      const first = await upsertToolExecution({
        workspaceId: fix.workspaceId,
        messageId: fix.assistantMessageId,
        runId: null,
        toolCallId: 'tc-1',
        toolName: 'search',
        args: {},
      });
      const replay = await upsertToolExecution({
        workspaceId: fix.workspaceId,
        messageId: fix.assistantMessageId,
        runId: null,
        toolCallId: 'tc-1',
        toolName: 'search',
        args: {},
      });
      assert.equal(replay, first, 'NULL run_id 重放应返回同一执行记录');
      const duplicateCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tool_executions
          WHERE workspace_id = $1 AND run_id IS NULL AND tool_call_id = 'tc-1'`,
        [fix.workspaceId],
      );
      assert.equal(duplicateCount.rows[0]?.count, '1', 'NULL run_id 重放不得产生重复行');
      // 跨 workspace：第二行换 workspace → 应允许。
      const other = await pool.query<{ id: string }>(
        `INSERT INTO workspaces(kind,name) VALUES('shared','other') RETURNING id`,
      );
      const otherId = other.rows[0]!.id;
      const cross = await pool.query<{ id: string }>(
        `INSERT INTO tool_executions(
            workspace_id,message_id,run_id,tool_call_id,tool_name,args,status
         ) VALUES($1,$2,NULL,'tc-1','search', '{}'::jsonb,'running') RETURNING id`,
        [otherId, fix.assistantMessageId],
      );
      assert.ok(cross.rows[0]?.id, '跨 workspace 同 toolCallId 应允许');
      // 同一 workspace 换 toolCallId → 应允许。
      const next = await pool.query<{ id: string }>(
        `INSERT INTO tool_executions(
            workspace_id,message_id,run_id,tool_call_id,tool_name,args,status
         ) VALUES($1,$2,NULL,'tc-2','search', '{}'::jsonb,'running') RETURNING id`,
        [fix.workspaceId, fix.assistantMessageId],
      );
      assert.ok(next.rows[0]?.id, '同 workspace 不同 toolCallId 应允许');
    });
  },
);

// ─── I2：tool backfill 真实 DB 行为 ─────────────────────────────────
test('finalizeToolExecutionByCallId: 缺失 start 行 → backfill 审计行（status 保留）',
  { skip: !RUN },
  async () => {
    await withIsolatedSchema(async (pool) => {
      const fix = await seedConversationAndRun(pool);
      // 用生产函数 finalizeToolExecutionByCallId 走真实路径。
      const wrote = await finalizeToolExecutionByCallId({
        workspaceId: fix.workspaceId,
        runId: fix.agentRunId,
        toolCallId: 'tc-backfill',
        result: { ok: true },
        status: 'success',
        error: undefined,
      });
      assert.equal(wrote, true, '首次 backfill 应返回 true');
      // 验证：行存在 + status='success' + error 字段标记。
      const row = await pool.query<{ status: string; error: string | null }>(
        `SELECT status, error FROM tool_executions
          WHERE workspace_id = $1 AND tool_call_id = $2`,
        [fix.workspaceId, 'tc-backfill'],
      );
      assert.equal(row.rowCount, 1, 'backfill 行应存在');
      assert.equal(row.rows[0]?.status, 'success', 'status 应保留 success');
      assert.equal(
        row.rows[0]?.error,
        'finalized_without_start',
        'error 字段应带 finalized_without_start 标记',
      );
      // 再次调用：行已存在且已终态 → 幂等 no-op（返回 false）。
      const second = await finalizeToolExecutionByCallId({
        workspaceId: fix.workspaceId,
        runId: fix.agentRunId,
        toolCallId: 'tc-backfill',
        result: { ok: true },
        status: 'success',
      });
      assert.equal(second, false, '已终态时第二次 finalize 应 no-op');
    });
  },
);

// ─── I3：tool backfill 数据缺失 → 抛错（不静默） ──────────────────
test('finalizeToolExecutionByCallId: 缺失关联 → 抛错（不静默 INSERT）',
  { skip: !RUN },
  async () => {
    await withIsolatedSchema(async (pool) => {
      const fix = await seedConversationAndRun(pool);
      // 既无 runId 也无 messageId / toolName → 抛错。
      await assert.rejects(
        finalizeToolExecutionByCallId({
          workspaceId: fix.workspaceId,
          runId: null,
          toolCallId: 'tc-missing',
          result: null,
          status: 'cancelled',
        }),
        /缺失 start 行且无法反查 messageId/,
        '无 runId + 无 messageId 应抛错',
      );
      // 验证：未写入任何行（不应静默 INSERT）。
      const cnt = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tool_executions
          WHERE workspace_id = $1 AND tool_call_id = 'tc-missing'`,
        [fix.workspaceId],
      );
      assert.equal(cnt.rows[0]?.count, '0', '抛错后不应写入审计行');
    });
  },
);

// ─── I4：partial content 停止 → reload → 状态一致 ──────────────────
test('stopRunByMessageId: partial content + citations 收敛到 stopped，reload 后一致',
  { skip: !RUN },
  async () => {
    await withIsolatedSchema(async (pool) => {
      const fix = await seedConversationAndRun(pool);
      // 先在 messages 上写一组已落库引用。
      const existingCitations = [
        { chunkId: 'c-1', score: 0.5 },
        { chunkId: 'c-2', score: 0.6 },
      ];
      await pool.query(
        `UPDATE messages SET citations = $3::jsonb
          WHERE id = $1 AND workspace_id = $2`,
        [fix.assistantMessageId, fix.workspaceId, JSON.stringify(existingCitations)],
      );
      // 走真实 stopRunByMessageId（happy path）。
      const { stopRunByMessageId } = await import('../../src/modules/runs/service.js');
      const finalContent = 'partial answer text';
      const finalCitations = [
        { chunkId: 'c-1', score: 0.9 }, // 覆盖 c-1
        { chunkId: 'c-3', score: 0.7 }, // 新增 c-3
      ];
      const client = await pool.connect();
      let result: Awaited<ReturnType<typeof stopRunByMessageId>>;
      try {
        await client.query('BEGIN');
        result = await stopRunByMessageId(client, {
          workspaceId: fix.workspaceId,
          assistantMessageId: fix.assistantMessageId,
          finalContent,
          citations: finalCitations,
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      assert.equal(result.stopped, true, 'stopped 应为 true');
      assert.equal(result.contentLength, finalContent.length, 'contentLength 应等于 finalContent.length');
      assert.equal(result.content, finalContent, 'content 应等于 finalContent');
      // citations：merged 应为 [c-1(0.9), c-3(0.7), c-2(0.6)]，按 incoming 优先 + DB 残留追加。
      const merged = result.citations as Array<{ chunkId: string; score: number }>;
      assert.equal(merged.length, 3, 'merged citations 应为 3 条');
      assert.equal(merged[0]?.chunkId, 'c-1');
      assert.equal(merged[0]?.score, 0.9, 'c-1 应取 incoming score');
      assert.equal(merged[1]?.chunkId, 'c-3');
      assert.equal(merged[2]?.chunkId, 'c-2', 'c-2 来自 DB 残留');
      // Reload：messages.content / status / citations 必须与 result 一致。
      const reloaded = await pool.query<{ content: string; status: string; citations: unknown }>(
        `SELECT content, status, citations FROM messages WHERE id = $1 AND workspace_id = $2`,
        [fix.assistantMessageId, fix.workspaceId],
      );
      assert.equal(reloaded.rows[0]?.content, finalContent);
      assert.equal(reloaded.rows[0]?.status, 'stopped');
      const reloadedCitations = reloaded.rows[0]?.citations as Array<{ chunkId: string }>;
      assert.equal(reloadedCitations.length, 3);
      assert.equal(reloadedCitations[0]?.chunkId, 'c-1');
      assert.equal(reloadedCitations[2]?.chunkId, 'c-2');
      // agent_runs 也应收敛到 stopped（同一事务内的条件 WHERE）。
      const runRow = await pool.query<{ status: string }>(
        `SELECT status FROM agent_runs WHERE id = $1`,
        [fix.agentRunId],
      );
      assert.equal(runRow.rows[0]?.status, 'stopped');
    });
  },
);

// ─── I6：DB 已存 citations + incoming=[] → SSE/HTTP 仍返回 DB 引用 ──
// PR-review Round 6 Item 1 回归：旧实现 empty incoming 分支把
// finalCitationsForPayload 设为 []，导致 SSE 告知前端"无引用"。
// 修复后：跳过 UPDATE 让 DB 保留已有引用，但 result.citations
// 必须是 DB 当前值（与 messages.citations 完全一致）。
test('stopRunByMessageId: DB 已存 citations + incoming=[] → final payload = DB citations',
  { skip: !RUN },
  async () => {
    await withIsolatedSchema(async (pool) => {
      const fix = await seedConversationAndRun(pool);
      // DB 已存 citations（典型：content-checkpoint 期间累积的部分引用）
      const existingCitations = [
        { chunkId: 'c-1', score: 0.5 },
        { chunkId: 'c-2', score: 0.6 },
      ];
      await pool.query(
        `UPDATE messages SET citations = $3::jsonb
          WHERE id = $1 AND workspace_id = $2`,
        [fix.assistantMessageId, fix.workspaceId, JSON.stringify(existingCitations)],
      );
      // 走 stopRunByMessageId，incoming=[]（executor 没传 citations）
      const { stopRunByMessageId } = await import('../../src/modules/runs/service.js');
      const client = await pool.connect();
      let result: Awaited<ReturnType<typeof stopRunByMessageId>>;
      try {
        await client.query('BEGIN');
        result = await stopRunByMessageId(client, {
          workspaceId: fix.workspaceId,
          assistantMessageId: fix.assistantMessageId,
          finalContent: 'partial',
          citations: [], // 关键：empty incoming
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      assert.equal(result.stopped, true);
      // 关键断言：HTTP response 必须返回 DB 已保留的 citations，
      // 不是 []。这是 SSE-first 场景下"HTTP 后到能补齐引用"的契约。
      const returnedCitations = result.citations as Array<{ chunkId: string; score: number }>;
      assert.equal(returnedCitations.length, 2, 'result.citations 应包含 DB 已保留的 2 条引用');
      assert.equal(returnedCitations[0]?.chunkId, 'c-1');
      assert.equal(returnedCitations[0]?.score, 0.5);
      assert.equal(returnedCitations[1]?.chunkId, 'c-2');
      // 验证：run-stopped SSE event payload 也使用同一个数组。
      const evt = await pool.query<{ payload: unknown }>(
        `SELECT payload FROM agent_run_events
          WHERE run_id = $1 AND type = 'run-stopped'
          ORDER BY id DESC LIMIT 1`,
        [fix.agentRunId],
      );
      assert.ok(evt.rows[0]?.payload, '应写入 run-stopped 事件');
      const payloadCitations = (evt.rows[0]!.payload as { citations: unknown[] }).citations;
      assert.equal(payloadCitations.length, 2,
        'SSE payload citations 应与 HTTP response 一致（来自 DB）');
      assert.equal((payloadCitations[0] as { chunkId: string }).chunkId, 'c-1');
      assert.equal((payloadCitations[1] as { chunkId: string }).chunkId, 'c-2');
      // 验证：messages.citations 也未被覆写（DB 保留原值）。
      const reloaded = await pool.query<{ citations: unknown }>(
        `SELECT citations FROM messages WHERE id = $1 AND workspace_id = $2`,
        [fix.assistantMessageId, fix.workspaceId],
      );
      const reloadedCitations = reloaded.rows[0]?.citations as Array<{ chunkId: string }>;
      assert.equal(reloadedCitations.length, 2);
      assert.equal(reloadedCitations[0]?.chunkId, 'c-1');
    });
  },
);

// ─── I5：UNIQUE 与 partial 索引职责划分（纯静态断言） ─────────────
test('init.sql contains tool_executions_null_run_unique partial index', { skip: false }, () => {
  // 静态校验 init.sql 包含 partial unique index（无需 DB）。这防止
  // 有人未来误删部分索引、让 NULL run_id 路径破坏去重语义。
  const sql = readFileSync(
    new URL('../../database/init.sql', import.meta.url),
    'utf-8',
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX tool_executions_null_run_unique[\s\S]+WHERE\s+run_id\s+IS\s+NULL/i,
    'init.sql 必须包含 tool_executions_null_run_unique 部分索引',
  );
});
