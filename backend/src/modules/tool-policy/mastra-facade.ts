/**
 * PR-3.3 — 生产路径 Mastra facade 装配。
 *
 * `state-machine.ts` 的 resolveApproval / takeoverInflightApproval 必须能
 * 调 `agent.approveToolCall / agent.declineToolCall / agent.listSuspendedRuns`；
 * 而 facade 注入只能由"运行期 + 已加载 Mastra 单例"的代码完成，否则会
 * 触发循环 import（state-machine → facade → mastra/index.ts → bootstrap
 * → run executor → streamAgent → ...）。
 *
 * 这里采用与 `core/agent/runtime.ts` 相同的"lazy load + cache"模式：
 *   1. 默认路径调用方是单进程 server，由 `installProductionMastraFacade`
 *      在 import 副作用里启动后注入一次；
 *   2. 单元测试调用 `state-machine._setMastraFacadeForTesting(fake)` 完全
 *      绕过本模块，避免引入 `mastra/index.ts` 副作用。
 *
 * facade 接口与 state-machine 中的 `MastraAgentFacade` 对齐；本文件只
 * 做"拿到 mastra 实例 + 转发到对应 Agent 方法"。
 *
 * agentId 的解析：Mastra SDK 的 `approveToolCall / declineToolCall` 不带
 * agent 维度（仅 runId + toolCallId）。但我们的 Mastra 单例上
 * `getAgent(agentId)` 是按 Agent 注册表查的，所以仍需 runId → agentId
 * 的映射——从 `agent_runs.agent_id` 反查；本模块**不**直接 import runs
 * repository（避免循环），而是接受 `getAgentIdByRun` 回调注入。
 *
 * state-machine 把 `workspaceId` 透传到 SDK facade，本模块按 (workspaceId,
 * runId) 调用 `getAgentIdByRun`，避免单一 workspace 注入导致跨 workspace
 * Run 命中同一 Agent 注册表。
 *
 * PR-3.3 修订：listSuspendedRuns 是 **Agent 实例方法**（不是 Mastra 单例）。
 * 真实 Mastra 1.61 API：agent.listSuspendedRuns({ threadId, resourceId }) →
 * `{ runs: [...] }`。facade 必须按 (workspaceId, runId) 反查 agent_id 后
 * 拿到 Agent 实例，再调实例方法。
 */
import type {
  ListSuspendedRunsArgs,
  MastraAgentFacade,
  SuspendedRunSnapshot,
} from './state-machine.js';
import type { AgentListSuspendedRunsResult } from '@mastra/core/agent';

export interface ProductionFacadeDeps {
  /**
   * 通过 (workspaceId, runId) 反查 agent_id。生产路径来自
   * `agent_runs.agent_id`（带 workspace_id 过滤）；调用方在 install
   * facade 时注入。
   *
   * PR-3.3 — 返回 null 时**必须**抛错（`agent_run_not_found`），**不**再
   * 退化到 'general-chat' 兜底。原因：
   *   - 兜底会在跨 workspace 注入出错时让 SDK 调用打到错误的 Agent
   *     实例，造成静默越权；
   *   - 上层（HTTP / worker）必须能区分"Run 不存在" vs "Run 处于中间态"
   *     → fail-closed。
   */
  getAgentIdByRun: (
    workspaceId: string,
    runId: string,
  ) => Promise<string | null>;
}

let _productionFacade: MastraAgentFacade | null = null;
let _facadeLoadingPromise: Promise<MastraAgentFacade> | null = null;
let _depsOverride: ProductionFacadeDeps | null = null;

async function loadProductionMastraInstance(): Promise<unknown> {
  // 复用 runtime 的同一个 `mastra` 单例——避免重复初始化 storage / agents。
  // 这里延迟 import 是为了切断 modules ↔ mastra/index 的静态依赖；
  // `mastra/index.ts` 会在首次 `mastra dev` 时被 bootstrap 拉起。
  const mod = (await import('../../mastra/index.js')) as {
    mastra?: { getAgent?: (id: string) => unknown };
  };
  if (!mod.mastra || typeof mod.mastra.getAgent !== 'function') {
    throw new Error('production mastra 单例未加载或缺少 getAgent()。');
  }
  return mod.mastra;
}

interface ApproveLike {
  approveToolCall?: (args: { runId: string; toolCallId: string }) => Promise<{ fullStream: AsyncIterable<unknown> }>;
  declineToolCall?: (args: {
    runId: string;
    toolCallId: string;
    reason: string;
  }) => Promise<{ fullStream: AsyncIterable<unknown> }>;
  /**
   * PR-3.3 — Agent 实例方法（非 Mastra 单例方法）。返回 `{ runs: [...] }`。
   */
  listSuspendedRuns?: (args: {
    threadId: string;
    resourceId: string;
  }) => Promise<AgentListSuspendedRunsResult>;
}

function asAgent(value: unknown, agentId: string): ApproveLike {
  const agent = value as ApproveLike;
  if (
    !agent ||
    typeof agent.approveToolCall !== 'function' ||
    typeof agent.declineToolCall !== 'function' ||
    typeof agent.listSuspendedRuns !== 'function'
  ) {
    throw new Error(
      `Mastra Agent ${agentId} 不支持 approveToolCall/declineToolCall/listSuspendedRuns；` +
        '请检查 @mastra/core 版本是否 ≥1.61。',
    );
  }
  return agent;
}

/**
 * 校验 listSuspendedRuns 返回的快照是否合法。
 *
 * fail-closed 边界：
 *   - runId 必须存在；
 *   - threadId / resourceId 必须与传入的 threadId / resourceId 匹配
 *     （避免 SDK 返回跨 thread 的 stale 快照）；
 *   - 任意缺失或 mismatch → 抛错，禁止上层 fallback 到空数组。
 */
export function validateSuspendedRunsSnapshot(
  args: { threadId: string; resourceId: string; workspaceId: string },
  raw: AgentListSuspendedRunsResult | null | undefined,
): SuspendedRunSnapshot[] {
  if (!raw || !Array.isArray(raw.runs)) {
    throw new Error(
      'listSuspendedRuns: SDK 返回结构不符合 { runs: [...] }；fail-closed。',
    );
  }
  const filtered: SuspendedRunSnapshot[] = [];
  for (const r of raw.runs) {
    if (!r || typeof r.runId !== 'string' || r.runId.length === 0) {
      throw new Error(
        'listSuspendedRuns: 快照缺 runId；fail-closed，禁止静默空数组。',
      );
    }
    // toolCallId 必填：恢复路径必须用 (runId, toolCallId) 定位
    // suspended state。toolCallId 缺失 → fail-closed。
    if (!Array.isArray(r.toolCalls) || r.toolCalls.length === 0) {
      throw new Error(
        'listSuspendedRuns: 快照缺 toolCallId；fail-closed，禁止静默空数组。',
      );
    }
    if (r.threadId !== args.threadId) {
      throw new Error(
        `listSuspendedRuns: 快照 threadId=${r.threadId} 与查询 threadId=${args.threadId} 不一致；fail-closed。`,
      );
    }
    if (r.resourceId !== args.resourceId || args.resourceId !== args.workspaceId) {
      throw new Error(
        `listSuspendedRuns: 快照 resourceId=${r.resourceId} 与查询 resourceId=${args.resourceId} 不一致；fail-closed。`,
      );
    }
    if (r.status !== 'suspended') throw new Error('Expected suspended SDK snapshot');
    for (const call of r.toolCalls) {
      if (!call.requiresApproval || !call.toolCallId) throw new Error('Missing approval tool identity');
      filtered.push({ runId: r.runId, toolCallId: call.toolCallId, threadId: r.threadId, resourceId: r.resourceId, status: r.status });
    }
  }
  return filtered;
}

/**
 * 构造一个生产路径的 facade。**不**自动注入——调用方在希望"运行时
 * 调 SDK"的位置（如路由 handler、worker 入口）显式 await 后再
 * 写入 `_mastraFacadeOverride`（通过 state-machine 的 setProd API）。
 *
 * 调用方可以缓存本函数返回的对象；它内部对 mastra 单例是惰性求值。
 */
export async function buildProductionMastraFacade(
  deps: ProductionFacadeDeps,
): Promise<MastraAgentFacade> {
  if (_productionFacade && _depsOverride === deps) return _productionFacade;
  if (_facadeLoadingPromise && _depsOverride === deps) return _facadeLoadingPromise;
  _depsOverride = deps;
  _facadeLoadingPromise = (async () => {
    const mastra = await loadProductionMastraInstance();
    const facade: MastraAgentFacade = {
      approveToolCall: async ({ runId, toolCallId, workspaceId }) => {
        // PR-3.3 — workspaceId 是强必填。缺即抛错，**不**退化。
        if (!workspaceId) {
          throw new Error(
            'facade.approveToolCall: workspaceId 必填（fail-closed）。',
          );
        }
        const agentId = await resolveAgentId(deps, workspaceId, runId);
        const agent = asAgent(
          (mastra as { getAgent: (id: string) => unknown }).getAgent(agentId),
          agentId,
        );
        // Mastra 1.61 真实签名：返回 AsyncIterable<chunk>（resume stream）。
        return (await agent.approveToolCall!({ runId, toolCallId })).fullStream;
      },
      declineToolCall: async ({ runId, toolCallId, reason, workspaceId }) => {
        if (!workspaceId) {
          throw new Error(
            'facade.declineToolCall: workspaceId 必填（fail-closed）。',
          );
        }
        const agentId = await resolveAgentId(deps, workspaceId, runId);
        const agent = asAgent(
          (mastra as { getAgent: (id: string) => unknown }).getAgent(agentId),
          agentId,
        );
        return (await agent.declineToolCall!({ runId, toolCallId, reason })).fullStream;
      },
      listSuspendedRuns: async ({
        threadId,
        resourceId,
        workspaceId,
        agentId,
      }: ListSuspendedRunsArgs) => {
        // PR-3.3 — 跨重启恢复路径必须把 workspaceId 透传到 SDK；
        // 缺 workspaceId 等同不可验证 → 直接拒答，不退化到空数组
        // （避免上层 fail-open 收敛到 DB 视角而错失"该 Run 不属于该
        // workspace"的越权 sniff）。
        if (!workspaceId) {
          throw new Error(
            'facade.listSuspendedRuns: workspaceId 必填（fail-closed）。',
          );
        }
        if (!agentId) {
          throw new Error(
            'facade.listSuspendedRuns: agentId 必填（fail-closed）。',
          );
        }
        // PR-3.3 — listSuspendedRuns 是 Agent **实例**方法（非 Mastra
        // 单例方法）。agentId 由调用方（run executor）从 agent_runs.agent_id
        // 透传，避免 facade 反查 conversations（防止循环依赖）。
        const mod = (await import('../../mastra/index.js')) as {
          mastra?: {
            getAgent?: (id: string) => unknown;
          };
        };
        if (!mod.mastra || typeof mod.mastra.getAgent !== 'function') {
          throw new Error(
            'facade.listSuspendedRuns: mastra.getAgent 缺失；fail-closed。',
          );
        }
        const agent = asAgent(mod.mastra.getAgent(agentId), agentId);
        const raw = await agent.listSuspendedRuns!({ threadId, resourceId });
        return validateSuspendedRunsSnapshot(
          { threadId, resourceId, workspaceId },
          raw,
        );
      },
    };
    _productionFacade = facade;
    return facade;
  })();
  return _facadeLoadingPromise;
}

async function resolveAgentId(
  deps: ProductionFacadeDeps,
  workspaceId: string | undefined,
  runId: string,
): Promise<string> {
  // PR-3.3 — workspaceId 缺失时**不**再静默兜底；fail-closed。
  if (!workspaceId) {
    throw new Error(
      'resolveAgentId: state-machine 必须透传 workspaceId；缺失意味着 SDK 调用越权风险。',
    );
  }
  const agentId = await deps.getAgentIdByRun(workspaceId, runId);
  if (!agentId) {
    throw new Error(
      `agent_run_not_found: agent_runs(workspace_id=${workspaceId}, id=${runId}) 无对应记录；` +
        'fail-closed，不退化到 general-chat。',
    );
  }
  return agentId;
}

/**
 * 把生产 facade 注入到 state-machine。**仅**供路由 / worker 启动期调用。
 */
export async function installProductionMastraFacade(
  deps: ProductionFacadeDeps,
): Promise<MastraAgentFacade> {
  const facade = await buildProductionMastraFacade(deps);
  // 动态 import state-machine 以避免循环依赖；
  // _setMastraFacadeForTesting 是 state-machine 模块层的"注入 facade"
  // 函数，名字虽含 Testing 但被本模块复用为生产注入通道。
  const sm = await import('./state-machine.js');
  sm._setMastraFacadeForTesting(facade);
  return facade;
}

/**
 * 测试钩子：清空 production 单例缓存与 facade override。
 * **仅**供单元测试使用；生产代码绝不调用。
 */
export function _resetMastraFacadeForTesting(): void {
  _productionFacade = null;
  _facadeLoadingPromise = null;
  _depsOverride = null;
}
