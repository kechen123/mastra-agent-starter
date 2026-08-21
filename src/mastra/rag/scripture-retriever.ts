import type { Citation } from '../../types.js';
import { embedQuery } from './embedding-service.js';
import { ensureScriptureIndex, SCRIPTURE_INDEX, scriptureVector } from '../vector.js';

export async function searchScripture(query: string, topK = 5): Promise<Citation[]> {
  await ensureScriptureIndex();
  const embedding = await embedQuery(query);
  const results = await scriptureVector.query({
    indexName: SCRIPTURE_INDEX,
    queryVector: embedding,
    topK,
  });

  return results.map((result) => {
    const metadata = result.metadata as Record<string, unknown>;
    return {
      chunkId: result.id,
      content: String(metadata.content ?? ''),
      title: String(metadata.title ?? ''),
      chapter: String(metadata.chapter ?? ''),
      author: asOptionalString(metadata.author),
      dynasty: asOptionalString(metadata.dynasty),
      category: String(metadata.category ?? ''),
      version: asOptionalString(metadata.version),
      type: String(metadata.type ?? 'scripture') as Citation['type'],
      originalWork: asOptionalString(metadata.originalWork),
      commentator: asOptionalString(metadata.commentator),
      source: String(metadata.source ?? ''),
      score: result.score,
    };
  });
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
