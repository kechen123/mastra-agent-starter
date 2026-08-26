import { Pool } from 'pg';

let pool: Pool | undefined;

export function getDatabasePool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL 未配置。');
  }
  pool = new Pool({ connectionString });
  return pool;
}