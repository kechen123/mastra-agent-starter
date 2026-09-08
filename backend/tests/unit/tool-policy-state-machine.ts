/** Real production state-machine + isolated PostgreSQL schema; never invokes SDK. */
import assert from 'node:assert/strict';
import { withApprovalFixture, seedApprovalRun } from '../helpers/approval-fixture.js';
import { createApprovalRequest, getApprovalRequestById } from '../../src/modules/tool-policy/repository.js';
import { resolveApproval } from '../../src/modules/tool-policy/state-machine.js';

await withApprovalFixture(async (pool) => {
  for (const decision of ['approve', 'decline'] as const) {
    const seed = await seedApprovalRun(pool);
    const row = await createApprovalRequest({
      ...seed, requesterId: seed.userId, toolId: 'calculator', toolCallId: decision,
      inputsHash: 'hash', inputsSummary: {}, expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const status = decision === 'approve' ? 'approved' : 'declined';
    const outcome = await resolveApproval({ ...seed, approvalId: row.id, resolverId: seed.userId, decision });
    assert.equal(outcome.kind, status);
    const stored = await getApprovalRequestById(seed.workspaceId, row.id);
    assert.equal(stored?.status, status);
    assert.equal(stored?.resolverId, seed.userId);
    assert.ok(stored?.resolvedAt);
    assert.equal(stored?.mastraResumeStartedAt, null);
    assert.equal(stored?.leaseOwner, null);
    const run = await pool.query('SELECT status FROM agent_runs WHERE id=$1', [seed.runId]);
    assert.equal(run.rows[0].status, 'waiting_approval');
    assert.equal((await resolveApproval({ ...seed, approvalId: row.id, resolverId: seed.userId, decision })).kind, 'already_resolved');
    const other = await seedApprovalRun(pool);
    assert.equal((await resolveApproval({ ...other, approvalId: row.id, resolverId: other.userId, decision })).kind, 'not_found');
  }
  const seed = await seedApprovalRun(pool);
  const row = await createApprovalRequest({
    ...seed, requesterId: seed.userId, toolId: 'calculator', toolCallId: 'race',
    inputsHash: 'hash', inputsSummary: {}, expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) => resolveApproval({
    ...seed, approvalId: row.id, resolverId: seed.userId, decision: index % 2 ? 'approve' : 'decline',
  })));
  assert.equal(outcomes.filter((o) => o.kind === 'approved' || o.kind === 'declined').length, 1);
  assert.equal(outcomes.filter((o) => o.kind === 'already_resolved').length, 11);
  console.log('state-machine: approve / decline / audit / isolation / 12-way decision race passed');
});
