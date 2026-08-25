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
