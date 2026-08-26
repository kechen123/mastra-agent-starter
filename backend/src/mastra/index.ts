/**
 * Thin Mastra bootstrap adapter.
 *
 * Concrete agents, tools, skills, and routes all live outside of
 * `backend/src/mastra/`. This module does exactly two things:
 *
 *   1. Trigger the server bootstrap (`server/bootstrap.ts`), which registers
 *      concrete agents and tools, preloads the skill registry, and returns
 *      the assembled `apiRoutes` array.
 *
 *   2. Hand those routes to a fresh `Mastra` instance and re-export it as
 *      `mastra` so the existing entrypoint / deployment script keeps working
 *      without any change to `package.json` or process manager config.
 *
 * No business logic lives in this file. To add routes, agents, tools, or
 * skills, edit the files in `backend/src/server/`, `backend/src/agents/`,
 * `backend/src/tools/`, or `backend/src/skills/` instead.
 */
import { Mastra } from '@mastra/core';
import { apiRoutes } from '../server/bootstrap.js';

export const mastra = new Mastra({
  server: {
    apiRoutes,
  },
});