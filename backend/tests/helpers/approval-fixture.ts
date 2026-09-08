import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { __resetTestPool, __setTestPool } from '../../src/infrastructure/database/pool.js';
import { _resetSystemResolverCacheForTesting, _setMastraFacadeForTesting } from '../../src/modules/tool-policy/state-machine.js';

/** Real PostgreSQL fixture; only its randomly named schema is removed. */
export async function withApprovalFixture(test: (pool: Pool) => Promise<void>): Promise<void> {
  if (process.env.RUN_PG_TOOL_POLICY !== '1') {
    console.log('SKIP: PostgreSQL fixture requires RUN_PG_TOOL_POLICY=1');
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');
  const target = new URL(connectionString);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/xuanshu') {
    throw new Error('Approval fixture requires the authorized local xuanshu database');
  }
  const schema = `approval_fixture_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await pool.query(readFileSync(new URL('../../database/init.sql', import.meta.url), 'utf8'));
    __setTestPool(pool);
    _resetSystemResolverCacheForTesting();
    const unexpectedSdkCall = async (): Promise<never> => { throw new Error('DB-only fixture called SDK'); };
    _setMastraFacadeForTesting({ approveToolCall: unexpectedSdkCall, declineToolCall: unexpectedSdkCall, listSuspendedRuns: unexpectedSdkCall });
    await test(pool);
  } finally {
    _setMastraFacadeForTesting(null);
    _resetSystemResolverCacheForTesting();
    __resetTestPool();
    await pool.end();
    if (created && /^approval_fixture_[a-f0-9]{32}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

export async function seedApprovalRun(pool: Pool): Promise<{ workspaceId: string; userId: string; runId: string }> {
  const username = `fixture_${randomUUID()}`;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users(username, username_normalized, password_hash) VALUES($1,$1,'!disabled!') RETURNING id`, [username]);
  const workspace = await pool.query<{ id: string }>(`INSERT INTO workspaces(kind,name) VALUES('shared','approval fixture') RETURNING id`);
  const workspaceId = workspace.rows[0]!.id;
  const userId = user.rows[0]!.id;
  const conversation = await pool.query<{ id: string }>(
    `INSERT INTO conversations(workspace_id,agent_id,title) VALUES($1,'general-chat','fixture') RETURNING id`, [workspaceId]);
  const message = await pool.query<{ id: string }>(
    `INSERT INTO messages(conversation_id,workspace_id,role,content,status) VALUES($1,$2,'assistant','','pending') RETURNING id`,
    [conversation.rows[0]!.id, workspaceId]);
  const run = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs(workspace_id,conversation_id,assistant_message_id,agent_id,provider,model,status,request_id,created_by)
     VALUES($1,$2,$3,'general-chat','test','test','waiting_approval',$4,$5) RETURNING id`,
    [workspaceId, conversation.rows[0]!.id, message.rows[0]!.id, randomUUID(), userId]);
  return { workspaceId, userId, runId: run.rows[0]!.id };
}
