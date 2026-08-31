import {
  ResourceNotFoundError,
  CrossWorkspaceAccessError,
} from '../../server/error-mapping.js';
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

export async function createDocument(
  workspaceId: string,
  knowledgeBaseId: string,
  input: {
    name: string;
    type: string;
    size: number;
  },
): Promise<DocumentSummary> {
  const pool = getDatabasePool();
  // 父 KB 不属于 workspace → 跨 workspace 访问，抛 CrossWorkspaceAccessError（404）。
  const kbCheck = await pool.query<{ id: string }>(
    'SELECT id FROM knowledge_bases WHERE id = $1 AND workspace_id = $2',
    [knowledgeBaseId, workspaceId],
  );
  if (kbCheck.rows.length === 0) {
    throw new CrossWorkspaceAccessError();
  }

  const result = await pool.query<DocumentRow>(`
    WITH created AS (
      INSERT INTO documents (workspace_id, knowledge_base_id, name, type, size, status)
      VALUES ($1, $2, $3, $4, $5, 'uploaded')
      RETURNING id, knowledge_base_id, name, type, size, status, error_message, created_at, updated_at
    )
    SELECT created.*, 0::int AS chunk_count FROM created
  `, [workspaceId, knowledgeBaseId, input.name, input.type, input.size]);
  return toDocument(result.rows[0]!);
}

export async function listDocuments(
  workspaceId: string,
  knowledgeBaseId?: string,
): Promise<DocumentSummary[]> {
  const filterKb = knowledgeBaseId ? 'AND d.knowledge_base_id = $2' : '';
  const result = await getDatabasePool().query<DocumentRow>(`
    SELECT ${documentFields}
    ${documentJoins}
    WHERE d.workspace_id = $1 ${filterKb}
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `, knowledgeBaseId ? [workspaceId, knowledgeBaseId] : [workspaceId]);
  return result.rows.map(toDocument);
}

export async function getDocument(workspaceId: string, docId: string): Promise<DocumentSummary | null> {
  const result = await getDatabasePool().query<DocumentRow>(`
    SELECT ${documentFields}
    ${documentJoins}
    WHERE d.id = $1 AND d.workspace_id = $2
    GROUP BY d.id
  `, [docId, workspaceId]);
  // 查询类：跨 workspace 0 行返 null（不抛错，与其他 query 语义一致）。
  return result.rows[0] ? toDocument(result.rows[0]) : null;
}

export async function updateDocumentStatus(
  workspaceId: string,
  docId: string,
  status: DocumentStatus,
  errorMessage: string | null = null,
): Promise<void> {
  const result = await getDatabasePool().query(`
    UPDATE documents
    SET status = $3, error_message = $4, updated_at = now()
    WHERE id = $1 AND workspace_id = $2
  `, [docId, workspaceId, status, errorMessage]);
  // 用户资源写：rowCount===0 → 抛 ResourceNotFoundError（404）。
  if (result.rowCount === 0) {
    throw new ResourceNotFoundError('文档不存在。');
  }
}

export async function deleteDocument(workspaceId: string, docId: string): Promise<boolean> {
  const result = await getDatabasePool().query(
    'DELETE FROM documents WHERE id = $1 AND workspace_id = $2',
    [docId, workspaceId],
  );
  // 用户资源写：rowCount===0 → 抛 ResourceNotFoundError（404）。
  if (result.rowCount === 0) {
    throw new ResourceNotFoundError('文档不存在。');
  }
  return true;
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
