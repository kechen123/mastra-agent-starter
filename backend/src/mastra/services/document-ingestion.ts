import type { PoolClient } from 'pg';
import { getDatabasePool } from '../../database/pool.js';
import { embedTexts } from '../rag/embedding-service.js';
import {
  createDocument,
  getDocument,
  updateDocumentStatus,
  type DocumentSummary,
} from './documents.js';

const CHUNK_SIZE = 1_000;
const CHUNK_OVERLAP = 150;
const INSERT_BATCH_SIZE = 50;

interface TextChunk {
  content: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  heading?: string;
}

export class DocumentIngestionError extends Error {
  constructor(readonly documentId: string) {
    super('文档处理失败。');
  }
}

export async function ingestTextDocument(input: {
  knowledgeBaseId: string;
  name: string;
  type: 'txt' | 'md';
  bytes: Uint8Array;
}): Promise<DocumentSummary> {
  const document = await createDocument({
    knowledgeBaseId: input.knowledgeBaseId,
    name: input.name,
    type: input.type,
    size: input.bytes.byteLength,
  });

  try {
    await updateDocumentStatus(document.id, 'parsing');
    const text = normalizeText(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes));
    if (!text) throw new Error('文件内容不能为空。');

    await updateDocumentStatus(document.id, 'chunking');
    const chunks = splitText(text);
    if (chunks.length === 0) throw new Error('未能从文件中生成有效文本块。');

    await updateDocumentStatus(document.id, 'embedding');
    const embeddings = await embedTexts(chunks.map((chunk) => chunk.content));
    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding 返回数量不匹配：期望 ${chunks.length}，实际 ${embeddings.length}`);
    }

    await replaceChunksAndComplete(document, chunks, embeddings);
    return (await getDocument(document.id))!;
  } catch (error) {
    const errorMessage = toSafeErrorMessage(error);
    console.error(`文档 ${document.id} 入库失败：`, error);
    await updateDocumentStatus(document.id, 'failed', errorMessage);
    throw new DocumentIngestionError(document.id);
  }
}

async function replaceChunksAndComplete(
  document: DocumentSummary,
  chunks: TextChunk[],
  embeddings: number[][],
): Promise<void> {
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM document_chunks WHERE document_id = $1', [document.id]);
    for (let index = 0; index < chunks.length; index += INSERT_BATCH_SIZE) {
      const chunkBatch = chunks.slice(index, index + INSERT_BATCH_SIZE);
      const embeddingBatch = embeddings.slice(index, index + INSERT_BATCH_SIZE);
      await insertChunkBatch(client, document, chunkBatch, embeddingBatch);
    }
    await client.query(`
      UPDATE documents
      SET status = 'completed', error_message = NULL, updated_at = now()
      WHERE id = $1
    `, [document.id]);
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
  document: DocumentSummary,
  chunks: TextChunk[],
  embeddings: number[][],
): Promise<void> {
  const values: unknown[] = [];
  const rows = chunks.map((chunk, index) => {
    const offset = index * 6;
    const metadata = {
      documentName: document.name,
      documentType: document.type,
      startChar: chunk.startChar,
      endChar: chunk.endChar,
      ...(chunk.heading ? { heading: chunk.heading } : {}),
    };
    values.push(
      document.knowledgeBaseId,
      document.id,
      chunk.content,
      chunk.chunkIndex,
      JSON.stringify(metadata),
      toVectorLiteral(embeddings[index]!),
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::jsonb, $${offset + 6}::vector)`;
  });
  await client.query(`
    INSERT INTO document_chunks (knowledge_base_id, document_id, content, chunk_index, metadata, embedding)
    VALUES ${rows.join(', ')}
  `, values);
}

function normalizeText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitText(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const targetEnd = Math.min(start + CHUNK_SIZE, text.length);
    const end = targetEnd === text.length ? targetEnd : findBoundary(text, start, targetEnd);
    const content = text.slice(start, end).trim();
    if (content) {
      chunks.push({
        content,
        chunkIndex: chunks.length,
        startChar: start,
        endChar: end,
        heading: findHeading(text, start),
      });
    }
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

function findBoundary(text: string, start: number, targetEnd: number): number {
  const minimumBoundary = start + Math.floor(CHUNK_SIZE * 0.5);
  const candidates = ['\n\n', '\n', '。', '！', '？', '；'];
  let best = -1;
  let boundaryLength = 0;
  for (const delimiter of candidates) {
    const index = text.lastIndexOf(delimiter, targetEnd - 1);
    if (index >= minimumBoundary && index > best) {
      best = index;
      boundaryLength = delimiter.length;
    }
  }
  return best >= 0 ? best + boundaryLength : targetEnd;
}

function findHeading(text: string, position: number): string | undefined {
  const headingAtChunkStart = text.slice(position).match(/^#{1,6}\s+([^\n]+)/)?.[1]?.trim();
  if (headingAtChunkStart) return headingAtChunkStart;
  const preceding = text.slice(0, position);
  const matches = [...preceding.matchAll(/^#{1,6}\s+(.+)$/gm)];
  const heading = matches.at(-1)?.[1]?.trim();
  return heading || undefined;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

function toSafeErrorMessage(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? `：${error.cause.message}` : '';
  const message = error instanceof Error ? `${error.message}${cause}` : '未知处理错误。';
  return message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgresql://[REDACTED]@')
    .slice(0, 1_000);
}
