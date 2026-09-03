import type { Citation } from '../../modules/citations/types.js';
import type { Message } from '../../modules/conversations/types.js';
import { getKnowledgeBase } from '../../modules/knowledge/service.js';
import { searchKnowledgeBase } from '../knowledge/search.js';
import { resolveTools, resolveToolIds } from '../tool/registry.js';
import {
  resolveSkillsForAgent,
  getAgentSkillBindings,
  ensureSkillRegistryLoaded,
} from '../skill/registry.js';
import { getAgentDefinition, resolvePerRequestAgent } from './registry.js';
import type { StreamEvent } from '../execution/stream-events.js';
import { normalizeTextChunk } from '../execution/stream-text-normalizer.js';
import type { Mastra } from '@mastra/core';
export type {
  StreamChunk,
  StreamResult,
  StreamStopped,
  StreamError,
  StreamToolCallStart,
  StreamToolCallComplete,
  StreamToolCallError,
  StreamEvent,
} from '../execution/stream-events.js';

/**
 * Phase 3.0 修订：Mastra 实例获取的依赖注入点。
 *
 * 默认行为：`getMastraInstance()` 在首次调用时通过
 * `await import('../../mastra/index.js')` 动态加载生产单例。
 * 该 import 会触发 `server/bootstrap.ts` 的副作用
 * （`startRunExecutor()` / `preloadSkillRegistry()` / PG LISTEN 句柄），
 * 适合在主进程启动后使用。
 *
 * 测试行为：单元测试在**首次** `streamAgent` 调用之前通过
 * `_setMastraInstanceForTesting(fakeInstance)` 注入一个最小 fake；
 * runtime 优先返回 override，绝不触发动态 import；测试收尾时
 * 调用 `_setMastraInstanceForTesting(null)` 清理。
 *
 * 注意：本钩子只控制 runtime 传给 `definition.factory` 的第三个参数；
 * `Mastra({ agents })` 单例构造仍由 `mastra/index.ts` 内部完成（生产
 * 路径不变）。生产代码绝不调用 `_setMastraInstanceForTesting`。
 *
 * 当前实现真实状态（按代码事实）：
 *   - 静态 Agent 构造期（`mastra/index.ts` → `createMastraInstance`）：
 *     factory 第三参数 `mastraInstance` 是 **undefined**（同一进程内
 *     `mastra` 单例虽已存在但本函数未提供；构造函数拿不到实例）。
 *     这些静态 Agent 通过 v1 公开 `new Mastra({ agents })` 路径接入
 *     同一 storage，**不**依赖 per-request `mastraInstance`。
 *   - per-request Agent（`streamAgent` 内通过 `definition.factory(...)`
 *     调用）：factory 第三参数可以拿到 `mastraInstance`（由本函数提供）。
 *     v1 当前并未通过该参数把 storage 强制绑定给 per-request Agent；
 *     per-request Agent 通过 `new Agent({..., mastra })` 同样拿到
 *     公共 `mastra.getStorage()`。本阶段的"已实现"= 公共参数已透传；
 *     "跨重启恢复审批 Run"在真实 PostgreSQL 上的端到端验证**未**完成。
 */
let _mastraInstanceOverride: unknown = undefined;
let _productionMastraCache: unknown = undefined;
let _productionMastraLoadingPromise: Promise<unknown> | null = null;
async function _loadProductionMastra(): Promise<unknown> {
  if (_productionMastraCache !== undefined) return _productionMastraCache;
  if (_productionMastraLoadingPromise) return _productionMastraLoadingPromise;
  _productionMastraLoadingPromise = (async () => {
    const mod = (await import('../../mastra/index.js')) as { mastra: unknown };
    _productionMastraCache = mod.mastra;
    return _productionMastraCache;
  })();
  return _productionMastraLoadingPromise;
}

export function _setMastraInstanceForTesting(
  instance: unknown | null,
): void {
  _mastraInstanceOverride = instance === null ? undefined : instance;
}

async function getMastraInstance(): Promise<unknown> {
  if (_mastraInstanceOverride !== undefined) return _mastraInstanceOverride;
  return _loadProductionMastra();
}

/**
 * 测试钩子：清空 production 单例缓存与 override。**仅供需要在进程
 * 内重新解析 Mastra 单例的测试使用**；生产代码绝不调用。
 */
export function _resetMastraInstanceCacheForTesting(): void {
  _productionMastraCache = undefined;
  _productionMastraLoadingPromise = null;
  _mastraInstanceOverride = undefined;
}

/**
 * `streamAgent` 的入参契约（V2.3.6 §5.1）。
 *
 * `workspaceId` 是唯一可信的工作区身份来源——调用方（HTTP 路由通过
 * `withAuthenticatedWorkspace`、CLI 脚本通过 SESSION_TOKEN 解析）必须
 * 把已经校验过的 `workspaceId` 传进来。Agent 运行时内部不允许再走任何
 * 客户端字段或回退路径。
 *
 * `conversationId` / `knowledgeBaseId` / `history` 都是**可选**的——Agent
 * 运行时本身不写 DB（写入路径在 `core/execution/ask-driver.ts`），但这些
 * 字段保留在契约上便于上层做最小上下文透传。
 */
export interface StreamAgentInput {
  workspaceId: string;
  agentId: string;
  prompt: string;
  conversationId?: string;
  knowledgeBaseId?: string | null;
  history?: Message[];
  abortSignal: AbortSignal;
  /**
   * Phase 3.0 — 标识映射字段（业务 ↔ Mastra）。
   * - `runId`：业务 `agent_runs.id`，透传到 Mastra `streamOptions.runId`；
   * - `threadId`：业务 `conversations.id`，透传到 Mastra
   *   `streamOptions.memory.thread.id`；
   * - `resourceId`：业务 `workspaces.id`，透传到 Mastra
   *   `streamOptions.memory.resource.id`。
   * 三个字段同时缺失时，Runtime 仍允许运行（向后兼容），但业务 ↔ Mastra
   * 标识不再持久——与 Phase 3.0 文档要求"必须真实携带"相对应。
   */
  runId?: string;
  threadId?: string;
  resourceId?: string;
}

/**
 * 通用 Agent 运行时（Runtime Driver）。
 *
 * 具体 Agent 工厂由 `definition.factory` 提供，负责拼装 Mastra Agent 的
 * `instructions` / `model` / 特定配置；Core 只负责"按能力驱动"：
 *
 *   - 当 `capabilities.knowledgeBase = true`：
 *       - 必须提供 knowledgeBaseId，并校验其存在（受 workspaceId 约束）；
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
  input: StreamAgentInput,
): AsyncGenerator<StreamEvent, void, unknown> {
  const { workspaceId, agentId, prompt, knowledgeBaseId, history, abortSignal } = input;

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

    // 按能力解析：tools=false 的 Agent 不会计算 activeTools；
    // skills=false 的 Agent 不会去读 DB 绑定。空数组让工厂内的 spread
    // 直接跳过对应字段，序列化更干净。
    //
    // Phase 3.0 修订：Tool 来源变更。
    //   - 全部 Tool 在 `Mastra({ tools })` 全局注册（详见
    //     `infrastructure/mastra/instance.ts`）；
    //   - per-request **不**再 inline 构造 tools Map；
    //   - 当前 Agent 可用的子集通过 `streamOptions.activeTools`
    //     传给 `agent.stream()`，由 v1 在执行期按白名单过滤。
    //   - `resolveTools()` 在本路径仅作为"按 ID 取 tool 对象"被复用，
    //     保留以兼容上层把 tools 重新 inline 装配的调用方（如单测）。
    const activeToolIds: string[] = definition.capabilities.tools
      ? resolveToolIds(definition.toolIds ?? [], undefined)
      : [];
    const inlineTools: Record<string, unknown> = activeToolIds.length > 0
      ? resolveTools(activeToolIds)
      : {};
    const skills: unknown[] = definition.capabilities.skills
      ? resolveSkillsForAgent(agentId, await getAgentSkillBindings(workspaceId, agentId))
          .map((s) => s.skill)
          .filter((s): s is NonNullable<typeof s> => !!s)
      : [];

    let resolvedPrompt: string;
    let citations: Citation[] = [];
    const historyOrEmpty = history ?? [];

    if (definition.capabilities.knowledgeBase) {
      if (!knowledgeBaseId) {
        yield { type: 'error', error: '请先选择一个知识库。' };
        return;
      }
      if (!(await getKnowledgeBase(workspaceId, knowledgeBaseId))) {
        yield { type: 'error', error: '绑定的知识库不存在，请重新选择。' };
        return;
      }
      // 必须通过 core/knowledge/search.ts wrapper 调用；retriever 本身已按
      // workspace_id 过滤（防御深度），但 wrapper 仍负责抛 CrossWorkspaceAccessError
      // 给上层，避免泄露 ID 存在性。禁止直连 retriever 绕过 workspaceId 校验。
      const retrieved = await searchKnowledgeBase(workspaceId, knowledgeBaseId, prompt);
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
      resolvedPrompt = buildPrompt(
        historyOrEmpty,
        `请仅根据以下当前知识库资料回答问题：「${prompt}」。\n\n${context}\n\n不要使用资料以外的知识，也不要调用其他检索工具。引文由系统单独返回。`,
      );
    } else {
      resolvedPrompt = buildPrompt(historyOrEmpty, prompt);
    }

    // Phase 3.0：把 Mastra 实例透传给 definition.factory。
    // 具体 Agent 工厂会把它注入 `new Agent({..., mastra })`，从而
    // per-request 创建的 Agent 通过 public Mastra 注册路径访问 storage，
    // 不依赖 `__registerMastra` 等 internal API。
    //
    // 通过 `getMastraInstance()` 解析（而非直接动态 import）：
    //   - 避免循环依赖：
    //     runtime.ts ←─→  mastra/index.ts ←─→  server/bootstrap.ts
    //   - 单元测试可在首次调用前通过 `_setMastraInstanceForTesting(...)`
    //     注入 fake，**不**触发 `server/bootstrap.ts` 的副作用
    //     （`startRunExecutor()` / `preloadSkillRegistry()` /
    //     PG LISTEN 句柄）；生产路径仍按 `_loadProductionMastra()`
    //     的 lazy dynamic import 行为。
    //
    // 注意：本路径仅是为了把 `mastra` 实例传给 per-request Agent；
    // 业务 ↔ Mastra 标识映射（runId / threadId / resourceId）**不**
    // 依赖本引用——标识由调用方通过 `StreamAgentInput` 显式提供，
    // 并在下面的 `agent.stream()` 选项里透传给 Mastra 公开 API。
    const mastra = (await getMastraInstance()) as Mastra;
    // Phase 3.0：把 Mastra 实例透传给 definition.factory。
    // 具体 Agent 工厂会把它注入 `new Agent({..., mastra })`，让 per-request
    // Agent 通过 public Mastra 注册路径同时拿到全局 tool 字典与 storage。
    // 这里把 `inlineTools` 作为兼容参数透传：具体工厂在 Phase 3.0 修订后
    // 不再读取 tools，但仍保留位置以不破坏 `AgentFactory` 签名。
    //
    // 优先走 `resolvePerRequestAgent`：单元测试用 `_setPerRequestFactoryOverrideForTesting`
    // 注入 stub Agent 拦截 `agent.stream()` 选项，stub 不会被写进
    // Agent 注册表，也不会污染生产 `Mastra({ agents })` 的构造。
    const agent =
      resolvePerRequestAgent(agentId, inlineTools, skills, mastra) ??
      definition.factory(inlineTools, skills, mastra);
    const stream = await agent.stream(resolvedPrompt, {
      abortSignal,
      // Phase 3.0：Tool 子集过滤走 v1 公开 streamOptions。
      // v1 在执行期按 `activeTools` 白名单过滤；不传时该 Agent 可用
      // 其注册的全部 tool。
      ...(activeToolIds.length > 0 ? { activeTools: activeToolIds } : {}),
      // Phase 3.0：标识映射通过 Mastra 公开 streamOptions 携带。
      // - `runId`：Mastra `AgentExecutionOptionsBase.runId`（参见
      //   `@mastra/core/agent.types.d.ts`），用于让框架把 snapshot 与
      //   我们的 `agent_runs.id` 同源；
      // - `memory`：v1 公开 API（`AgentMemoryOption`）的字段是
      //   `thread: string | { id: string }` 与 `resource: string`（注意
      //   resource 字段是字符串，不是对象）。当 `threadId` / `resourceId`
      //   同时具备时构造 `memory` 选项；缺一不可，否则仅作为概念层
      //   映射，不进入 Mastra snapshot。
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.threadId !== undefined && input.resourceId !== undefined
        ? {
            memory: {
              thread: input.threadId,
              resource: input.resourceId,
            },
          }
        : {}),
    });
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
          const incomingText = c.payload?.text ?? c.textDelta ?? '';
          const normalized = normalizeTextChunk(content, incomingText);
          content = normalized.accumulatedText;
          // SSE / executor 对外只有纯增量；累计快照的无变化帧不应产生事件。
          if (normalized.delta) yield { type: 'delta', text: normalized.delta };
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
