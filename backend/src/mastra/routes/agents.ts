import { registerApiRoute } from '@mastra/core/server';
import { listAgentDefinitions } from '../agents/registry.js';

export const agentsRoute = registerApiRoute('/agents', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => context.json(listAgentDefinitions()),
});
