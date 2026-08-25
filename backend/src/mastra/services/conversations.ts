import { getDatabasePool } from '../../database/pool.js';
import { getAgentDefinition } from '../agents/registry.js';
import { getKnowledgeBase } from './knowledge-bases.js';
import type { Citation } from '../../types.js';
import { isExecutionActive } from './execution.js';

export interface ConversationSummary {
  id: string;
  title: string;
  agentId: string;
  knowledgeBaseId: string | null;
  knowledgeBaseName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail {
  id: string;
  title: string;
  agentId: string;
  knowledgeBaseId: string | null;
  knowledgeBaseName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  status: 'pending' | 'streaming' | 'completed' | 'stopped' | 'failed';
  createdAt: string;
}

export interface CreateConversationInput {
  title?: string;
  agentId: string;
  knowledgeBaseId?: string | null;
}

export interface UpdateConversationInput {
  title?: string;
  agentId?: string;
  knowledgeBaseId?: string | null;
}

const DEFAULT_TITLE = '新对话';

export async function createConversation(input: CreateConversationInput): Promise<ConversationDetail> {
  const agentId = input.agentId;
  if (!getAgentDefinition(agentId)) {
    throw new Error('Agent 不存在。');
  }

  let knowledgeBaseId: string | null = input.knowledgeBaseId ?? null;
  if (agentId === 'general-chat') {
    knowledgeBaseId = null;
  }
  if (agentId === 'knowledge-base' && knowledgeBaseId) {
    if (!(await getKnowledgeBase(knowledgeBaseId))) {
      throw new Error('知识库不存在。');
    }
  }

  const result = await getDatabasePool().query<
    { id: string; title: string; agent_id: string; knowledge_base_id: string | null; created_at: Date; updated_at: Date }
  >(
    `INSERT INTO conversations (title, agent_id, knowledge_base_id)
     VALUES ($1, $2, $3)
     RETURNING id, title, agent_id, knowledge_base_id, created_at, updated_at`,
    [input.title ?? DEFAULT_TITLE, agentId, knowledgeBaseId],
  );
  return toDetail(result.rows[0]!);
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const result = await getDatabasePool().query<
    { id: string; title: string; agent_id: string; knowledge_base_id: string | null; knowledge_base_name: string | null; created_at: Date; updated_at: Date }
  >(
    `SELECT c.id, c.title, c.agent_id, c.knowledge_base_id,
            kb.name AS knowledge_base_name,
            c.created_at, c.updated_at
     FROM conversations c
     LEFT JOIN knowledge_bases kb ON kb.id = c.knowledge_base_id
     ORDER BY c.updated_at DESC, c.created_at DESC`,
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

export async function getConversationWithMessages(conversationId: string): Promise<{ conversation: ConversationDetail; messages: Message[] }> {
  const pool = getDatabasePool();
  const convResult = await pool.query<
    { id: string; title: string; agent_id: string; knowledge_base_id: string | null; knowledge_base_name: string | null; created_at: Date; updated_at: Date }
  >(
    `SELECT c.id, c.title, c.agent_id, c.knowledge_base_id,
            kb.name AS knowledge_base_name,
            c.created_at, c.updated_at
     FROM conversations c
     LEFT JOIN knowledge_bases kb ON kb.id = c.knowledge_base_id
     WHERE c.id = $1`,
    [conversationId],
  );
  const row = convResult.rows[0];
  if (!row) throw new Error('会话不存在。');

  const msgResult = await pool.query<
    { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }
  >(
    `SELECT id, conversation_id, role, content, citations, status, created_at
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId],
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

export async function updateConversation(conversationId: string, input: UpdateConversationInput): Promise<ConversationDetail> {
  const pool = getDatabasePool();

  const currentResult = await pool.query<
    { id: string; title: string; agent_id: string; knowledge_base_id: string | null; created_at: Date; updated_at: Date }
  >(
    `SELECT id, title, agent_id, knowledge_base_id, created_at, updated_at FROM conversations WHERE id = $1`,
    [conversationId],
  );
  const current = currentResult.rows[0];
  if (!current) throw new Error('会话不存在。');

  const finalAgentId = input.agentId ?? current.agent_id;
  let finalKnowledgeBaseId = input.knowledgeBaseId !== undefined ? input.knowledgeBaseId : current.knowledge_base_id;

  if (!getAgentDefinition(finalAgentId)) {
    throw new Error('Agent 不存在。');
  }

  if (finalAgentId === 'general-chat') {
    finalKnowledgeBaseId = null;
  }
  if (finalAgentId === 'knowledge-base' && finalKnowledgeBaseId) {
    if (!(await getKnowledgeBase(finalKnowledgeBaseId))) {
      throw new Error('知识库不存在。');
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
  if (input.knowledgeBaseId !== undefined || (finalAgentId === 'general-chat' && current.knowledge_base_id !== null)) {
    values.push(finalKnowledgeBaseId);
    fields.push(`knowledge_base_id = $${values.length}`);
  }

  values.push(conversationId);
  const result = await pool.query<
    { id: string; title: string; agent_id: string; knowledge_base_id: string | null; created_at: Date; updated_at: Date }
  >(
    `UPDATE conversations SET ${fields.join(', ')} WHERE id = $${values.length}
     RETURNING id, title, agent_id, knowledge_base_id, created_at, updated_at`,
    values,
  );
  return toDetail(result.rows[0]!);
}

export async function deleteConversation(conversationId: string): Promise<boolean> {
  const result = await getDatabasePool().query('DELETE FROM conversations WHERE id = $1', [conversationId]);
  return (result.rowCount ?? 0) > 0;
}

export async function saveUserMessage(conversationId: string, content: string): Promise<Message> {
  const result = await getDatabasePool().query<
    { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }
  >(
    `INSERT INTO messages (conversation_id, role, content, status)
     VALUES ($1, 'user', $2, 'completed')
     RETURNING id, conversation_id, role, content, citations, status, created_at`,
    [conversationId, content],
  );
  return toMessage(result.rows[0]!);
}

export async function saveAssistantMessage(
  conversationId: string,
  content: string,
  citations: Citation[],
  status: 'completed' | 'stopped' | 'failed',
): Promise<Message> {
  const result = await getDatabasePool().query<
    { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }
  >(
    `INSERT INTO messages (conversation_id, role, content, citations, status)
     VALUES ($1, 'assistant', $2, $3, $4)
     RETURNING id, conversation_id, role, content, citations, status, created_at`,
    [conversationId, content, JSON.stringify(citations), status],
  );
  return toMessage(result.rows[0]!);
}

export async function createAssistantPending(conversationId: string): Promise<Message> {
  const result = await getDatabasePool().query<
    { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }
  >(
    `INSERT INTO messages (conversation_id, role, content, citations, status)
     VALUES ($1, 'assistant', '', '[]'::jsonb, 'pending')
     RETURNING id, conversation_id, role, content, citations, status, created_at`,
    [conversationId],
  );
  await touchConversation(conversationId);
  return toMessage(result.rows[0]!);
}

export async function updateAssistantStreaming(assistantMessageId: string): Promise<void> {
  await getDatabasePool().query(
    `UPDATE messages SET status = 'streaming' WHERE id = $1`,
    [assistantMessageId],
  );
}

export async function finalizeAssistant(
  assistantMessageId: string,
  content: string,
  citations: Citation[],
  status: 'completed' | 'stopped' | 'failed',
): Promise<Message> {
  const result = await getDatabasePool().query<
    { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }
  >(
    `UPDATE messages
     SET content = $2, citations = $3, status = $4
     WHERE id = $1
     RETURNING id, conversation_id, role, content, citations, status, created_at`,
    [assistantMessageId, content, JSON.stringify(citations), status],
  );
  const msg = toMessage(result.rows[0]!);
  await touchConversation(msg.conversationId);
  return msg;
}

export async function resetAssistantForRetry(assistantMessageId: string): Promise<void> {
  await getDatabasePool().query(
    `UPDATE messages SET content = '', citations = '[]'::jsonb, status = 'pending' WHERE id = $1`,
    [assistantMessageId],
  );
}

export async function getLastAssistantMessage(conversationId: string): Promise<Message | null> {
  const result = await getDatabasePool().query<
    { id: string; conversation_id: string; role: string; content: string; citations: unknown; status: string; created_at: Date }
  >(
    `SELECT id, conversation_id, role, content, citations, status, created_at
     FROM messages
     WHERE conversation_id = $1 AND role = 'assistant'
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId],
  );
  return result.rows[0] ? toMessage(result.rows[0]) : null;
}

export async function touchConversation(conversationId: string): Promise<void> {
  await getDatabasePool().query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
}

export async function updateConversationTitle(conversationId: string, title: string): Promise<void> {
  await getDatabasePool().query('UPDATE conversations SET title = $1 WHERE id = $2', [title, conversationId]);
}

export async function maybeUpdateTitleFromFirstMessage(conversationId: string, messageContent: string): Promise<void> {
  const pool = getDatabasePool();
  const conv = await pool.query<{ title: string }>('SELECT title FROM conversations WHERE id = $1', [conversationId]);
  if (conv.rows[0]?.title !== DEFAULT_TITLE) return;
  const trimmed = messageContent.trim();
  const newTitle = trimmed.slice(0, 30) || DEFAULT_TITLE;
  await updateConversationTitle(conversationId, newTitle);
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
