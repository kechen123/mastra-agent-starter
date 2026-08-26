/**
 * ask / regenerate 路由共用的工具调用事件处理。
 *
 * HTTP 层绝对不能把 `input` / `output` / 原始 error 字符串透传给客户端——
 * 这些内容只落到 `tool_executions` 表。仅 `toolCallId` / `toolName` /
 * `status`（加上固定的 `safeErrorCode`）可以走 SSE。
 */
import { createToolExecution, finalizeToolExecution } from '../../modules/conversations/tool-executions.js';
import type { StreamEvent } from './stream-events.js';
import type { SseController } from './sse.js';

type ToolStreamEvent = Extract<
  StreamEvent,
  { type: 'tool-call-start' | 'tool-call-complete' | 'tool-call-error' }
>;

/** 最小化安全错误码：固定值，不暴露真实错误文本。 */
export const SAFE_TOOL_ERROR_CODE = 'tool_error';

/** 可注入的工具执行写入器；测试可注入内存假实现以避免连接真实 DB。 */
export interface ToolExecutionSink {
  createToolExecution(
    conversationId: string,
    messageId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string>;
  finalizeToolExecution(
    id: string,
    output: Record<string, unknown>,
    status: 'completed' | 'failed',
    errorCode?: string,
  ): Promise<void>;
}

const productionSink: ToolExecutionSink = {
  async createToolExecution(conversationId, messageId, toolName, input) {
    return createToolExecution(conversationId, messageId, toolName, input);
  },
  async finalizeToolExecution(id, output, status, errorCode) {
    await finalizeToolExecution(id, output, status, errorCode);
  },
};

let activeSink: ToolExecutionSink = productionSink;

/** @internal 测试钩子：注入内存假 sink，避免连接真实 DB。 */
export function _setToolExecutionSinkForTesting(sink: ToolExecutionSink | null): void {
  activeSink = sink ?? productionSink;
}

/**
 * 写入工具执行行 + 推送安全的 SSE 载荷。`toolExecutionMap` 由调用方持有，
 * 保证 tool-call-id ↔ DB-row id 在 start / complete / error 之间一致。
 *
 * DB 写入异常被吞掉（仅日志记录）——瞬时 DB 抖动不应中断整条 SSE 流。
 */
export async function handleToolEvent(
  event: ToolStreamEvent,
  _conversationId: string,
  assistantMessageId: string,
  toolExecutionMap: Map<string, string>,
  sse: SseController,
): Promise<void> {
  if (event.type === 'tool-call-start') {
    try {
      const execId = await activeSink.createToolExecution(
        _conversationId,
        assistantMessageId,
        event.toolName,
        event.input,
      );
      toolExecutionMap.set(event.toolCallId, execId);
    } catch (err) {
      console.error('Tool execution create failed:', err);
    }
    try {
      sse.send('tool-call-start', {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: 'running',
      });
    } catch {
      // 客户端可能已断开连接
    }
    return;
  }

  if (event.type === 'tool-call-complete') {
    const execId = toolExecutionMap.get(event.toolCallId);
    if (execId) {
      try {
        await activeSink.finalizeToolExecution(execId, event.output, 'completed');
      } catch (err) {
        console.error('Tool execution finalize failed:', err);
      }
    }
    try {
      sse.send('tool-call-complete', {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: 'completed',
      });
    } catch {
      // 客户端可能已断开连接
    }
    return;
  }

  // tool-call-error
  const execId = toolExecutionMap.get(event.toolCallId);
  if (execId) {
    try {
      await activeSink.finalizeToolExecution(execId, {}, 'failed', SAFE_TOOL_ERROR_CODE);
    } catch (err) {
      console.error('Tool execution finalize failed:', err);
    }
  }
  try {
    sse.send('tool-call-error', {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: 'failed',
      errorCode: SAFE_TOOL_ERROR_CODE,
    });
  } catch {
    // 客户端可能已断开连接
  }
}

/**
 * 把单个 StreamEvent 分发到对应的处理逻辑。ask / regenerate 的 SSE
 * `for-await` 循环都通过本函数统一事件分支，避免分支梯重复维护。
 */
export async function dispatchStreamEvent(
  event: StreamEvent,
  ctx: {
    conversationId: string;
    assistantMessageId: string;
    fullTextRef: { current: string };
    toolExecutionMap: Map<string, string>;
    sse: SseController;
  },
): Promise<void> {
  if (event.type === 'delta') {
    ctx.fullTextRef.current += event.text;
    try {
      ctx.sse.send('content-delta', { messageId: ctx.assistantMessageId, text: event.text });
    } catch {
      // 客户端可能已断开，仍继续累积文本用于持久化
    }
    return;
  }

  if (event.type === 'tool-call-start' || event.type === 'tool-call-complete' || event.type === 'tool-call-error') {
    await handleToolEvent(event, ctx.conversationId, ctx.assistantMessageId, ctx.toolExecutionMap, ctx.sse);
    return;
  }

  // done / stopped / error 由调用方负责 `finalizeMessage`：
  // 调用方持有 citations / errorMessage 的闭包值。
  // 本函数只返回，让 for-await 主体 break 出去。
  if (event.type === 'done' || event.type === 'stopped' || event.type === 'error') {
    return;
  }
}
