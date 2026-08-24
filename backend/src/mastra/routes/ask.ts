import { registerApiRoute } from '@mastra/core/server';
import { answerWithCitations } from '../services/ask.js';
import { getKnowledgeBase } from '../services/knowledge-bases.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const askRoute = registerApiRoute('/ask', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    try {
      const body = await context.req.json<{ question?: unknown; knowledgeBaseId?: unknown }>();
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      const knowledgeBaseId = body.knowledgeBaseId;

      if (question.length === 0) {
        return context.json({ message: '请输入问题。' }, 400);
      }
      if (question.length > 2_000) {
        return context.json({ message: '问题不能超过 2000 个字符。' }, 400);
      }
      if (knowledgeBaseId !== undefined) {
        if (typeof knowledgeBaseId !== 'string' || !UUID_PATTERN.test(knowledgeBaseId)) {
          return context.json({ message: '知识库 id 格式不正确。' }, 400);
        }
        if (!(await getKnowledgeBase(knowledgeBaseId))) {
          return context.json({ message: '知识库不存在。' }, 404);
        }
      }

      return context.json(await answerWithCitations(question, knowledgeBaseId));
    } catch (error) {
      console.error('知识问答请求失败：', error);
      return context.json({ message: '知识问答暂时不可用，请稍后重试。' }, 500);
    }
  },
});
