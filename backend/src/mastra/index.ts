import { Mastra } from '@mastra/core';
import { askRoute, stopMessageRoute, regenerateMessageRoute } from './routes/ask.js';
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
import { toolsRoute } from './routes/tools.js';
import {
  listSkillsRoute,
  getSkillRoute,
  searchMarketSkillsRoute,
  listPopularMarketSkillsRoute,
  previewSkillRoute,
  installSkillRoute,
  updateSkillRoute,
  removeSkillRoute,
  bindSkillRoute,
  unbindSkillRoute,
} from './routes/skills.js';
import {
  createConversationRoute,
  deleteConversationRoute,
  getConversationRoute,
  listConversationsRoute,
  updateConversationRoute,
} from './routes/conversations.js';
import { preloadSkillRegistry } from './skills/registry.js';

// Boot-time hydration: a non-blocking preload so the first GET /skills
// doesn't wait for the DB query when the registry is already warm. This is
// strictly an optimisation — routes call `await ensureSkillRegistryLoaded()`
// on every read, so correctness does NOT depend on this finishing first.
preloadSkillRegistry();

export const mastra = new Mastra({
  server: {
    apiRoutes: [
      askRoute,
      stopMessageRoute,
      regenerateMessageRoute,
      agentsRoute,
      toolsRoute,
      listSkillsRoute,
      getSkillRoute,
      searchMarketSkillsRoute,
      listPopularMarketSkillsRoute,
      previewSkillRoute,
      installSkillRoute,
      updateSkillRoute,
      removeSkillRoute,
      bindSkillRoute,
      unbindSkillRoute,
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
