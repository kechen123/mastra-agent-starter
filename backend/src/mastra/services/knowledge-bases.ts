import { getDatabasePool } from '../../database/pool.js';

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

export async function listKnowledgeBases(): Promise<KnowledgeBaseSummary[]> {
  const result = await getDatabasePool().query<KnowledgeBaseRow>(`
    SELECT ${summaryFields}
    ${summaryJoins}
    GROUP BY kb.id
    ORDER BY kb.updated_at DESC, kb.created_at DESC
  `);
  return result.rows.map(toSummary);
}

export async function createKnowledgeBase(input: { name: string; description?: string }): Promise<KnowledgeBaseSummary> {
  const result = await getDatabasePool().query<KnowledgeBaseRow>(`
    WITH created AS (
      INSERT INTO knowledge_bases (name, description)
      VALUES ($1, $2)
      RETURNING id, name, description, created_at, updated_at
    )
    SELECT created.id, created.name, created.description, 0::int AS document_count,
      created.created_at, created.updated_at
    FROM created
  `, [input.name, input.description ?? null]);
  return toSummary(result.rows[0]!);
}

export async function getKnowledgeBase(id: string): Promise<KnowledgeBaseDetail | null> {
  const result = await getDatabasePool().query<KnowledgeBaseRow>(`
    SELECT ${summaryFields}, COUNT(c.id)::int AS chunk_count
    ${summaryJoins}
    LEFT JOIN document_chunks c ON c.knowledge_base_id = kb.id
    WHERE kb.id = $1
    GROUP BY kb.id
  `, [id]);
  const row = result.rows[0];
  return row ? { ...toSummary(row), chunkCount: row.chunk_count ?? 0 } : null;
}

export async function updateKnowledgeBase(
  id: string,
  input: { name?: string; description?: string },
): Promise<KnowledgeBaseDetail | null> {
  const fields: string[] = [];
  const values: string[] = [];
  if (input.name !== undefined) {
    values.push(input.name);
    fields.push(`name = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    fields.push(`description = $${values.length}`);
  }
  values.push(id);
  const result = await getDatabasePool().query<{ id: string }>(`
    UPDATE knowledge_bases
    SET ${fields.join(', ')}, updated_at = now()
    WHERE id = $${values.length}
    RETURNING id
  `, values);
  return result.rows[0] ? getKnowledgeBase(id) : null;
}

export async function deleteKnowledgeBase(id: string): Promise<boolean> {
  const result = await getDatabasePool().query('DELETE FROM knowledge_bases WHERE id = $1', [id]);
  return result.rowCount === 1;
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
