import { generalAgent } from './general-agent.js';
import { knowledgeBaseAgent } from './knowledge-base-agent.js';
import { searchKnowledgeBase } from '../rag/knowledge-base-retriever.js';
import type { Citation } from '../../types.js';
import { getAgentDefinition } from './registry.js';
import { getKnowledgeBase } from '../services/knowledge-bases.js';

export interface AgentExecutionResult {
  content: string;
  citations: Citation[];
  status: 'completed' | 'failed';
}

export async function executeAgent(
  agentId: string,
  message: string,
  knowledgeBaseId?: string | null,
): Promise<AgentExecutionResult> {
  const definition = getAgentDefinition(agentId);
  if (!definition) {
    return { content: 'Agent 不存在。', citations: [], status: 'failed' };
  }

  try {
    if (agentId === 'general-chat') {
      const response = await generalAgent.generate(message);
      return { content: response.text, citations: [], status: 'completed' };
    }

    if (agentId === 'knowledge-base') {
      if (!knowledgeBaseId) {
        return { content: '请先选择一个知识库。', citations: [], status: 'failed' };
      }
      if (!(await getKnowledgeBase(knowledgeBaseId))) {
        return { content: '绑定的知识库不存在，请重新选择。', citations: [], status: 'failed' };
      }
      const citations = await searchKnowledgeBase(knowledgeBaseId, message);
      if (citations.length === 0) {
        return {
          content: '当前知识库中没有检索到可用于回答此问题的资料。',
          citations: [],
          status: 'completed',
        };
      }
      const context = citations
        .map((c, i) => `[${i + 1}] ${c.title}｜${c.chapter}\n${c.content}`)
        .join('\n\n');
      const response = await knowledgeBaseAgent.generate(
        `请仅根据以下当前知识库资料回答问题：「${message}」。\n\n${context}\n\n不要使用资料以外的知识，也不要调用其他检索工具。引文由系统单独返回。`,
      );
      return { content: response.text, citations, status: 'completed' };
    }

    return { content: 'Agent 暂未实现。', citations: [], status: 'failed' };
  } catch (error) {
    console.error('Agent 执行失败：', error);
    return { content: '服务暂时不可用，请稍后重试。', citations: [], status: 'failed' };
  }
}
