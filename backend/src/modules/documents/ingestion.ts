import type { PoolClient } from 'pg';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { CrossWorkspaceAccessError } from '../../server/error-mapping.js';
import {
  getDocument,
  updateDocumentStatus,
  type DocumentSummary,
} from './service.js';
import { UnsupportedDocumentTypeError } from './parsers/types.js';
import { MinerUClientError, MinerUParseError } from './parsers/mineru-client.js';

const INSERT_BATCH_SIZE = 50;

/**
 * 已嵌入完成的待入库文本块 —— caller 负责 parse / split / embed，
 * 本函数只负责把 chunks 写入 document_chunks 并把 document 标记为 completed。
 * INSERT 时的 workspace_id 从通过校验的父 document 行复制而来，不接受调用方传入。
 */
export interface IngestionChunk {
  content: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  embedding: number[];
  parser: string;
  sourceFormat: string;
  heading?: string;
}

export class DocumentIngestionError extends Error {
  constructor(readonly documentId: string) {
    super('文档处理失败。');
  }
}

export async function ingestDocument(
  workspaceId: string,
  documentId: string,
  chunks: IngestionChunk[],
): Promise<DocumentSummary> {
  // 父 document 校验：跨 workspace 访问 → 抛 CrossWorkspaceAccessError（404）。
  // 同时把 document.workspace_id / knowledge_base_id 拷出来用于后续 INSERT，
  // 避免重复 SELECT 且保证写出的 workspace_id 与父行一致。
  const docCheck = await getDatabasePool().query<{
    id: string;
    workspace_id: string;
    knowledge_base_id: string;
    name: string;
    type: string;
  }>(
    `SELECT id, workspace_id, knowledge_base_id, name, type
       FROM documents
      WHERE id = $1 AND workspace_id = $2`,
    [documentId, workspaceId],
  );
  if (docCheck.rows.length === 0) {
    throw new CrossWorkspaceAccessError();
  }
  const document = {
    id: docCheck.rows[0]!.id,
    workspaceId: docCheck.rows[0]!.workspace_id,
    knowledgeBaseId: docCheck.rows[0]!.knowledge_base_id,
    name: docCheck.rows[0]!.name,
    type: docCheck.rows[0]!.type,
  };

  try {
    await replaceChunksAndComplete(workspaceId, document, chunks);
  } catch (error) {
    const errorMessage = toSafeErrorMessage(error);
    console.error(`文档 ${document.id} 入库失败：`, error);
    // 失败路径上的状态收敛：document 已被 SELECT 锁定在 workspace 内，
    // 失败状态写入不应抛出 ResourceNotFoundError；吞掉次级错误，让
    // primary DocumentIngestionError 上抛。
    await updateDocumentStatus(workspaceId, document.id, 'failed', errorMessage).catch(() => { /* swallow */ });
    throw new DocumentIngestionError(document.id);
  }
  return (await getDocument(workspaceId, document.id))!;
}

async function replaceChunksAndComplete(
  workspaceId: string,
  document: {
    id: string;
    workspaceId: string;
    knowledgeBaseId: string;
    name: string;
    type: string;
  },
  chunks: IngestionChunk[],
): Promise<void> {
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM document_chunks WHERE document_id = $1 AND workspace_id = $2',
      [document.id, workspaceId],
    );
    for (let index = 0; index < chunks.length; index += INSERT_BATCH_SIZE) {
      const chunkBatch = chunks.slice(index, index + INSERT_BATCH_SIZE);
      await insertChunkBatch(client, document, chunkBatch);
    }
    await client.query(`
      UPDATE documents
      SET status = 'completed', error_message = NULL, updated_at = now()
      WHERE id = $1 AND workspace_id = $2
    `, [document.id, workspaceId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertChunkBatch(
  client: PoolClient,
  document: {
    id: string;
    workspaceId: string;
    knowledgeBaseId: string;
    name: string;
    type: string;
  },
  chunks: IngestionChunk[],
): Promise<void> {
  const values: unknown[] = [];
  const rows = chunks.map((chunk, index) => {
    const offset = index * 7;
    const metadata = {
      documentName: document.name,
      documentType: document.type,
      startChar: chunk.startChar,
      endChar: chunk.endChar,
      parser: chunk.parser,
      sourceFormat: chunk.sourceFormat,
      ...(chunk.heading ? { heading: chunk.heading } : {}),
    };
    values.push(
      document.workspaceId,
      document.knowledgeBaseId,
      document.id,
      chunk.content,
      chunk.chunkIndex,
      JSON.stringify(metadata),
      toVectorLiteral(chunk.embedding),
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::jsonb, $${offset + 7}::vector)`;
  });
  await client.query(`
    INSERT INTO document_chunks (workspace_id, knowledge_base_id, document_id, content, chunk_index, metadata, embedding)
    VALUES ${rows.join(', ')}
  `, values);
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

function toSafeErrorMessage(error: unknown): string {
  if (error instanceof UnsupportedDocumentTypeError) {
    return error.message;
  }

  // MinerU 相关错误使用受控固定文本，不暴露内部 cause、response body、网络细节或 stack
  if (error instanceof MinerUClientError || error instanceof MinerUParseError) {
    return error.message;
  }

  const message = error instanceof Error ? error.message : '未知处理错误。';
  if (message.startsWith('Embedding ')) {
    return '文档向量化服务暂时不可用。';
  }
  return message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgresql://[REDACTED]@')
    .slice(0, 1_000);
}
