import { registerApiRoute } from '@mastra/core/server';
import { answerWithCitations } from '../services/ask.js';

export const askRoute = registerApiRoute('/ask', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    try {
      const body = await context.req.json<{ question?: unknown }>();
      const question = typeof body.question === 'string' ? body.question.trim() : '';

      if (question.length === 0) {
        return context.json({ message: '请输入问题。' }, 400);
      }
      if (question.length > 2_000) {
        return context.json({ message: '问题不能超过 2000 个字符。' }, 400);
      }

      return context.json(await answerWithCitations(question));
    } catch (error) {
      console.error('知识问答请求失败：', error);
      return context.json({ message: '知识问答暂时不可用，请稍后重试。' }, 500);
    }
  },
});
