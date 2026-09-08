import assert from 'node:assert/strict';
import { withApprovalFixture, seedApprovalRun } from '../helpers/approval-fixture.js';
import * as repo from '../../src/modules/tool-policy/repository.js';
import { _setMastraFacadeForTesting } from '../../src/modules/tool-policy/state-machine.js';
import { runReconcileIndeterminateOnce } from '../../src/core/execution/run-executor.js';
import '../../src/tools/index.js';

await withApprovalFixture(async (pool) => {
  const create = async () => {
    const seed = await seedApprovalRun(pool);
    const row = await repo.createApprovalRequest({ ...seed, requesterId: seed.userId,
      toolId: 'calculator', toolCallId: 'call', inputsHash: 'hash', inputsSummary: {},
      expiresAt: new Date(Date.now() + 60000).toISOString() });
    await pool.query("UPDATE tool_approval_requests SET status='approved_resume_indeterminate', mastra_resume_started_at=now(), resume_attempts=1 WHERE id=$1", [row.id]);
    return { ...seed, row };
  };
  const fence = await create();
  const claim = (workerId: string) => repo.claimApprovalForReconcile({ workspaceId: fence.workspaceId,
    approvalId: fence.row.id, workerId, leaseMs: 60000, maxAttempts: 3 });
  assert.equal((await claim('worker-A')).kind, 'claimed');
  assert.equal((await claim('worker-B')).kind, 'lease_contended');
  await pool.query("UPDATE tool_approval_requests SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [fence.row.id]);
  assert.equal((await claim('worker-B')).kind, 'claimed');
  assert.notEqual((await repo.revertApprovalForReconcile({ workspaceId: fence.workspaceId, approvalId: fence.row.id, workerId: 'worker-A' })).kind, 'reverted');
  assert.notEqual((await repo.failApprovalReconcile({ workspaceId: fence.workspaceId, approvalId: fence.row.id, workerId: 'worker-A', resolverError: 'stale' })).kind, 'failed');
  assert.equal((await repo.getApprovalRequestById(fence.workspaceId, fence.row.id))?.leaseOwner, 'worker-B');
  assert.equal((await repo.revertApprovalForReconcile({ workspaceId: fence.workspaceId, approvalId: fence.row.id, workerId: 'worker-B' })).kind, 'reverted');

  const backoff = await create();
  await pool.query("UPDATE tool_approval_requests SET lease_owner=NULL,lease_expires_at=now()+interval '30 seconds' WHERE id=$1", [backoff.row.id]);
  assert.ok(!(await repo.listApprovalsPendingReconcile(3)).some((r) => r.id === backoff.row.id));
  assert.notEqual((await repo.claimApprovalForReconcile({ workspaceId: backoff.workspaceId, approvalId: backoff.row.id,
    workerId: 'early', leaseMs: 60000, maxAttempts: 3 })).kind, 'claimed');

  const nonIdempotent = await create();
  await pool.query("UPDATE tool_approval_requests SET tool_id='unknown-side-effect-tool',lease_expires_at=now()-interval '1 second' WHERE id=$1", [nonIdempotent.row.id]);
  let nonIdempotentSnapshotCalls = 0;
  const forbidden = async (): Promise<never> => { throw new Error('reconciler must not call resume SDK'); };
  _setMastraFacadeForTesting({ approveToolCall: forbidden, declineToolCall: forbidden,
    listSuspendedRuns: async () => { nonIdempotentSnapshotCalls++; return []; } });
  await runReconcileIndeterminateOnce();
  assert.equal(nonIdempotentSnapshotCalls, 0, 'unknown/non-idempotent tool must not query snapshot for automatic replay');
  assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [nonIdempotent.runId])).rows[0].status, 'failed');
  assert.match((await repo.getApprovalRequestById(nonIdempotent.workspaceId, nonIdempotent.row.id))!.resolverError!, /not registered as idempotent/);

  const atomic = await create();
  let snapshotCalls = 0;
  _setMastraFacadeForTesting({ approveToolCall: forbidden, declineToolCall: forbidden,
    listSuspendedRuns: async () => { snapshotCalls++; return []; } });
  await pool.query("CREATE FUNCTION reject_fixture_message_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected transaction failure'; END $$");
  await pool.query('CREATE TRIGGER reject_fixture_message_update BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION reject_fixture_message_update()');
  await runReconcileIndeterminateOnce();
  assert.equal(snapshotCalls, 1);
  const afterFailure = await repo.getApprovalRequestById(atomic.workspaceId, atomic.row.id);
  assert.equal(afterFailure?.resolverError, null, 'manual marker must roll back when message write fails');
  assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [atomic.runId])).rows[0].status, 'waiting_approval');
  await pool.query('DROP TRIGGER reject_fixture_message_update ON messages');
  await pool.query("UPDATE tool_approval_requests SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [atomic.row.id]);
  await runReconcileIndeterminateOnce();
  assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [atomic.runId])).rows[0].status, 'failed');
  assert.match((await repo.getApprovalRequestById(atomic.workspaceId, atomic.row.id))!.resolverError!, /^APPROVAL_RECONCILE_MANUAL_INTERVENTION_/);
  await runReconcileIndeterminateOnce();
  assert.equal(snapshotCalls, 2, 'terminal manual intervention must leave scan set');
  assert.notEqual((await repo.claimApprovalForReconcile({ workspaceId: atomic.workspaceId, approvalId: atomic.row.id,
    workerId: 'stale-scan', leaseMs: 60000, maxAttempts: 3 })).kind, 'claimed');
  console.log('reconcile safety: lease fencing / backoff / atomic rollback / terminal exclusion passed');
});
