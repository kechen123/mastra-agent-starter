import { registerApiRoute } from '@mastra/core/server';
import { getDocumentParserConfig } from '../document-parsers/config.js';

export const capabilitiesRoute = registerApiRoute('/capabilities', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => {
    const config = getDocumentParserConfig();
    return context.json({
      documentFormats: config.documentFormats,
      mineruEnabled: config.mineruEnabled,
      chatAgents: [
        {
          id: 'general',
          name: '通用对话 Agent',
          requiresKnowledgeBase: false,
        },
        {
          id: 'knowledge-base',
          name: '知识库问答 Agent',
          requiresKnowledgeBase: true,
        },
      ],
      defaultChatModel: process.env.XUANSHU_CHAT_MODEL ?? 'deepseek/deepseek-v4-flash',
    });
  },
});
