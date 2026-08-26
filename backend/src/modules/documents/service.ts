import { getDatabasePool } from '../../infrastructure/database/pool.js';

export type DocumentStatus = 'uploaded' | 'parsing' | 'chunking' | 'embedding' | 'completed' | 'failed';

export interface DocumentSummary {
  id: string;
  knowledgeBaseId: string;
  name: string;
  type: string;
  size: number;
  status: DocumentStatus;
  errorMessage: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

interface DocumentRow {
  id: string;
  knowledge_base_id: string;
  name: string;
  type: string;
  size: string | number;
  status: DocumentStatus;
  error_message: string | null;
  chunk_count: number;
  created_at: Date;
  updated_at: Date;
}

const documentFields = `
  d.id,
  d.knowledge_base_id,
  d.name,
  d.type,
  d.size,
  d.status,
  d.error_message,
  COUNT(c.id)::int AS chunk_count,
  d.created_at,
  d.updated_at
`;

const documentJoins = `
  FROM documents d
  LEFT JOIN document_chunks c ON c.document_id = d.id
`;

export async function createDocument(input: {
  knowledgeBaseId: string;
  name: string;
  type: string;
  size: number;
}): Promise<DocumentSummary> {
  const result = await getDatabasePool().query<DocumentRow>(`
    WITH created AS (
      INSERT INTO documents (knowledge_base_id, name, type, size, status)
      VALUES ($1, $2, $3, $4, 'uploaded')
      RETURNING id, knowledge_base_id, name, type, size, status, error_message, created_at, updated_at
    )
    SELECT created.*, 0::int AS chunk_count FROM created
  `, [input.knowledgeBaseId, input.name, input.type, input.size]);
  return toDocument(result.rows[0]!);
}

export async function listDocuments(knowledgeBaseId: string): Promise<DocumentSummary[]> {
  const result = await getDatabasePool().query<DocumentRow>(`
    SELECT ${documentFields}
    ${documentJoins}
    WHERE d.knowledge_base_id = $1
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `, [knowledgeBaseId]);
  return result.rows.map(toDocument);
}

export async function getDocument(id: string): Promise<DocumentSummary | null> {
  const result = await getDatabasePool().query<DocumentRow>(`
    SELECT ${documentFields}
    ${documentJoins}
    WHERE d.id = $1
    GROUP BY d.id
  `, [id]);
  return result.rows[0] ? toDocument(result.rows[0]) : null;
}

export async function updateDocumentStatus(
  id: string,
  status: DocumentStatus,
  errorMessage: string | null = null,
): Promise<void> {
  await getDatabasePool().query(`
    UPDATE documents
    SET status = $2, error_message = $3, updated_at = now()
    WHERE id = $1
  `, [id, status, errorMessage]);
}

export async function deleteDocument(id: string): Promise<boolean> {
  const result = await getDatabasePool().query('DELETE FROM documents WHERE id = $1', [id]);
  return result.rowCount === 1;
}

function toDocument(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    name: row.name,
    type: row.type,
    size: Number(row.size),
    status: row.status,
    errorMessage: row.error_message,
    chunkCount: row.chunk_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}