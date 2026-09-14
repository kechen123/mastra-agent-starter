/**
 * V2 停止 / 终态收敛状态机（前端纯逻辑模块）。
 *
 * 解决的问题：
 *   - SSE 终端事件 run-stopped 与 HTTP POST /messages/:id/stop 两条路径
 *     都可能触发 finalize；二者**任意顺序**到达必须都能安全完成同一终态
 *     收敛（幂等），不得重复设置状态、不得抛出。
 *   - 切换会话 / 打开知识库 / 能力页：仅关闭当前页面 EventSource，
 *     **不能**调用后端 stop；旧 Run 仍可在后端继续完成，下次切回同一会话
 *     由 currentRunId + lastEventId 续上。
 *   - "停止生成"按钮：必须显式调用 stop；
 *     HTTP 返回 200 后**不能**立即关 EventSource —— 必须等待 run-stopped
 *     终态事件完成最终收敛（contentLength / 引用 / status）。
 *     否则提前关流会丢失 run-stopped 终态事件，导致 UI 状态与后端
 *     message.content 不同步。
 *
 * 本模块**不**依赖 React / EventSource —— 单测可直接 `tsx` 跑。
 *
 * Run with: npx tsx src/lib/stop-state-machine.test.ts
 */

export type AssistantStatus = 'pending' | 'streaming' | 'completed' | 'stopped' | 'failed';

/**
 * 终态收敛触发源（哪条路径先到都行，二者幂等）。
 *
 * 状态机在每条 kind 上独立维护收敛语义（PR-review Item 2 修复：HTTP 失败
 * 不再错误地翻成 stopped）：
 *   - 'http_stop_ok' : POST /messages/:id/stop 返回 200。完成独立 finalize
 *                      路径（assistant=stopped, isAsking=false, refs 收敛,
 *                      EventSource 安全可关）。
 *   - 'sse_stopped'  : SSE run-stopped 事件到达。已 finalized 时为幂等 no-op。
 *   - 'http_stop_fail': HTTP 失败 → 上层展示 chatError；finalized 仍保持
 *                      false 等 SSE 终态事件兜底。
 *   - 'session_leave': 用户离开当前会话 / 切换页面，**仅**关闭当前页面
 *                      EventSource；**不**调后端 stop；oldRunId 留在后端
 *                      继续完成。
 *   - 'stop_requested': 用户点了"停止生成"，HTTP 正在路上；闸门翻 true
 *                      但 status 不变，避免在 HTTP 失败时错误进入终态。
 */
export type FinalizeKind =
  | 'http_stop_ok'
  | 'sse_stopped'
  | 'http_stop_fail'
  | 'session_leave'
  | 'stop_requested';

/**
 * 单个 assistant message 的纯状态片段（解耦 React state shape，
 * 让本模块可纯函数单测）。
 */
export interface AssistantStopState {
  assistantId: string;
  runId: string | null;
  status: AssistantStatus;
  /** 累积到当前的 targetText（用于 stop 时把内容写回 React state）。 */
  content: string;
  /** 已收到过任意形式的终态收敛信号（幂等闸门）。 */
  finalized: boolean;
  /** 终态来源（用于日志 / 调试；幂等收敛时保留首次来源）。 */
  finalizedBy: FinalizeKind | null;
  /** 用户**显式**点击过"停止生成"——session switch 期间必须保留
   *  EventSource 直到 run-stopped 到达；与 finalized 解耦：HTTP 失败时
   *  finalized=false，但 isStopRequested 仍为 true。 */
  isStopRequested: boolean;
  /** HTTP 失败是否已被上层用 chatError 告知用户；防止重复报错。 */
  hasReportedHttpFailure: boolean;
}

export function createAssistantStopState(args: {
  assistantId: string;
  runId: string | null;
  initialStatus?: AssistantStatus;
  initialContent?: string;
}): AssistantStopState {
  return {
    assistantId: args.assistantId,
    runId: args.runId,
    status: args.initialStatus ?? 'streaming',
    content: args.initialContent ?? '',
    finalized: false,
    finalizedBy: null,
    isStopRequested: false,
    hasReportedHttpFailure: false,
  };
}

/**
 * 收敛到 stopped 终态的纯函数。
 *
 * 规则（PR-review Item 2 修复）：
 *   - 已 finalized === true 且 kind 不是 session_leave → 幂等 no-op。
 *   - session_leave：标记 finalized=true 但**不**改 status；下次回到同一
 *     assistant 仍可在后端继续，由 currentRunId + lastEventId 续上。
 *   - http_stop_fail：翻 isStopRequested / hasReportedHttpFailure，不翻
 *     finalized（HTTP 失败但 SSE 仍可能兜底到达 run-stopped）。
 *   - stop_requested：仅翻 isStopRequested，status / finalized 不动。
 *   - http_stop_ok 与 sse_stopped：等价地把 status 切到 'stopped'，
 *     finalized=true。后续再到的另一条路径会走幂等 no-op。
 *
 * 返回**新** state（不可变更新），方便 React setState 直接替换。
 */
export function finalizeAssistantStop(
  state: AssistantStopState,
  kind: FinalizeKind,
  options?: { content?: string; runId?: string },
): AssistantStopState {
  // 已经收敛过：除 session_leave 之外的其它 kind 都必须 no-op。
  if (state.finalized && kind !== 'session_leave') {
    return state;
  }

  // session_leave 不强制改 status；只翻 finalized 闸门避免重复 close。
  if (kind === 'session_leave') {
    return { ...state, finalized: true, finalizedBy: 'session_leave' };
  }

  // HTTP 失败路径：保留 finalized=false（让 SSE 仍可兜底）。
  if (kind === 'http_stop_fail') {
    return {
      ...state,
      isStopRequested: true,
      hasReportedHttpFailure: true,
      finalizedBy: state.finalized ? state.finalizedBy : 'http_stop_fail',
    };
  }

  // 用户点"停止" 但 HTTP 还在路上：仅翻请求闸门，不翻 finalized。
  if (kind === 'stop_requested') {
    return {
      ...state,
      isStopRequested: true,
      finalizedBy: state.finalized ? state.finalizedBy : 'stop_requested',
    };
  }

  return {
    ...state,
    status: 'stopped',
    content: options?.content ?? state.content,
    runId: options?.runId ?? state.runId,
    finalized: true,
    isStopRequested: true,
    finalizedBy: kind,
  };
}

/**
 * SSE 终态事件到达时的语义：来自 run-completed / run-stopped / run-failed
 * 都属于"sse 终态"，但 completed 与 failed 不走本模块（走 React 自身的
 * SSE 终态分支），run-stopped 才进入本状态机。
 *
 * 返回 'apply' 时调用方应 finalizeAssistantStop(state, 'sse_stopped', ...)；
 * 返回 'duplicate' 时直接 no-op（HTTP 已先到，状态机已 finalized）。
 */
export function resolveSseStoppedAction(
  state: AssistantStopState,
): 'apply' | 'duplicate' {
  return state.finalized ? 'duplicate' : 'apply';
}

/**
 * "用户离开当前页面"的判定：返回 true 表示调用方应当仅关闭当前页面
 * EventSource、**不**调后端 stop、**不**改 status。
 *
 * 关键约束（PR-review Round 2 Item 5）：
 *   页面级 EventSource detach 永远应该允许。即使 isStopRequested=true
 *   且 finalized=false（HTTP 失败 / 等待 SSE），只要用户在当前 assistant
 *   页面上停留时间结束、切换会话 / 知识库 / 能力页 / 关闭标签，后端 Run
 *   仍可在服务端自然完成，下次切回同一会话由 currentRunId + lastEventId
 *   续上，**不需要**前端的 EventSource 监听兜底。
 *
 *   仅在用户**仍停留在同一 assistant**上时才需要保留 EventSource
 *   等 run-stopped（这是 awaitingRunStoppedOnPage 的语义，不是
 *   session-leave 的语义）。两个职责必须解耦。
 */
export function shouldCloseStreamOnly(args: {
  isStreaming: boolean;
  isStopRequested: boolean;
  /** 当前 assistant 是否处于"已 finalize"状态；finalized=true 时即便
   *  isStopRequested 也不必保留 EventSource。 */
  isFinalized: boolean;
}): boolean {
  // 仍在 streaming 但没显式点停止 → 仅本地关闭 SSE，让旧 Run 在后端
  // 自然完成；下次回到该会话由 currentRunId 续上。
  // PR-review Round 2 Item 5 修复：即使 isStopRequested=true + !finalized
  // 也允许 session-leave 关闭页面 EventSource——后端 Run 继续完成即可，
  // 旧会话事件不应再写入新页面。
  return args.isStreaming || args.isStopRequested;
}

/**
 * "用户停留在当前 assistant 页面等待 SSE run-stopped 终态事件"的判定。
 *
 * 与 shouldCloseStreamOnly 互补：
 *   - shouldCloseStreamOnly 管"是否允许页面级 EventSource detach"；
 *   - awaitingRunStoppedOnPage 管"当前 assistant 页面是否还要继续监听
 *     SSE run-stopped 以收敛最终 contentLength / citations"。
 *
 * 返回 true 时：调用方应当保持 EventSource 打开，等待 SSE run-stopped
 * 携带权威 contentLength + citations 收敛。
 */
export function awaitingRunStoppedOnPage(args: {
  isStopRequested: boolean;
  isFinalized: boolean;
  hasStreamingAssistant: boolean;
}): boolean {
  // 只有在"用户显式请求停止且未 finalize、且仍停留在该 assistant 页面"
  // 这三条件同时满足时，才需要等 SSE run-stopped 兜底。
  if (!args.hasStreamingAssistant) return false;
  if (!args.isStopRequested) return false;
  if (args.isFinalized) return false;
  return true;
}

/**
 * 共享的幂等终态收敛函数（PR-review Round 3 Item 1 + Round 4 SSE/HTTP 竞态修复）。
 *
 * 关键约束（PR-review Round 4 新增）：
 *   `state` 参数允许为 `null`。语义是"SSE handler 已经做过收尾
 *   并把 ref 清空 / 复位"，此时 HTTP 恢复路径（await stopMessage()
 *   之后才 resolve）必须返回 `applied=false`，调用方**不应**执行
 *   任何 React / EventSource 副作用（setState / 关流）。这是为了
 *   避免 SSE-first-then-HTTP 顺序下的 null 解引用和重复副作用。
 *
 * 调用方契约：
 *   1. SSE handler 调 `applyTerminalSnapshot(state, { kind: 'sse_stopped' })`
 *      → 收到 `applied=true` 时才执行 markTerminalToRenderer / 关流
 *        / 清 runStreamRef，并把 state 写回 stopStateRef（**不**清空，
 *        保留 finalized=true 作为后续 HTTP 恢复路径的幂等闸门）。
 *      → 收到 `applied=false` 时什么都不做（已 finalized，无副作用）。
 *   2. HTTP handler（handleStop）调 `applyTerminalSnapshot(state,
 *      { kind: 'http_stop_ok' })`
 *      → 收到 `applied=true` 时执行 setMessages / setIsAsking /
 *        关流，并写回 state。
  *      → 收到 `applied=false` 时不重复状态、输入框或 EventSource
  *        副作用；若迟到 HTTP 携带非空 citations，调用方仍可补齐引用。
  *        **不**进入失败路径、**不**做 chatError 上报——失败路径必须由
  *        HTTP 请求本身的 reject 触发，而不是"看起来没 finalize"就误报失败。
 *
 * 返回 `{ applied, state, citationsChanged }`：
 *   - `applied`     本次调用是否产生了新的收敛（第一次收敛或 SSE 带新
 *                   citations 的更新）。
 *   - `state`       调用后的 state（无新收敛时仍返回旧 state，便于
 *                   调用方直接 `stopStateRef.current = result.state`）。
 *   - `citationsChanged`
 *                   SSE 带新 citations / HTTP 带 citations 时为 true，
 *                   调用方应触发 updateStreamingAssistantCitations。
 */
export interface TerminalSnapshot {
  content: string;
  contentLength: number;
  citations: ReadonlyArray<unknown>;
}

export type SharedFinalizeSource =
  | { kind: 'http_stop_ok'; snapshot: TerminalSnapshot }
  | { kind: 'sse_stopped'; snapshot: TerminalSnapshot };

export interface ApplyTerminalSnapshotResult {
  /** true 表示本次调用产生了收敛副作用；false 表示幂等 no-op。 */
  applied: boolean;
  /** 调用后的 state；调用方写回 stopStateRef.current。无 state（null
   *  输入且未收敛）时仍为 null。 */
  state: AssistantStopState | null;
  /** incoming citations 非空时为 true；调用方触发 citations 应用。 */
  citationsChanged: boolean;
}

export function applyTerminalSnapshot(
  state: AssistantStopState | null,
  source: SharedFinalizeSource,
): ApplyTerminalSnapshotResult {
  // SSE-first-then-HTTP 顺序的 HTTP 恢复路径：
  //   SSE 已 finalize，但 SSE handler 不应清空 state（保留 finalized=true
  //   闸门）。若调用方真的传 null → 视为"状态已被清理"，HTTP 必须
  //   完全无副作用 no-op，**不**进入失败路径（fail 路径会做
  //   setChatError / 二次关流等，与 SSE 已 finalize 的事实冲突）。
  if (state === null) {
    return { applied: false, state: null, citationsChanged: false };
  }
  if (state.finalized) {
    // SSE 留 state、HTTP 后到 / HTTP 留 state、SSE 后到 → 收敛侧
    // 已发生；仅当 incoming citations 非空时仍要 apply 一次。
    const incomingCitations = source.snapshot.citations;
    if (Array.isArray(incomingCitations) && incomingCitations.length > 0) {
      return { state, citationsChanged: true, applied: false };
    }
    return { state, citationsChanged: false, applied: false };
  }
  const newState = finalizeAssistantStop(state, source.kind, {
    content: source.snapshot.content,
    runId: source.kind === 'http_stop_ok' ? state.runId ?? undefined : undefined,
  });
  return {
    state: newState,
    citationsChanged: Array.isArray(source.snapshot.citations) && source.snapshot.citations.length > 0,
    applied: true,
  };
}
