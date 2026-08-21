import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MDocument } from '@mastra/rag';
import { Pool } from 'pg';
import { embedTexts } from '../mastra/rag/embedding-service.js';
import { ensureScriptureIndex, SCRIPTURE_INDEX, scriptureVector } from '../mastra/vector.js';

const metadata = {
  title: '道德经',
  author: '老子（传）',
  dynasty: '先秦',
  category: '先秦道家',
  version: '王弼本（测试摘录）',
  type: 'scripture',
  source: '项目内置测试文本；正式导入前须补充可核验的版本与来源。',
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing DATABASE_URL');
  const content = await readFile(resolve('data/seed/daodejing-wangbi-sample.md'), 'utf8');
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const work = await client.query<{ id: string }>(
      `SELECT id FROM works WHERE title = $1 AND version = $2 AND type = $3 LIMIT 1`,
      [metadata.title, metadata.version, metadata.type],
    );
    const workId = work.rows[0]?.id ?? (await client.query<{ id: string }>(
      `INSERT INTO works (title, author, dynasty, category, version, type, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [metadata.title, metadata.author, metadata.dynasty, metadata.category, metadata.version, metadata.type, metadata.source],
    )).rows[0].id;

    const chapters = splitChapters(content);
    const allChunks: Array<{ chapter: string; chapterId: string; text: string }> = [];
    for (const [ordinal, chapter] of chapters.entries()) {
      const chapterRow = await client.query<{ id: string }>(
        `INSERT INTO chapters (work_id, name, ordinal, original_text, normalized_text)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (work_id, name) DO UPDATE SET original_text = EXCLUDED.original_text, normalized_text = EXCLUDED.normalized_text
         RETURNING id`,
        [workId, chapter.name, ordinal + 1, chapter.text, chapter.text],
      );
      const document = MDocument.fromText(chapter.text);
      const chunks = await document.chunk({ strategy: 'recursive', maxSize: 500, overlap: 60 });
      allChunks.push(...chunks.map((chunk) => ({ chapter: chapter.name, chapterId: chapterRow.rows[0].id, text: chunk.text })));
    }

    await ensureScriptureIndex();
    const embeddings = await embedTexts(allChunks.map((chunk) => chunk.text));
    await scriptureVector.upsert({
      indexName: SCRIPTURE_INDEX,
      vectors: embeddings,
      deleteFilter: { workId },
      metadata: allChunks.map((chunk) => ({ ...metadata, workId, chapterId: chunk.chapterId, chapter: chunk.chapter, content: chunk.text })),
    });
    console.log(`已导入《道德经》测试摘录：${chapters.length} 章，${allChunks.length} 个检索块。`);
  } finally {
    client.release();
    await pool.end();
  }
}

function splitChapters(markdown: string): Array<{ name: string; text: string }> {
  const sections = markdown.trim().split(/^##\s+/m).filter(Boolean);
  return sections.map((section) => {
    const [name, ...body] = section.split('\n');
    return { name: name.trim(), text: body.join('\n').trim() };
  }).filter((chapter) => chapter.text.length > 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
