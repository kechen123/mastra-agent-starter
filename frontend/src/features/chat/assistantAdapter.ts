import type { AppendMessage, MessageStatus, ThreadMessageLike } from '@assistant-ui/react';
import type { Citation } from '../../lib/api';
import type { ChatMessage, ToolCallState } from '../../types/ui';

/**
 * 把项目自定义 ChatMessage 映射成 assistant-ui ThreadMessageLike。
 *
 * 设计原则：assistant-ui 只承担「聊天运行时适配」；后端 SSE 协议、业务字段
 * （citations / tool calls / 状态语义）不改造，全部通过 metadata.custom 透传
 * 给到下游组件。这样 App 继续拥有唯一可信的状态，runtime 仅消费映射。
 *
 * 注意：assistant-ui 不允许 content 为空数组；当 message 没有正文时退化为
 * 一个空字符串 text part，确保渲染管线不抛错。
 */
export interface ChatMessageMetadata {
  citations: Citation[];
  toolCalls: ToolCallState[];
  /** 业务层 ChatMessage 的 status，方便渲染层做失败/停止分支。 */
  chatStatus: ChatMessage['status'];
}

const EMPTY_TEXT_PART: ThreadMessageLike = {
  role: 'assistant',
  content: [{ type: 'text', text: '' }],
};

export function chatMessageToThreadMessage(message: ChatMessage): ThreadMessageLike {
  if (message.role === 'user') {
    return {
      id: message.id,
      role: 'user',
      content: [{ type: 'text', text: message.content }],
      metadata: {
        custom: {
          chatStatus: message.status,
        } satisfies Partial<ChatMessageMetadata>,
      },
    };
  }
  const textPart = { type: 'text' as const, text: message.content };
  const status = assistantMessageStatus(message.status);
  return {
    id: message.id,
    role: 'assistant',
    content: [textPart],
    status,
    metadata: {
      custom: {
        citations: message.citations,
        toolCalls: message.tools ?? [],
        chatStatus: message.status,
      } satisfies ChatMessageMetadata,
    },
  };
}

function assistantMessageStatus(
  status: Extract<ChatMessage, { role: 'assistant' }>['status'],
): MessageStatus {
  switch (status) {
    case 'pending':
    case 'streaming':
      return { type: 'running' };
    case 'completed':
      return { type: 'complete', reason: 'stop' };
    case 'stopped':
      return { type: 'incomplete', reason: 'cancelled' };
    case 'failed':
      return { type: 'incomplete', reason: 'error' };
  }
}

/**
 * 从 assistant-ui 提交回调里抽出用户文本。
 *
 * 用户输入来自 ComposerPrimitive.Input，AppendMessage.content 既可能是字符串
 * （旧 / 简化路径），也可能是 part 数组；只取 type === 'text' 的部分拼回去。
 */
export function extractAppendMessageText(message: AppendMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => (part as { type?: string }).type === 'text')
    .map((part) => part.text)
    .join('');
}

/**
 * 默认空消息，避免 assistant-ui 在某些边界场景下要求非空 content。
 */
export const EMPTY_THREAD_MESSAGE: ThreadMessageLike = EMPTY_TEXT_PART;
