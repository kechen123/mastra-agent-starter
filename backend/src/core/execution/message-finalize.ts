/**
 * 共享消息 / 工具执行终态收敛逻辑（SSE 流的最终阶段）。
 *
 * ask / regenerate 都遵循同一套协议：
 *   1. 把 DB 行更新为终态（completed / stopped / failed）；
 *   2. 把最小化的 `message-complete` / `message-error` 事件推送给客户端；
 *   3. 收敛仍处于 running 的 `tool_executions` 行；
 *   4. 在 `finally` 块里调用 `sweepRunningToolExecutions` 兜底，避免漏行。
 *
 * 终态协议对外保证：
 *   - 同一 `assistantMessageId` 只能产出一次终态事件；
 *   - 终态事件名固定为 `message-complete`（completed / stopped）或
 *     `message-error`（failed）；
 *   - 工具事件上行的 `errorCode` 恒为 SAFE_TOOL_ERROR_CODE（不暴露原始错误）。
 *
 * DB 写入通过可注入的 `MessageFinalizer` 接口进行；生产路径默认指向
 * `finalizeAssistant` / `convergeRunningToolExecutions`，测试路径可注入
 * 内存假实现（见 `_setMessageFinalizerForTesting`）。
 */
import { finalizeAssistant } from '../../modules/conversations/service.js';
import {
  convergeRunningToolExecutions,
} from '../../modules/conversations/tool-executions.js';
import type { Message } from '../../modules/conversations/types.js';
import type { SseController } from './sse.js';
import type { Citation } from '../../modules/citations/types.js';

export type TerminalStatus = 'completed' | 'stopped' | 'failed';

export interface FinalizeSuccess {
  terminal: 'completed' | 'stopped';
  content: string;
  citations: Citation[];
  fullText: string;
}
export interface FinalizeError {
  terminal: 'failed';
  fullText: string;
  errorMessage: string;
}

export type FinalizeInput = FinalizeSuccess | FinalizeError;

/** 可注入的"终态写入器"接口。生产实现走 DB；测试实现走内存假实现。 */
export interface MessageFinalizer {
  finalizeAssistant(
    id: string,
    content: string,
    citations: Citation[],
    terminal: 'completed' | 'stopped' | 'failed',
  ): Promise<Message>;
  convergeRunningToolExecutions(
    messageId: string,
    terminal: 'stopped' | 'failed',
    reason?: string,
  ): Promise<number>;
}

const productionFinalizer: MessageFinalizer = {
  async finalizeAssistant(id, content, citations, terminal) {
    return finalizeAssistant(id, content, citations, terminal);
  },
  async convergeRunningToolExecutions(messageId, terminal, reason) {
    return convergeRunningToolExecutions(messageId, terminal, reason);
  },
};

let activeFinalizer: MessageFinalizer = productionFinalizer;

/** @internal 测试钩子：注入内存假 finalizer，避免连接真实 DB。 */
export function _setMessageFinalizerForTesting(finalizer: MessageFinalizer | null): void {
  activeFinalizer = finalizer ?? productionFinalizer;
}

function isError(input: FinalizeInput): input is FinalizeError {
  return input.terminal === 'failed';
}

/**
 * 把助手消息收敛到终态：写 DB + 推 SSE + 收敛仍 running 的工具执行。
 *
 * 调用方期望：
 *   - 即便 DB 写入失败（行已被并发终态化等），SSE 仍必须 emit 一次终态事件，
 *     否则客户端会一直挂在等待 `message-complete` 上。
 *   - 终态事件字段必须和 DB 行内容一致（content / citations / status）。
 */
export async function finalizeMessage(
  assistantMessageId: string,
  input: FinalizeInput,
  sse: SseController,
): Promise<void> {
  if (isError(input)) {
    try {
      await activeFinalizer.finalizeAssistant(assistantMessageId, input.fullText, [], 'failed');
    } catch {
      // 静默忽略：消息已经处于终态或被并发请求处理
    }
    try {
      sse.send('message-error', {
        id: assistantMessageId,
        role: 'assistant',
        content: input.fullText,
        citations: [],
        status: 'failed',
        error: { message: input.errorMessage },
      });
    } catch {
      // 流已关闭
    }
    return;
  }

  try {
    const finalized = await activeFinalizer.finalizeAssistant(
      assistantMessageId,
      input.content,
      input.citations,
      input.terminal,
    );
    try {
      sse.send('message-complete', {
        id: finalized.id,
        role: finalized.role,
        content: finalized.content,
        citations: finalized.citations,
        status: finalized.status,
        createdAt: typeof finalized.createdAt === 'string'
          ? finalized.createdAt
          : new Date(finalized.createdAt).toISOString(),
      });
    } catch {
      // 流已关闭
    }
  } catch {
    // finalizeAssistant 失败：仍需推一次终态事件，避免客户端一直挂在
    // 等待 `message-complete` 上。
    try {
      sse.send(input.terminal === 'stopped' ? 'message-complete' : 'message-error', {
        id: assistantMessageId,
        role: 'assistant',
        content: input.content,
        citations: input.citations,
        status: input.terminal,
      });
    } catch {
      // 流已关闭
    }
  }
}

/**
 * 紧急路径：流循环内部抛出异常。区分 Abort 与真实错误并收敛 DB 行。
 */
export async function finalizeAfterStreamError(
  assistantMessageId: string,
  fullText: string,
  isAbort: boolean,
  sse: SseController,
): Promise<void> {
  const status: TerminalStatus = isAbort ? 'stopped' : 'failed';
  const reason = isAbort ? 'stream_aborted' : 'stream_error';
  try {
    await activeFinalizer.finalizeAssistant(assistantMessageId, fullText, [], status);
  } catch {
    // 静默忽略：消息已经处于终态或被并发请求处理
  }
  try {
    await activeFinalizer.convergeRunningToolExecutions(assistantMessageId, status, reason);
  } catch (err) {
    console.error('收敛 tool executions 失败：', err);
  }
  try {
    if (isAbort) {
      sse.send('message-complete', {
        id: assistantMessageId,
        role: 'assistant',
        content: fullText,
        citations: [],
        status: 'stopped',
      });
    } else {
      sse.send('message-error', {
        id: assistantMessageId,
        role: 'assistant',
        content: fullText,
        citations: [],
        status: 'failed',
        error: { message: '服务暂时不可用，请稍后重试。' },
      });
    }
  } catch {
    // 流已关闭
  }
}

/**
 * 兜底：无论正常完成还是异常退出，最后都跑一次"仍 running 工具执行"收敛，
 * 避免孤儿行。总是从 `finally` 块调用。
 */
export async function sweepRunningToolExecutions(
  assistantMessageId: string,
  reason: string,
): Promise<void> {
  try {
    await activeFinalizer.convergeRunningToolExecutions(assistantMessageId, 'stopped', reason);
  } catch (err) {
    console.error('最终收敛 tool executions 失败：', err);
  }
}
