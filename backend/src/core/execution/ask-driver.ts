/**
 * ask / regenerate 路由共用的流驱动。
 *
 * 两条路由产出的 SSE 流使用相同的事件名 + 载荷：
 * `message-start` / `content-delta` / `tool-call-*` / `message-complete` /
 * `message-error`。差异仅在上游输入（起点消息、历史切片），通过 `AskStreamInput`
 * 显式传入。
 *
 * V2.3.6 §5.1：`AskStreamInput` 现在强制携带 `workspaceId`（已认证上下文中
 * 解析得到的非空字符串），并贯穿到 `streamAgent` / `dispatchStreamEvent` /
 * `finalizeMessage` / `finalizeAfterStreamError` / `sweepRunningToolExecutions`
 * 全链。客户端字段（`body.workspaceId` / `?workspaceId=` / `X-Workspace-Id`）
 * 一律忽略。
 */
import { streamAgent, type StreamEvent } from '../agent/runtime.js';
import {
  appendPartialContent,
  cleanupExecution,
} from './controller.js';
import {
  buildSseController,
  sseResponse,
  type SseController,
} from './sse.js';
import {
  dispatchStreamEvent,
} from './tool-event.js';
import {
  finalizeAfterStreamError,
  finalizeMessage,
  sweepRunningToolExecutions,
} from './message-finalize.js';
import type { Citation } from '../../modules/citations/types.js';
import type { Message } from '../../modules/conversations/types.js';

export interface AskStreamInput {
  /** 已认证上下文中解析到的非空工作区 ID（V2.3.6 §5.1）。 */
  workspaceId: string;
  assistantMessageId: string;
  conversationId: string;
  agentId: string;
  message: string;
  knowledgeBaseId: string | null;
  history: Message[];
  abortSignal: AbortSignal;
}

export interface AskDriverOptions {
  /** 日志前缀：用于在错误日志里区分 ask / regenerate。 */
  logTag: 'ask' | 'regenerate';
}

interface RunAgentStreamState {
  fullText: string;
}

/**
 * 单条消息的 Agent 生成器薄包装：从原 ask.ts 抽出，仅做 `streamAgent` 转发，
 * 让两条路由共享同一调用形态。
 */
async function* runAgentStream(input: AskStreamInput): AsyncGenerator<StreamEvent, void, unknown> {
  yield* streamAgent({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    prompt: input.message,
    conversationId: input.conversationId,
    knowledgeBaseId: input.knowledgeBaseId,
    history: input.history,
    abortSignal: input.abortSignal,
  });
}

/**
 * 构造 ask / regenerate 请求的 SSE 响应。两条路由使用相同的 `input` 形态
 * 调用本函数，唯一区别是错误日志的 `logTag`。
 *
 * 返回的 `Response` 持有的 `ReadableStream` 流程：
 *  1. 推送 `message-start`；
 *  2. 通过 `dispatchStreamEvent` 转发 Agent 流事件；
 *  3. 终态事件（`done` / `stopped` / `error`）走 `finalizeMessage`；
 *  4. 异常通过 `finalizeAfterStreamError` 兜底；
 *  5. `finally` 清理内存执行条目。
 *
 * 全链路 `workspaceId` 透传——`streamAgent` 用于技能绑定 / KB 校验，
 * `dispatchStreamEvent` / `finalizeMessage` / `finalizeAfterStreamError` /
 * `sweepRunningToolExecutions` 用于 `tool_executions` / `messages` 写入的
 * 工作区隔离校验。
 */
export function buildAskStreamResponse(
  input: AskStreamInput,
  options: AskDriverOptions,
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const sse: SseController = buildSseController(controller);
      const fullTextRef = { current: '' };
      const toolExecutionMap = new Map<string, string>();
      const state: RunAgentStreamState = { fullText: '' };

      try {
        sse.send('message-start', {
          id: input.assistantMessageId,
          role: 'assistant',
          status: 'streaming',
        });

        for await (const event of runAgentStream(input)) {
          if (event.type === 'delta') {
            state.fullText += event.text;
            fullTextRef.current = state.fullText;
            appendPartialContent(input.assistantMessageId, event.text);
            try {
              sse.send('content-delta', { messageId: input.assistantMessageId, text: event.text });
            } catch {
              // 客户端可能已断开，仍继续累积文本用于持久化
            }
            continue;
          }

          if (event.type === 'tool-call-start' || event.type === 'tool-call-complete' || event.type === 'tool-call-error') {
            await dispatchStreamEvent(event, {
              workspaceId: input.workspaceId,
              conversationId: input.conversationId,
              assistantMessageId: input.assistantMessageId,
              fullTextRef,
              toolExecutionMap,
              sse,
            });
            continue;
          }

          if (event.type === 'done') {
            await finalizeMessage(input.workspaceId, input.assistantMessageId, {
              terminal: 'completed',
              content: event.content,
              citations: event.citations,
              fullText: state.fullText,
            }, sse);
            break;
          }

          if (event.type === 'stopped') {
            await finalizeMessage(input.workspaceId, input.assistantMessageId, {
              terminal: 'stopped',
              content: event.content,
              citations: [],
              fullText: state.fullText,
            }, sse);
            break;
          }

          if (event.type === 'error') {
            await finalizeMessage(input.workspaceId, input.assistantMessageId, {
              terminal: 'failed',
              fullText: state.fullText,
              errorMessage: event.error,
            }, sse);
            break;
          }
        }
      } catch (error) {
        const isAbort = (error as Error).name === 'AbortError' || input.abortSignal.aborted;
        console.error(isAbort ? `${options.logTag} SSE 流已中断` : `${options.logTag} SSE 流错误：`, error);
        await finalizeAfterStreamError(
          input.workspaceId,
          input.assistantMessageId,
          state.fullText,
          isAbort,
          sse,
        );
      } finally {
        await sweepRunningToolExecutions(input.workspaceId, input.assistantMessageId, 'stream_finalized');
        cleanupExecution(input.assistantMessageId);
        sse.close();
      }
    },
  });

  return sseResponse(stream);
}

/**
 * 旧接口兼容：路由层优先使用 controller.ts 的
 * `tryReserveConversationExecution` + `bindAssistantMessageToExecution` 取得
 * 会话级互斥；本文件不再二次封装。
 */
export { tryRegisterExecution } from './controller.js';

export type { Citation };
