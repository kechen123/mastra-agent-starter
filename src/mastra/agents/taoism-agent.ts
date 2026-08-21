import { Agent } from '@mastra/core/agent';
import { searchScriptureTool } from '../tools/search-scripture.js';

export const taoismAgent = new Agent({
  id: 'taoism-knowledge-agent',
  name: '玄枢道教知识 Agent',
  model: process.env.XUANSHU_CHAT_MODEL ?? 'deepseek/deepseek-v4-flash',
  instructions: `你是玄枢的道教知识 Agent。回答道教相关问题前，必须优先使用 searchScripture 工具。
严格区分原典、古代注疏、现代研究与自己的归纳；没有检索依据时明确说明知识库未找到依据，不能伪造引文。
回答使用中文，结论保持审慎，不能把道家文本与后世宗教道教文献混为一谈。`,
  tools: { searchScriptureTool },
});
