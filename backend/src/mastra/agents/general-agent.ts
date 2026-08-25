import { Agent } from '@mastra/core/agent';

export function createGeneralAgent(tools?: Record<string, any>, skills?: unknown[]) {
  return new Agent({
    id: 'general-agent',
    name: '玄枢通用对话 Agent',
    model: process.env.XUANSHU_CHAT_MODEL ?? 'deepseek/deepseek-v4-flash',
    instructions: `你是玄枢通用对话助手。可以回答闲聊、百科、技术、生活等各类问题。回答使用中文，保持友善和准确。`,
    ...(tools && Object.keys(tools).length > 0 ? { tools } : {}),
    ...(skills && skills.length > 0 ? { skills: skills as any } : {}),
  });
}
