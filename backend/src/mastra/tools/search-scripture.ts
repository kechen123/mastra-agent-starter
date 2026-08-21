import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { searchScripture } from '../rag/scripture-retriever.js';

export const searchScriptureTool = createTool({
  id: 'search-scripture',
  description: '检索玄枢道教知识库中的原典或注疏，返回原文片段及可追溯出处。',
  inputSchema: z.object({
    query: z.string().min(1).describe('要检索的道教问题、术语或原文关键词'),
    topK: z.number().int().min(1).max(10).optional(),
  }),
  execute: async ({ query, topK }) => searchScripture(query, topK),
});
