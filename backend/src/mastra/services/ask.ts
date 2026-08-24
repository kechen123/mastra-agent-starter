import type { Citation } from '../../types.js';
import { knowledgeBaseAgent } from '../agents/knowledge-base-agent.js';
import { taoismAgent } from '../agents/taoism-agent.js';
import { searchKnowledgeBase } from '../rag/knowledge-base-retriever.js';
import { searchScripture } from '../rag/scripture-retriever.js';

export interface GroundedAnswer {
  answer: string;
  citations: Citation[];
}

export async function answerWithCitations(question: string, knowledgeBaseId?: string): Promise<GroundedAnswer> {
  const citations = knowledgeBaseId
    ? await searchKnowledgeBase(knowledgeBaseId, question)
    : await searchScripture(question);
  if (citations.length === 0) {
    return {
      answer: knowledgeBaseId
        ? '当前知识库中没有检索到可用于回答此问题的资料。'
        : '知识库中暂未检索到可用于回答此问题的资料。',
      citations: [],
    };
  }
  const context = citations.map((citation, index) =>
    `[${index + 1}] ${citation.title}｜${citation.chapter}｜${citation.type}\n${citation.content}`,
  ).join('\n\n');
  const response = await (knowledgeBaseId ? knowledgeBaseAgent : taoismAgent).generate(
    knowledgeBaseId
      ? `请仅根据以下当前知识库资料回答问题：「${question}」。\n\n${context}\n\n不要使用资料以外的知识，也不要调用其他知识库或典籍检索工具。引文由系统单独返回。`
      : `请仅根据以下检索资料回答问题：「${question}」。\n\n${context}\n\n` +
        '按“核心结论 / 典籍依据 / AI 综合说明”作答。不要杜撰资料；引文编号由系统在回答后单独返回。',
  );
  return { answer: response.text, citations };
}
