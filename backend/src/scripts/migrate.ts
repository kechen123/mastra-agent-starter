import 'dotenv/config';
import { Pool } from 'pg';
import { config } from '../config.js';
import { ensureSchema, InitSchemaDriftError } from '../test-utils/schema-init.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL 未配置。');

// PR-4.1 §8.4.1 整改：`ragEnabled` 必须由当前部署配置显式传入；
// bootstrap 在 init 事务内决定是否创建 `vector` 扩展与是否执行
// init.sql 末尾的 RAG 条件块。Core-only 部署 ragEnabled=false →
// pgvector 不被加载、embedding_profiles/document_embeddings 不存在。
const ragEnabled = config.ragEnabled;

const pool = new Pool({ connectionString: url });
try {
  const result = await ensureSchema(pool, { ragEnabled });
  if (result.action === 'applied') {
    console.log(`applied  checksum=${result.checksum}  rag_enabled=${ragEnabled}`);
  } else if (result.action === 'skipped') {
    console.log(`skipped  checksum=${result.checksum}  rag_enabled=${ragEnabled}`);
  } else {
    throw new InitSchemaDriftError(result.expected, result.actual);
  }
} catch (error) {
  if (error instanceof InitSchemaDriftError) {
    console.error(`drift    expected=${error.expected} actual=${error.actual}`);
    console.error('init.sql 已被修改但 DB 仍是旧 schema；删库重建即可。');
    process.exitCode = 2;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}