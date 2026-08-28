import {
  ResourceNotFoundError,
  CrossWorkspaceAccessError,
} from '../../server/error-mapping.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { getAgentDefinition } from '../../core/agent/registry.js';
import type { Citation } from '../citations/types.js';
import { isExecutionActive } from '../../core/execution/controller.js';
import type { ConversationDetail, ConversationSummary, CreateConversationInput, Message, UpdateConversationInput } from './types.js';

const DEFAULT_TITLE = '新对话';

export async function createConversation(workspaceId: string, input: CreateConversationInput): Promise<ConversationDetail> {
  const agentId = input.agentId;
  const def = getAgentDefinition(agentId);
  if (!def) {
    throw new Error('Agent 不存在。');
  }

  let knowledgeBaseId: string | null = input.knowledgeBaseId ?? null;
  // 未声明 knowledgeBase 能力的 Agent 不能携带知识库引用——这里强制为 null，
  // 保持会话自洽。该规则由能力矩阵驱动，取代原先按 agentId 硬编码的写法。
  if (!def.capabilities.knowledgeBase) {
    knowledgeBaseId = null;
  } else if (knowledgeBaseId) {
    // 工作区内知识库存在性校验：跨 workspace 访问必须以 404 暴露（不区分"不存在"与"越权"）。
    const kbResult = await getDatabasePool().query<{ id: string }>(
      'SELECT id FROM knowledge_bases WHERE id = $1 AND workspace_id = $2',
      [knowledgeBaseId, workspaceId],
    );
    if (kbResult.rows.length === 0) {
      throw new CrossWorkspaceAccessError();
    }
  }

  const result = await getDatabasePool().query<
    { id: string; title: string; agent_id: string; knowledge_base_id: string | null; created_at: Date; updated_at: Date }
  >(
    `INSERT INTO conversations (workspace_id, title, agent_id, knowledge_base_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, title, agent_id, knowledge_base_id, created_at, updated_at`,
    [workspaceId, input.title ?? DEFAULT_TITLE, agentId, knowledgeBaseId],
  );
  return toDetail(result.rows[0]!);
}

export async function listConversations(workspaceId: string): Promise<ConversationSummary[]> {
  const result = await getDatabasePool().query<
    { id: string; title: string; agent_id: string; knowledge_base_id: string | null; knowledge_base_name: string | null; created_at: Date; updated_at: Date }
  >(
    `SELECT c.id, c.title, c.agent_id, c.knowledge_base_id,
            kb.name AS knowledge_base_name,
            c.created_at, c.updated_at
     FROM conversations c
     LEFT JOIN knowledge_bases kb ON kb.id = c.knowledge_base_id
     WHERE c.workspace_id = $1
     ORDER BY c.updated_at DESC, c.created_at DESC`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    agentId: row.agent_id,
    knowledgeBaseId: row.knowledge_base_id,
    knowledgeBaseName: row.knowledge_base_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function getConversationWithMessages(
  workspaceId: string,
  conversationId: string,
): Promise<{ conversation: ConversationDetail; messages: Message[] } | null> {
  const pool = getDatabasePool();
  const convResult = await pool.query<
    { id: string; title: string; agent_id: string; knowledge_base_id: string | null; knowledge_base_name: string | null; created_at: Date; updated_at: Date }
  >(
    `SELECT c.id, c.title, c.agent_id, c.knowledge_base_id,
            kb.name AS knowledge_base_name,
            c.created_at, c.updated_at
     FROM conversations c
     LEFT JOIN knowledge_bases kb ON kb.id = c.knowledge_base_id
     WHERE c.id = $1 AND c.workspace_id = $2`,
    [conversationId, workspaceId],
  );
  const row = convResult.rows[0];
  // 查询类：跨 workspace 0 行返 null，不抛错（与其他 query 语义一致）。
  if (!row) return null;

  const msgResult = await pool.query<
    { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }
  >(
    `SELECT id, conversation_id, role, content, citations, status, created_at
     FROM messages
     WHERE conversation_id = $1 AND workspace_id = $2
     ORDER BY created_at ASC`,
    [conversationId, workspaceId],
  );

  const orphanedIds: string[] = [];
  const messages: Message[] = msgResult.rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role as 'user' | 'assistant',
    content: r.content,
    citations: (r.citations as Citation[]) ?? [],
    status: r.status as Message['status'],
    createdAt: r.created_at.toISOString(),
  })).map((m) => {
    if ((m.status === 'pending' || m.status === 'streaming') && !isExecutionActive(m.id)) {
      orphanedIds.push(m.id);
      return { ...m, status: 'failed' as const, content: m.content || '生成已中断，请重试。' };
    }
    return m;
  });

  if (orphanedIds.length > 0) {
    await pool.query(
      `UPDATE messages SET status = 'failed', content = COALESCE(NULLIF(content, ''), '生成已中断，请重试。'), citations = '[]'::jsonb WHERE id = ANY($1)`,
      [orphanedIds],
    );
  }

  return { conversation: toDetail(row), messages };
}

export async function updateConversation(
  workspaceId: string,
  conversationId: string,
  input: UpdateConversationInput,
): Promise<ConversationDetail> {
  const pool = getDatabasePool();

  const currentResult = await pool.query<
    { id: string; title: string; agent_id: string; knowledge_base_id: string | null; created_at: Date; updated_at: Date }
  >(
    `SELECT id, title, agent_id, knowledge_base_id, created_at, updated_at
       FROM conversations
      WHERE id = $1 AND workspace_id = $2`,
    [conversationId, workspaceId],
  );
  const current = currentResult.rows[0];
  if (!current) throw new ResourceNotFoundError('会话不存在。');

  const finalAgentId = input.agentId ?? current.agent_id;
  let finalKnowledgeBaseId = input.knowledgeBaseId !== undefined ? input.knowledgeBaseId : current.knowledge_base_id;

  const def = getAgentDefinition(finalAgentId);
  if (!def) {
    throw new Error('Agent 不存在。');
  }

  if (!def.capabilities.knowledgeBase) {
    finalKnowledgeBaseId = null;
  } else if (finalKnowledgeBaseId) {
    // 工作区内知识库存在性校验：跨 workspace 访问必须以 404 暴露。
    const kbResult = await pool.query<{ id: string }>(
      'SELECT id FROM knowledge_bases WHERE id = $1 AND workspace_id = $2',
      [finalKnowledgeBaseId, workspaceId],
    );
    if (kbResult.rows.length === 0) {
      throw new CrossWorkspaceAccessError();
    }
  }

  const fields: string[] = ['updated_at = now()'];
  const values: (string | null)[] = [];

  if (input.title !== undefined) {
    values.push(input.title);
    fields.push(`title = $${values.length}`);
  }
  if (input.agentId !== undefined) {
    values.push(finalAgentId);
    fields.push(`agent_id = $${values.length}`);
  }
  if (input.knowledgeBaseId !== undefined || (!def.capabilities.knowledgeBase && current.knowledge_base_id !== null) || (def.capabilities.knowledgeBase && finalKnowledgeBaseId !== current.knowledge_base_id)) {
    values.push(finalKnowledgeBaseId);
    fields.push(`knowledge_base_id = $${values.length}`);
  }

  values.push(conversationId);
  values.push(workspaceId);
  const result = await pool.query<
    { id: string; title: string; agent_id: string; knowledge_base_id: string | null; created_at: Date; updated_at: Date }
  >(
    `UPDATE conversations SET ${fields.join(', ')}
      WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
      RETURNING id, title, agent_id, knowledge_base_id, created_at, updated_at`,
    values,
  );
  if (result.rowCount === 0) {
    throw new ResourceNotFoundError('会话不存在。');
  }
  return toDetail(result.rows[0]!);
}

export async function deleteConversation(workspaceId: string, conversationId: string): Promise<boolean> {
  const result = await getDatabasePool().query(
    'DELETE FROM conversations WHERE id = $1 AND workspace_id = $2',
    [conversationId, workspaceId],
  );
  if (result.rowCount === 0) {
    throw new ResourceNotFoundError('会话不存在。');
  }
  return true;
}

export async function saveUserMessage(workspaceId: string, conversationId: string, content: string): Promise<Message> {
  // 父 conversation 校验：跨 workspace 访问 → 抛 CrossWorkspaceAccessError（404）。
  const convCheck = await getDatabasePool().query<{ id: string }>(
    'SELECT id FROM conversations WHERE id = $1 AND workspace_id = $2',
    [conversationId, workspaceId],
  );
  if (convCheck.rows.length === 0) {
    throw new CrossWorkspaceAccessError();
  }

  const result = await getDatabasePool().query<
    { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }
  >(
    `INSERT INTO messages (workspace_id, conversation_id, role, content, status)
     VALUES ($1, $2, 'user', $3, 'completed')
     RETURNING id, conversation_id, role, content, citations, status, created_at`,
    [workspaceId, conversationId, content],
  );
  return toMessage(result.rows[0]!);
}

export async function saveAssistantMessage(
  workspaceId: string,
  conversationId: string,
  content: string,
  citations: Citation[],
  status: 'completed' | 'stopped' | 'failed',
): Promise<Message> {
  // 父 conversation 校验：与 saveUserMessage 一致，跨 workspace → 404。
  const convCheck = await getDatabasePool().query<{ id: string }>(
    'SELECT id FROM conversations WHERE id = $1 AND workspace_id = $2',
    [conversationId, workspaceId],
  );
  if (convCheck.rows.length === 0) {
    throw new CrossWorkspaceAccessError();
  }

  const result = await getDatabasePool().query<
    { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }
  >(
    `INSERT INTO messages (workspace_id, conversation_id, role, content, citations, status)
     VALUES ($1, $2, 'assistant', $3, $4, $5)
     RETURNING id, conversation_id, role, content, citations, status, created_at`,
    [workspaceId, conversationId, content, JSON.stringify(citations), status],
  );
  return toMessage(result.rows[0]!);
}

export async function createAssistantPending(workspaceId: string, conversationId: string): Promise<Message> {
  // 父 conversation 校验：跨 workspace → 404。
  const convCheck = await getDatabasePool().query<{ id: string }>(
    'SELECT id FROM conversations WHERE id = $1 AND workspace_id = $2',
    [conversationId, workspaceId],
  );
  if (convCheck.rows.length === 0) {
    throw new CrossWorkspaceAccessError();
  }

  const result = await getDatabasePool().query<
    { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }
  >(
    `INSERT INTO messages (workspace_id, conversation_id, role, content, citations, status)
     VALUES ($1, $2, 'assistant', '', '[]'::jsonb, 'pending')
     RETURNING id, conversation_id, role, content, citations, status, created_at`,
    [workspaceId, conversationId],
  );
  await touchConversation(workspaceId, conversationId);
  return toMessage(result.rows[0]!);
}

export async function updateAssistantStreaming(workspaceId: string, assistantMessageId: string): Promise<void> {
  // internal: rowCount may be 0 —— 状态推进写，命中即写入，不命中即幂等通过。
  await getDatabasePool().query(
    `UPDATE messages SET status = 'streaming'
      WHERE id = $1 AND workspace_id = $2`,
    [assistantMessageId, workspaceId],
  );
}

export async function finalizeAssistant(
  workspaceId: string,
  assistantMessageId: string,
  content: string,
  citations: Citation[],
  status: 'completed' | 'stopped' | 'failed',
): Promise<Message> {
  const result = await getDatabasePool().query<
    { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }
  >(
    `UPDATE messages
       SET content = $3, citations = $4, status = $5
     WHERE id = $1 AND workspace_id = $2
     RETURNING id, conversation_id, role, content, citations, status, created_at`,
    [assistantMessageId, workspaceId, content, JSON.stringify(citations), status],
  );
  if (result.rowCount === 0) {
    throw new ResourceNotFoundError('消息不存在。');
  }
  const msg = toMessage(result.rows[0]!);
  await touchConversation(workspaceId, msg.conversationId);
  return msg;
}

export async function resetAssistantForRetry(workspaceId: string, assistantMessageId: string): Promise<void> {
  // internal idempotent —— 仅当目标消息仍处于 pending/streaming 才生效；
  // 已被 finalize 的消息保持原状（与 convergeAssistantToFailed 相同的收敛语义）。
  await getDatabasePool().query(
    `UPDATE messages SET content = '', citations = '[]'::jsonb, status = 'pending'
      WHERE id = $1 AND workspace_id = $2`,
    [assistantMessageId, workspaceId],
  );
}

/**
 * 把一条仍处于 pending/streaming 的助手消息收敛为 failed，避免 setup 阶段
 * 失败后该消息永久悬挂。仅对尚未进入终态的行生效——已被并发 finalize 的行
 * 不会被改写。返回被收敛的行数（0 或 1）。
 */
export async function convergeAssistantToFailed(workspaceId: string, messageId: string): Promise<number> {
  // internal idempotent —— 行不存在或已终态均视作正常收敛结果（0 行）。
  const result = await getDatabasePool().query(
    `UPDATE messages
       SET status = 'failed',
           content = COALESCE(NULLIF(content, ''), '生成已中断，请重试。'),
           citations = '[]'::jsonb
     WHERE id = $1 AND workspace_id = $2 AND status IN ('pending', 'streaming')`,
    [messageId, workspaceId],
  );
  return result.rowCount ?? 0;
}

/**
 * 读取一条消息的当前快照（content / citations / status），供 regenerate
 * 失败路径做原子回退。
 */
export async function getMessageSnapshot(
  workspaceId: string,
  messageId: string,
): Promise<{ content: string; citations: Citation[]; status: string } | null> {
  const r = await getDatabasePool().query<{ content: string; citations: unknown; status: string }>(
    `SELECT content, citations, status FROM messages WHERE id = $1 AND workspace_id = $2`,
    [messageId, workspaceId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    content: row.content,
    citations: (row.citations as Citation[]) ?? [],
    status: row.status,
  };
}

/**
 * 将一条消息按快照恢复。仅当该消息当前仍处于 pending/streaming 时才写入——
 * 已被并发 finalize 的行保持原状，避免覆盖已完成/已停止/已失败的事实。
 */
export async function restoreAssistantFromSnapshot(
  workspaceId: string,
  messageId: string,
  snapshot: { content: string; citations: Citation[]; status: string },
): Promise<void> {
  const recoverable = ['pending', 'streaming'];
  if (!recoverable.includes(snapshot.status)) return;
  // internal compensating write —— 回退路径上的"撤销式"写入；行已被 finalize 时
  // 不强制要求命中，让上层 regenerate 流程自己处理观察。
  await getDatabasePool().query(
    `UPDATE messages
       SET content = $3, citations = $4, status = $5
     WHERE id = $1 AND workspace_id = $2 AND status IN ('pending', 'streaming')`,
    [messageId, workspaceId, snapshot.content, JSON.stringify(snapshot.citations), snapshot.status],
  );
}

export async function getLastAssistantMessage(workspaceId: string, conversationId: string): Promise<Message | null> {
  const result = await getDatabasePool().query<
    { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }
  >(
    `SELECT id, conversation_id, role, content, citations, status, created_at
     FROM messages
     WHERE conversation_id = $1 AND workspace_id = $2 AND role = 'assistant'
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId, workspaceId],
  );
  return result.rows[0] ? toMessage(result.rows[0]) : null;
}

export async function touchConversation(workspaceId: string, conversationId: string): Promise<void> {
  // internal: rowCount may be 0 —— updated_at 推进写，命中即更新，不命中即静默通过。
  await getDatabasePool().query(
    'UPDATE conversations SET updated_at = now() WHERE id = $1 AND workspace_id = $2',
    [conversationId, workspaceId],
  );
}

export async function updateConversationTitle(workspaceId: string, conversationId: string, title: string): Promise<void> {
  // internal helper for maybeUpdateTitle —— 由 maybeUpdateTitleFromFirstMessage 独占调用，
  // 不命中即放弃；外层调用点不感知 0/1 区别。
  await getDatabasePool().query(
    'UPDATE conversations SET title = $1 WHERE id = $2 AND workspace_id = $3',
    [title, conversationId, workspaceId],
  );
}

export async function maybeUpdateTitleFromFirstMessage(
  workspaceId: string,
  conversationId: string,
  messageContent: string,
): Promise<void> {
  const pool = getDatabasePool();
  // internal idempotent —— 仅在标题仍为默认占位时改写；跨 workspace 一律按"未命中"语义处理。
  const conv = await pool.query<{ title: string }>(
    'SELECT title FROM conversations WHERE id = $1 AND workspace_id = $2',
    [conversationId, workspaceId],
  );
  if (conv.rows[0]?.title !== DEFAULT_TITLE) return;
  const trimmed = messageContent.trim();
  const newTitle = trimmed.slice(0, 30) || DEFAULT_TITLE;
  await updateConversationTitle(workspaceId, conversationId, newTitle);
}

function toDetail(row: { id: string; title: string; agent_id: string; knowledge_base_id: string | null; knowledge_base_name?: string | null; created_at: Date; updated_at: Date }): ConversationDetail {
  return {
    id: row.id,
    title: row.title,
    agentId: row.agent_id,
    knowledgeBaseId: row.knowledge_base_id,
    knowledgeBaseName: row.knowledge_base_name ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toMessage(row: { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    citations: (row.citations as Citation[]) ?? [],
    status: row.status as Message['status'],
    createdAt: row.created_at.toISOString(),
  };
}
