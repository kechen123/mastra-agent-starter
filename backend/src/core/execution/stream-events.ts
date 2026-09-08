import type { Citation } from '../../modules/citations/types.js';

/**
 * Agent Runtime 与 HTTP 路由之间的内部流式协议。
 *
 * `server/routes/` 会把每个变体转成最小化的 SSE 事件：
 * - input/output/error 的完整内容只落到 `tool_executions` 等持久化表，
 *   不在 SSE 上回放，避免敏感内容泄露到前端。
 * - 该类型是 `core/agent/runtime.ts` ↔ HTTP 层之间的契约，
 *   修改前请同步更新 ask / regenerate 路由里的事件分发。
 */
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

/**
 * 工具调用进入"等待人工审批"挂起态——前端 / SSE 收到这个事件后
 * 展示"待审批"卡片；后端在事务内已经持久化 approval request，
 * 释放 Run lease，Run 进入 `waiting_approval`。
 */
export interface StreamApprovalRequested {
  type: 'approval-requested';
  approvalId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  /**
   * 已脱敏的输入摘要（结构化：每个 leaf 是 `{kind, preview, count?}`）。
   * 不含原始敏感输入。
   */
  inputsSummary: Record<string, unknown>;
  inputsHash: string;
  expiresAt: string;
}

export type StreamEvent =
  | StreamChunk
  | StreamResult
  | StreamStopped
  | StreamError
  | StreamToolCallStart
  | StreamToolCallComplete
  | StreamToolCallError
  | StreamApprovalRequested;