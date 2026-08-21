import { Mastra } from '@mastra/core';
import { taoismAgent } from './agents/taoism-agent.js';
import { scriptureVector } from './vector.js';

export const mastra = new Mastra({
  agents: { taoismAgent },
  vectors: { scriptureVector },
});
