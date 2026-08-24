import { Agent } from '@mastra/core/agent';

export const knowledgeBaseAgent = new Agent({
  id: 'knowledge-base-agent',
  name: '玄枢知识库问答 Agent',
  model: process.env.XUANSHU_CHAT_MODEL ?? 'deepseek/deepseek-v4-flash',
  instructions: `你是玄枢的知识库问答 Agent。只能依据本次请求提供的当前知识库资料回答。
如果资料不足或没有资料，明确说明当前知识库中没有足够信息；不能调用外部知识、不能杜撰引文。
回答使用中文，区分原文内容与自己的简要归纳。`,
});
