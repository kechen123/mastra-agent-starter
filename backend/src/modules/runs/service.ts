/**
 * Run 业务服务：把单事务内的命令副作用封装为可复用 service 函数。
 *
 * 关键约束（architecture-v2.md §6.2 / §6.3）：
 *   - 创建 Run / 写 run-queued 事件 / 回填 current_run_id 必须严格顺序；
 *   - 任一步失败必须整体回滚；
 *   - 同会话并发 POST 触发 partial unique 冲突 → 409。
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { getRequestId, logRequest } from '../../infrastructure/logging/request-id.js';
import { CrossWorkspaceAccessError } from '../../server/error-mapping.js';
import {
  createQueuedRun,
  insertRunEvent,
  getRunById,
  type RunRow,
} from './repository.js';
import { buildRunTerminalPayload, mergeCitationsByChunkId } from './citation-merge.js';

export interface CreateRunForMessageInput {
  workspaceId: string;
  conversationId: string;
  assistantMessageId: string;
  agentId: string;
  provider: string;
  model: string;
  userId: string;
  requestId?: string;
}

/**
 * POST `/conversations/:id/messages` 的核心副作用：
 *   1. 校验会话归属 + 拿 agentId / knowledgeBaseId；
 *   2. UPDATE conversations: draft → active，title 触发 maybeUpdateTitleFromFirstMessage；
 *   3. INSERT messages(role='user')；
 *   4. INSERT messages(role='assistant', status='pending', current_run_id=NULL)；
 *   5. INSERT agent_runs(status='queued')；
 *   6. INSERT agent_run_events(type='run-queued') + NOTIFY；
 *   7. UPDATE messages SET current_run_id=:runId；
 *   8. 写 idempotency_keys 缓存由调用方决定）。
 *
 * 调用方负责：开 / 提交 / 回滚事务。
 */
export async function createUserMessageAndQueuedRun(
  client: PoolClient,
  input: {
    workspaceId: string;
    conversationId: string;
    userMessageContent: string;
    agentId: string;
    provider: string;
    model: string;
    userId: string;
    requestId?: string;
  },
): Promise<{
  conversation: { id: string; title: string; status: 'draft' | 'active' };
  userMessage: { id: string };
  assistantMessage: { id: string };
  run: RunRow;
  runEventId: number;
}> {
  const requestId = input.requestId ?? getRequestId() ?? '';

  // 1. 锁住会话行 + 校验 workspace；FOR UPDATE 防同会话并发互踩。
  const convRow = await client.query<{
    id: string;
    status: 'draft' | 'active';
    title: string;
    agent_id: string;
    knowledge_base_id: string | null;
  }>(
    `SELECT id, status, title, agent_id, knowledge_base_id
       FROM conversations
      WHERE id = $1 AND workspace_id = $2
      FOR UPDATE`,
    [input.conversationId, input.workspaceId],
  );
  const conv = convRow.rows[0];
  if (!conv) {
    throw new CrossWorkspaceAccessError();
  }

  // 2. draft → active + 标题触发。
  if (conv.status === 'draft') {
    const newTitle = input.userMessageContent.trim().slice(0, 30) || conv.title;
    await client.query(
      `UPDATE conversations
          SET status = 'active', title = $3, updated_at = now()
        WHERE id = $1 AND workspace_id = $2 AND status = 'draft'`,
      [conv.id, input.workspaceId, newTitle],
    );
  } else {
    await client.query(
      `UPDATE conversations SET updated_at = now()
        WHERE id = $1 AND workspace_id = $2`,
      [conv.id, input.workspaceId],
    );
  }

  // 3. user message
  const userMsgRow = await client.query<{ id: string }>(
    `INSERT INTO messages (workspace_id, conversation_id, role, content, status)
     VALUES ($1, $2, 'user', $3, 'completed')
     RETURNING id`,
    [input.workspaceId, conv.id, input.userMessageContent],
  );
  const userMessageId = userMsgRow.rows[0]!.id;

  // 4. assistant pending message；必须先 INSERT 出 id 才能给 agent_runs.assistant_message_id。
  const asstRow = await client.query<{ id: string }>(
    `INSERT INTO messages (workspace_id, conversation_id, role, content, citations, status, current_run_id)
     VALUES ($1, $2, 'assistant', '', '[]'::jsonb, 'pending', NULL)
     RETURNING id`,
    [input.workspaceId, conv.id],
  );
  const assistantMessageId = asstRow.rows[0]!.id;

  // 5. queued run；同会话 partial unique 冲突 → PG 抛 23505 → 上层翻译 409。
  let runRow: RunRow;
  try {
    runRow = await createQueuedRun(
      {
        workspaceId: input.workspaceId,
        conversationId: conv.id,
        assistantMessageId,
        userMessageId,
        agentId: input.agentId,
        provider: input.provider,
        model: input.model,
        requestId,
        createdBy: input.userId,
      },
      client,
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      const e = new Error('该会话已有正在进行的生成，请等待完成或停止后再试。') as Error & { name: string };
      e.name = 'ConversationActiveRunError';
      throw e;
    }
    throw err;
  }

  // 6. run-queued 事件 + NOTIFY
  const runEventId = await insertRunEvent(client, {
    runId: runRow.id,
    workspaceId: input.workspaceId,
    type: 'run-queued',
    payload: { assistantMessageId },
  });

  // 7. 回填 assistant.current_run_id（FK 安全，因为 run 已存在）
  await client.query(
    `UPDATE messages SET current_run_id = $2 WHERE id = $1`,
    [assistantMessageId, runRow.id],
  );

  return {
    conversation: { id: conv.id, title: conv.title, status: 'active' },
    userMessage: { id: userMessageId },
    assistantMessage: { id: assistantMessageId },
    run: runRow,
    runEventId,
  };
}

export interface CreateDraftConversationInput {
  workspaceId: string;
  userId: string;
  agentId: string;
  knowledgeBaseId: string | null;
}

/**
 * POST `/conversations`：在事务内创建 draft conversation，返回新行。
 * 调用方负责事务边界 + 写 idempotency_keys。
 */
export async function createDraftConversation(
  client: PoolClient,
  input: CreateDraftConversationInput,
): Promise<{ id: string; status: 'draft'; agentId: string; knowledgeBaseId: string | null; createdAt: string }> {
  const conversationId = randomUUID();
  const r = await client.query<{
    id: string;
    agent_id: string;
    knowledge_base_id: string | null;
    created_at: string;
  }>(
    `INSERT INTO conversations (
       id, workspace_id, agent_id, knowledge_base_id, title, status, created_by
     ) VALUES ($1, $2, $3, $4, '新对话', 'draft', $5)
     RETURNING id, agent_id, knowledge_base_id, created_at`,
    [
      conversationId,
      input.workspaceId,
      input.agentId,
      input.knowledgeBaseId,
      input.userId,
    ],
  );
  const row = r.rows[0]!;
  logRequest('info', {
    msg: 'draft conversation created',
    workspaceId: input.workspaceId,
    userId: input.userId,
    conversationId: row.id,
  });
  return {
    id: row.id,
    status: 'draft',
    agentId: row.agent_id,
    knowledgeBaseId: row.knowledge_base_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function ensureRunReadable(
  workspaceId: string,
  runId: string,
): Promise<RunRow | null> {
  return getRunById(runId, workspaceId, getDatabasePool());
}

/**
 * 停止一条 Run 的事务收敛（V2 §6.3）。
 *
 * 调用方负责传入 `PoolClient`；本函数在调用方事务内执行：
 *   1. UPDATE agent_runs WHERE status IN ('queued','running','waiting_approval')
 *      → SET status='stopped', completed_at=now(), lease_owner=NULL, ...；
 *      用条件 WHERE 防止覆写已经被 completed/failed/stopped 的行。
 *   2. UPDATE messages SET status='stopped', content=COALESCE(partialContent),
 *      citations=COALESCE(保留已落库引用)
 *      WHERE id = assistant_message_id AND workspace_id。
 *   3. INSERT agent_run_events(type='run-stopped', payload.contentLength)
 *      + NOTIFY。
 *
 * 引用保留规则（架构契约）：停止行为**不**清除已在本 Run 中产生且
 * 已持久化的引用——这些引用是真实检索结果，已被前端展示使用；仅在
 * 明确"引用不可信 / 未提交"的语义（例如 Run 进入 failed + 重新计算）
 * 才清除。本函数路径仅写 stopped，不写 citations='[]'。
 *
 * 幂等性：Run 已是 stopped/completed/failed 时返回
 * `{ stopped: false, run, reason: 'already_terminal', contentLength }`
 * 且**不**再写 run-stopped 事件；`contentLength` 取自当前 message.content
 * 的实际长度（保证 HTTP 响应的 contentLength 与落库正文一致）。
 *
 * 返回：{ stopped: true } 若 Run 行确实从活跃态收敛；
 *       { stopped: false, run } 若该 Run 已处于终态（stopped/completed/failed）；
 *       { stopped: false, missing: true } 若消息 / Run 不存在或跨 workspace。
 *
 * 不变量：所有写入在同一调用方事务中执行；调用方负责 BEGIN / COMMIT / ROLLBACK。
 */
export async function stopRunByMessageId(
  client: import('pg').PoolClient,
  args: {
    workspaceId: string;
    assistantMessageId: string;
    /**
     * 来自 V2 ActiveExecution 的全量文本快照（`executor.fullText`）；
     * V2 stop 路径权威文本。空字符串是合法值——空文本停止同样收敛
     * 为 stopped，contentLength=0。
     */
    finalContent: string;
    /** 已落库的引用快照；停止行为只追加、不清除。 */
    citations: ReadonlyArray<unknown>;
  },
): Promise<
  | {
      stopped: true;
      run: RunRow;
      eventId: number;
      contentLength: number;
      /**
       * PR-review Round 3 Item 1：HTTP stop 成功后必须返回**同一事务**
       * 已落库的权威 content + citations 快照。前端不再依赖 SSE run-stopped
       * 才能完成独立 finalize——HTTP 200 + 权威快照 = 立即收敛；
       SSE run-stopped 后到走幂等 no-op。
       * `contentLength === content.length`。
       */
      content: string;
      citations: ReadonlyArray<unknown>;
    }
  | {
      stopped: false;
      run: RunRow;
      reason: 'already_terminal';
      contentLength: number;
      /** 同上：幂等路径也返回权威 content + citations。 */
      content: string;
      citations: ReadonlyArray<unknown>;
    }
  | { stopped: false; missing: true }
> {
  // 1. 锁住消息行 + 拿到 current_run_id（行锁防同会话并发误收敛）
  const msgRow = await client.query<{
    current_run_id: string | null;
    workspace_id: string;
  }>(
    `SELECT current_run_id, workspace_id FROM messages
      WHERE id = $1
      FOR UPDATE`,
    [args.assistantMessageId],
  );
  const msg = msgRow.rows[0];
  if (!msg || msg.workspace_id !== args.workspaceId) {
    return { stopped: false, missing: true };
  }
  if (!msg.current_run_id) {
    return { stopped: false, missing: true };
  }

  // 2. 锁住 Run 行
  const runRow = await client.query<Record<string, unknown>>(
    `SELECT id, workspace_id, conversation_id, assistant_message_id, user_message_id, agent_id,
            provider, model, status, input_tokens, output_tokens,
            estimated_cost_usd, started_at, completed_at, error_code,
            parent_run_id, request_id, lease_owner, lease_expires_at,
            heartbeat_at, created_by, created_at, updated_at
       FROM agent_runs
      WHERE id = $1 AND workspace_id = $2
      FOR UPDATE`,
    [msg.current_run_id, args.workspaceId],
  );
  const row = runRow.rows[0];
  if (!row) {
    return { stopped: false, missing: true };
  }
  const run = {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    conversationId: row.conversation_id as string,
    assistantMessageId: row.assistant_message_id as string,
    userMessageId: row.user_message_id as string,
    agentId: row.agent_id as string,
    provider: row.provider as string,
    model: row.model as string,
    status: row.status as RunRow['status'],
    inputTokens: (row.input_tokens as number) ?? 0,
    outputTokens: (row.output_tokens as number) ?? 0,
    estimatedCostUsd: Number(row.estimated_cost_usd ?? 0),
    startedAt: row.started_at ? new Date(row.started_at as string).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
    errorCode: (row.error_code as string | null) ?? null,
    parentRunId: (row.parent_run_id as string | null) ?? null,
    requestId: row.request_id as string,
    leaseOwner: (row.lease_owner as string | null) ?? null,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at as string).toISOString() : null,
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at as string).toISOString() : null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  } satisfies RunRow;

  // 3. 已是终态 → 幂等：不覆写 content/citations/状态，不重复写 run-stopped；
  //    contentLength 取自当前 message.content 长度，保证与落库正文一致。
  if (run.status === 'stopped' || run.status === 'completed' || run.status === 'failed') {
    const currentMsgRow = await client.query<{
      content: string;
      status: string;
    }>(
      `SELECT content, status FROM messages WHERE id = $1 AND workspace_id = $2`,
      [args.assistantMessageId, args.workspaceId],
    );
    const currentContent = currentMsgRow.rows[0]?.content ?? '';
    // 幂等路径同样要返回权威 citations 快照，方便前端把"老终态"
    //   与"新 stop"两条路径都收敛到同一 UI 终态。
    const citationsRow = await client.query<{ citations: unknown }>(
      `SELECT citations FROM messages WHERE id = $1 AND workspace_id = $2`,
      [args.assistantMessageId, args.workspaceId],
    );
    const currentCitations = Array.isArray(citationsRow.rows[0]?.citations)
      ? (citationsRow.rows[0]?.citations as ReadonlyArray<unknown>)
      : [];
    logRequest('info', {
      msg: 'stopRunByMessageId 幂等：Run 已终态，不重复收敛',
      workspaceId: args.workspaceId,
      runId: run.id,
      assistantMessageId: args.assistantMessageId,
      currentStatus: run.status,
      messageStatus: currentMsgRow.rows[0]?.status,
    });
    return {
      stopped: false,
      run,
      reason: 'already_terminal',
      contentLength: currentContent.length,
      content: currentContent,
      citations: currentCitations,
    };
  }

  // 4. 收敛 Run（条件 WHERE 防止覆写）
  await client.query(
    `UPDATE agent_runs
        SET status = 'stopped',
            completed_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND status IN ('queued','running','waiting_approval')`,
    [run.id, args.workspaceId],
  );

  // 5. 收敛 message（条件 WHERE）：content 用 V2 终态快照（args.finalContent），
  //    citations 仅在快照非空时合并写入；若快照为空（null/undefined/[]）→
  //    保留 DB 现有引用，避免 COALESCE($4::jsonb, citations) 把空数组
  //    误当作非空写入导致覆盖已落库引用（PR-review Item 3）。
  //    合并策略（PR-review Round 2 Item 4 修复）：按 `chunkId` 字段
  //    取并集，incoming 优先；同 chunkId 视作同一引用。`chunkId` 是
  //    Citation 契约的唯一稳定字段（`modules/citations/types.ts`），
  //    之前的 `id` 字段在 Citation 上不存在 → 去重无效。
  const incomingCitations = Array.isArray(args.citations) ? args.citations : null;
  const contentValue = args.finalContent ?? '';

  // PR-review Round 5 Item 1 + Round 6 Item 1：先在变量层把"最终
  //   citations"统一为一个数组 `finalCitationsForPayload`，随后
  //   messages UPDATE（可能跳过 citations 列）/ SSE run-stopped payload /
  //   HTTP response 三处都用同一个数组。SSE 与 HTTP 通道必须携带完全
  //   一致的终态快照。
  //
  //   空 incoming 不代表最终 citations 为空（PR-review Round 6 Item 1）：
  //   当 messages.citations 已有引用、incoming=[]（典型：executor stop 时
  //   只持有部分快照或运行时未带 citations）→ 跳过 UPDATE 让 DB 保留已有
  //   引用，但 finalCitationsForPayload **必须**取 DB 当前值，而不是 []。
  //   否则 SSE 会告知前端"无引用"、HTTP 也返空，UI 与 DB 不一致直到
  //   用户刷新。
  let finalCitationsForPayload: ReadonlyArray<unknown>;
  if (incomingCitations && incomingCitations.length > 0) {
    // 拉 DB 已落库引用 → JS 端按 chunkId 合并 → 一次性 UPDATE。
    // PR-review Round 3 Item 3：合并逻辑提取至 citation-merge.ts 的
    // `mergeCitationsByChunkId`，service.ts / run-executor.ts / 测试三者
    // 共用同一实现，禁止在调用点复制。
    const existingRow = await client.query<{ citations: unknown }>(
      `SELECT citations FROM messages WHERE id = $1 AND workspace_id = $2`,
      [args.assistantMessageId, args.workspaceId],
    );
    const existingCitations = Array.isArray(existingRow.rows[0]?.citations)
      ? (existingRow.rows[0].citations as Array<Record<string, unknown>>)
      : [];
    const mergedCitations = mergeCitationsByChunkId(existingCitations, incomingCitations);
    const merged = mergedCitations.merged as Array<Record<string, unknown>>;
    finalCitationsForPayload = merged;
    await client.query(
      `UPDATE messages
          SET status = 'stopped',
              content = $3,
              citations = $4::jsonb
        WHERE id = $1
          AND workspace_id = $2
          AND status IN ('pending','streaming')`,
      [args.assistantMessageId, args.workspaceId, contentValue, JSON.stringify(merged)],
    );
  } else {
    // incoming 为空：不覆写 messages.citations（DB 已保留已有引用），
    //   但 finalCitationsForPayload 必须取 DB 当前值 —— SSE / HTTP
    //   都向 UI 报告"实际保留的最终引用"，否则会向 UI 撒谎说"没有引用"。
    const existingRow = await client.query<{ citations: unknown }>(
      `SELECT citations FROM messages WHERE id = $1 AND workspace_id = $2`,
      [args.assistantMessageId, args.workspaceId],
    );
    finalCitationsForPayload = Array.isArray(existingRow.rows[0]?.citations)
      ? (existingRow.rows[0]?.citations as ReadonlyArray<unknown>)
      : [];
    await client.query(
      `UPDATE messages
          SET status = 'stopped',
              content = $3
        WHERE id = $1
          AND workspace_id = $2
          AND status IN ('pending','streaming')`,
      [args.assistantMessageId, args.workspaceId, contentValue],
    );
  }

  // 6. 写 run-stopped 事件——payload 必须使用 finalCitationsForPayload
  //   （已合并并持久化的最终数组），而不是 incomingCitations。这条
  //   不变量是 PR-review Round 5 Item 1 修复的核心：SSE / HTTP 两条
  //   终态通道必须共享同一权威快照。
  //    PR-review Round 3 Item 3：payload 构造提取至 citation-merge.ts 的
  //    `buildRunTerminalPayload`，与 run-executor 的 run-completed 共用。
  const terminalPayload = buildRunTerminalPayload(contentValue, finalCitationsForPayload);
  const eventId = await insertRunEvent(client, {
    runId: run.id,
    workspaceId: args.workspaceId,
    type: 'run-stopped',
    payload: terminalPayload,
  });

  // 7. PR-review Round 3 Item 1：从 messages 重新 SELECT 权威 content
  //    （同一事务已 COMMIT 前）。citations 不再需要重读 —— 已经
  //    在 finalCitationsForPayload 中持有写入后的最终值；重读反而
  //    增加与 SSE payload 不一致的风险。
  const finalRow = await client.query<{ content: string }>(
    `SELECT content FROM messages WHERE id = $1 AND workspace_id = $2`,
    [args.assistantMessageId, args.workspaceId],
  );
  const finalContent = finalRow.rows[0]?.content ?? '';

  logRequest('info', {
    msg: 'Run stopped transactionally',
    workspaceId: args.workspaceId,
    runId: run.id,
    assistantMessageId: args.assistantMessageId,
    eventId,
    contentLength: finalContent.length,
  });

  return {
    stopped: true,
    run,
    eventId,
    contentLength: finalContent.length,
    content: finalContent,
    citations: finalCitationsForPayload,
  };
}

/**
 * V2 重新生成（regenerate）的事务核心。
 *
 * 设计：
 *   - 输入 assistantMessageId：必须归属当前 workspace，且所在会话当前没有活跃 Run。
 *   - 找到 assistant 的直接上一条 user message（按 created_at 倒序第一条 role=user）；
 *     重新生成走的是"同一 user 上下文重新跑一遍"，因此 user message 不动。
 *   - 把目标 assistant message 收敛到 stopped 终态（保留 content / citations，
 *     避免刷新页面后看到空白；status=stopped 表明已弃用），
 *     并 INSERT 一条新的 assistant pending message 接收新 Run 输出。
 *   - 新建 agent_runs（status=queued）→ run-queued 事件 → 回填
 *     messages.current_run_id → 整事务提交。run executor 后续从队列
 *     claim、推 run-started / content-* / 终态事件。
 *
 * 错误码：
 *   - 404：assistantMessageId 不存在 / 跨 workspace / 找不到紧邻的 user 父消息。
 *   - 409 CONVERSATION_CONFLICT_ACTIVE_RUN：同会话仍有活跃 Run，强制用户先停止。
 *
 * 调用方负责：开 / 提交 / 回滚事务 + 写 idempotency_keys。
 */
export async function createRegenerateRun(
  client: PoolClient,
  input: {
    workspaceId: string;
    assistantMessageId: string;
    provider: string;
    model: string;
    userId: string;
    requestId?: string;
  },
): Promise<{
  conversation: { id: string; agentId: string };
  userMessage: { id: string };
  oldAssistantMessage: { id: string };
  assistantMessage: { id: string };
  run: RunRow;
  runEventId: number;
}> {
  const requestId = input.requestId ?? getRequestId() ?? '';

  // 1. 锁住目标 assistant message 行 + 校验 workspace。
  const targetRow = await client.query<{
    id: string;
    conversation_id: string;
    role: string;
    status: string;
    workspace_id: string;
    created_at: string;
  }>(
    `SELECT id, conversation_id, role, status, workspace_id, created_at
       FROM messages
      WHERE id = $1
      FOR UPDATE`,
    [input.assistantMessageId],
  );
  const target = targetRow.rows[0];
  if (!target || target.workspace_id !== input.workspaceId || target.role !== 'assistant') {
    const e = new Error('目标消息不存在或不属于当前 Workspace。') as Error & { name: string };
    e.name = 'NotFoundError';
    throw e;
  }

  // 2. 锁住会话 + 校验 workspace + 取 agentId。
  const convRow = await client.query<{
    id: string;
    agent_id: string;
  }>(
    `SELECT id, agent_id FROM conversations
      WHERE id = $1 AND workspace_id = $2
      FOR UPDATE`,
    [target.conversation_id, input.workspaceId],
  );
  const conv = convRow.rows[0];
  if (!conv) {
    const e = new Error('会话不存在。') as Error & { name: string };
    e.name = 'NotFoundError';
    throw e;
  }

  // 3. 找 assistant 响应的原始 user message：直接读 agent_runs.user_message_id 稳定 FK。
  //
  // 历史背景：旧实现用 `created_at < target.created_at` 在 messages 表里查最近
  // 的 user 消息，但 PG `now()` 在同一事务内固定，正常"发送一问一答"事务里
  // user 与 assistant 会拥有相同的 created_at，启发式会错误返回空。
  //
  // 当前数据模型约束（init.sql）：`agent_runs.user_message_id` 为 NOT NULL FK
  // → messages(id)。任何由本系统产生的 assistant 消息必有对应 Run，所以唯一
  // 权威关联是 agent_runs.user_message_id。
  //
  // 不再做"created_at / xmin / id"时序启发式兜底：
  //   - 时序启发式无法稳定指向唯一一条 user，且在并发生改/历史数据/数据迁移
  //     等场景下会指向错误的 user message，污染上下文；
  //   - 兜底会掩盖数据完整性 bug（"assistant 没有对应 Run"是异常，不是正常
  //     路径），应让其显式失败，便于定位修复，而不是被静默掩盖。
  //
  // 若确实需要支持历史无 Run 数据（例如旧库从其它系统导入而来），必须先做
  // 一轮可验证的数据回填（写明关联规则 + 人工审阅 + 抽样验证），不要在
  // service 层用启发式伪造关联。
  const priorRunRow = await client.query<{ user_message_id: string }>(
    `SELECT user_message_id FROM agent_runs
      WHERE workspace_id = $1
        AND assistant_message_id = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.workspaceId, input.assistantMessageId],
  );
  const priorRun = priorRunRow.rows[0];
  if (!priorRun) {
    logRequest('warn', {
      msg: 'regenerate 命中无 agent_runs 关联的 assistant message；视为数据完整性异常',
      workspaceId: input.workspaceId,
      assistantMessageId: input.assistantMessageId,
    });
    const e = new Error(
      '该 assistant 消息没有可识别的原始 user 消息（无对应 agent_runs 记录）。',
    ) as Error & { name: string };
    e.name = 'NotFoundError';
    throw e;
  }
  const userMessage = { id: priorRun.user_message_id };

  // 4. 同会话活跃 Run 检查（与 createUserMessageAndQueuedRun 同样的 partial unique 兜底）。
  const activeRow = await client.query<{ id: string }>(
    `SELECT id FROM agent_runs
      WHERE conversation_id = $1
        AND workspace_id = $2
        AND status IN ('queued', 'running', 'waiting_approval')
      LIMIT 1`,
    [conv.id, input.workspaceId],
  );
  if (activeRow.rows.length > 0) {
    const e = new Error('该会话已有正在进行的生成，请等待完成或停止后再试。') as Error & { name: string };
    e.name = 'ConversationActiveRunError';
    throw e;
  }

  // 5. 把旧 assistant message 收敛到 stopped 终态（保留 content 与 citations）。
  await client.query(
    `UPDATE messages
        SET status = 'stopped',
            current_run_id = NULL,
            updated_at = now()
      WHERE id = $1 AND workspace_id = $2`,
    [target.id, input.workspaceId],
  );

  // 6. 新建 assistant pending 消息。
  const asstRow = await client.query<{ id: string }>(
    `INSERT INTO messages (workspace_id, conversation_id, role, content, citations, status, current_run_id)
     VALUES ($1, $2, 'assistant', '', '[]'::jsonb, 'pending', NULL)
     RETURNING id`,
    [input.workspaceId, conv.id],
  );
  const newAssistantMessageId = asstRow.rows[0]!.id;

  // 7. queued run；同会话 partial unique 冲突 → PG 抛 23505 → 上层翻译 409。
  let runRow: RunRow;
  try {
    runRow = await createQueuedRun(
      {
        workspaceId: input.workspaceId,
        conversationId: conv.id,
        assistantMessageId: newAssistantMessageId,
        userMessageId: userMessage.id,
        agentId: conv.agent_id,
        provider: input.provider,
        model: input.model,
        requestId,
        createdBy: input.userId,
      },
      client,
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      const e = new Error('该会话已有正在进行的生成，请等待完成或停止后再试。') as Error & { name: string };
      e.name = 'ConversationActiveRunError';
      throw e;
    }
    throw err;
  }

  // 8. run-queued 事件 + NOTIFY
  const runEventId = await insertRunEvent(client, {
    runId: runRow.id,
    workspaceId: input.workspaceId,
    type: 'run-queued',
    payload: { assistantMessageId: newAssistantMessageId },
  });

  // 9. 回填 newAssistantMessage.current_run_id。
  await client.query(
    `UPDATE messages SET current_run_id = $2 WHERE id = $1`,
    [newAssistantMessageId, runRow.id],
  );

  // 10. 更新会话 updated_at。
  await client.query(
    `UPDATE conversations SET updated_at = now()
      WHERE id = $1 AND workspace_id = $2`,
    [conv.id, input.workspaceId],
  );

  return {
    conversation: { id: conv.id, agentId: conv.agent_id },
    userMessage: { id: userMessage.id },
    oldAssistantMessage: { id: target.id },
    assistantMessage: { id: newAssistantMessageId },
    run: runRow,
    runEventId,
  };
}