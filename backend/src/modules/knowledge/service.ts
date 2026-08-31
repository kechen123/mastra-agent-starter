import { ResourceNotFoundError } from '../../server/error-mapping.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';

export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseDetail extends KnowledgeBaseSummary {
  chunkCount: number;
}

interface KnowledgeBaseRow {
  id: string;
  name: string;
  description: string | null;
  document_count: number;
  chunk_count?: number;
  created_at: Date;
  updated_at: Date;
}

const summaryFields = `
  kb.id,
  kb.name,
  kb.description,
  COUNT(DISTINCT d.id)::int AS document_count,
  kb.created_at,
  kb.updated_at
`;

const summaryJoins = `
  FROM knowledge_bases kb
  LEFT JOIN documents d ON d.knowledge_base_id = kb.id
`;

export async function listKnowledgeBases(workspaceId: string): Promise<KnowledgeBaseSummary[]> {
  // 查询类：按 workspace 过滤；0 行返空数组，不抛错。
  const result = await getDatabasePool().query<KnowledgeBaseRow>(`
    SELECT ${summaryFields}
    ${summaryJoins}
    WHERE kb.workspace_id = $1
    GROUP BY kb.id
    ORDER BY kb.updated_at DESC, kb.created_at DESC
  `, [workspaceId]);
  return result.rows.map(toSummary);
}

export async function createKnowledgeBase(
  workspaceId: string,
  input: { name: string; description?: string },
): Promise<KnowledgeBaseSummary> {
  // KB 无父资源——直接 INSERT 带 workspace_id。
  const result = await getDatabasePool().query<KnowledgeBaseRow>(`
    WITH created AS (
      INSERT INTO knowledge_bases (workspace_id, name, description)
      VALUES ($1, $2, $3)
      RETURNING id, name, description, created_at, updated_at
    )
    SELECT created.id, created.name, created.description, 0::int AS document_count,
      created.created_at, created.updated_at
    FROM created
  `, [workspaceId, input.name, input.description ?? null]);
  return toSummary(result.rows[0]!);
}

export async function getKnowledgeBase(
  workspaceId: string,
  kbId: string,
): Promise<KnowledgeBaseDetail | null> {
  // 查询类：跨 workspace 0 行返 null，与 listKnowledgeBases 语义一致。
  const result = await getDatabasePool().query<KnowledgeBaseRow>(`
    SELECT ${summaryFields}, COUNT(c.id)::int AS chunk_count
    ${summaryJoins}
    LEFT JOIN document_chunks c ON c.knowledge_base_id = kb.id
    WHERE kb.id = $1 AND kb.workspace_id = $2
    GROUP BY kb.id
  `, [kbId, workspaceId]);
  const row = result.rows[0];
  return row ? { ...toSummary(row), chunkCount: row.chunk_count ?? 0 } : null;
}

export async function updateKnowledgeBase(
  workspaceId: string,
  kbId: string,
  input: { name?: string; description?: string },
): Promise<KnowledgeBaseDetail> {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  if (input.name !== undefined) {
    values.push(input.name);
    fields.push(`name = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    fields.push(`description = $${values.length}`);
  }
  values.push(kbId);
  values.push(workspaceId);
  const result = await getDatabasePool().query<{ id: string }>(`
    UPDATE knowledge_bases
    SET ${fields.join(', ')}, updated_at = now()
    WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
    RETURNING id
  `, values);
  // 用户资源写：跨 workspace 写入 rowCount===0 抛 ResourceNotFoundError（404）。
  if (result.rowCount === 0) {
    throw new ResourceNotFoundError('知识库不存在。');
  }
  return (await getKnowledgeBase(workspaceId, kbId)) as KnowledgeBaseDetail;
}

export async function deleteKnowledgeBase(workspaceId: string, kbId: string): Promise<true> {
  // 用户资源写：依赖 ON DELETE CASCADE 清理 documents/document_chunks（PR-1.2 schema），不手动级联。
  const result = await getDatabasePool().query(
    'DELETE FROM knowledge_bases WHERE id = $1 AND workspace_id = $2',
    [kbId, workspaceId],
  );
  if (result.rowCount === 0) {
    throw new ResourceNotFoundError('知识库不存在。');
  }
  return true;
}

function toSummary(row: KnowledgeBaseRow): KnowledgeBaseSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    documentCount: row.document_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
