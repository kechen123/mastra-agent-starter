/**
 * V2 重新生成（regenerate）事务流集成测试。
 *
 * 需要真实 PostgreSQL：RUN_DB_TESTS=1 + TEST_DATABASE_URL=postgres://...
 * schema-init 已落地时此 fixture 才能跑；否则全部 SKIPPED。
 *
 * 覆盖：
 *   1. 成功创建新 Run：旧 assistant 收敛为 stopped、新 assistant pending + 新 Run queued，
 *      新 Run 的 user_message_id 与旧 Run 一致（FK 传递）。
 *   2. 跨 workspace 拒绝：assistant 归属 workspace B 时 workspace A 调 createRegenerateRun
 *      应抛 NotFoundError（与现有 CrossWorkspaceAccessError 一致 404 行为）。
 *   3. 同会话活跃 Run 冲突：现有 running/queued Run 时再次调 createRegenerateRun
 *      应抛 ConversationActiveRunError（PG 23505）。
 *   4. 目标 assistant 无 agent_runs 关联（数据完整性异常）→ NotFoundError，
 *      不再做 created_at/xmin/id 时序启发式兜底。
 *   5. PG now() 同事务 user+assistant created_at 相同场景：提前注入一条
 *      agent_runs(assistant_message_id=原 assistant, user_message_id=原 user, status=completed)，
 *      并把 user/assistant 的 created_at 拉到同一事务时间，再插入一条更晚的 decoy user。
 *      断言 regenerate 走 agent_runs.user_message_id 稳定 FK 命中原始 user，
 *      不被 created_at 启发式 / decoy 时间干扰。同时验证连续 regenerate 仍命中
 *      同一原始 user（不漂移到 decoy）。
 *
 * 不覆盖：
 *   - run executor 真正消费 Run（避免 mock mastra runtime；这部分在 run-executor
 *     自己的测试里覆盖）。
 *   - SSE 流；流本身由 streamRunEvents 测试覆盖，本 fixture 只保证 run-queued
 *     事件被持久化。
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Pool } from 'pg';
import { createRegenerateRun } from '../../src/modules/runs/service.js';
import {
  ensureSchema,
  createIsolatedSchema,
  dropIsolatedSchema,
} from '../../src/test-utils/schema-init.js';

const URL = process.env.TEST_DATABASE_URL;
const RUN = process.env.RUN_DB_TESTS === '1' && !!URL;

interface Harness {
  pool: Pool;
  schema: string;
  workspaceA: string;
  workspaceB: string;
  userA: string;
  conversationA: string;
  agentId: string;
  assistantMessageId: string;
  userMessageId: string;
}

/**
 * 为目标 assistant message 注入一条「已完成」的 agent_runs 记录，显式
 * 写入 user_message_id = 原 user message id。这模拟"正常一问一答"链路
 * 在单事务里 INSERT user + assistant messages + agent_runs 时必然存在的
 * 数据形态，是 regenerate 走稳定 FK 命中 user 的前提。
 */
async function seedOriginalRun(
  h: Harness,
  opts: { runStatus?: 'completed' | 'stopped' | 'failed'; runId?: string; workspaceId?: string } = {},
): Promise<string> {
  const runId = opts.runId ?? `00000000-0000-4000-8000-000000000050`;
  const wsId = opts.workspaceId ?? h.workspaceA;
  await h.pool.query(
    `INSERT INTO agent_runs (
       id, workspace_id, conversation_id, assistant_message_id, user_message_id,
       agent_id, provider, model, status, request_id, created_by
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'openai', 'gpt-test', $7, $8, $9)`,
    [
      runId,
      wsId,
      h.conversationA,
      h.assistantMessageId,
      h.userMessageId,
      h.agentId,
      opts.runStatus ?? 'completed',
      'test-seed-req',
      h.userA,
    ],
  );
  return runId;
}

async function setupHarness(): Promise<Harness> {
  const root = new Pool({ connectionString: URL });
  const schema = `test_regen_${Math.random().toString(36).slice(2, 10)}`;
  await createIsolatedSchema(root, schema);
  const pool = new Pool({
    connectionString: URL,
    options: `-c search_path=${schema},public`,
  });
  await ensureSchema(pool);

  // 注入 workspace + 用户 + 会话 + 两条消息（user + assistant）。
  // agent_id 是字符串（registry 中已注册），无需 INSERT。
  const agentId = 'general-chat';
  const workspaceA = `00000000-0000-4000-8000-000000000001`;
  const workspaceB = `00000000-0000-4000-8000-000000000002`;
  const userA = `00000000-0000-4000-8000-000000000010`;
  const conversationA = `00000000-0000-4000-8000-000000000020`;
  const userMessageId = `00000000-0000-4000-8000-000000000030`;
  const assistantMessageId = `00000000-0000-4000-8000-000000000031`;

  await pool.query(
    `INSERT INTO app_users (id, username, username_normalized, password_hash)
     VALUES ($1, 'u_a', 'u_a', 'x')`,
    [userA],
  );
  await pool.query(
    `INSERT INTO workspaces (id, kind, name) VALUES ($1, 'shared', 'ws-a'), ($2, 'shared', 'ws-b')`,
    [workspaceA, workspaceB],
  );
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($3, $2, 'owner')`,
    [workspaceA, userA, workspaceB],
  );
  await pool.query(
    `INSERT INTO conversations (id, workspace_id, agent_id, knowledge_base_id, title)
     VALUES ($1, $2, $3, NULL, 'regen test')`,
    [conversationA, workspaceA, agentId],
  );
  await pool.query(
    `INSERT INTO messages (id, workspace_id, conversation_id, role, content, status, created_at)
     VALUES ($1, $2, $3, 'user', 'hello', 'completed', now() - interval '10 seconds'),
            ($4, $2, $3, 'assistant', 'first answer', 'completed', now() - interval '5 seconds')`,
    [userMessageId, workspaceA, conversationA, assistantMessageId],
  );

  return { pool, schema, workspaceA, workspaceB, userA, conversationA, agentId, assistantMessageId, userMessageId };
}

async function teardown(h: Harness): Promise<void> {
  const root = new Pool({ connectionString: URL });
  await h.pool.end();
  await dropIsolatedSchema(root, h.schema);
  await root.end();
}

test('regenerate: 成功创建新 Run，旧 assistant 收敛为 stopped', { skip: !RUN }, async () => {
  const h = await setupHarness();
  try {
    // 必须先 seed 一条原 Run，regenerate 才能走稳定 FK 命中 user。
    await seedOriginalRun(h);

    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await createRegenerateRun(client, {
        workspaceId: h.workspaceA,
        assistantMessageId: h.assistantMessageId,
        provider: 'openai',
        model: 'gpt-test',
        userId: h.userA,
        requestId: 'test-regen-ok',
      });
      await client.query('COMMIT');

      assert.equal(result.conversation.id, h.conversationA);
      assert.equal(result.userMessage.id, h.userMessageId);
      assert.equal(result.oldAssistantMessage.id, h.assistantMessageId);
      assert.notEqual(result.assistantMessage.id, h.assistantMessageId);
      assert.equal(result.run.status, 'queued');
      assert.equal(result.run.conversationId, h.conversationA);
      assert.equal(result.run.assistantMessageId, result.assistantMessage.id);
      // 新 Run 的 user_message_id FK 必须与原 Run 一致（向下传递）。
      assert.equal(result.run.userMessageId, h.userMessageId);

      // 旧 assistant status=stopped
      const oldRow = await h.pool.query<{ status: string }>(
        `SELECT status FROM messages WHERE id = $1`,
        [h.assistantMessageId],
      );
      assert.equal(oldRow.rows[0]!.status, 'stopped');

      // 新 assistant status=pending + current_run_id=new
      const newRow = await h.pool.query<{ status: string; current_run_id: string }>(
        `SELECT status, current_run_id FROM messages WHERE id = $1`,
        [result.assistantMessage.id],
      );
      assert.equal(newRow.rows[0]!.status, 'pending');
      assert.equal(newRow.rows[0]!.current_run_id, result.run.id);

      // run-queued 事件存在且 payload.assistantMessageId 指向新 assistant
      const evtRow = await h.pool.query<{ type: string; payload: unknown }>(
        `SELECT type, payload FROM agent_run_events WHERE run_id = $1`,
        [result.run.id],
      );
      assert.equal(evtRow.rows.length, 1);
      assert.equal(evtRow.rows[0]!.type, 'run-queued');
      assert.deepEqual(evtRow.rows[0]!.payload, { assistantMessageId: result.assistantMessage.id });
    } finally {
      client.release();
    }
  } finally {
    await teardown(h);
  }
});

test('regenerate: 跨 workspace 拒绝（assistant 属于 B，A 调用 → NotFoundError）', { skip: !RUN }, async () => {
  const h = await setupHarness();
  try {
    // 把 assistant message 改到 workspaceB；同步把 conversation 也搬到 B
    // （messages.workspace_id 是单维度隔离，conversations 同样；保持一致避免
    // 触发其它约束）。
    await h.pool.query(`UPDATE conversations SET workspace_id = $1 WHERE id = $2`, [h.workspaceB, h.conversationA]);
    await h.pool.query(`UPDATE messages SET workspace_id = $1 WHERE id = $2`, [h.workspaceB, h.assistantMessageId]);
    await h.pool.query(`UPDATE messages SET workspace_id = $1 WHERE id = $2`, [h.workspaceB, h.userMessageId]);
    // 也 seed 一条 Run，让 service 走到跨 workspace 校验前不先因无 Run 失败。
    await seedOriginalRun(h, {
      runId: '00000000-0000-4000-8000-000000000051',
      workspaceId: h.workspaceB,
    });

    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        () => createRegenerateRun(client, {
          workspaceId: h.workspaceA,
          assistantMessageId: h.assistantMessageId,
          provider: 'openai',
          model: 'gpt-test',
          userId: h.userA,
          requestId: 'test-regen-cross',
        }),
        (err: Error) => err.name === 'NotFoundError',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await teardown(h);
  }
});

test('regenerate: 同会话活跃 Run 冲突 → ConversationActiveRunError', { skip: !RUN }, async () => {
  const h = await setupHarness();
  try {
    // 注入原始 Run（已 completed）→ 让 regenerate 走到 active Run 检查前不先因无 Run 失败。
    await seedOriginalRun(h);

    // 注入一条 active run
    const activeRunId = `00000000-0000-4000-8000-000000000099`;
    const activeAssistantId = `00000000-0000-4000-8000-000000000098`;
    await h.pool.query(
      `INSERT INTO messages (id, workspace_id, conversation_id, role, content, status)
       VALUES ($1, $2, $3, 'assistant', 'stream...', 'streaming')`,
      [activeAssistantId, h.workspaceA, h.conversationA],
    );
    await h.pool.query(
      `INSERT INTO agent_runs (id, workspace_id, conversation_id, assistant_message_id, user_message_id, agent_id,
                                provider, model, status, request_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'openai', 'gpt-test', 'running', $7, $8)`,
      [activeRunId, h.workspaceA, h.conversationA, activeAssistantId, h.userMessageId, h.agentId, 'test-active-req', h.userA],
    );

    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        () => createRegenerateRun(client, {
          workspaceId: h.workspaceA,
          assistantMessageId: h.assistantMessageId,
          provider: 'openai',
          model: 'gpt-test',
          userId: h.userA,
          requestId: 'test-regen-conflict',
        }),
        (err: Error) => err.name === 'ConversationActiveRunError',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await teardown(h);
  }
});

test('regenerate: 目标 assistant 无 agent_runs 关联 → NotFoundError（数据完整性异常）', { skip: !RUN }, async () => {
  const h = await setupHarness();
  try {
    // 不 seed 任何 agent_runs；模拟"assistant 消息没有对应 Run"的数据完整性
    // 异常。service 不再做 created_at/xmin/id 时序启发式兜底 → 直接显式失败。
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        () => createRegenerateRun(client, {
          workspaceId: h.workspaceA,
          assistantMessageId: h.assistantMessageId,
          provider: 'openai',
          model: 'gpt-test',
          userId: h.userA,
          requestId: 'test-regen-orphan',
        }),
        (err: Error) => err.name === 'NotFoundError' && /没有可识别的原始 user 消息/.test(err.message),
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await teardown(h);
  }
});

/**
 * PR-UI-1.0.5 F1 核心场景：PG `now()` 在同一事务内固定。
 *
 * 真实业务流：用户在 UI 点"发送"→ 后端单事务内 INSERT user message + INSERT
 * assistant pending + INSERT agent_runs → 这三条记录 created_at 都是同一个
 * `now()` 值。修复前的 created_at < target.created_at 启发式会在这种真实
 * 场景下错误返回空（404 NotFoundError）。
 *
 * 测试通过如下步骤强制模拟该数据形态：
 *   1. 提前 INSERT 一条 agent_runs(assistant_message_id=原 assistant,
 *      user_message_id=原 user, status=completed) → 这是同事务链路必然产生
 *      的"原 Run 关联"。
 *   2. UPDATE user + assistant 的 created_at = 同一 now()（同事务时间）。
 *   3. INSERT 一条 created_at 更晚的 decoy user → 验证即使 decoy 在时序上
 *      更优，regenerate 仍命中原始 user 而非 decoy。
 *   4. 调 createRegenerateRun，断言 result.userMessage.id === 原 user。
 *   5. 连续第二次 regenerate（针对新生成的 assistant），断言 result.userMessage.id
 *      仍 === 原 user（FK 向下传递，不漂移到 decoy）。
 */
test('regenerate: PG now() 同事务 user+assistant created_at 相同 + decoy 更晚 → 仍命中原始 user', { skip: !RUN }, async () => {
  const h = await setupHarness();
  try {
    // 1. 注入原 Run（必须先 seed，否则 service 会先因无 Run 失败 → 拿不到"同事务"修复路径）。
    const originalRunId = await seedOriginalRun(h);

    // 2. 把 user/assistant 的 created_at 拉到同一事务时间 now() —— 这是触发
    //    旧 created_at < target.created_at 启发式失败的真实场景。
    await h.pool.query(
      `UPDATE messages SET created_at = now()
        WHERE id IN ($1, $2)`,
      [h.userMessageId, h.assistantMessageId],
    );

    // 3. 注入一条 created_at 更晚的 decoy user —— 如果 service 错误地退回
    //    created_at DESC 时序启发式，会错误命中这条 decoy。
    const decoyUserId = `00000000-0000-4000-8000-000000000040`;
    await h.pool.query(
      `INSERT INTO messages (id, workspace_id, conversation_id, role, content, status, created_at)
       VALUES ($1, $2, $3, 'user', 'decoy', 'completed', now() + interval '1 microsecond')`,
      [decoyUserId, h.workspaceA, h.conversationA],
    );

    // 4. 第一轮 regenerate：必须命中原始 userMessageId，**不**是 decoy。
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await createRegenerateRun(client, {
        workspaceId: h.workspaceA,
        assistantMessageId: h.assistantMessageId,
        provider: 'openai',
        model: 'gpt-test',
        userId: h.userA,
        requestId: 'test-regen-sametx',
      });
      await client.query('COMMIT');

      assert.equal(result.userMessage.id, h.userMessageId, '必须命中原始 user，而非 decoy');
      assert.notEqual(result.userMessage.id, decoyUserId, '绝不能命中 decoy user');
      assert.equal(result.run.userMessageId, h.userMessageId, '新 Run 的 user_message_id FK 与 result.userMessage.id 一致');

      // 同时验证原 Run 的 user_message_id 与新 Run 一致（向下传递路径）。
      const originalRunRow = await h.pool.query<{ user_message_id: string }>(
        `SELECT user_message_id FROM agent_runs WHERE id = $1`,
        [originalRunId],
      );
      assert.equal(originalRunRow.rows[0]!.user_message_id, result.run.userMessageId);

      // 5. 连续第二次 regenerate 前，必须先把第一轮的 Run 收敛到 completed
      //    （模仿"前一次生成已完成"的用户场景），否则 active run 校验会拦截。
      //    同时把上一轮新建的 assistant message 也收敛到 stopped，让它
      //    成为可被 regenerate 的目标。
      await h.pool.query(
        `UPDATE agent_runs SET status = 'completed', completed_at = now() WHERE id = $1`,
        [result.run.id],
      );
      await h.pool.query(
        `UPDATE messages SET status = 'stopped' WHERE id = $1`,
        [result.assistantMessage.id],
      );

      // 6. 连续第二次 regenerate（针对上一轮新生成的 assistant）：新 Run 的
      //    user_message_id 必须仍是原始 userMessageId（不漂移到 decoy）。
      const previousAssistantId = result.assistantMessage.id;
      const client2 = await h.pool.connect();
      try {
        await client2.query('BEGIN');
        const result2 = await createRegenerateRun(client2, {
          workspaceId: h.workspaceA,
          assistantMessageId: previousAssistantId,
          provider: 'openai',
          model: 'gpt-test',
          userId: h.userA,
          requestId: 'test-regen-sametx-2',
        });
        await client2.query('COMMIT');

        assert.equal(result2.userMessage.id, h.userMessageId, '第二轮仍命中原始 user');
        assert.notEqual(result2.userMessage.id, decoyUserId, '第二轮也绝不命中 decoy');
        assert.equal(result2.run.userMessageId, h.userMessageId, '第二轮 Run 的 user_message_id FK 仍指向原始 user');

        // 验证 agent_runs.user_message_id 链：原 Run → 第一次 regenerate → 第二次 regenerate，
        // 三条 Run 的 user_message_id 必须都是原始 userMessageId。
        const allRuns = await h.pool.query<{ user_message_id: string }>(
          `SELECT user_message_id FROM agent_runs
            WHERE workspace_id = $1 AND conversation_id = $2
            ORDER BY created_at ASC`,
          [h.workspaceA, h.conversationA],
        );
        assert.equal(allRuns.rows.length, 3, '应恰好 3 条 Run（1 原始 + 2 重新生成）');
        for (const r of allRuns.rows) {
          assert.equal(r.user_message_id, h.userMessageId, '所有 Run.user_message_id 必须指向原始 user');
        }
      } finally {
        client2.release();
      }
    } finally {
      client.release();
    }
  } finally {
    await teardown(h);
  }
});