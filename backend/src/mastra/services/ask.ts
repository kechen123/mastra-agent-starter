import type { Citation } from '../../types.js';
import { taoismAgent } from '../agents/taoism-agent.js';
import { searchScripture } from '../rag/scripture-retriever.js';

export interface GroundedAnswer {
  answer: string;
  citations: Citation[];
}

export async function answerWithCitations(question: string): Promise<GroundedAnswer> {
  const citations = await searchScripture(question);
  if (citations.length === 0) {
    return { answer: '知识库中暂未检索到可用于回答此问题的资料。', citations: [] };
  }
  const context = citations.map((citation, index) =>
    `[${index + 1}] ${citation.title}｜${citation.chapter}｜${citation.version ?? '版本未标注'}｜${citation.type}\n${citation.content}`,
  ).join('\n\n');
  const response = await taoismAgent.generate(
    `请仅根据以下检索资料回答问题：「${question}」。\n\n${context}\n\n` +
      '按“核心结论 / 典籍依据 / AI 综合说明”作答。不要杜撰资料；引文编号由系统在回答后单独返回。',
  );
  return { answer: response.text, citations };
}
