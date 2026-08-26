import { createGeneralAgent } from './general-agent.js';
import { createKnowledgeBaseAgent } from './knowledge-base-agent.js';
import { searchKnowledgeBase } from '../rag/knowledge-base-retriever.js';
import type { Citation } from '../../types.js';
import { getAgentDefinition } from './registry.js';
import { getKnowledgeBase } from '../services/knowledge-bases.js';
import type { Message } from '../services/conversations.js';
import { resolveTools, resolveToolIds } from '../tools/registry.js';
import { resolveSkillsForAgent, getAgentSkillBindings, ensureSkillRegistryLoaded } from '../skills/registry.js';

export interface StreamChunk {
  type: 'delta';
  text: string;
}

export interface StreamResult {
  type: 'done';
  content: string;
  citations: Citation[];
}

export interface StreamStopped {
  type: 'stopped';
  content: string;
}

export interface StreamError {
  type: 'error';
  error: string;
}

export interface StreamToolCallStart {
  type: 'tool-call-start';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface StreamToolCallComplete {
  type: 'tool-call-complete';
  toolCallId: string;
  toolName: string;
  output: Record<string, unknown>;
}

export interface StreamToolCallError {
  type: 'tool-call-error';
  toolCallId: string;
  toolName: string;
  error: string;
}

export type StreamEvent =
  | StreamChunk
  | StreamResult
  | StreamStopped
  | StreamError
  | StreamToolCallStart
  | StreamToolCallComplete
  | StreamToolCallError;

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
    // Hydration gate — the registry must reflect filesystem + DB before we
    // resolve which skills to inject. ensureSkillRegistryLoaded() is idempotent
    // so this is O(1) once the first caller has loaded it.
    await ensureSkillRegistryLoaded();

    // Resolve tool IDs: agent toolIds only
    const agentToolIds = definition.toolIds ?? [];
    const resolvedToolIds = resolveToolIds(agentToolIds, undefined);
    const tools = resolveTools(resolvedToolIds);

    // Resolve skills: only database bindings drive runtime injection. The
    // agent definition has no `defaultSkillIds` — users bind skills explicitly
    // via POST /skills/:id/bind. resolveSkillsForAgent() will further filter
    // to (a) compatibility === 'compatible' AND (b) skill.allowedTools ⊆
    // agent.toolIds. Requires-runtime skills can never leak into an agent,
    // and skills requesting tools the agent doesn't have are silently dropped
    // for THIS agent (they remain bindable to other agents that do have them).
    const dbBindings = await getAgentSkillBindings(agentId);
    const resolvedSkills = resolveSkillsForAgent(agentId, dbBindings);
    const skills = resolvedSkills.map((s) => s.skill).filter((s): s is NonNullable<typeof s> => !!s);

    if (agentId === 'general-chat') {
      const prompt = buildPrompt(history, message);
      const agent = createGeneralAgent(tools, skills);
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
              yield { type: 'tool-call-start', toolCallId: payload.toolCallId ?? '', toolName: payload.toolName ?? '', input: (payload.args as Record<string, unknown>) ?? {} };
            }
          }
          if (chunk.type === 'tool-result') {
            const payload = (chunk as unknown as { payload?: { toolCallId?: string; toolName?: string; result?: unknown } }).payload;
            if (payload) {
              const result = payload.result;
              const isError = result && typeof result === 'object' && 'error' in result && !!result.error;
              if (isError) {
                yield { type: 'tool-call-error', toolCallId: payload.toolCallId ?? '', toolName: payload.toolName ?? '', error: (result as { error: string }).error };
              } else {
                yield { type: 'tool-call-complete', toolCallId: payload.toolCallId ?? '', toolName: payload.toolName ?? '', output: (result as Record<string, unknown>) ?? {} };
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
      yield { type: 'done', content, citations: [] };
      return;
    }

    if (agentId === 'knowledge-base') {
      if (!knowledgeBaseId) {
        yield { type: 'error', error: '请先选择一个知识库。' };
        return;
      }
      if (!(await getKnowledgeBase(knowledgeBaseId))) {
        yield { type: 'error', error: '绑定的知识库不存在，请重新选择。' };
        return;
      }
      const citations = await searchKnowledgeBase(knowledgeBaseId, message);
      if (citations.length === 0) {
        yield { type: 'done', content: '当前知识库中没有检索到可用于回答此问题的资料。', citations: [] };
        return;
      }
      const context = citations
        .map((c, i) => `[${i + 1}] ${c.title}｜${c.chapter}\n${c.content}`)
        .join('\n\n');
      const prompt = buildPrompt(history, `请仅根据以下当前知识库资料回答问题：「${message}」。\n\n${context}\n\n不要使用资料以外的知识，也不要调用其他检索工具。引文由系统单独返回。`);
      const agent = createKnowledgeBaseAgent(tools, skills);
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
              yield { type: 'tool-call-start', toolCallId: payload.toolCallId ?? '', toolName: payload.toolName ?? '', input: (payload.args as Record<string, unknown>) ?? {} };
            }
          }
          if (chunk.type === 'tool-result') {
            const payload = (chunk as unknown as { payload?: { toolCallId?: string; toolName?: string; result?: unknown } }).payload;
            if (payload) {
              const result = payload.result;
              const isError = result && typeof result === 'object' && 'error' in result && !!result.error;
              if (isError) {
                yield { type: 'tool-call-error', toolCallId: payload.toolCallId ?? '', toolName: payload.toolName ?? '', error: (result as { error: string }).error };
              } else {
                yield { type: 'tool-call-complete', toolCallId: payload.toolCallId ?? '', toolName: payload.toolName ?? '', output: (result as Record<string, unknown>) ?? {} };
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
      return;
    }

    yield { type: 'error', error: 'Agent 暂未实现。' };
  } catch (error) {
    console.error('Agent 流式执行失败：', error);
    yield { type: 'error', error: '服务暂时不可用，请稍后重试。' };
  }
}

function buildPrompt(history: Message[], latestUserMessage: string): string {
  let recent = history.slice(-20);
  // Ensure the first message in context is a user message (complete turn boundary)
  if (recent.length > 0 && recent[0]!.role === 'assistant') {
    recent = recent.slice(1);
  }
  const lines = recent.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
  if (lines.length === 0 || recent[recent.length - 1]?.role !== 'user') {
    lines.push(`User: ${latestUserMessage}`);
  }
  return lines.join('\n\n');
}
