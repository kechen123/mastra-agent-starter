import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

/**
 * 轻量迁移执行器。
 *
 * 不引入额外依赖，复用已有 pg：
 * - `database/init.sql` 是首次安装的 0000 基线；
 * - `database/migrations/<序号>-<名称>.sql` 是后续只增不改的迁移；
 * - 已执行迁移的 checksum 一旦变化即停止，避免静默 schema 漂移。
 */
type Migration = { id: string; path: string; sql: string; checksum: string };

const DATABASE_DIR = resolve(import.meta.dirname, '../../database');
const MIGRATIONS_DIR = join(DATABASE_DIR, 'migrations');

function readMigration(id: string, path: string): Migration {
  const sql = readFileSync(path, 'utf-8');
  return {
    id,
    path,
    sql,
    checksum: createHash('sha256').update(sql).digest('hex'),
  };
}

function listMigrations(): Migration[] {
  const baselinePath = join(DATABASE_DIR, 'init.sql');
  const migrations: Migration[] = [readMigration('0000-initial-schema', baselinePath)];
  if (!existsSync(MIGRATIONS_DIR)) return migrations;

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{4,}[-_][a-z0-9][a-z0-9_-]*\.sql$/i.test(file))
    .sort();
  for (const file of files) {
    migrations.push(readMigration(file.replace(/\.sql$/i, ''), join(MIGRATIONS_DIR, file)));
  }
  return migrations;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL 未配置，无法执行数据库迁移。');
}

const pool = new Pool({ connectionString });
try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for (const migration of listMigrations()) {
    const existing = await pool.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE id = $1',
      [migration.id],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== migration.checksum) {
        throw new Error(`迁移 ${migration.id} 的内容已变化，拒绝继续执行。已执行迁移不得修改。`);
      }
      console.log(`跳过已执行迁移：${migration.id}`);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)',
        [migration.id, migration.checksum],
      );
      await client.query('COMMIT');
      console.log(`已执行迁移：${migration.id}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
