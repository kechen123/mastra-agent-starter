import { registerApiRoute } from '@mastra/core/server';
import {
  getConversationWithMessages,
  maybeUpdateTitleFromFirstMessage,
  saveUserMessage,
  createAssistantPending,
  updateAssistantStreaming,
  finalizeAssistant,
  resetAssistantForRetry,
  getLastAssistantMessage,
} from '../services/conversations.js';
import { streamAgent } from '../agents/runtime.js';
import {
  registerExecution,
  abortExecution,
  isExecutionActive,
  cleanupExecution,
  updatePartialContent,
  ExecutionConflictError,
} from '../services/execution.js';
import {
  createToolExecution,
  finalizeToolExecution,
  convergeRunningToolExecutions,
} from '../services/tool-executions.js';
import type { StreamEvent } from '../agents/runtime.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

interface SSESend {
  (event: string, data: unknown): void;
}

async function* runAgentStream(
  assistantMessageId: string,
  conversationId: string,
  agentId: string,
  message: string,
  knowledgeBaseId: string | null,
  history: import('../services/conversations.js').Message[],
  abortSignal: AbortSignal,
): AsyncGenerator<StreamEvent, void, unknown> {
  yield* streamAgent(agentId, message, knowledgeBaseId, history, abortSignal);
}

async function handleToolEvent(
  event: Extract<StreamEvent, { type: 'tool-call-start' | 'tool-call-complete' | 'tool-call-error' }>,
  _conversationId: string,
  assistantMessageId: string,
  toolExecutionMap: Map<string, string>,
  send: SSESend,
): Promise<void> {
  if (event.type === 'tool-call-start') {
    try {
      const execId = await createToolExecution(_conversationId, assistantMessageId, event.toolName, event.input);
      toolExecutionMap.set(event.toolCallId, execId);
    } catch (err) {
      console.error('Tool execution create failed:', err);
    }
    // Minimal safe SSE payload — no input/output bodies are forwarded to the client.
    try {
      send('tool-call-start', {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: 'running',
      });
    } catch {
      // stream may be closed
    }
  } else if (event.type === 'tool-call-complete') {
    const execId = toolExecutionMap.get(event.toolCallId);
    if (execId) {
      try {
        await finalizeToolExecution(execId, event.output, 'completed');
      } catch (err) {
        console.error('Tool execution finalize failed:', err);
      }
    }
    try {
      send('tool-call-complete', {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: 'completed',
      });
    } catch {
      // stream may be closed
    }
  } else if (event.type === 'tool-call-error') {
    const execId = toolExecutionMap.get(event.toolCallId);
    // Only a safe error code is forwarded to the client; the full error
    // message is persisted server-side but not exposed over SSE.
    const safeErrorCode = 'tool_error';
    if (execId) {
      try {
        await finalizeToolExecution(execId, {}, 'failed', safeErrorCode);
      } catch (err) {
        console.error('Tool execution finalize failed:', err);
      }
    }
    try {
      send('tool-call-error', {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: 'failed',
        errorCode: safeErrorCode,
      });
    } catch {
      // stream may be closed
    }
  }
}

export const askRoute = registerApiRoute('/ask', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    try {
      const body = await context.req.json<unknown>();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return context.json({ message: '请求体必须是 JSON 对象。' }, 400);
      }
      const { conversationId, message } = body as Record<string, unknown>;
      if (typeof conversationId !== 'string' || !isUuid(conversationId)) {
        return context.json({ message: 'conversationId 格式不正确。' }, 400);
      }
      if (typeof message !== 'string' || message.trim().length === 0) {
        return context.json({ message: '请输入问题。' }, 400);
      }
      if (message.trim().length > 2000) {
        return context.json({ message: '问题不能超过 2000 个字符。' }, 400);
      }

      const { conversation, messages: history } = await getConversationWithMessages(conversationId);

      // Save user message
      await saveUserMessage(conversationId, message.trim());
      await maybeUpdateTitleFromFirstMessage(conversationId, message.trim());

      // Create assistant pending
      const assistantMessage = await createAssistantPending(conversationId);

      // Register execution
      let abortController: AbortController;
      try {
        abortController = registerExecution(assistantMessage.id);
      } catch (err) {
        if (err instanceof ExecutionConflictError) {
          return context.json({ message: err.message }, 409);
        }
        throw err;
      }

      // Switch to streaming
      await updateAssistantStreaming(assistantMessage.id);

      // SSE response
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send: SSESend = (event: string, data: unknown) => {
            controller.enqueue(encoder.encode(`event: ${event}\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          };

          let fullText = '';
          const toolExecutionMap = new Map<string, string>();

          try {
            send('message-start', {
              id: assistantMessage.id,
              role: 'assistant',
              status: 'streaming',
            });

            const generator = runAgentStream(
              assistantMessage.id,
              conversationId,
              conversation.agentId,
              message.trim(),
              conversation.knowledgeBaseId,
              history,
              abortController.signal,
            );

            for await (const event of generator) {
              if (event.type === 'delta') {
                fullText += event.text;
                updatePartialContent(assistantMessage.id, event.text);
                try {
                  send('content-delta', { messageId: assistantMessage.id, text: event.text });
                } catch {
                  // stream may be closed by client disconnect; continue accumulating for persistence
                }
              } else if (event.type === 'done') {
                const finalized = await finalizeAssistant(
                  assistantMessage.id,
                  event.content,
                  event.citations,
                  'completed',
                );
                try {
                  send('message-complete', {
                    id: finalized.id,
                    role: finalized.role,
                    content: finalized.content,
                    citations: finalized.citations,
                    status: finalized.status,
                    createdAt: finalized.createdAt,
                  });
                } catch {
                  // stream closed
                }
              } else if (event.type === 'stopped') {
                const finalized = await finalizeAssistant(
                  assistantMessage.id,
                  event.content,
                  [],
                  'stopped',
                );
                try {
                  send('message-complete', {
                    id: finalized.id,
                    role: finalized.role,
                    content: finalized.content,
                    citations: finalized.citations,
                    status: finalized.status,
                    createdAt: finalized.createdAt,
                  });
                } catch {
                  // stream closed
                }
              } else if (event.type === 'error') {
                const finalized = await finalizeAssistant(
                  assistantMessage.id,
                  fullText,
                  [],
                  'failed',
                );
                try {
                  send('message-error', {
                    id: finalized.id,
                    role: finalized.role,
                    content: finalized.content,
                    citations: [],
                    status: finalized.status,
                    createdAt: finalized.createdAt,
                    error: { message: event.error },
                  });
                } catch {
                  // stream closed
                }
              } else if (event.type === 'tool-call-start' || event.type === 'tool-call-complete' || event.type === 'tool-call-error') {
                await handleToolEvent(event, conversationId, assistantMessage.id, toolExecutionMap, send);
              }
            }
          } catch (error) {
            const isAbort = (error as Error).name === 'AbortError' || abortController.signal.aborted;
            console.error(isAbort ? 'SSE stream aborted' : 'SSE stream error:', error);
            try {
              await finalizeAssistant(
                assistantMessage.id,
                fullText,
                [],
                isAbort ? 'stopped' : 'failed',
              );
            } catch {
              // ignore
            }
            // Converge any still-running tool executions on this message
            try {
              await convergeRunningToolExecutions(
                assistantMessage.id,
                isAbort ? 'stopped' : 'failed',
                isAbort ? 'stream_aborted' : 'stream_error',
              );
            } catch (err) {
              console.error('Converge running tool executions failed:', err);
            }
            try {
              if (isAbort) {
                send('message-complete', {
                  id: assistantMessage.id,
                  role: 'assistant',
                  content: fullText,
                  citations: [],
                  status: 'stopped',
                });
              } else {
                send('message-error', {
                  id: assistantMessage.id,
                  role: 'assistant',
                  content: fullText,
                  citations: [],
                  status: 'failed',
                  error: { message: '服务暂时不可用，请稍后重试。' },
                });
              }
            } catch {
              // stream closed
            }
          } finally {
            // Ensure no tool_executions row stays at status='running' even if
            // the upstream stream ended cleanly without delivering a complete/error
            // event for every started tool call (e.g. abrupt close).
            try {
              await convergeRunningToolExecutions(assistantMessage.id, 'stopped', 'stream_finalized');
            } catch (err) {
              console.error('Final converge running tool executions failed:', err);
            }
            cleanupExecution(assistantMessage.id);
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    } catch (error) {
      console.error('问答请求失败：', error);
      if (error instanceof Error && error.message === '会话不存在。') {
        return context.json({ message: '会话不存在。' }, 404);
      }
      return context.json({ message: '服务暂时不可用，请稍后重试。' }, 500);
    }
  },
});

export const stopMessageRoute = registerApiRoute('/messages/:id/stop', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    const id = context.req.param('id');
    if (!id || !isUuid(id)) {
      return context.json({ message: '消息 ID 格式不正确。' }, 400);
    }
    const { success, partialContent } = abortExecution(id);
    if (!success) {
      const { getDatabasePool } = await import('../../database/pool.js');
      const pool = getDatabasePool();
      const msgResult = await pool.query<{ status: string; content: string }>(
        `SELECT status, content FROM messages WHERE id = $1`,
        [id],
      );
      const row = msgResult.rows[0];
      if (!row) {
        return context.json({ message: '消息不存在。' }, 404);
      }
      if (row.status === 'pending' || row.status === 'streaming') {
        const safeContent = row.content || partialContent || '';
        await finalizeAssistant(id, safeContent, [], 'stopped');
        await convergeRunningToolExecutions(id, 'stopped', 'stream_aborted');
        return context.json({ message: '已停止生成。', status: 'stopped' }, 200);
      }
      return context.json({ message: '无活跃生成可停止。', status: row.status }, 200);
    }
    // Active execution aborted — converge any running tool executions.
    await convergeRunningToolExecutions(id, 'stopped', 'stream_aborted');
    return context.json({ message: '已停止生成。', status: 'stopped' }, 200);
  },
});

export const regenerateMessageRoute = registerApiRoute('/messages/:assistantMessageId/regenerate', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    try {
      const assistantMessageId = context.req.param('assistantMessageId');
      if (!assistantMessageId || !isUuid(assistantMessageId)) {
        return context.json({ message: '消息 ID 格式不正确。' }, 400);
      }

      const { getDatabasePool } = await import('../../database/pool.js');
      const pool = getDatabasePool();
      const msgResult = await pool.query<{ conversation_id: string }>(
        `SELECT conversation_id FROM messages WHERE id = $1`,
        [assistantMessageId],
      );
      if (!msgResult.rows[0]) {
        return context.json({ message: '消息不存在。' }, 404);
      }
      const conversationId = msgResult.rows[0].conversation_id;

      const { getConversationWithMessages } = await import('../services/conversations.js');
      const { conversation, messages: history } = await getConversationWithMessages(conversationId);

      const lastAssistant = await getLastAssistantMessage(conversationId);
      if (!lastAssistant || lastAssistant.id !== assistantMessageId) {
        return context.json({ message: '只能对会话最后一条助手消息重新生成。' }, 409);
      }

      if (isExecutionActive(assistantMessageId)) {
        return context.json({ message: '该消息正在生成中，请等待完成或停止后再试。' }, 409);
      }

      const assistantIndex = history.findIndex((m) => m.id === assistantMessageId);
      const priorHistory = history.slice(0, assistantIndex);
      let triggeringUserMessage: typeof priorHistory[number] | undefined;
      for (let i = assistantIndex - 1; i >= 0; i--) {
        if (history[i]!.role === 'user') {
          triggeringUserMessage = history[i];
          break;
        }
      }
      if (!triggeringUserMessage) {
        return context.json({ message: '找不到对应用户问题。' }, 400);
      }

      await resetAssistantForRetry(assistantMessageId);

      let abortController: AbortController;
      try {
        abortController = registerExecution(assistantMessageId);
      } catch (err) {
        if (err instanceof ExecutionConflictError) {
          return context.json({ message: err.message }, 409);
        }
        throw err;
      }

      await updateAssistantStreaming(assistantMessageId);

      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send: SSESend = (event: string, data: unknown) => {
            controller.enqueue(encoder.encode(`event: ${event}\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          };

          let fullText = '';
          const toolExecutionMap = new Map<string, string>();

          try {
            send('message-start', {
              id: assistantMessageId,
              role: 'assistant',
              status: 'streaming',
            });

            const generator = runAgentStream(
              assistantMessageId,
              conversationId,
              conversation.agentId,
              triggeringUserMessage.content,
              conversation.knowledgeBaseId,
              priorHistory,
              abortController.signal,
            );

            for await (const event of generator) {
              if (event.type === 'delta') {
                fullText += event.text;
                updatePartialContent(assistantMessageId, event.text);
                try {
                  send('content-delta', { messageId: assistantMessageId, text: event.text });
                } catch {
                  // stream may be closed by client disconnect
                }
              } else if (event.type === 'done') {
                const finalized = await finalizeAssistant(
                  assistantMessageId,
                  event.content,
                  event.citations,
                  'completed',
                );
                try {
                  send('message-complete', {
                    id: finalized.id,
                    role: finalized.role,
                    content: finalized.content,
                    citations: finalized.citations,
                    status: finalized.status,
                    createdAt: finalized.createdAt,
                  });
                } catch {
                  // stream closed
                }
              } else if (event.type === 'stopped') {
                const finalized = await finalizeAssistant(
                  assistantMessageId,
                  event.content,
                  [],
                  'stopped',
                );
                try {
                  send('message-complete', {
                    id: finalized.id,
                    role: finalized.role,
                    content: finalized.content,
                    citations: finalized.citations,
                    status: finalized.status,
                    createdAt: finalized.createdAt,
                  });
                } catch {
                  // stream closed
                }
              } else if (event.type === 'error') {
                const finalized = await finalizeAssistant(
                  assistantMessageId,
                  fullText,
                  [],
                  'failed',
                );
                try {
                  send('message-error', {
                    id: finalized.id,
                    role: finalized.role,
                    content: finalized.content,
                    citations: [],
                    status: finalized.status,
                    createdAt: finalized.createdAt,
                    error: { message: event.error },
                  });
                } catch {
                  // stream closed
                }
              } else if (event.type === 'tool-call-start' || event.type === 'tool-call-complete' || event.type === 'tool-call-error') {
                await handleToolEvent(event, conversationId, assistantMessageId, toolExecutionMap, send);
              }
            }
          } catch (error) {
            const isAbort = (error as Error).name === 'AbortError' || abortController.signal.aborted;
            console.error(isAbort ? 'SSE regenerate stream aborted' : 'SSE regenerate stream error:', error);
            try {
              await finalizeAssistant(
                assistantMessageId,
                fullText,
                [],
                isAbort ? 'stopped' : 'failed',
              );
            } catch {
              // ignore
            }
            try {
              await convergeRunningToolExecutions(
                assistantMessageId,
                isAbort ? 'stopped' : 'failed',
                isAbort ? 'stream_aborted' : 'stream_error',
              );
            } catch (err) {
              console.error('Converge running tool executions failed:', err);
            }
            try {
              if (isAbort) {
                send('message-complete', {
                  id: assistantMessageId,
                  role: 'assistant',
                  content: fullText,
                  citations: [],
                  status: 'stopped',
                });
              } else {
                send('message-error', {
                  id: assistantMessageId,
                  role: 'assistant',
                  content: fullText,
                  citations: [],
                  status: 'failed',
                  error: { message: '服务暂时不可用，请稍后重试。' },
                });
              }
            } catch {
              // stream closed
            }
          } finally {
            try {
              await convergeRunningToolExecutions(assistantMessageId, 'stopped', 'stream_finalized');
            } catch (err) {
              console.error('Final converge running tool executions failed:', err);
            }
            cleanupExecution(assistantMessageId);
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    } catch (error) {
      console.error('重新生成请求失败：', error);
      if (error instanceof Error && error.message === '会话不存在。') {
        return context.json({ message: '会话不存在。' }, 404);
      }
      return context.json({ message: '服务暂时不可用，请稍后重试。' }, 500);
    }
  },
});
