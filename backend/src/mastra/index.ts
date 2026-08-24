import { Mastra } from '@mastra/core';
import { taoismAgent } from './agents/taoism-agent.js';
import { askRoute } from './routes/ask.js';
import {
  deleteDocumentRoute,
  getDocumentRoute,
  listDocumentsRoute,
  uploadDocumentRoute,
} from './routes/documents.js';
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
      uploadDocumentRoute,
      listDocumentsRoute,
      getDocumentRoute,
      deleteDocumentRoute,
    ],
  },
});
