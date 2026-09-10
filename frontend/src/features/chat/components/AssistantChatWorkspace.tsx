import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useThreadViewport,
  type AppendMessage,
  type ExternalStoreAdapter,
  type MessageState,
} from '@assistant-ui/react';
import { Check, ChevronDown, Copy, Library, LoaderCircle, PanelLeftOpen, RefreshCw, RotateCcw, Send, Sparkles, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Citation, KnowledgeBase } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import type { ChatMessage, ToolCallState } from '../../../types/ui';
import type { ApprovalView } from '../../../types/approval';
import {
  chatMessageToThreadMessage,
  extractAppendMessageText,
  type ChatMessageMetadata,
} from '../assistantAdapter';
import { CitationPanel } from './CitationPanel';
import { Markdown } from './Markdown';
import { ApprovalsBanner } from './ApprovalsBanner';
import { AgentSelect } from './AgentSelect';
import { KnowledgeBasePicker } from './KnowledgeBasePicker';
import { ModelSelect } from './ModelSelect';

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
  /** 后端 llm.displayName（如 "DeepSeek"）；缺省回退 defaultChatModel。 */
  llmDisplayName?: string;
  activeKnowledgeBase: Pick<KnowledgeBase, 'id' | 'name'> | null;
  onSubmit: (text: string) => void;
  onStop: () => void;
  onRegenerate: (assistantMessageId: string) => void;
  onSwitchAgent: (agentId: string) => void;
  onSelectKnowledgeBase: (knowledgeBase: KnowledgeBase) => void;
  onClearKnowledgeBase: () => void;
  onSelectCitation: (citation: Citation) => void;
  /**
   * PR-3.3 — 当前 run 命中的 pending approvals。本组件仅渲染；
   * 列表 state 由 `useApprovals` 在 App 侧管理。
   */
  pendingApprovals?: ApprovalView[];
  /** PR-3.3 — 当前正在 resolve 的 approval.id（用于禁用按钮）。 */
  busyApprovalId?: string | null;
  /** PR-3.3 — 用户点击 Approve / Decline 时的回调。 */
  onApproveApproval?: (approval: ApprovalView) => void;
  onDeclineApproval?: (approval: ApprovalView) => void;
  /** 桌面 sidebar 折叠状态：折叠时在聊天头部渲染展开入口。 */
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
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
    llmDisplayName,
    activeKnowledgeBase,
    onSwitchAgent,
    onSelectKnowledgeBase,
    onClearKnowledgeBase,
    onSelectCitation,
    pendingApprovals,
    busyApprovalId,
    onApproveApproval,
    onDeclineApproval,
    sidebarCollapsed,
    onExpandSidebar,
  } = props;

  const messageScrollRef = useRef<HTMLDivElement>(null);

  // assistant-ui viewport store：isAtBottom 由框架原生维护，
  // 不再依赖手写 scrollTop/scrollHeight 阈值；用户上滑 → isAtBottom=false →
  // "回到最新"按钮可见；点击 ThreadPrimitive.ScrollToBottom → 恢复自动跟随。
  const viewport = useThreadViewport();
  const isAtBottom = viewport.isAtBottom;

  const currentAgent = chatAgents.find((agent) => agent.id === selectedAgentId);
  const isKnowledgeAgent = currentAgent?.requiresKnowledgeBase ?? false;
  const hasInFlightAssistant = useMemo(() => {
    return messages.find(
      (m): m is Extract<ChatMessage, { role: 'assistant' }> =>
        m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming'),
    );
  }, [messages]);
  const lastAssistantIndex = messages.reduce(
    (idx, m, i) => (m.role === 'assistant' ? i : idx),
    -1,
  );

  return (
    <section className="relative flex flex-1 min-w-0 min-h-0 overflow-hidden flex-col bg-app-sidebar app-chat-canvas">
      <header className="relative z-10 flex items-center justify-between gap-3 shrink-0 min-h-14 px-4 max-[760px]:pl-14 bg-app-sidebar/95 backdrop-blur-xl">
        <div className="flex items-center gap-2 min-w-0">
          {sidebarCollapsed && onExpandSidebar && (
            <button
              type="button"
              onClick={onExpandSidebar}
              aria-label="展开 sidebar"
              title="展开 sidebar"
              className="hidden md:grid place-items-center w-9 h-9 text-app-muted bg-transparent border-0 rounded-lg transition-colors duration-150 hover:text-app-text hover:bg-app-hover focus-visible:text-app-text focus-visible:bg-app-hover"
            >
              <PanelLeftOpen size={16} strokeWidth={1.9} aria-hidden />
            </button>
          )}
          <div className="relative min-w-0">
            <AgentSelect
              agents={chatAgents}
              value={selectedAgentId}
              onChange={onSwitchAgent}
            />
          </div>
        </div>
      </header>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        <ThreadPrimitive.Viewport
          ref={messageScrollRef}
          // 使用 assistant-ui 原生的 ResizeObserver 自动跟随器：内容流式增长、
          // Markdown 排版变化、终态按钮出现都会再次定位到底部；仅用户主动上滑
          // 时暂停，避免自定义 scrollHeight 时序与内部 viewport 状态相互打架。
          // runStart 默认会无条件发起一次底部滚动，会覆盖用户正在阅读历史时
          // 由 autoScroll 暂停的状态；关闭它后，仅原本位于底部的视口继续跟随。
          // isAtBottom / scrollToBottom 由 useThreadViewport 提供给下面的
          // 自定义按钮可见性 / 点击使用。
          autoScroll
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
            {isAsking && !hasInFlightAssistant && (
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
        {!isAtBottom && (
          <ThreadPrimitive.ScrollToBottom
            className={cn(
              'absolute z-20 left-1/2 -translate-x-1/2 bottom-4 grid place-items-center w-10 h-10 p-0 text-app-text bg-app-surface border border-app-border-strong rounded-full shadow-xl hover:bg-app-hover hover:border-app-text',
              isStreaming && 'bg-app-text text-app-surface border-app-text hover:bg-app-text',
            )}
            aria-label="滚动到底部"
          >
            {isStreaming ? <LoaderCircle size={17} className="animate-spin" /> : <ChevronDown size={17} />}
          </ThreadPrimitive.ScrollToBottom>
        )}
      </div>

      <div className="relative z-10 shrink-0 px-4 sm:px-8 pb-3">
        {pendingApprovals && pendingApprovals.length > 0 && (
          <ApprovalsBanner
            approvals={pendingApprovals}
            busyApprovalId={busyApprovalId ?? null}
            onApprove={(item) => onApproveApproval?.(item)}
            onDecline={(item) => onDeclineApproval?.(item)}
          />
        )}
        <ComposerPrimitive.Root
          className={cn(
            'w-full max-w-[768px] mx-auto p-2 rounded-[26px] bg-app-surface transition-shadow duration-150 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_8px_28px_rgba(0,0,0,0.14)]',
          )}
        >
          {isKnowledgeAgent && activeKnowledgeBase && (
            <div className="flex items-center gap-2 w-fit max-w-full mt-0 mx-1.5 mb-1.5 px-2 py-1 bg-app-surface-muted border border-app-border rounded text-[11.5px]">
              <Library size={14} className="shrink-0 text-app-muted" />
              <span className="truncate min-w-0 max-w-[180px] sm:max-w-[260px]">
                当前知识库：<strong className="font-semibold">{activeKnowledgeBase.name}</strong>
              </span>
              <button
                className="grid place-items-center shrink-0 w-5 h-5 p-0 text-app-muted bg-transparent border-0 rounded transition-colors duration-150 hover:text-app-text hover:bg-app-hover focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus-ring focus-visible:text-app-text"
                style={{ outlineOffset: 2 }}
                onClick={onClearKnowledgeBase}
                aria-label="退出当前知识库"
              >
                <X size={12} />
              </button>
            </div>
          )}
          {isKnowledgeAgent && !activeKnowledgeBase && (
            <div className="flex items-center gap-2 w-fit max-w-full mt-0 mx-1.5 mb-1.5 px-2 py-1 text-app-danger bg-app-danger/[0.07] border border-app-border rounded text-[11.5px]">
              <Library size={14} className="shrink-0" />
              <span className="truncate">请先选择一个知识库</span>
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
            className="block w-full min-h-[54px] px-3 py-2.5 resize-none border-0 outline-none text-app-text bg-transparent text-[15px] leading-6 placeholder:text-app-muted focus:outline-none focus-visible:outline-none"
            rows={2}
          />
          <div className="flex items-center justify-between gap-2.5 mt-1 px-0.5">
            <KnowledgeBasePicker
              knowledgeBases={knowledgeBases}
              activeId={activeKnowledgeBase?.id ?? null}
              onSelect={onSelectKnowledgeBase}
            />
            <div className="flex items-center gap-1.5">
              <ModelSelect defaultChatModel={defaultChatModel} llmDisplayName={llmDisplayName} />
              {isStreaming ? (
                <ComposerPrimitive.Cancel
                  className="grid place-items-center w-9 h-9 text-app-surface bg-app-text border-0 rounded-full transition-transform duration-150 active:scale-95 hover:opacity-90 focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus-ring"
                  style={{ outlineOffset: 2 }}
                  aria-label="停止生成"
                >
                  <Square size={13} fill="currentColor" strokeWidth={0} aria-hidden />
                </ComposerPrimitive.Cancel>
              ) : (
                <ComposerPrimitive.Send
                  className="grid place-items-center w-9 h-9 text-app-bg bg-app-text border-0 rounded-full transition-[transform,opacity] duration-150 active:scale-95 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus-ring"
                  style={{ outlineOffset: 2 }}
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
  const meta = (message.metadata.custom ?? {}) as Partial<ChatMessageMetadata>;
  const content = messageContentText(message.content);
  const [copied, setCopied] = useState(false);
  const createdAt = meta.createdAt;

  async function handleCopy() {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = content;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.append(textArea);
      textArea.select();
      const copiedByFallback = document.execCommand('copy');
      textArea.remove();
      if (copiedByFallback) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }
    }
  }

  const copyButton = content ? (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="grid place-items-center w-7 h-7 text-app-muted bg-transparent border-0 rounded-md hover:text-app-text hover:bg-app-hover focus-visible:outline-none focus-visible:bg-app-hover"
      aria-label={copied ? '已复制' : '复制消息'}
      title={copied ? '已复制' : '复制消息'}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  ) : null;

  if (isUser) {
    return (
      <div className="group flex flex-row-reverse mt-8" data-message-id={message.id} data-index={index}>
        <div className="flex flex-col items-end max-w-[78%]">
          <p className="m-0 py-2.5 px-4 max-w-full break-words whitespace-pre-wrap bg-app-surface-muted border-0 rounded-[20px] text-[15px] leading-[1.65]">
            {content}
          </p>
          <div className="flex items-center gap-1 h-7 mt-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {createdAt && <time className="text-[11px] text-app-muted" dateTime={createdAt}>{formatMessageTime(createdAt)}</time>}
            {copyButton}
          </div>
        </div>
      </div>
    );
  }

  const citations = meta.citations ?? [];
  const toolCalls = meta.toolCalls ?? [];
  const chatStatus = (meta.chatStatus ?? 'completed') as Extract<ChatMessage, { role: 'assistant' }>['status'];
  const isFailed = chatStatus === 'failed';
  const isStopped = chatStatus === 'stopped';
  const showRetry = isFailed || isStopped;
  const showRegenerate = chatStatus === 'completed' && isLastAssistant;
  const showActions = chatStatus !== 'pending' && chatStatus !== 'streaming';

  return (
    <div className="group flex mt-8" data-message-id={message.id} data-index={index}>
      <div className="min-w-0 max-w-full">
        <div className="text-[15.5px] leading-7">
          {content ? (
            <Markdown text={content} />
          ) : chatStatus === 'pending' || chatStatus === 'streaming' ? (
            <div className="flex items-center gap-2 min-h-7 text-[14px] leading-[1.65] text-app-muted" role="status" aria-label="正在思考">
              <span className="w-1.5 h-1.5 rounded-full bg-current" style={{ animation: 'app-loading-dot 1s infinite ease-in-out' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-current" style={{ animation: 'app-loading-dot 1s infinite ease-in-out', animationDelay: '0.15s' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-current" style={{ animation: 'app-loading-dot 1s infinite ease-in-out', animationDelay: '0.3s' }} />
              <span>正在思考…</span>
            </div>
          ) : (
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
        {(showActions || createdAt) && (
          <div className={cn(
            'flex items-center gap-1 h-8 mt-3 transition-opacity',
            showActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          )}>
            {createdAt && <time className="mr-1 text-[11px] text-app-muted" dateTime={createdAt}>{formatMessageTime(createdAt)}</time>}
            {copyButton}
            {showRetry && (
              <button
                type="button"
                className="grid place-items-center w-7 h-7 text-app-muted bg-transparent border-0 rounded-md hover:text-app-text hover:bg-app-hover focus-visible:outline-none focus-visible:bg-app-hover"
                onClick={() => onRegenerate(message.id)}
                aria-label="重试生成"
                title="重试生成"
              >
                <RotateCcw size={14} />
              </button>
            )}
            {showRegenerate && (
              <button
                type="button"
                className="grid place-items-center w-7 h-7 text-app-muted bg-transparent border-0 rounded-md hover:text-app-text hover:bg-app-hover focus-visible:outline-none focus-visible:bg-app-hover"
                onClick={() => onRegenerate(message.id)}
                aria-label="重新生成"
                title="重新生成"
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
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
