import { Mastra } from '@mastra/core';
import { taoismAgent } from './agents/taoism-agent.js';
import { askRoute } from './routes/ask.js';
import {
  createKnowledgeBaseRoute,
  deleteKnowledgeBaseRoute,
  getKnowledgeBaseRoute,
  listKnowledgeBasesRoute,
  updateKnowledgeBaseRoute,
} from './routes/knowledge-bases.js';
import { scriptureVector } from './vector.js';

export const mastra = new Mastra({
  agents: { taoismAgent },
  vectors: { scriptureVector },
  server: {
    apiRoutes: [
      askRoute,
      listKnowledgeBasesRoute,
      createKnowledgeBaseRoute,
      getKnowledgeBaseRoute,
      updateKnowledgeBaseRoute,
      deleteKnowledgeBaseRoute,
    ],
  },
});
