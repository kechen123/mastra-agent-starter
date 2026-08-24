import { registerApiRoute } from '@mastra/core/server';
import { answerGeneral, answerWithKnowledge } from '../services/ask.js';
import { getKnowledgeBase } from '../services/knowledge-bases.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const askRoute = registerApiRoute('/ask', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    try {
      const body = await context.req.json<{
        question?: unknown;
        agentId?: unknown;
        knowledgeBaseId?: unknown;
      }>();
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : 'general';
      const knowledgeBaseId = body.knowledgeBaseId;

      if (question.length === 0) {
        return context.json({ message: '请输入问题。' }, 400);
      }
      if (question.length > 2_000) {
        return context.json({ message: '问题不能超过 2000 个字符。' }, 400);
      }
      if (agentId !== 'general' && agentId !== 'knowledge-base') {
        return context.json({ message: 'agentId 仅支持 general 或 knowledge-base。' }, 400);
      }

      if (agentId === 'general') {
        return context.json(await answerGeneral(question));
      }

      // knowledge-base agent
      if (knowledgeBaseId === undefined || knowledgeBaseId === null || knowledgeBaseId === '') {
        return context.json({ message: '请先选择一个知识库。' }, 400);
      }
      if (typeof knowledgeBaseId !== 'string' || !UUID_PATTERN.test(knowledgeBaseId)) {
        return context.json({ message: '知识库 id 格式不正确。' }, 400);
      }
      if (!(await getKnowledgeBase(knowledgeBaseId))) {
        return context.json({ message: '知识库不存在。' }, 404);
      }

      return context.json(await answerWithKnowledge(question, knowledgeBaseId));
    } catch (error) {
      console.error('问答请求失败：', error);
      return context.json({ message: '问答暂时不可用，请稍后重试。' }, 500);
    }
  },
});
