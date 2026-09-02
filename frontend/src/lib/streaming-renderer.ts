/**
 * 流式渲染状态机（PR-2.4 双通道 SSE 前端唯一权威实现）。
 *
 * 设计要点：
 *   - 单一权威目标文本 `targetText`：任何时候都代表"当前应该显示什么"。
 *   - rAF 只负责把 `targetText` 中尚未写入 React state 的部分逐 code point
 *     写出；网络到达的批次与视觉打字节奏彻底解耦，避免模型一次吐出多个
 *     token 时界面跳成一串文字。
 *   - `content-delta`（实时增量）：合并进 targetText 末尾。
 *   - `content-checkpoint`（持久化权威快照）：三种关系：
 *       1. targetText === checkpoint → no-op；
 *       2. targetText 仍是 checkpoint 的更长前缀扩展 → 保留 targetText；
 *       3. 其它（含非前缀）→ targetText = checkpoint。
 *   - 终态（completed / stopped / failed）：等 targetText 全部 flush 后
 *     切换 status；否则排队到下一次 flush。
 *
 * 该模块是纯函数 + 单一对象；不依赖 React，方便 vitest 单测。
 */

export type TerminalStatus = 'completed' | 'stopped' | 'failed';

export interface RendererState {
  /** 单一权威目标文本。 */
  targetText: string;
  /** 已经渲染到 React 的前缀长度——`renderedPrefixLength <= targetText.length`。 */
  renderedPrefixLength: number;
  /** 排队中的终态；非 null 时下一次 flush 后切换。 */
  pendingTerminal: TerminalStatus | null;
  /** 当前 rAF 句柄；用于取消。 */
  rafHandle: number | null;
}

export function createRendererState(): RendererState {
  return {
    targetText: '',
    renderedPrefixLength: 0,
    pendingTerminal: null,
    rafHandle: null,
  };
}

/** Renderer 与外部世界（DOM / React / raf）的接口。 */
export interface RendererOps {
  /** 写入 React 的最新全文（幂等：相同全文多次写入无副作用）。 */
  writeToDom(fullText: string): void;
  /** 切换终态 status（仅在 targetText 完全渲染后才调用）。 */
  setTerminalStatus(status: TerminalStatus): void;
  /** 排下一帧；返回 raf 句柄。 */
  scheduleRaf(cb: () => void): number;
  /** 取消 raf。 */
  cancelRaf(handle: number): void;
}

/**
 * 收 content-delta：合并进 targetText 末尾（实时增量永远按发送顺序到达，
 * 视为在已有文本末尾追加；不做额外前缀校验以保留简洁）。
 */
export function applyDelta(state: RendererState, text: string, ops: RendererOps): void {
  if (!text) return;
  state.targetText += text;
  scheduleFlush(state, ops);
}

/**
 * 收 content-checkpoint：权威收敛。
 *   - targetText === checkpoint → no-op；
 *   - targetText 已是 checkpoint 的更长前缀 → 保留 targetText（不允许回退）；
 *   - 其它（含非前缀 / checkpoint 更长）→ targetText = checkpoint，重置
 *     renderedPrefixLength 以从头渲染（语义不可比，宁可丢增量）。
 */
export function applyCheckpoint(state: RendererState, text: string, ops: RendererOps): void {
  if (text === state.targetText) return;
  // case 2：targetText 是 checkpoint 的更长前缀扩展。
  if (state.targetText.startsWith(text)) {
    scheduleFlush(state, ops);
    return;
  }
  // case 3：checkpoint 推进，或非前缀——统一收敛到 checkpoint。
  // 先记录"已经渲染过的文本"：它必然是 OLD targetText 的前缀。
  const prevRendered = state.targetText.slice(0, state.renderedPrefixLength);
  state.targetText = text;
  // 如果之前渲染过的不是新 targetText 的前缀（例如非前缀 checkpoint），
  // 必须从头渲染；否则保留 renderedPrefixLength，让 flush 只写差量。
  if (!text.startsWith(prevRendered)) {
    state.renderedPrefixLength = 0;
  }
  scheduleFlush(state, ops);
}

/** 排队终态；下一次 flush 时若已全部渲染就切换 status。 */
export function markTerminal(state: RendererState, status: TerminalStatus, ops: RendererOps): void {
  state.pendingTerminal = status;
  scheduleFlush(state, ops);
}

/** 重置 renderer：清空所有状态、取消 pending raf。 */
export function resetRenderer(state: RendererState, ops: RendererOps): void {
  if (state.rafHandle !== null) {
    ops.cancelRaf(state.rafHandle);
    state.rafHandle = null;
  }
  state.targetText = '';
  state.renderedPrefixLength = 0;
  state.pendingTerminal = null;
}

/**
 * rAF flush：每帧只把一个 Unicode code point 写入 React。
 *
 * `targetText` 使用 UTF-16 字符串，`renderedPrefixLength` 因而也必须保留
 * UTF-16 offset；不能用 `charAt`，否则 emoji 会被拆成两个不可见的 surrogate
 * 更新。网络层可以一次送来任意大小的 delta，但用户始终看到均匀的字符推进。
 */
export function flush(state: RendererState, ops: RendererOps): void {
  state.rafHandle = null;
  if (state.renderedPrefixLength < state.targetText.length) {
    const codePoint = state.targetText.codePointAt(state.renderedPrefixLength)!;
    state.renderedPrefixLength += codePoint > 0xFFFF ? 2 : 1;
    ops.writeToDom(state.targetText.slice(0, state.renderedPrefixLength));
    // 尚有待显示字符时继续排下一帧。不要在一个 rAF 内清空积压，
    // 否则 30ms 的服务端批次仍会在界面上表现为成串跳字。
    if (state.renderedPrefixLength < state.targetText.length) {
      scheduleFlush(state, ops);
      return;
    }
  }
  if (state.pendingTerminal !== null) {
    const status = state.pendingTerminal;
    state.pendingTerminal = null;
    ops.setTerminalStatus(status);
  }
}

function scheduleFlush(state: RendererState, ops: RendererOps): void {
  if (state.rafHandle !== null) return;
  state.rafHandle = ops.scheduleRaf(() => flush(state, ops));
}
