import type { Citation } from '../../modules/citations/types.js';
import type { Message } from '../../modules/conversations/types.js';
import { getKnowledgeBase } from '../../modules/knowledge/service.js';
import { searchKnowledgeBase } from '../../modules/knowledge/rag/retriever.js';
import { resolveTools, resolveToolIds } from '../tool/registry.js';
import {
  resolveSkillsForAgent,
  getAgentSkillBindings,
  ensureSkillRegistryLoaded,
} from '../skill/registry.js';
import { getAgentDefinition } from './registry.js';
import type { StreamChunk, StreamResult, StreamStopped, StreamError, StreamToolCallStart, StreamToolCallComplete, StreamToolCallError } from '../execution/stream-events.js';

export type { StreamChunk, StreamResult, StreamStopped, StreamError, StreamToolCallStart, StreamToolCallComplete, StreamToolCallError } from '../execution/stream-events.js';
import type { StreamEvent } from '../execution/stream-events.js';
export type { StreamEvent };

/**
 * 通用 Agent 运行时（Runtime Driver）。
 *
 * 具体 Agent 工厂由 `definition.factory` 提供，负责拼装 Mastra Agent 的
 * `instructions` / `model` / 特定配置；Core 只负责"按能力驱动"：
 *
 *   - 当 `capabilities.knowledgeBase = true`：
 *       - 必须提供 knowledgeBaseId，并校验其存在；
 *       - 检索为空时立即发"done-empty"事件，不再进入 LLM；
 *       - 把引文上下文注入 prompt（带编号 [1] [2]...）。
 *       - `citations: false` 仍会注入上下文，但不会回传引文给调用方。
 *   - 否则：基于历史构造普通对话 prompt。
 *
 * 关键约束：
 * - 本文件不 import 任何具体 Agent / Tool / Skill — 全部依赖
 *   `core/agent/types.ts` 与 `core/tool/registry.ts` 提供的契约。
 * - 严禁再写 `if (agentId === 'xxx')` 这类按 ID 分支，所有差异通过
 *   `definition.capabilities` 表达。
 */
export async function* streamAgent(
  agentId: string,
  message: string,
  knowledgeBaseId: string | null,
  history: Message[],
  abortSignal: AbortSignal,
): AsyncGenerator<StreamEvent, void, unknown> {
  const definition = getAgentDefinition(agentId);
  if (!definition) {
    yield { type: 'error', error: 'Agent 不存在。' };
    return;
  }

  try {
    // 加载闸门：在解析 Skill 之前，必须让 Skill Registry 反映"文件系统 + DB"
    // 的真实状态。ensureSkillRegistryLoaded() 是幂等的，首次加载后所有调用
    // 共享同一个 resolved Promise，开销可忽略。
    await ensureSkillRegistryLoaded();

    // 按能力解析：tools=false 的 Agent 不会得到 tools Map；
    // skills=false 的 Agent 不会去读 DB 绑定。空对象/数组让工厂内的 spread
    // 直接跳过对应字段，序列化更干净。
    const tools: Record<string, unknown> = definition.capabilities.tools
      ? resolveTools(resolveToolIds(definition.toolIds ?? [], undefined))
      : {};
    const skills: unknown[] = definition.capabilities.skills
      ? resolveSkillsForAgent(agentId, await getAgentSkillBindings(agentId))
          .map((s) => s.skill)
          .filter((s): s is NonNullable<typeof s> => !!s)
      : [];

    let prompt: string;
    let citations: Citation[] = [];

    if (definition.capabilities.knowledgeBase) {
      if (!knowledgeBaseId) {
        yield { type: 'error', error: '请先选择一个知识库。' };
        return;
      }
      if (!(await getKnowledgeBase(knowledgeBaseId))) {
        yield { type: 'error', error: '绑定的知识库不存在，请重新选择。' };
        return;
      }
      const retrieved = await searchKnowledgeBase(knowledgeBaseId, message);
      if (retrieved.length === 0) {
        // citations=false 的 Agent 也会发出同样的 done 事件，但 citations
        // 数组为空；下游消费者按 capabilities.citations 自己忽略即可。
        yield { type: 'done', content: '当前知识库中没有检索到可用于回答此问题的资料。', citations: [] };
        return;
      }
      // 仅当 Agent 显式开启 citations 时才把引文回传；
      // 否则引文仅用于 prompt 注入，最终结果不带引用。
      if (definition.capabilities.citations) {
        citations = retrieved;
      }
      const context = retrieved
        .map((c, i) => `[${i + 1}] ${c.title}｜${c.chapter}\n${c.content}`)
        .join('\n\n');
      prompt = buildPrompt(
        history,
        `请仅根据以下当前知识库资料回答问题：「${message}」。\n\n${context}\n\n不要使用资料以外的知识，也不要调用其他检索工具。引文由系统单独返回。`,
      );
    } else {
      prompt = buildPrompt(history, message);
    }

    const agent = definition.factory(tools, skills);
    const stream = await agent.stream(prompt, { abortSignal });
    if (abortSignal.aborted) {
      yield { type: 'stopped', content: '' };
      return;
    }
    let content = '';
    try {
      for await (const chunk of stream.fullStream) {
        if (abortSignal.aborted) {
          yield { type: 'stopped', content };
          return;
        }
        if (chunk.type === 'text-delta') {
          const c = chunk as unknown as { payload?: { text?: string }; textDelta?: string };
          const text = c.payload?.text ?? c.textDelta ?? '';
          content += text;
          yield { type: 'delta', text };
        }
        if (chunk.type === 'tool-call') {
          const payload = (chunk as unknown as { payload?: { toolCallId?: string; toolName?: string; args?: unknown } }).payload;
          if (payload) {
            yield {
              type: 'tool-call-start',
              toolCallId: payload.toolCallId ?? '',
              toolName: payload.toolName ?? '',
              input: (payload.args as Record<string, unknown>) ?? {},
            };
          }
        }
        if (chunk.type === 'tool-result') {
          const payload = (chunk as unknown as { payload?: { toolCallId?: string; toolName?: string; result?: unknown } }).payload;
          if (payload) {
            const result = payload.result;
            const isError = result && typeof result === 'object' && 'error' in result && !!result.error;
            if (isError) {
              yield {
                type: 'tool-call-error',
                toolCallId: payload.toolCallId ?? '',
                toolName: payload.toolName ?? '',
                error: (result as { error: string }).error,
              };
            } else {
              yield {
                type: 'tool-call-complete',
                toolCallId: payload.toolCallId ?? '',
                toolName: payload.toolName ?? '',
                output: (result as Record<string, unknown>) ?? {},
              };
            }
          }
        }
        if (chunk.type === 'error') {
          const payload = (chunk as unknown as { payload?: { error?: string } }).payload;
          console.error('Provider error chunk:', payload?.error ?? 'unknown provider error');
          yield { type: 'error', error: '服务暂时不可用，请稍后重试。' };
          return;
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError' || abortSignal.aborted) {
        yield { type: 'stopped', content };
        return;
      }
      throw error;
    }
    if (abortSignal.aborted) {
      yield { type: 'stopped', content };
      return;
    }
    yield { type: 'done', content, citations };
  } catch (error) {
    console.error('Agent 流式执行失败：', error);
    yield { type: 'error', error: '服务暂时不可用，请稍后重试。' };
  }
}

function buildPrompt(history: Message[], latestUserMessage: string): string {
  let recent = history.slice(-20);
  // 确保注入上下文的第 1 条是 user（完整的回合边界），避免模型看到半截 Assistant 回复。
  if (recent.length > 0 && recent[0]!.role === 'assistant') {
    recent = recent.slice(1);
  }
  const lines = recent.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
  if (lines.length === 0 || recent[recent.length - 1]?.role !== 'user') {
    lines.push(`User: ${latestUserMessage}`);
  }
  return lines.join('\n\n');
}