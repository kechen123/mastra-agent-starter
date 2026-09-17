import type { Citation } from '../../modules/citations/types.js';
import type { Message } from '../../modules/conversations/types.js';
import { getKnowledgeBase } from '../../modules/knowledge/service.js';
import { searchDaymindSources } from '../../modules/sources/retrieval.js';
import { searchKnowledgeBase } from '../knowledge/search.js';
import { resolveTools } from '../tool/registry.js';
import {
  resolveSkillsForAgent,
  getAgentSkillBindings,
  ensureSkillRegistryLoaded,
} from '../skill/registry.js';
import { getAgentDefinition, resolvePerRequestAgent } from './registry.js';
import type { StreamEvent } from '../execution/stream-events.js';
import { normalizeTextChunk } from '../execution/stream-text-normalizer.js';
import type { Mastra } from '@mastra/core';
import {
  createDefaultResolverContext,
  resolveAllowedToolIds,
} from '../../modules/tool-policy/resolver.js';
import { buildRequireApproval } from './tool-approval-gateway.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import {
  type RunEventType,
  insertRunEvent,
} from '../../modules/runs/repository.js';
import { createApprovalRequest } from '../../modules/tool-policy/repository.js';
import { sanitizeToolInputs } from '../../modules/tool-policy/sanitize.js';
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
// `consumeAgentStream` 与 `AgentStreamExecution` 在本文件内声明；
// 调用方 import 它们时直接拿本模块的命名导出即可。

/**
 * 工具审批请求事件——前端 / SSE 端拿这个事件展示待审批列表。
 */
export interface StreamApprovalRequested {
  type: 'approval-requested';
  approvalId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  inputsSummary: Record<string, unknown>;
  inputsHash: string;
  expiresAt: string;
}

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
 * Phase 3.2 — Policy-aware Tool Resolver 注入点。
 *
 * 默认路径：`resolveAllowedToolIdsForRuntime()` 走真实 resolver
 * （`createDefaultResolverContext()` 装配 Tool 注册表 +
 * tool_policy_rules repository）；该路径需要 DATABASE_URL 等真实依赖。
 *
 * 测试路径：单元测试通过本钩子注入一个不连 DB 的 stub resolver；
 * 注入后 streamAgent 内**不**触发真实 repository 调用，也不会触发
 * `server/bootstrap.ts` 副作用。生产代码绝不调用本钩子。
 */
export type PolicyResolverOverride = (
  workspaceId: string,
  toolIds: string[],
) => Promise<string[]>;
let _policyResolverOverride: PolicyResolverOverride | null = null;
export function _setPolicyResolverForTesting(
  impl: PolicyResolverOverride | null,
): void {
  _policyResolverOverride = impl;
}
async function resolveAllowedToolIdsForRuntime(
  workspaceId: string,
  toolIds: string[],
): Promise<string[]> {
  if (_policyResolverOverride) {
    return _policyResolverOverride(workspaceId, toolIds);
  }
  return resolveAllowedToolIds(
    workspaceId,
    toolIds,
    createDefaultResolverContext(),
  );
}

/**
 * 测试钩子：注入 `requireToolApproval` 函数。生产代码绝不调用本钩子。
 * 用于 runtime-filtering 测试在不连真实 Tool 注册表的情况下，验证
 * `requireToolApproval` 回调被注入 streamOptions。
 */
export type RequireApprovalOverride = (
  ctx: { toolName: string; args: Record<string, unknown> },
) => boolean | Promise<boolean>;
let _requireApprovalOverride: RequireApprovalOverride | null = null;
export function _setRequireApprovalForTesting(
  impl: RequireApprovalOverride | null,
): void {
  _requireApprovalOverride = impl;
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
   * PR-3.3 — 创建 approval request 时需要的 requester_id。
   * 不传则使用 system fallback（实际业务路径 run executor 总会传）；
   * null 表示"系统发起"（cron / 重试 worker）。
   */
  requesterId?: string | null;
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
 * PR-3.3 — `consumeAgentStream` 公共内部能力。
 *
 * 共享于"首次 Run"（`streamAgent` 调 `agent.stream(...).fullStream`）与
 * "审批续 Run"（resume 调度器调 `agent.approveToolCall(...).fullStream` /
 * `agent.declineToolCall(...).fullStream`）。**唯一**翻译 Mastra chunk →
 * 业务 `StreamEvent` 的入口；任何 delta / tool 事件 / checkpoint /
 * messages / SSE / Run completed-failed-stopped 都必须走它。
 *
 * 设计动机：
 *   - 旧版本的 resume 路径"把 Run 改 queued + 重跑 streamAgent(prompt)"是
 *     **错误重放**——Mastra 重新发起模型请求，而非从 approval 挂起点恢复。
 *   - 真正续 Run 必须消费 `agent.approveToolCall(...)` 返回的 AsyncIterable
 *     stream；该 stream 由框架从 workflow snapshot 处续推，**不**包含重
 *     新 prompt 与历史。
 *
 * 调用方约定：
 *   - 调用前由调用方**保证** lease 已抢占、Run 状态已推到 'running'（续
 *     Run 时由 resume 调度器负责）；
 *   - 循环退出条件由 stream 自身决定（done / stopped / error / approval-
 *     requested）；
 *   - 持久化副作用（事件、checkpoint、message 状态）由 `handleStreamEvent`
 *     兜底；本函数**只**做翻译。
 */
export async function* consumeAgentStream(
  execution: AgentStreamExecution,
  stream: AsyncIterable<unknown>,
): AsyncGenerator<StreamEvent, void, unknown> {
  let content = '';
  for await (const chunk of stream) {
    if (execution.abortSignal.aborted) {
      yield { type: 'stopped', content };
      return;
    }
    const c = chunk as { type?: string };
    if (c.type === 'text-delta') {
      const payload = (chunk as { payload?: { text?: string }; textDelta?: string });
      const incomingText = payload.payload?.text ?? payload.textDelta ?? '';
      const normalized = normalizeTextChunk(content, incomingText);
      content = normalized.accumulatedText;
      if (normalized.delta) yield { type: 'delta', text: normalized.delta };
    } else if (c.type === 'tool-call') {
      const payload = (chunk as { payload?: { toolCallId?: string; toolName?: string; args?: unknown } }).payload;
      if (payload) {
        yield {
          type: 'tool-call-start',
          toolCallId: payload.toolCallId ?? '',
          toolName: payload.toolName ?? '',
          input: (payload.args as Record<string, unknown>) ?? {},
        };
      }
    } else if (c.type === 'tool-result') {
      const payload = (chunk as { payload?: { toolCallId?: string; toolName?: string; result?: unknown } }).payload;
      if (payload) {
        const result = payload.result;
        const isError = result && typeof result === 'object' && 'error' in result && !!(result as { error?: unknown }).error;
        if (isError) {
          yield {
            type: 'tool-call-error',
            toolCallId: payload.toolCallId ?? '',
            toolName: payload.toolName ?? '',
            error: String((result as { error: unknown }).error),
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
    } else if (c.type === 'error') {
      const payload = (chunk as { payload?: { error?: string } }).payload;
      console.error('Provider error chunk:', payload?.error ?? 'unknown provider error');
      yield { type: 'error', error: '服务暂时不可用，请稍后重试。' };
      return;
    } else if (c.type === 'tool-call-approval') {
      // PR-3.3：Mastra 1.61 在 requireToolApproval=true 时再次发
      // 'tool-call-approval' chunk（resume stream 中也可能出现，例如第二
      // 个 Tool 也需审批）；持久化 approval request + 写 approval-requested
      // 事件 + 把 Run 推到 waiting_approval + 释放 lease。
      const payload = (chunk as { payload?: { toolCallId?: string; toolName?: string; args?: Record<string, unknown> } }).payload;
      if (payload && execution.runId) {
        // PR-3.3 — requesterId 必须非空（schema NOT NULL FK）。若
        // execution.requesterId 为 null，必须由调用方在 run executor 入口
        // 把 agent_runs.created_by 注入（run executor 已保证）。这里
        // 显式校验，避免 NULL 写库。
        if (!execution.requesterId) {
          yield {
            type: 'error',
            error:
              '审批请求创建失败：agent_runs.created_by 为 NULL；' +
              '必须由真实用户创建 Run。',
          };
          return;
        }
        const sanitized = sanitizeToolInputs(payload.args ?? {});
        const ttlMs = resolveApprovalTtlMs();
        const expiresAt = new Date(Date.now() + ttlMs).toISOString();
        const approvalRow = await persistApprovalRequested({
          workspaceId: execution.workspaceId,
          runId: execution.runId,
          toolCallId: payload.toolCallId ?? '',
          toolName: payload.toolName ?? '',
          inputsHash: sanitized.hash,
          inputsSummary: sanitized.summary,
          requesterId: execution.requesterId,
          expiresAt,
        });
        yield {
          type: 'approval-requested',
          approvalId: approvalRow.id,
          runId: approvalRow.runId,
          toolCallId: approvalRow.toolCallId,
          toolName: approvalRow.toolId,
          inputsSummary: sanitized.summary,
          inputsHash: sanitized.hash,
          expiresAt: approvalRow.expiresAt,
        };
        return;
      }
    }
  }
  if (execution.abortSignal.aborted) {
    yield { type: 'stopped', content };
    return;
  }
  yield { type: 'done', content, citations: execution.citations ?? [] };
}

/**
 * PR-3.3.1 — 审批 TTL 的可测试性。
 *
 * 默认行为：与 PR-3.3 完全一致——`5 * 60_000` ms。
 *
 * 测试 / staging 覆盖路径：仅当
 *   1. `ENABLE_STAGING_APPROVAL_PROBE=true`
 *   2. `DEPLOYMENT_PROFILE !== 'production'`
 * 才允许 `STAGING_APPROVAL_E2E_APPROVAL_TTL_MS` 覆盖默认 TTL；
 * 任何生产部署即便误设 TTL 也**不会**影响 5 分钟默认行为，避免在生产
 * 把 pending 审批的有效期改成秒级。
 *
 * 校验范围（严格）：
 *   - 必须是正整数；
 *   - 必须 ≥ 1 000 ms（避免毫秒级 TTL 让 pending 状态在写入瞬间过期、
 *     让 e2e 误判为超时路径）；
 *   - 必须 ≤ 5 * 60_000 ms（不允许拉长到超过默认 TTL——避免 staging 用例
 *     改坏未来回归测试的 SLA 期望）。
 *
 * 不通过：
 *   - 默认场景未设置 → 仍使用 5 分钟；
 *   - 任何不满足上述三项校验的值 → 抛错（fail-closed，**不**回退到 5 分钟）。
 */
export const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;
export const STAGING_APPROVAL_TTL_MIN_MS = 1_000;
export const STAGING_APPROVAL_TTL_MAX_MS = DEFAULT_APPROVAL_TTL_MS;

export function resolveApprovalTtlMs(): number {
  const raw = process.env.STAGING_APPROVAL_E2E_APPROVAL_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_APPROVAL_TTL_MS;
  if (process.env.ENABLE_STAGING_APPROVAL_PROBE !== 'true') {
    throw new Error(
      'STAGING_APPROVAL_E2E_APPROVAL_TTL_MS 仅在 ENABLE_STAGING_APPROVAL_PROBE=true 时生效。',
    );
  }
  if (process.env.DEPLOYMENT_PROFILE === 'production') {
    throw new Error(
      'STAGING_APPROVAL_E2E_APPROVAL_TTL_MS 在 DEPLOYMENT_PROFILE=production 时被禁用。',
    );
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < STAGING_APPROVAL_TTL_MIN_MS || parsed > STAGING_APPROVAL_TTL_MAX_MS) {
    throw new Error(
      `STAGING_APPROVAL_E2E_APPROVAL_TTL_MS=${raw} 不合法：必须是 ${STAGING_APPROVAL_TTL_MIN_MS}–${STAGING_APPROVAL_TTL_MAX_MS} 之间的整数。`,
    );
  }
  return parsed;
}

/**
 * `consumeAgentStream` 的执行上下文契约——调用方把"已知的会话身份"
 * 透传进来，避免每次重读历史 / 重算 prompt。
 */
export interface AgentStreamExecution {
  workspaceId: string;
  /** 必填：首次 Run 与 resume 都必须透传 runId。 */
  runId: string;
  /**
   * PR-3.3 — 必填非空：审批 requesterId 必须来自 agent_runs.created_by
   * （NULL 时拒绝创建审批）。Run executor 在 executeRun / consumeResumeStream
   * 入口强制透传；若 null 直接 fail-closed。
   */
  requesterId: string;
  abortSignal: AbortSignal;
  citations?: Citation[];
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
    //
    // Phase 3.2 修订：activeTools 走策略感知解析器——
    //   - 服务端 ToolDefinition 元数据（destructive / openWorld /
    //     requiresRuntime）是风险判定唯一来源；
    //   - tool_policy_rules 是 Workspace 维度策略唯一来源；
    //   - forbidden 不出现（fail-closed 阻断）；
    //   - requires-approval **进入** activeTools（PR-3.3 起），由
    //     requireToolApproval(ctx) 在调用前回调触发挂起 + 持久化。
    //
    // Phase 3.3 修订：requireToolApproval 真实接入。
    //   - 调用 buildRequireApproval({ workspaceId }) 构造 per-workspace
    //     函数，注入 streamOptions.requireToolApproval；
    //   - 真实 Mastra 1.61 行为：requireToolApproval 返回 true →
    //     Mastra 发 'tool-call-approval' chunk 并挂起；返回 false →
    //     Tool 正常执行；
    //   - forbidden Tool 不进入 activeTools——理论上不应被 Mastra
    //     调用，万一绕过 requireToolApproval 返回 false 即可（fallback）。
    const activeToolIds: string[] = definition.capabilities.tools
      ? await resolveAllowedToolIdsForRuntime(
          workspaceId,
          definition.toolIds ?? [],
        )
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

    const usesDaymindSources = definition.capabilities.daymindSources === true;
    const usesKnowledgeBase = definition.capabilities.knowledgeBase;
    const daymindRetrieval = usesDaymindSources
      ? await searchDaymindSources(workspaceId, prompt, { topK: 5, signal: input.abortSignal })
      : null;
    const retrievalKnowledgeBaseId = daymindRetrieval?.knowledgeBaseId ?? knowledgeBaseId;

    if (usesKnowledgeBase || usesDaymindSources) {
      if (!retrievalKnowledgeBaseId && usesKnowledgeBase) {
        yield { type: 'error', error: '请先选择一个知识库。' };
        return;
      }
      // Daymind 尚没有资料时只是正常对话，不能因不存在隐藏索引而报错。
      if (!retrievalKnowledgeBaseId) {
        resolvedPrompt = buildPrompt(historyOrEmpty, prompt);
      } else if (!(await getKnowledgeBase(workspaceId, retrievalKnowledgeBaseId))) {
        yield { type: 'error', error: '绑定的知识库不存在，请重新选择。' };
        return;
      } else if (usesDaymindSources) {
        const retrieved = daymindRetrieval!.citations;
        if (retrieved.length === 0) {
          resolvedPrompt = buildPrompt(historyOrEmpty, prompt);
        } else {
          if (definition.capabilities.citations) citations = retrieved;
          const context = retrieved
            .map((c, i) => `[${i + 1}] ${c.title}｜${c.chapter}\n${c.content}`)
            .join('\n\n');
          resolvedPrompt = buildPrompt(
            historyOrEmpty,
            `请优先根据以下 Daymind 长期资料回答问题：「${prompt}」。\n\n${context}\n\n资料不足时请明确说明哪些内容来自已记录资料，避免把推测说成事实。引文由系统单独返回。`,
          );
        }
      } else {
      // 必须通过 core/knowledge/search.ts wrapper 调用；retriever 本身已按
      // workspace_id 过滤（防御深度），但 wrapper 仍负责抛 CrossWorkspaceAccessError
      // 给上层，避免泄露 ID 存在性。禁止直连 retriever 绕过 workspaceId 校验。
      //
      // AbortSignal 透传：用户停止 / 超时立即中断 Embedding API 上游 fetch。
      const retrieved = await searchKnowledgeBase(
        workspaceId,
        retrievalKnowledgeBaseId,
        prompt,
        5,
        input.abortSignal,
      );
      if (retrieved.length === 0 && usesKnowledgeBase) {
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
      }
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
    // Agent 通过 public Mastra 注册路径访问 storage。
    // `inlineTools` 必须由工厂显式传给 Agent.tools，不能依赖全局工具自动注入。
    //
    // 优先走 `resolvePerRequestAgent`：单元测试用 `_setPerRequestFactoryOverrideForTesting`
    // 注入 stub Agent 拦截 `agent.stream()` 选项，stub 不会被写进
    // Agent 注册表，也不会污染生产 `Mastra({ agents })` 的构造。
    const agent =
      resolvePerRequestAgent(agentId, inlineTools, skills, mastra) ??
      definition.factory(inlineTools, skills, mastra);
    // PR-3.3：构造 per-workspace 的 requireToolApproval 函数。
    // 该函数被 Mastra 在每次 Tool 调用前回调；返回 true → 触发
    // 'tool-call-approval' chunk + 挂起；false → 正常执行。
    const requireApproval = _requireApprovalOverride ?? buildRequireApproval({ workspaceId });
    const stream = await agent.stream(resolvedPrompt, {
      abortSignal,
      // Phase 3.0：Tool 子集过滤走 v1 公开 streamOptions。
      // v1 在执行期按 `activeTools` 白名单过滤；不传时该 Agent 可用
      // 其注册的全部 tool。
      ...(activeToolIds.length > 0 ? { activeTools: activeToolIds } : {}),
      // PR-3.3：把服务端策略感知的 requireToolApproval 注入 Mastra。
      requireToolApproval: requireApproval,
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
    try {
      // PR-3.3 — requesterId 必须非空；run executor 入口已校验
      // agent_runs.created_by，运行时透传。
      if (!input.runId) {
        yield { type: 'error', error: 'runId 缺失；streamAgent 必须由 run executor 调用。' };
        return;
      }
      if (!input.requesterId) {
        yield {
          type: 'error',
          error:
            'agent_runs.created_by 为 NULL；拒绝创建审批请求。',
        };
        return;
      }
      yield* consumeAgentStream(
        {
          workspaceId,
          runId: input.runId,
          requesterId: input.requesterId,
          abortSignal,
          citations,
        },
        stream.fullStream as AsyncIterable<unknown>,
      );
    } catch (error) {
      if ((error as Error).name === 'AbortError' || abortSignal.aborted) {
        yield { type: 'stopped', content: '' };
        return;
      }
      throw error;
    }
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

/**
 * 在事务内：
 *   1. INSERT tool_approval_requests（status='pending'）；
 *   2. INSERT agent_run_events(type='approval-requested')；
 *   3. UPDATE agent_runs SET status='waiting_approval', lease 清空。
 *
 * 三件事必须同事务——任何一步失败就回滚，避免"已写 approval 但 Run
 * 还在 running"的脑裂状态。
 *
 * requesterId 为 null 表示"系统主动发起的审批请求"——例如 run executor
 * 续 Run 时重建 approval row。nullable + ON DELETE SET NULL 已在
 * init.sql 阶段 3.3 段声明；这里直接透传 null 给 PG。
 */
async function persistApprovalRequested(args: {
  workspaceId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  inputsHash: string;
  inputsSummary: Record<string, unknown>;
  requesterId: string | null;
  expiresAt: string;
}): Promise<{
  id: string;
  runId: string;
  toolCallId: string;
  toolId: string;
  expiresAt: string;
}> {
  const pool = getDatabasePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 1. INSERT approval request
    const r = await client.query<Record<string, unknown>>(
      `INSERT INTO tool_approval_requests (
         workspace_id, run_id, tool_id, tool_call_id,
         inputs_hash, inputs_summary, status,
         requester_id, resolver_id, expires_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6::jsonb, 'pending',
         $7::uuid, $7::uuid, $8
       )
       RETURNING id, run_id, tool_call_id, tool_id, expires_at`,
      [
        args.workspaceId,
        args.runId,
        args.toolName,
        args.toolCallId,
        args.inputsHash,
        JSON.stringify(args.inputsSummary ?? {}),
        args.requesterId,
        args.expiresAt,
      ],
    );
    const approvalRow = r.rows[0]!;
    // 2. INSERT approval-requested event
    await insertRunEvent(client, {
      runId: args.runId,
      workspaceId: args.workspaceId,
      type: 'approval-requested',
      payload: {
        approvalId: approvalRow.id as string,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        inputsHash: args.inputsHash,
        expiresAt: args.expiresAt,
      },
    });
    // 3. UPDATE agent_runs → waiting_approval + 清 lease
    await client.query(
      `UPDATE agent_runs
          SET status = 'waiting_approval',
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND workspace_id = $2
          AND status IN ('queued', 'running')`,
      [args.runId, args.workspaceId],
    );
    await client.query('COMMIT');
    return {
      id: approvalRow.id as string,
      runId: approvalRow.run_id as string,
      toolCallId: approvalRow.tool_call_id as string,
      toolId: approvalRow.tool_id as string,
      expiresAt: new Date(approvalRow.expires_at as string).toISOString(),
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}
