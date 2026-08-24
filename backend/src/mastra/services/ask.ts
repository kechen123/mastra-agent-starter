import type { Citation } from '../../types.js';
import { generalAgent } from '../agents/general-agent.js';
import { knowledgeBaseAgent } from '../agents/knowledge-base-agent.js';
import { searchKnowledgeBase } from '../rag/knowledge-base-retriever.js';

export interface GroundedAnswer {
  answer: string;
  citations: Citation[];
}

export async function answerGeneral(question: string): Promise<GroundedAnswer> {
  const response = await generalAgent.generate(question);
  return { answer: response.text, citations: [] };
}

export async function answerWithKnowledge(
  question: string,
  knowledgeBaseId: string,
): Promise<GroundedAnswer> {
  const citations = await searchKnowledgeBase(knowledgeBaseId, question);
  if (citations.length === 0) {
    return {
      answer: '当前知识库中没有检索到可用于回答此问题的资料。',
      citations: [],
    };
  }
  const context = citations
    .map(
      (citation, index) =>
        `[${index + 1}] ${citation.title}｜${citation.chapter}\n${citation.content}`,
    )
    .join('\n\n');
  const response = await knowledgeBaseAgent.generate(
    `请仅根据以下当前知识库资料回答问题：「${question}」。\n\n${context}\n\n不要使用资料以外的知识，也不要调用其他检索工具。引文由系统单独返回。`,
  );
  return { answer: response.text, citations };
}
