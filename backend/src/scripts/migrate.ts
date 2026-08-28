import 'dotenv/config';
import { Pool } from 'pg';
import { ensureSchema, InitSchemaDriftError } from '../test-utils/schema-init.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL 未配置。');

const pool = new Pool({ connectionString: url });
try {
  const result = await ensureSchema(pool);
  if (result.action === 'applied') {
    console.log(`applied  checksum=${result.checksum}`);
  } else if (result.action === 'skipped') {
    console.log(`skipped  checksum=${result.checksum}`);
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
