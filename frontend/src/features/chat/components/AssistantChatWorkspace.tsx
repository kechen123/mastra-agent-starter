import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreAdapter,
  type MessageState,
} from '@assistant-ui/react';
import { Check, ChevronDown, Library, LoaderCircle, RefreshCw, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Citation, KnowledgeBase } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import type { ChatMessage, ToolCallState } from '../../../types/ui';
import {
  chatMessageToThreadMessage,
  extractAppendMessageText,
  type ChatMessageMetadata,
} from '../assistantAdapter';
import { CitationPanel } from './CitationPanel';
import { Markdown } from './Markdown';

export interface AssistantChatWorkspaceProps {
  appShortName: string;
  messages: ChatMessage[];
  isAsking: boolean;
  isStreaming: boolean;
  error: string | null;
  chatAgents: { id: string; name: string; requiresKnowledgeBase: boolean }[];
  knowledgeBases: KnowledgeBase[];
  selectedAgentId: string;
  defaultChatModel: string;
  activeKnowledgeBase: Pick<KnowledgeBase, 'id' | 'name'> | null;
  onSubmit: (text: string) => void;
  onStop: () => void;
  onRegenerate: (assistantMessageId: string) => void;
  onSwitchAgent: (agentId: string) => void;
  onSelectKnowledgeBase: (knowledgeBase: KnowledgeBase) => void;
  onClearKnowledgeBase: () => void;
  onSelectCitation: (citation: Citation) => void;
}

const scrollbarStyle = {
  scrollbarColor: 'var(--color-app-border-strong) transparent',
  scrollbarWidth: 'thin',
} as React.CSSProperties;

/**
 * 对话主面板：assistant-ui runtime 适配 + 业务能力回调。
 *
 * - assistant-ui 只负责聊天运行时适配与组件原语（Thread / Message / Composer）。
 * - App 持有所有后端 / SSE / 会话业务状态；本组件只把数据映射到 adapter 并把
 *   用户操作回传给 App。
 * - 不修改后端 SSE 协议；citations、tool calls、失败状态等业务字段通过
 *   `metadata.custom` 透传给到消息渲染层。
 */
export function AssistantChatWorkspace(props: AssistantChatWorkspaceProps) {
  const adapter = useChatAdapter(props);
  const runtime = useExternalStoreRuntime(adapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadView {...props} />
    </AssistantRuntimeProvider>
  );
}

function useChatAdapter(props: AssistantChatWorkspaceProps): ExternalStoreAdapter<ChatMessage> {
  const { messages, isStreaming, onSubmit, onStop, onRegenerate } = props;
  // 保持回调引用稳定，避免每次 render 重建 adapter 触发 runtime 重置。
  const submitRef = useRef(onSubmit);
  const stopRef = useRef(onStop);
  const regenerateRef = useRef(onRegenerate);
  useEffect(() => {
    submitRef.current = onSubmit;
    stopRef.current = onStop;
    regenerateRef.current = onRegenerate;
  }, [onSubmit, onStop, onRegenerate]);

  return useMemo<ExternalStoreAdapter<ChatMessage>>(
    () => ({
      isRunning: isStreaming,
      messages,
      convertMessage: chatMessageToThreadMessage,
      onNew: async (message: AppendMessage) => {
        const text = extractAppendMessageText(message).trim();
        if (!text) return;
        await submitRef.current(text);
      },
      onCancel: async () => {
        await stopRef.current();
      },
      onReload: async (parentId: string | null) => {
        if (!parentId) return;
        await regenerateRef.current(parentId);
      },
    }),
    [messages, isStreaming],
  );
}

function ThreadView(props: AssistantChatWorkspaceProps) {
  const {
    appShortName,
    messages,
    isAsking,
    isStreaming,
    error,
    chatAgents,
    knowledgeBases,
    selectedAgentId,
    defaultChatModel,
    activeKnowledgeBase,
    onSwitchAgent,
    onSelectKnowledgeBase,
    onClearKnowledgeBase,
    onSelectCitation,
  } = props;

  const messageScrollRef = useRef<HTMLDivElement>(null);
  const followsLatestRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isKnowledgeBasePickerOpen, setIsKnowledgeBasePickerOpen] = useState(false);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const knowledgeBasePickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function closePickers(event: MouseEvent) {
      if (!agentPickerRef.current?.contains(event.target as Node)) setIsAgentPickerOpen(false);
      if (!knowledgeBasePickerRef.current?.contains(event.target as Node)) setIsKnowledgeBasePickerOpen(false);
    }
    document.addEventListener('mousedown', closePickers);
    return () => document.removeEventListener('mousedown', closePickers);
  }, []);

  function scrollToLatest(behavior: ScrollBehavior = 'smooth') {
    const element = messageScrollRef.current;
    if (!element) return;
    followsLatestRef.current = true;
    setShowJumpToLatest(false);
    element.scrollTo({ top: element.scrollHeight, behavior });
  }

  function handleMessageScroll() {
    const element = messageScrollRef.current;
    if (!element) return;
    const isAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    followsLatestRef.current = isAtBottom;
    setShowJumpToLatest(!isAtBottom);
  }

  useEffect(() => {
    // 仅当用户本来就在底部时，才跟随新的流式内容；浏览历史时绝不强制跳走。
    if (!followsLatestRef.current) {
      setShowJumpToLatest(true);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const element = messageScrollRef.current;
      element?.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, isAsking, isStreaming]);

  const currentAgent = chatAgents.find((agent) => agent.id === selectedAgentId);
  const isKnowledgeAgent = currentAgent?.requiresKnowledgeBase ?? false;
  const streamingAssistant = useMemo(() => {
    return messages.find(
      (m): m is Extract<ChatMessage, { role: 'assistant' }> =>
        m.role === 'assistant' && m.status === 'streaming',
    );
  }, [messages]);
  const lastAssistantIndex = messages.reduce(
    (idx, m, i) => (m.role === 'assistant' ? i : idx),
    -1,
  );

  return (
    <section className="relative flex flex-1 min-w-0 min-h-0 overflow-hidden flex-col bg-app-bg app-chat-canvas">
      <header className="relative z-10 flex items-center justify-between gap-3 shrink-0 min-h-14 px-4 max-[760px]:pl-14 bg-app-bg/95 backdrop-blur-xl">
        <div className="relative min-w-0" ref={agentPickerRef}>
            <button
              className="flex items-center gap-1.5 min-w-0 h-10 px-2.5 text-[15px] font-medium text-app-text bg-transparent border-0 rounded-lg transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover"
              type="button"
              onClick={() => setIsAgentPickerOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={isAgentPickerOpen}
            >
              <span className="truncate">
                {currentAgent?.name ?? '选择智能体'}
              </span>
              <ChevronDown size={15} className="shrink-0 pointer-events-none text-app-muted" />
            </button>
            {isAgentPickerOpen && (
              <div
                className="absolute z-20 top-[calc(100%+6px)] left-0 grid min-w-[240px] p-1.5 bg-app-surface border border-app-border rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.28)]"
                role="listbox"
                aria-label="选择智能体"
              >
                {chatAgents.map((agent) => (
                  <button
                    key={agent.id}
                    className={cn(
                      'flex items-center justify-between gap-3 min-h-10 py-2 px-3 text-[13.5px] text-app-text bg-transparent border-0 rounded-lg text-left transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover',
                      agent.id === selectedAgentId && 'bg-app-hover font-medium',
                    )}
                    type="button"
                    role="option"
                    aria-selected={agent.id === selectedAgentId}
                    onClick={() => {
                      onSwitchAgent(agent.id);
                      setIsAgentPickerOpen(false);
                    }}
                  >
                    <span>{agent.name}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      {agent.requiresKnowledgeBase && <small className="text-app-muted text-[11px]">需知识库</small>}
                      {agent.id === selectedAgentId && <Check size={14} className="text-app-muted" />}
                    </span>
                  </button>
                ))}
              </div>
            )}
        </div>
        <span className="hidden md:block max-w-[260px] truncate text-[12px] text-app-muted app-mono" title={defaultChatModel}>
          {defaultChatModel}
        </span>
      </header>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        <ThreadPrimitive.Viewport
          ref={messageScrollRef}
          onScroll={handleMessageScroll}
          autoScroll={false}
          scrollToBottomOnRunStart={false}
          style={scrollbarStyle}
          className="h-full overflow-y-auto px-4 sm:px-8"
        >
          <ThreadPrimitive.Root className="w-full max-w-[768px] mx-auto py-6 sm:py-8 px-0">
            <ThreadPrimitive.Empty>
              <div className="grid place-items-center content-center min-h-[calc(100vh-220px)] py-10 text-center">
                <div className="grid place-items-center w-10 h-10 mb-5 rounded-full bg-app-text text-app-bg">
                  <Sparkles size={18} />
                </div>
                <h2 className="m-0 text-[clamp(26px,3vw,32px)] leading-tight font-semibold tracking-[-0.035em] text-app-text">
                  {isKnowledgeAgent ? '从资料中找到答案' : '有什么可以帮忙的？'}
                </h2>
                <p className="max-w-lg mt-3 mb-0 text-[14px] leading-6 text-app-muted">
                  {isKnowledgeAgent
                    ? `选择知识库后，${appShortName} 会基于可追溯的原文资料回答。`
                    : '选择合适的智能体，开始一段清晰、连续的工作对话。'}
                </p>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages>
              {({ message }) => (
                <MessageView
                  message={message}
                  index={messages.findIndex((m) => m.id === message.id)}
                  isLastAssistant={
                    message.role === 'assistant' && messages.findIndex((m) => m.id === message.id) === lastAssistantIndex
                  }
                  onSelectCitation={onSelectCitation}
                  onRegenerate={(id) => props.onRegenerate(id)}
                />
              )}
            </ThreadPrimitive.Messages>
            {isAsking && !streamingAssistant && (
              <div className="flex gap-3.5 mt-8">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[14px] leading-[1.65] text-app-muted">
                    <span className="w-1.5 h-1.5 rounded-full bg-current" style={{ animation: 'app-loading-dot 1s infinite ease-in-out' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-current" style={{ animation: 'app-loading-dot 1s infinite ease-in-out', animationDelay: '0.15s' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-current" style={{ animation: 'app-loading-dot 1s infinite ease-in-out', animationDelay: '0.3s' }} />
                    {isKnowledgeAgent ? '正在检索知识库并生成回答…' : '正在思考…'}
                  </div>
                </div>
              </div>
            )}
            {error && (
              <p className="my-4 py-2.5 px-3 text-app-danger bg-app-danger/[0.07] border border-app-danger/33 rounded-md text-[13px]">
                {error}
              </p>
            )}
          </ThreadPrimitive.Root>
        </ThreadPrimitive.Viewport>
        {showJumpToLatest && (
          <button
            className={cn(
              'absolute z-20 left-1/2 -translate-x-1/2 bottom-4 grid place-items-center w-10 h-10 p-0 text-app-text bg-app-surface border border-app-border-strong rounded-full shadow-xl hover:bg-app-hover hover:border-app-text',
              isStreaming && 'bg-app-text text-app-surface border-app-text hover:bg-app-text',
            )}
            type="button"
            onClick={() => scrollToLatest()}
            aria-label="滚动到底部"
          >
            {isStreaming ? <LoaderCircle size={17} className="animate-spin" /> : <ChevronDown size={17} />}
          </button>
        )}
      </div>

      <div className="relative z-10 shrink-0 px-4 sm:px-8 pb-3 bg-gradient-to-t from-app-bg via-app-bg to-transparent">
        <ComposerPrimitive.Root
          className={cn(
            'w-full max-w-[768px] mx-auto p-2 rounded-[26px] bg-app-surface shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_8px_28px_rgba(0,0,0,0.14)]',
          )}
        >
          {isKnowledgeAgent && activeKnowledgeBase && (
            <div className="flex items-center gap-1.5 w-fit mt-0 mx-1.5 mb-1 px-2 py-1 bg-app-surface-muted border border-app-border rounded text-[11.5px]">
              <Library size={14} />
              <span>当前知识库：<strong>{activeKnowledgeBase.name}</strong></span>
              <button
                className="grid place-items-center p-0 text-app-muted bg-transparent border-0 focus-visible:outline-none focus-visible:text-app-text"
                onClick={onClearKnowledgeBase}
                aria-label="退出当前知识库"
              >
                <X size={14} />
              </button>
            </div>
          )}
          {isKnowledgeAgent && !activeKnowledgeBase && (
            <div className="flex items-center gap-1.5 w-fit mt-0 mx-1.5 mb-1 px-2 py-1 text-app-danger bg-app-danger/[0.07] border border-app-border rounded text-[11.5px]">
              <Library size={14} />
              <span>请先选择一个知识库</span>
            </div>
          )}
          <ComposerPrimitive.Input
            submitMode="enter"
            placeholder={
              isKnowledgeAgent
                ? activeKnowledgeBase
                  ? '输入问题'
                  : '请先选择一个知识库'
                : '输入问题，开始对话'
            }
            className="block w-full min-h-[54px] px-3 py-2.5 resize-none border-0 outline-none text-app-text bg-transparent text-[15px] leading-6 placeholder:text-app-muted"
            rows={2}
          />
          <div className="flex items-center justify-between gap-2.5 mt-1 px-0.5">
            <div className="relative" ref={knowledgeBasePickerRef}>
              <button
                className="inline-flex items-center gap-1.5 min-h-9 py-1.5 px-3 text-[13px] text-app-muted bg-transparent border-0 rounded-full transition-colors duration-150 hover:text-app-text hover:bg-app-hover focus-visible:bg-app-hover"
                type="button"
                onClick={() => setIsKnowledgeBasePickerOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={isKnowledgeBasePickerOpen}
              >
                <Library size={13} />知识库
              </button>
              {isKnowledgeBasePickerOpen && (
                <div
                  className="absolute z-20 bottom-[calc(100%+9px)] left-0 grid min-w-[220px] max-w-[280px] p-1.5 bg-app-surface border border-app-border-strong rounded-xl shadow-2xl"
                  role="listbox"
                  aria-label="选择知识库"
                >
                  {knowledgeBases.length === 0 ? (
                    <p className="m-1.5 px-2 text-app-muted text-xs leading-snug">暂无知识库，请先在知识库页创建。</p>
                  ) : (
                    knowledgeBases.map((knowledgeBase) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={knowledgeBase.id === activeKnowledgeBase?.id}
                        className={cn(
                          'flex items-center gap-2 w-full py-2 px-2.5 text-[12.5px] text-app-text bg-transparent border-0 rounded-lg text-left hover:bg-app-surface-muted focus-visible:outline-none focus-visible:bg-app-surface-muted',
                          knowledgeBase.id === activeKnowledgeBase?.id && 'bg-app-surface-muted',
                        )}
                        key={knowledgeBase.id}
                        onClick={() => {
                          onSelectKnowledgeBase(knowledgeBase);
                          setIsKnowledgeBasePickerOpen(false);
                        }}
                      >
                        <Library size={14} />
                        <span>{knowledgeBase.name}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {isStreaming ? (
                <ComposerPrimitive.Cancel
                  className="grid place-items-center w-9 h-9 text-white bg-app-danger border-0 rounded-full transition-transform duration-150 active:scale-95 hover:opacity-90"
                  aria-label="停止生成"
                >
                  <X size={18} />
                </ComposerPrimitive.Cancel>
              ) : (
                <ComposerPrimitive.Send
                  className="grid place-items-center w-9 h-9 text-app-bg bg-app-text border-0 rounded-full transition-[transform,opacity] duration-150 active:scale-95 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
                  aria-label="发送问题"
                >
                  <Send size={18} />
                </ComposerPrimitive.Send>
              )}
            </div>
          </div>
        </ComposerPrimitive.Root>
        <p className="w-full max-w-[768px] mx-auto mt-2 text-app-muted text-center text-[11px]">
          AI 可能会出错，请核对重要信息 · Enter 发送，Shift + Enter 换行
        </p>
      </div>
    </section>
  );
}

interface MessageViewProps {
  message: MessageState;
  index: number;
  isLastAssistant: boolean;
  onSelectCitation: (citation: Citation) => void;
  onRegenerate: (id: string) => void;
}

function MessageView({ message, index, isLastAssistant, onSelectCitation, onRegenerate }: MessageViewProps) {
  const isUser = message.role === 'user';
  if (isUser) {
    return (
      <div className="flex flex-row-reverse mt-8" data-message-id={message.id} data-index={index}>
        <div className="flex flex-col items-end max-w-[78%]">
          <p className="m-0 py-2.5 px-4 max-w-full break-words whitespace-pre-wrap bg-app-surface-muted border-0 rounded-[20px] text-[15px] leading-[1.65]">
            {messageContentText(message.content)}
          </p>
        </div>
      </div>
    );
  }

  const meta = (message.metadata.custom ?? {}) as Partial<ChatMessageMetadata>;
  const citations = meta.citations ?? [];
  const toolCalls = meta.toolCalls ?? [];
  const chatStatus = (meta.chatStatus ?? 'completed') as Extract<ChatMessage, { role: 'assistant' }>['status'];
  const isFailed = chatStatus === 'failed';
  const isStopped = chatStatus === 'stopped';
  const showRetry = isFailed || isStopped;
  const showRegenerate = chatStatus === 'completed' && isLastAssistant;
  const showActions = chatStatus !== 'pending' && chatStatus !== 'streaming';
  const content = messageContentText(message.content);

  return (
    <div className="flex mt-8" data-message-id={message.id} data-index={index}>
      <div className="min-w-0 max-w-full">
        <div className="text-[15.5px] leading-7">
          {content ? (
            <Markdown text={content} />
          ) : chatStatus === 'pending' || chatStatus === 'streaming' ? null : (
            <p className="m-0 text-app-muted">（无内容）</p>
          )}
          {isFailed && (
            <span className="inline-flex items-center gap-1 mt-2 px-2 py-1 rounded text-[11.5px] text-app-danger bg-app-danger/10 border border-app-danger/20">
              生成失败
            </span>
          )}
          {isStopped && (
            <span className="inline-flex items-center gap-1 mt-2 px-2 py-1 rounded text-[11.5px] text-app-warning bg-app-warning/10 border border-app-warning/20">
              已停止
            </span>
          )}
        </div>
        {toolCalls.length > 0 && (
          <ToolCallsPanel toolCalls={toolCalls} />
        )}
        {citations.length > 0 && chatStatus === 'completed' && (
          <div className="mt-4">
            <div className="text-app-muted text-[10.5px] uppercase tracking-[0.06em]">引用来源（{citations.length}）</div>
            <div className="flex flex-wrap gap-2 mt-2">
              {citations.map((citation, cidx) => (
                <button
                  onClick={() => onSelectCitation(citation)}
                  className="flex items-center gap-1.5 py-1.5 px-2.5 text-[12.5px] text-app-text bg-transparent border border-app-border-strong rounded-md hover:border-app-text hover:bg-app-surface-muted focus-visible:outline-none focus-visible:border-focus-border focus-visible:bg-app-surface-muted"
                  key={citation.chunkId}
                >
                  <span className="grid place-items-center w-4 h-4 border border-app-muted rounded-full text-[10px]">
                    {cidx + 1}
                  </span>
                  {citation.title} {citation.chapter}
                </button>
              ))}
            </div>
          </div>
        )}
        {showActions && (showRetry || showRegenerate) && (
          <div className="flex flex-wrap gap-2 mt-3">
            {showRetry && (
              <button
                className="inline-flex items-center gap-1 py-1 px-2.5 text-[12px] text-app-text bg-app-surface-muted border border-app-border rounded hover:bg-app-hover focus-visible:outline-none focus-visible:border-focus-border focus-visible:bg-app-hover"
                onClick={() => onRegenerate(message.id)}
              >
                <RotateCcw size={13} />
                重试
              </button>
            )}
            {showRegenerate && (
              <button
                className="inline-flex items-center gap-1 py-1 px-2.5 text-[12px] text-app-text bg-app-surface-muted border border-app-border rounded hover:bg-app-hover focus-visible:outline-none focus-visible:border-focus-border focus-visible:bg-app-hover"
                onClick={() => onRegenerate(message.id)}
              >
                <RefreshCw size={13} />
                重新生成
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallsPanel({ toolCalls }: { toolCalls: ToolCallState[] }) {
  return (
    <div className="mt-3 py-2.5 px-3 bg-app-surface-muted border border-app-border rounded-md">
      <div className="mb-1.5 text-app-muted text-[10.5px] font-semibold uppercase tracking-[0.06em]">工具调用</div>
      {toolCalls.map((tool) => (
        <div key={tool.toolCallId} className="flex items-center gap-2 py-1 text-[12.5px]">
          <span className="shrink-0 text-[13px]">
            {tool.status === 'running' ? '⏳' : tool.status === 'completed' ? '✅' : '❌'}
          </span>
          <span className="font-semibold">{tool.toolName}</span>
          {tool.status === 'running' && <span className="ml-auto text-app-muted text-[11px]">执行中…</span>}
          {tool.status === 'completed' && <span className="ml-auto text-app-muted text-[11px]">已完成</span>}
          {tool.status === 'failed' && <span className="ml-auto text-app-muted text-[11px]">失败 ({tool.errorCode})</span>}
        </div>
      ))}
    </div>
  );
}

function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part as { type?: string; text?: string }).type === 'text' ? (part as { text: string }).text : '')
    .join('');
}

// 重新导出 CitationPanel 以便在 App 中按原路径引用。
export { CitationPanel };
