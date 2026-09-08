import assert from 'node:assert/strict';
import type { AgentListSuspendedRunsResult } from '@mastra/core/agent';
import type { Pool } from 'pg';
import { validateSuspendedRunsSnapshot } from '../../src/modules/tool-policy/mastra-facade.js';
import { createGeneralAgent } from '../../src/agents/general-chat/agent.js';
import { createKnowledgeBaseAgent } from '../../src/agents/knowledge-base/agent.js';
import { createStagingApprovalProbeAgent } from '../../src/agents/staging-approval-probe/agent.js';
import { createTemplateAgent } from '../../src/agents/_template/agent.js';
import { calculatorDefinition } from '../../src/tools/calculator/tool.js';
import { publishLiveDelta } from '../../src/modules/runs/repository.js';
import { __setTestPool, __resetTestPool } from '../../src/infrastructure/database/pool.js';

const args = { threadId: 'thread-1', resourceId: 'workspace-1', workspaceId: 'workspace-1' };
const raw: AgentListSuspendedRunsResult = {
  total: 1,
  runs: [{
    runId: 'run-1', status: 'suspended', threadId: args.threadId,
    resourceId: args.resourceId, suspendedAt: new Date(),
    toolCalls: [{ toolCallId: 'call-1', toolName: 'calculator', requiresApproval: true }],
  }],
};
assert.deepEqual(validateSuspendedRunsSnapshot(args, raw), [{
  runId: 'run-1', toolCallId: 'call-1', threadId: args.threadId,
  resourceId: args.resourceId, status: 'suspended',
}]);
for (const patch of [
  { threadId: 'other' }, { resourceId: 'other' }, { status: 'running' },
  { toolCalls: [] }, { toolCalls: [{ requiresApproval: true }] },
]) {
  assert.throws(() => validateSuspendedRunsSnapshot(args, {
    ...raw, runs: [{ ...raw.runs[0], ...patch }],
  } as AgentListSuspendedRunsResult));
}

for (const factory of [createGeneralAgent, createKnowledgeBaseAgent, createStagingApprovalProbeAgent, createTemplateAgent]) {
  const agent = factory({ calculator: calculatorDefinition.tool });
  assert.ok((await agent.listTools()).calculator, `${factory.name} 必须给 SDK Agent 注册工具`);
}

const payloads: string[] = [];
let releases = 0;
__setTestPool({
  connect: async () => ({
    query: async (_sql: string, params: string[]) => { payloads.push(params[0]!); },
    release: () => { releases++; },
  }),
} as unknown as Pool);
try {
  const text = '中文🚀"\\\n'.repeat(1800);
  await publishLiveDelta({ runId: 'run-1', workspaceId: args.workspaceId, text });
  assert.ok(payloads.length > 1);
  assert.equal(payloads.map((payload) => {
    assert.ok(Buffer.byteLength(payload) < 7900);
    const parsed = JSON.parse(payload);
    assert.equal(parsed.runId, 'run-1');
    return parsed.text;
  }).join(''), text);
  assert.equal(releases, payloads.length);
} finally {
  __resetTestPool();
}
console.log('approval-sdk-boundary: SDK snapshot / Agent tools / real publisher regression passed');
