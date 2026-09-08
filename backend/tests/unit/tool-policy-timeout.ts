/** Real DB-only expiration and defensive inflight reconciliation. */
import assert from 'node:assert/strict';
import { withApprovalFixture, seedApprovalRun } from '../helpers/approval-fixture.js';
import { createApprovalRequest, getApprovalRequestById } from '../../src/modules/tool-policy/repository.js';
import { expireApproval, reconcileInflightApprovals } from '../../src/modules/tool-policy/state-machine.js';

await withApprovalFixture(async (pool) => {
  const create = async (expiresAt: string) => {
    const seed = await seedApprovalRun(pool);
    const row = await createApprovalRequest({
      ...seed, requesterId: seed.userId, toolId: 'calculator', toolCallId: 'call',
      inputsHash: 'hash', inputsSummary: {}, expiresAt,
    });
    return { ...seed, row };
  };
  const expired = await create(new Date(Date.now() - 1000).toISOString());
  const result = await expireApproval({ workspaceId: expired.workspaceId, approvalId: expired.row.id });
  assert.equal(result.kind, 'expired');
  const stored = await getApprovalRequestById(expired.workspaceId, expired.row.id);
  assert.equal(stored?.status, 'expired');
  assert.equal(stored?.resolverId, '00000000-0000-0000-0000-0000000000a1');
  assert.equal(stored?.mastraResumeStartedAt, null);
  const user = await pool.query('SELECT username_normalized FROM app_users WHERE id=$1', [stored?.resolverId]);
  assert.equal(user.rows[0].username_normalized, 'system-approval-worker');
  const future = await create(new Date(Date.now() + 60000).toISOString());
  assert.equal((await expireApproval({ workspaceId: future.workspaceId, approvalId: future.row.id })).kind, 'not_pending_yet');
  assert.equal((await expireApproval({ workspaceId: future.workspaceId, approvalId: expired.row.id })).kind, 'not_found');
  const stale = await create(new Date(Date.now() + 60000).toISOString());
  const active = await create(new Date(Date.now() + 60000).toISOString());
  for (const [fixture, ttl] of [[stale, -60000], [active, 60000]] as const) {
    await pool.query("UPDATE tool_approval_requests SET status='approving', decision='approved', lease_owner='other-worker', lease_expires_at=now()+($2::int * interval '1 millisecond') WHERE id=$1", [fixture.row.id, ttl]);
  }
  assert.deepEqual(await reconcileInflightApprovals(), { scanned: 2, dbOnlyTakenOver: 1, leaseActive: 1, notInflight: 0, errors: 0 });
  assert.equal((await getApprovalRequestById(stale.workspaceId, stale.row.id))?.status, 'declined');
  assert.equal((await getApprovalRequestById(active.workspaceId, active.row.id))?.status, 'approving');
  console.log('timeout: expiration / platform FK / not-yet / isolation / stale-vs-active lease passed');
});
