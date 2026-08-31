import { registerApiRoute } from '@mastra/core/server';
import { listToolDefinitions } from '../../core/tool/registry.js';
import { withAuthenticatedWorkspace } from '../../modules/auth/workspace-context.js';

export const toolsRoute = registerApiRoute('/tools', {
  method: 'GET',
  requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (_authCtx, context) => {
    const defs = listToolDefinitions();
    return context.json(
      defs.map((d) => ({
        id: d.id,
        displayName: d.displayName,
        description: d.description,
        metadata: d.metadata,
      })),
    );
  }),
});
