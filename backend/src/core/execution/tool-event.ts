/**
 * ask / regenerate 路由共用的工具调用事件处理（legacy / V1 兼容路径）。
 *
 * HTTP 层绝对不能把 `input` / `output` / 原始 error 字符串透传给客户端——
 * 这些内容只落到 `tool_executions` 表。仅 `toolCallId` / `toolName` /
 * `status`（加上固定的 `safeErrorCode`）可以走 SSE。
 *
 * V2.3.6 §5.1：所有 `tool_executions` 写入必须携带 `workspaceId`。
 *
 * 注意：本文件是 V1 ask / regenerate 兼容路径。V2 run-executor 已切换到
 * `upsertToolExecution` / `finalizeToolExecutionByCallId`（按 toolCallId
 * 幂等 upsert）。legacy 路径也保持同样的稳定 ID 语义。
 */
import {
  upsertToolExecution,
  finalizeToolExecutionByCallId,
} from '../../modules/conversations/tool-executions.js';
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
  /** upsert by toolCallId：返回 DB id（仅做兼容日志用，新路径不再依赖）。 */
  createToolExecution(
    workspaceId: string,
    messageId: string,
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
  ): Promise<string>;
  finalizeToolExecution(
    workspaceId: string,
    toolCallId: string,
    output: Record<string, unknown> | null,
    status: 'completed' | 'failed',
    errorCode?: string,
    /** backfill 缺失 start 行时必填：toolName + messageId。 */
    backfillHint?: { toolName: string; messageId: string },
  ): Promise<void>;
}

const productionSink: ToolExecutionSink = {
  async createToolExecution(workspaceId, messageId, toolName, toolCallId, input) {
    // V2 阶段 2：toolCallId 是稳定的业务 ID；upsert 同 toolCallId 幂等。
    return upsertToolExecution({
      workspaceId,
      messageId,
      runId: null,
      toolCallId,
      toolName,
      args: input,
    });
  },
  async finalizeToolExecution(workspaceId, toolCallId, output, status, errorCode, backfillHint) {
    await finalizeToolExecutionByCallId({
      workspaceId,
      runId: null,
      toolCallId,
      result: output,
      status: status === 'completed' ? 'success' : 'error',
      error: errorCode,
      // legacy sink 没有 runId 关联，backfill 必须由调用方显式提供
      // messageId + toolName（PR-review Item 4 强制要求）。
      ...(backfillHint ?? {}),
    });
  },
};

let activeSink: ToolExecutionSink = productionSink;

/** @internal 测试钩子：注入内存假 sink，避免连接真实 DB。 */
export function _setToolExecutionSinkForTesting(sink: ToolExecutionSink | null): void {
  activeSink = sink ?? productionSink;
}

/**
 * 写入工具执行行 + 推送安全的 SSE 载荷。
 *
 * V2 阶段 2：稳定 ID = toolCallId；事件 replay 重复调用不重复 INSERT。
 *
 * DB 写入异常被吞掉（仅日志记录）——瞬时 DB 抖动不应中断整条 SSE 流。
 *
 * `workspaceId` 必填（V2.3.6 §5.1）——所有 `tool_executions` 写入的父
 * 资源（message）校验由底层 `upsertToolExecution` 完成。
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
        event.toolCallId,
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
    // finalize by toolCallId：缺失 start 行也能安全收敛；事件 replay 不重复写。
    // backfillHint 让 finalize 在行不存在时也能落审计行（PR-review Item 4）。
    try {
      await activeSink.finalizeToolExecution(
        workspaceId,
        event.toolCallId,
        event.output,
        'completed',
        undefined,
        { toolName: event.toolName, messageId: assistantMessageId },
      );
    } catch (err) {
      console.error('Tool execution finalize failed:', err);
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
  try {
    await activeSink.finalizeToolExecution(
      workspaceId,
      event.toolCallId,
      null,
      'failed',
      SAFE_TOOL_ERROR_CODE,
      { toolName: event.toolName, messageId: assistantMessageId },
    );
  } catch (err) {
    console.error('Tool execution finalize failed:', err);
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
