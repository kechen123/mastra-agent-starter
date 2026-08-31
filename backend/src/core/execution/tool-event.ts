/**
 * ask / regenerate 路由共用的工具调用事件处理。
 *
 * HTTP 层绝对不能把 `input` / `output` / 原始 error 字符串透传给客户端——
 * 这些内容只落到 `tool_executions` 表。仅 `toolCallId` / `toolName` /
 * `status`（加上固定的 `safeErrorCode`）可以走 SSE。
 *
 * V2.3.6 §5.1：所有 `tool_executions` 写入必须携带 `workspaceId`——
 * `createToolExecution` / `finalizeToolExecution`（Task 9）已经把
 * `workspace_id` 列为必填首参，本文件把 `workspaceId` 透传给 sink，
 * 再由 sink 透传给底层 `tool-executions.ts` 模块。`conversationId`
 * 在新链路里不再需要：`createToolExecution` 通过 message_id 反查父
 * 工作区，省去了对话级二次校验。
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
    workspaceId: string,
    messageId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string>;
  finalizeToolExecution(
    workspaceId: string,
    id: string,
    output: Record<string, unknown>,
    status: 'completed' | 'failed',
    errorCode?: string,
  ): Promise<void>;
}

const productionSink: ToolExecutionSink = {
  async createToolExecution(workspaceId, messageId, toolName, input) {
    // workspaceId 必填（Task 9 已重排签名）；conversationId 不再需要——
    // 底层按 messageId + workspaceId 反查父 message 完成跨工作区校验。
    return createToolExecution(workspaceId, messageId, toolName, input);
  },
  async finalizeToolExecution(workspaceId, id, output, status, errorCode) {
    await finalizeToolExecution(workspaceId, id, output, status === 'completed' ? 'success' : 'error', errorCode);
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
 *
 * `workspaceId` 必填（V2.3.6 §5.1）——所有 `tool_executions` 写入的父
 * 资源（message）校验由底层 `createToolExecution` / `finalizeToolExecution`
 * 完成，传入的 workspaceId 必须与 message 所属工作区一致。
 */
export async function handleToolEvent(
  event: ToolStreamEvent,
  workspaceId: string,
  assistantMessageId: string,
  toolExecutionMap: Map<string, string>,
  sse: SseController,
): Promise<void> {
  if (event.type === 'tool-call-start') {
    try {
      const execId = await activeSink.createToolExecution(
        workspaceId,
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
        await activeSink.finalizeToolExecution(workspaceId, execId, event.output, 'completed');
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
      await activeSink.finalizeToolExecution(workspaceId, execId, {}, 'failed', SAFE_TOOL_ERROR_CODE);
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
 *
 * V2.3.6 §5.1：`ctx` 现在强制携带 `workspaceId`；所有 tool-call 写入
 * 路径都把 workspaceId 透传给 `handleToolEvent` → `ToolExecutionSink` →
 * `tool-executions.ts`，保证跨工作区访问会以 404 抛出。
 */
export async function dispatchStreamEvent(
  event: StreamEvent,
  ctx: {
    workspaceId: string;
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
    await handleToolEvent(event, ctx.workspaceId, ctx.assistantMessageId, ctx.toolExecutionMap, ctx.sse);
    return;
  }

  // done / stopped / error 由调用方负责 `finalizeMessage`：
  // 调用方持有 citations / errorMessage 的闭包值。
  // 本函数只返回，让 for-await 主体 break 出去。
  if (event.type === 'done' || event.type === 'stopped' || event.type === 'error') {
    return;
  }
}
