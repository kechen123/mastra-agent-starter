/**
 * 本地人工验收辅助：覆盖 Daymind Composer 文件 / URL 录入路径。
 *
 * 跑在真实 PG + 真实 Embedding Provider；不创建 Conversation；不修改
 * 既有用户数据，但会在 sources / documents / document_chunks /
 * document_embeddings 表追加受控测试条目。
 *
 * 使用：
 *   cd backend && DATABASE_URL=postgres://...?safety-identifier=test_... \
 *     npx tsx src/scripts/verify-daymind-file-and-url.ts
 *
 * 默认仅在 `config.ragEnabled === true` 时执行；RAG 关闭时 SKIPPED。
 * 工作区取自现有 Source：SELECT workspace_id FROM sources LIMIT 1。
 * 测试 workspace 不存在时直接抛错（避免静默写入新 workspace）。
 *
 * 覆盖场景：
 *   1) TXT 文件 → 录入 + 跨会话检索；
 *   2) Markdown（含标题）→ 录入 + 跨会话检索；
 *   3) URL（example.com）→ 录入 + 检索；网络受限沙箱允许失败；
 *   4) 含明文凭据的 TXT → 必须被 SensitiveSourceRejectedError 拒绝；
 *   5) 同 contentHash 重复录入 → documents / chunks / embeddings
 *      行数前后必须一致（dedup 不应新增下游记录）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabasePool } from '../infrastructure/database/pool.js';
import { config } from '../config.js';
import { LocalFsStorage } from '../infrastructure/storage/local-storage.js';
import { setDocumentStorage } from '../infrastructure/storage/document-storage.js';
import {
  recordFileSource,
  recordUrlSource,
  SensitiveSourceRejectedError,
} from '../modules/sources/service.js';
import { searchDaymindSources } from '../modules/sources/retrieval.js';

if (!config.ragEnabled) {
  console.log('[verify-daymind-file-and-url] SKIPPED: config.ragEnabled=false（需要 RAG）');
  process.exit(0);
}

setDocumentStorage(new LocalFsStorage());
const pool = getDatabasePool();

interface CountRow { count: string }

try {
  const workspace = await pool.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM sources ORDER BY created_at DESC LIMIT 1',
  );
  const workspaceId = workspace.rows[0]?.workspace_id;
  if (!workspaceId) {
    throw new Error('没有 workspace；请先通过 recordTextSource / recordFileSource 创建至少一个 source。');
  }

  const results: Record<string, unknown> = {};

  // 1) TXT：含可被检索的代号。
  const txt = `测试项目代号：Silver River 8921\n此代号用于跨会话验收。`;
  const txtFile = Buffer.from(txt, 'utf-8');
  const txtSource = await recordFileSource(workspaceId, {
    filename: 'silver-river-8921.txt',
    mimeType: 'text/plain',
    buffer: txtFile,
  });
  const txtRetrieved = await searchDaymindSources(workspaceId, 'Silver River 代号是什么？');
  results.txt = {
    source: {
      id: txtSource.id,
      type: txtSource.type,
      chunkCount: txtSource.chunkCount,
    },
    citations: txtRetrieved.citations.map((c) => ({
      sourceId: c.sourceId,
      sourceTitle: c.sourceTitle,
      sourceType: c.sourceType,
      documentId: c.documentId,
      chunkId: c.chunkId,
      score: c.score,
      snippet: c.content.slice(0, 80),
    })),
  };

  // 2) Markdown：含标题，应被解析器识别为 heading 并进入 chunk metadata。
  const md = `# 项目代号\n\n项目代号是 Bronze Lotus 3340。`;
  const mdSource = await recordFileSource(workspaceId, {
    filename: 'bronze-lotus.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(md, 'utf-8'),
  });
  const mdRetrieved = await searchDaymindSources(workspaceId, 'Bronze Lotus 代号');
  results.md = {
    source: {
      id: mdSource.id,
      type: mdSource.type,
      chunkCount: mdSource.chunkCount,
    },
    citations: mdRetrieved.citations.map((c) => ({
      sourceId: c.sourceId,
      documentId: c.documentId,
      chunkId: c.chunkId,
      score: c.score,
      heading: c.heading,
    })),
  };

  // 3) URL：example.com 公开静态页。沙箱网络受限时允许失败——记录原因，
  //    不让脚本整体中断（避免本地验收在断网机器上无谓报错）。
  let urlSourceId: string | null = null;
  let urlCitations: unknown[] = [];
  let urlError: string | null = null;
  try {
    const urlSource = await recordUrlSource(workspaceId, 'https://example.com/');
    urlSourceId = urlSource.id;
    const urlRetrieved = await searchDaymindSources(workspaceId, 'example domain');
    urlCitations = urlRetrieved.citations.map((c) => ({
      sourceId: c.sourceId,
      documentId: c.documentId,
      chunkId: c.chunkId,
      score: c.score,
      url: c.url,
    }));
  } catch (err) {
    urlError = err instanceof Error ? err.message : String(err);
  }
  results.url = { sourceId: urlSourceId, citations: urlCitations, error: urlError };

  // 4) secret 文件：必须被 SensitiveSourceRejectedError 拒绝。捕获其它错误
  //    也保留下来，便于排查，但只有命中 SensitiveSourceRejectedError 时
  //    才算验收通过。`e.name` 比较放在结果里，便于在 JSON 里直接核对；
  //    `instanceof SensitiveSourceRejectedError` 给出运行时类型断言。
  let secretCaughtName: string | null = null;
  let secretCaughtMessage: string | null = null;
  let secretMatched: SensitiveSourceRejectedError | null = null;
  try {
    await recordFileSource(workspaceId, {
      filename: 'password-leak.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('password=abc123456', 'utf-8'),
    });
  } catch (err) {
    secretCaughtName = err instanceof Error ? err.name : 'UnknownError';
    secretCaughtMessage = err instanceof Error ? err.message : String(err);
    if (err instanceof SensitiveSourceRejectedError) secretMatched = err;
  }
  results.secret = {
    rejected: secretCaughtName === 'SensitiveSourceRejectedError',
    caughtAs: secretCaughtName,
    caughtMessage: secretCaughtMessage,
    matchedErrorClass: secretMatched !== null,
  };

  // 5) Dedup：同 contentHash 重复录入，不应新增 Document / Chunk / Embedding。
  const beforeDocs = await pool.query<CountRow>(
    'SELECT count(*)::text AS count FROM documents WHERE source_id = $1',
    [txtSource.id],
  );
  const beforeChunks = await pool.query<CountRow>(
    `SELECT count(*)::text AS count
       FROM document_chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE d.source_id = $1`,
    [txtSource.id],
  );
  const beforeEmbeddings = await pool.query<CountRow>(
    `SELECT count(*)::text AS count
       FROM document_embeddings e
       JOIN documents d ON d.id = e.document_id
      WHERE d.source_id = $1`,
    [txtSource.id],
  );
  await recordFileSource(workspaceId, {
    filename: 'silver-river-8921.txt',
    mimeType: 'text/plain',
    buffer: txtFile,
  });
  const afterDocs = await pool.query<CountRow>(
    'SELECT count(*)::text AS count FROM documents WHERE source_id = $1',
    [txtSource.id],
  );
  const afterChunks = await pool.query<CountRow>(
    `SELECT count(*)::text AS count
       FROM document_chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE d.source_id = $1`,
    [txtSource.id],
  );
  const afterEmbeddings = await pool.query<CountRow>(
    `SELECT count(*)::text AS count
       FROM document_embeddings e
       JOIN documents d ON d.id = e.document_id
      WHERE d.source_id = $1`,
    [txtSource.id],
  );
  const toCount = (row: CountRow | undefined): string => row?.count ?? '0';
  results.dedup = {
    documents: {
      before: toCount(beforeDocs.rows[0]),
      after: toCount(afterDocs.rows[0]),
      unchanged: toCount(beforeDocs.rows[0]) === toCount(afterDocs.rows[0]),
    },
    chunks: {
      before: toCount(beforeChunks.rows[0]),
      after: toCount(afterChunks.rows[0]),
      unchanged: toCount(beforeChunks.rows[0]) === toCount(afterChunks.rows[0]),
    },
    embeddings: {
      before: toCount(beforeEmbeddings.rows[0]),
      after: toCount(afterEmbeddings.rows[0]),
      unchanged: toCount(beforeEmbeddings.rows[0]) === toCount(afterEmbeddings.rows[0]),
    },
  };

  mkdirSync('verify-out', { recursive: true });
  writeFileSync(
    join('verify-out', 'daymind-file-and-url.json'),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));

  // 旁路断言：把硬性契约暴露在退出状态里，便于 CI / 验收一眼看出失败分支。
  interface DedupReport {
    documents: { unchanged: boolean };
    chunks: { unchanged: boolean };
    embeddings: { unchanged: boolean };
  }
  interface SecretReport { rejected: boolean }
  const dedup = results.dedup as DedupReport;
  const secret = results.secret as SecretReport;
  const dedupOk = dedup.documents.unchanged && dedup.chunks.unchanged && dedup.embeddings.unchanged;
  const secretOk = secret.rejected;
  if (!dedupOk || !secretOk) {
    console.error(
      `[verify-daymind-file-and-url] HARD ASSERT FAILED: dedupOk=${dedupOk}, secretOk=${secretOk}`,
    );
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
