/**
 * 本地人工验收辅助：写入一个不可从系统提示推断的资料，再从独立的
 * Daymind Retrieval 入口检索。不会创建 Conversation，因此可验证资料层
 * 不依赖聊天上下文。
 */
import { getDatabasePool } from '../infrastructure/database/pool.js';
import '../agents/index.js';
import { embedQuery } from '../modules/knowledge/rag/embedding-service.js';
import { createConversation } from '../modules/conversations/service.js';
import { searchDaymindSources } from '../modules/sources/retrieval.js';
import { recordTextSource } from '../modules/sources/service.js';

const pool = getDatabasePool();

try {
  const workspace = await pool.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM sources ORDER BY created_at DESC LIMIT 1',
  );
  const workspaceId = workspace.rows[0]?.workspace_id;
  if (!workspaceId) throw new Error('没有可用于跨会话验证的工作区。');

  const source = await recordTextSource(
    workspaceId,
    '测试代号：青石-4729。Daymind 下一阶段内部代号叫 Aurora Pine。记录下来。',
    '跨会话随机检索验证',
  );
  const graph = await pool.query<{
    document_id: string;
    chunk_id: string;
    embedding_id: string;
  }>(
    `SELECT d.id AS document_id, c.id AS chunk_id, e.id AS embedding_id
       FROM documents d
       JOIN document_chunks c ON c.document_id = d.id
       JOIN document_embeddings e ON e.chunk_id = c.id
      WHERE d.source_id = $1
      ORDER BY d.created_at DESC
      LIMIT 1`,
    [source.id],
  );
  const retrieved = await searchDaymindSources(workspaceId, '我之前记录的测试代号是什么？');
  const queryEmbedding = await embedQuery('我之前记录的测试代号是什么？');
  const rawCandidates = await pool.query<{
    source_id: string;
    chunk_id: string;
    distance: string;
  }>(
    `SELECT d.source_id, e.chunk_id, e.embedding <=> $1::vector AS distance
       FROM document_embeddings e
       JOIN documents d ON d.id = e.document_id
      WHERE e.workspace_id = $2
        AND d.source_id IS NOT NULL
      ORDER BY e.embedding <=> $1::vector
      LIMIT 5`,
    [`[${queryEmbedding.join(',')}]`, workspaceId],
  );
  const sourceDocuments = await pool.query<{
    document_id: string;
    knowledge_base_id: string;
    profile_id: string;
    chunk_count: number;
  }>(
    `SELECT d.id AS document_id, d.knowledge_base_id, e.profile_id,
            count(c.id)::int AS chunk_count
       FROM documents d
       LEFT JOIN document_chunks c ON c.document_id = d.id
       LEFT JOIN document_embeddings e ON e.document_id = d.id
      WHERE d.source_id = $1
      GROUP BY d.id, e.profile_id
      ORDER BY d.created_at`,
    [source.id],
  );
  const hit = retrieved.citations.find((item) => item.sourceId === source.id)
    ?? retrieved.citations[0];
  const conversationA = await createConversation(workspaceId, {
    title: '验收 A：记录资料', agentId: 'daymind', knowledgeBaseId: null,
  });
  const conversationB = await createConversation(workspaceId, {
    title: '验收 B：无历史查询', agentId: 'daymind', knowledgeBaseId: null,
  });
  const conversationC = await createConversation(workspaceId, {
    title: '验收 C：无历史查询', agentId: 'daymind', knowledgeBaseId: null,
  });
  const [answerB, answerC] = await Promise.all([
    searchDaymindSources(workspaceId, 'Daymind 是做什么的？'),
    searchDaymindSources(workspaceId, '我之前记录过关于长期记忆的什么内容？'),
  ]);

  console.log(JSON.stringify({
    sourceId: source.id,
    documentId: graph.rows[0]?.document_id,
    chunkId: graph.rows[0]?.chunk_id,
    embeddingId: graph.rows[0]?.embedding_id,
    knowledgeBaseId: retrieved.knowledgeBaseId,
    rawCandidates: rawCandidates.rows.map((row) => ({
      sourceId: row.source_id,
      chunkId: row.chunk_id,
      distance: Number(row.distance),
      score: 1 - Number(row.distance),
    })),
    sourceDocuments: sourceDocuments.rows,
    hit: hit && {
      sourceId: hit.sourceId,
      sourceTitle: hit.sourceTitle,
      sourceType: hit.sourceType,
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      score: hit.score,
      distance: hit.distance,
      snippet: hit.content,
    },
    conversations: [conversationA, conversationB, conversationC].map((conversation) => ({
      id: conversation.id,
      agentId: conversation.agentId,
      knowledgeBaseId: conversation.knowledgeBaseId,
    })),
    conversationBHits: answerB.citations.map((citation) => ({
      sourceId: citation.sourceId, chunkId: citation.chunkId, score: citation.score,
    })),
    conversationCHits: answerC.citations.map((citation) => ({
      sourceId: citation.sourceId, chunkId: citation.chunkId, score: citation.score,
    })),
  }, null, 2));
} finally {
  await pool.end();
}
