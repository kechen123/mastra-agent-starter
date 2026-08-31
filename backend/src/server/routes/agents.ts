import { registerApiRoute } from '@mastra/core/server';
import { listAgentDefinitions } from '../../core/agent/registry.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { withAuthenticatedWorkspace } from '../../modules/auth/workspace-context.js';

export const agentsRoute = registerApiRoute('/agents', {
  method: 'GET',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (authCtx, context) => {
    const defs = listAgentDefinitions();
    const pool = getDatabasePool();
    const bindingsResult = await pool.query<{ agent_id: string; skill_id: string }>(
      `SELECT agent_id, skill_id FROM agent_skill_bindings WHERE workspace_id = $1`,
      [authCtx.workspaceId],
    );
    const bindingsMap = new Map<string, string[]>();
    for (const row of bindingsResult.rows) {
      const list = bindingsMap.get(row.agent_id) ?? [];
      list.push(row.skill_id);
      bindingsMap.set(row.agent_id, list);
    }
    return context.json(
      defs.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        capabilities: d.capabilities,
        toolIds: d.toolIds ?? [],
        boundSkillIds: bindingsMap.get(d.id) ?? [],
      })),
    );
  }),
});