/** Local acceptance launcher: ephemeral password, dedicated account, no database reset. */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword } from '../infrastructure/auth/password.js';

if (process.env.RUN_LOCAL_APPROVAL_ACCEPTANCE !== '1') throw new Error('Explicit opt-in required');
const database = new URL(process.env.DATABASE_URL!);
if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.pathname !== '/xuanshu') throw new Error('Local xuanshu database required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const username = `e2e_${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('base64url');
await pool.query('INSERT INTO app_users (username, username_normalized, password_hash) VALUES ($1, $1, $2)', [username, hashPassword(password)]);
await pool.end();
Object.assign(process.env, {
  RUN_STAGING_TOOL_APPROVAL_E2E: '1',
  STAGING_E2E_BASE_URL: 'http://localhost:4111',
  STAGING_E2E_ORIGIN: process.env.AUTH_ALLOWED_ORIGIN ?? 'http://localhost:5173',
  STAGING_E2E_USERNAME: username,
  STAGING_E2E_PASSWORD: password,
  STAGING_APPROVAL_E2E_APPROVAL_TTL_MS: process.env.STAGING_APPROVAL_E2E_APPROVAL_TTL_MS ?? '30000',
});
await import('./staging-tool-approval-e2e.js');
