/**
 * Thin Mastra bootstrap adapter.
 *
 * Concrete agents, tools, skills, and routes all live outside of
 * `backend/src/mastra/`. This module does exactly three things:
 *
 *   1. Trigger the server bootstrap (`server/bootstrap.ts`), which registers
 *      concrete agents and tools, preloads the skill registry, and returns
 *      the assembled `apiRoutes` array.
 *
 *   2. Construct the local account / password `LocalAuthProvider`. All
 *      `requiresAuth: true` routes flow through this provider's
 *      `authenticateToken` (cookie) and `authorizeUser` (origin gate)
 *      methods. We do **not** use `SimpleAuth` because it is a static token
 *      scheme that cannot be revoked per session.
 *
 *   3. Hand those routes to a fresh `Mastra` instance and re-export it as
 *      `mastra` so the existing entrypoint / deployment script keeps working
 *      without any change to `package.json` or process manager config.
 *
 * No business logic lives in this file. To add routes, agents, tools, or
 * skills, edit the files in `backend/src/server/`, `backend/src/agents/`,
 * `backend/src/tools/`, or `backend/src/skills/` instead.
 */
import { Mastra } from '@mastra/core';
import { apiRoutes } from '../server/bootstrap.js';
import { LocalAuthProvider } from '../infrastructure/auth/local-auth-provider.js';

const authProvider = new LocalAuthProvider();

export const mastra = new Mastra({
  server: {
    apiRoutes,
    auth: authProvider,
  },
});

export { authProvider };
