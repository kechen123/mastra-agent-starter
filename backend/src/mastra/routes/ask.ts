import { registerApiRoute } from '@mastra/core/server';
import {
  getConversationWithMessages,
  maybeUpdateTitleFromFirstMessage,
  saveAssistantMessage,
  saveUserMessage,
  touchConversation,
} from '../services/conversations.js';
import { executeAgent } from '../agents/runtime.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const askRoute = registerApiRoute('/ask', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    try {
      const body = await context.req.json<unknown>();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return context.json({ message: '请求体必须是 JSON 对象。' }, 400);
      }
      const { conversationId, message } = body as Record<string, unknown>;
      if (typeof conversationId !== 'string' || !UUID_PATTERN.test(conversationId)) {
        return context.json({ message: 'conversationId 格式不正确。' }, 400);
      }
      if (typeof message !== 'string' || message.trim().length === 0) {
        return context.json({ message: '请输入问题。' }, 400);
      }
      if (message.trim().length > 2000) {
        return context.json({ message: '问题不能超过 2000 个字符。' }, 400);
      }

      const { conversation } = await getConversationWithMessages(conversationId);

      // Save user message
      await saveUserMessage(conversationId, message.trim());
      await maybeUpdateTitleFromFirstMessage(conversationId, message.trim());

      // Execute agent based on conversation.agentId
      const result = await executeAgent(
        conversation.agentId,
        message.trim(),
        conversation.knowledgeBaseId,
      );

      // Save assistant message
      const assistantMessage = await saveAssistantMessage(
        conversationId,
        result.content,
        result.citations,
        result.status,
      );

      // Touch conversation updated_at
      await touchConversation(conversationId);

      // Return in a shape compatible with frontend
      return context.json({
        id: assistantMessage.id,
        role: assistantMessage.role,
        content: assistantMessage.content,
        citations: assistantMessage.citations,
        status: assistantMessage.status,
        createdAt: assistantMessage.createdAt,
      });
    } catch (error) {
      console.error('问答请求失败：', error);
      if (error instanceof Error && error.message === '会话不存在。') {
        return context.json({ message: '会话不存在。' }, 404);
      }
      return context.json({ message: '服务暂时不可用，请稍后重试。' }, 500);
    }
  },
});
