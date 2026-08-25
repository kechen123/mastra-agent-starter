import { Mastra } from '@mastra/core';
import { generalAgent } from './agents/general-agent.js';
import { knowledgeBaseAgent } from './agents/knowledge-base-agent.js';
import { askRoute } from './routes/ask.js';
import {
  deleteDocumentRoute,
  getDocumentRoute,
  listDocumentsRoute,
  uploadDocumentRoute,
} from './routes/documents.js';
import { capabilitiesRoute } from './routes/capabilities.js';
import {
  createKnowledgeBaseRoute,
  deleteKnowledgeBaseRoute,
  getKnowledgeBaseRoute,
  listKnowledgeBasesRoute,
  updateKnowledgeBaseRoute,
} from './routes/knowledge-bases.js';
import { agentsRoute } from './routes/agents.js';
import {
  createConversationRoute,
  deleteConversationRoute,
  getConversationRoute,
  listConversationsRoute,
  updateConversationRoute,
} from './routes/conversations.js';

export const mastra = new Mastra({
  agents: { generalAgent, knowledgeBaseAgent },
  server: {
    apiRoutes: [
      askRoute,
      agentsRoute,
      listConversationsRoute,
      createConversationRoute,
      getConversationRoute,
      updateConversationRoute,
      deleteConversationRoute,
      listKnowledgeBasesRoute,
      createKnowledgeBaseRoute,
      getKnowledgeBaseRoute,
      updateKnowledgeBaseRoute,
      deleteKnowledgeBaseRoute,
      uploadDocumentRoute,
      listDocumentsRoute,
      getDocumentRoute,
      deleteDocumentRoute,
      capabilitiesRoute,
    ],
  },
});
