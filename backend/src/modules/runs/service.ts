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
 *   2. UPDATE messages SET status='stopped', content=COALESCE(partialContent)
 *      WHERE id = assistant_message_id AND workspace_id。
 *   3. INSERT agent_run_events(type='run-stopped', payload.contentLength)
 *      + NOTIFY。
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
    partialContent: string;
  },
): Promise<
  | { stopped: true; run: RunRow; eventId: number; contentLength: number }
  | { stopped: false; run: RunRow; reason: 'already_terminal' }
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
    `SELECT id, workspace_id, conversation_id, assistant_message_id, agent_id,
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

  // 3. 已是终态 → 不覆写，返回 already_terminal
  if (run.status === 'stopped' || run.status === 'completed' || run.status === 'failed') {
    return { stopped: false, run, reason: 'already_terminal' };
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

  // 5. 收敛 message（条件 WHERE）
  await client.query(
    `UPDATE messages
        SET status = 'stopped',
            content = COALESCE(NULLIF($3, ''), ''),
            citations = '[]'::jsonb
      WHERE id = $1
        AND workspace_id = $2
        AND status IN ('pending','streaming')`,
    [args.assistantMessageId, args.workspaceId, args.partialContent],
  );

  // 6. 写 run-stopped 事件
  const eventId = await insertRunEvent(client, {
    runId: run.id,
    workspaceId: args.workspaceId,
    type: 'run-stopped',
    payload: { contentLength: args.partialContent.length },
  });

  logRequest('info', {
    msg: 'Run stopped transactionally',
    workspaceId: args.workspaceId,
    runId: run.id,
    assistantMessageId: args.assistantMessageId,
    eventId,
  });

  return { stopped: true, run, eventId, contentLength: args.partialContent.length };
}