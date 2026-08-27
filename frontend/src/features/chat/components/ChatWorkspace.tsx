import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ChevronDown, Library, RefreshCw, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import type { ChatAgentInfo, Citation, KnowledgeBase } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import type { ChatMessage, ToolCallState } from '../../../types/ui';
import { Markdown } from './Markdown';

// 聊天气泡区滚动条：保留薄滚动条与拇指描边效果。
const chatContentScrollbarStyle = {
  scrollbarColor: 'var(--color-app-border-strong) transparent',
  scrollbarWidth: 'thin',
} as React.CSSProperties;

export interface ChatWorkspaceProps {
  appShortName: string;
  question: string;
  messages: ChatMessage[];
  isAsking: boolean;
  isStreaming: boolean;
  error: string | null;
  chatAgents: ChatAgentInfo[];
  knowledgeBases: KnowledgeBase[];
  selectedAgentId: string;
  defaultChatModel: string;
  activeKnowledgeBase: Pick<KnowledgeBase, 'id' | 'name'> | null;
  onQuestionChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onRegenerate: (assistantMessageId: string) => void;
  onSwitchAgent: (agentId: string) => void;
  onSelectKnowledgeBase: (knowledgeBase: KnowledgeBase) => void;
  onClearKnowledgeBase: () => void;
  onSelectCitation: (citation: Citation) => void;
}

/**
 * 对话主面板：渲染 Agent/KB 选择、消息流、工具调用、引用条、提问框、停止/发送按钮。
 *
 * SSE 事件分发、AbortController、用户提交/重试等跨事件逻辑保留在 App 层；
 * 本组件只负责"已经发生的状态"如何展示与触发用户输入。
 */
export function ChatWorkspace({
  appShortName,
  question,
  messages,
  isAsking,
  isStreaming,
  error,
  chatAgents,
  knowledgeBases,
  selectedAgentId,
  defaultChatModel,
  activeKnowledgeBase,
  onQuestionChange,
  onSubmit,
  onStop,
  onRegenerate,
  onSwitchAgent,
  onSelectKnowledgeBase,
  onClearKnowledgeBase,
  onSelectCitation,
}: ChatWorkspaceProps) {
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isKnowledgeBasePickerOpen, setIsKnowledgeBasePickerOpen] = useState(false);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const knowledgeBasePickerRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const followsLatestRef = useRef(true);
  const isComposingRef = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

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
    if (!followsLatestRef.current) return;
    const frame = requestAnimationFrame(() => scrollToLatest('auto'));
    return () => cancelAnimationFrame(frame);
  }, [messages, isAsking]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !isComposingRef.current) {
      event.preventDefault();
      if (isStreaming) {
        onStop();
      } else {
        onSubmit();
      }
    }
  }

  const currentAgent = chatAgents.find((agent) => agent.id === selectedAgentId);
  const isKnowledgeAgent = currentAgent?.requiresKnowledgeBase ?? false;
  const canSend = question.trim().length > 0 && !isAsking && !isStreaming && (!isKnowledgeAgent || !!activeKnowledgeBase);
  const lastAssistantIndex = messages.reduce((idx, m, i) => m.role === 'assistant' ? i : idx, -1);

  return <section className="flex flex-1 min-w-0 min-h-0 overflow-hidden flex-col bg-app-bg">
    <header className="flex items-center justify-between gap-4 shrink-0 min-h-[68px] py-3 px-6 border-b border-app-border bg-app-surface">
      <div><h1 className="m-0 text-lg">{currentAgent?.name ?? '对话'}</h1></div>
      <div className="flex items-center gap-3">
        <div className="relative flex items-center gap-1.5" ref={agentPickerRef}>
          <span className="text-app-muted text-xs">智能体</span>
          <button className="relative flex items-center justify-between gap-4 min-w-[138px] min-h-[30px] py-1.5 px-2 text-xs text-app-text bg-app-surface border border-app-border-strong rounded-md cursor-pointer hover:bg-app-hover hover:border-app-text focus-visible:outline-none focus-visible:border-focus-border" type="button" onClick={() => setIsAgentPickerOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={isAgentPickerOpen}>
            {currentAgent?.name ?? '选择智能体'}
            <ChevronDown size={15} className="static shrink-0 pointer-events-none" />
          </button>
          {isAgentPickerOpen && <div className="absolute z-10 top-[calc(100%+5px)] right-0 grid min-w-[184px] p-1 bg-app-surface border border-app-border-strong rounded-md shadow-2xl" role="listbox" aria-label="选择智能体">
            {chatAgents.map((agent) => (
              <button key={agent.id} className={cn('flex items-center justify-between gap-2.5 py-1.5 px-2 text-xs text-app-text bg-transparent border-0 rounded text-left hover:bg-app-surface-muted focus-visible:outline-none focus-visible:bg-app-surface-muted', agent.id === selectedAgentId && 'bg-app-surface-muted font-semibold')} type="button" role="option" aria-selected={agent.id === selectedAgentId} onClick={() => { onSwitchAgent(agent.id); setIsAgentPickerOpen(false) }}>
                <span>{agent.name}</span>
                {agent.requiresKnowledgeBase && <small className="text-app-muted text-[10px]">需知识库</small>}
              </button>
            ))}
          </div>}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-app-muted text-xs">当前模型</span>
          <span className="flex items-center min-h-[30px] py-1.5 px-2 text-xs text-app-muted whitespace-nowrap bg-app-surface border border-app-border-strong rounded-md">{defaultChatModel}</span>
        </div>
      </div>
    </header>
    <div className="relative flex-1 min-h-0 overflow-hidden px-6">
      <div className="h-full overflow-y-auto m-0" ref={messageScrollRef} onScroll={handleMessageScroll} style={chatContentScrollbarStyle}>
        <div className="w-full max-w-[805px] mx-auto py-7 px-0">
          {messages.length === 0 && (
            <div className="grid place-items-center gap-3 min-h-72 py-8 text-app-muted text-center">
              <Sparkles size={24} />
              <p className="max-w-md m-0 text-sm leading-[1.75]">{isKnowledgeAgent ? `向知识库提问，${appShortName} 会基于检索到的原文回答并附上引用来源。` : `你好，我是${appShortName}通用助手。有什么可以帮你的吗？`}</p>
            </div>
          )}
          {messages.map((message, index) => message.role === 'user' ? (
            <div className="flex gap-3.5 flex-row-reverse mt-6" key={message.id}>
              <div className="flex flex-col items-end max-w-[68%]">
                <p className="m-0 py-2 px-3 max-w-full break-words whitespace-pre-wrap bg-app-surface-muted border border-app-divider rounded-md text-[14px] leading-[1.6]">
                  {message.content}
                </p>
              </div>
            </div>
          ) : <AssistantMessage key={message.id} message={message} isLast={index === lastAssistantIndex} onSelectCitation={onSelectCitation} onRegenerate={onRegenerate} />)}
          {isAsking && !isStreaming && (
            <div className="flex gap-3.5 mt-6">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[14px] leading-[1.65] text-app-muted">
                  <span className="w-1.5 h-1.5 rounded-full bg-currentColor" style={{ animation: 'app-loading-dot 1s infinite ease-in-out' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-currentColor" style={{ animation: 'app-loading-dot 1s infinite ease-in-out', animationDelay: '0.15s' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-currentColor" style={{ animation: 'app-loading-dot 1s infinite ease-in-out', animationDelay: '0.3s' }} />
                  {isKnowledgeAgent ? '正在检索知识库并生成回答…' : '正在思考…'}
                </div>
              </div>
            </div>
          )}
          {error && <p className="my-4 py-2.5 px-3 text-app-danger bg-app-danger/[0.07] border border-app-danger/33 rounded-md text-[13px]">{error}</p>}
        </div>
      </div>
      {showJumpToLatest && (
        <button className={cn('absolute z-20 right-[max(32px,calc(50%-390px))] bottom-4 grid place-items-center w-9 h-9 p-0 text-app-text bg-app-surface border border-app-border-strong rounded-full shadow-lg hover:bg-app-hover hover:border-app-text', isStreaming && 'flex gap-1.5 w-auto h-[34px] px-2.5 text-app-surface bg-app-info border-app-info rounded-full text-xs font-semibold hover:bg-blue-700')} type="button" onClick={() => scrollToLatest()} aria-label="滚动到底部">
          {isStreaming && <span>正在回复</span>}
          <ArrowDown size={17} />
        </button>
      )}
    </div>
    <div className="shrink-0 px-6 pb-3.5 bg-app-bg">
      <div className="app-composer w-full max-w-[805px] mx-auto p-2.5 border border-app-border-strong rounded-xl bg-app-surface transition-colors duration-150">
        {isKnowledgeAgent && activeKnowledgeBase && (
          <div className="flex items-center gap-1.5 w-fit mt-0 mx-2 mb-0.5 px-2 py-1.5 bg-app-surface-muted border border-app-border rounded text-xs">
            <Library size={15} /><span>当前知识库：<strong>{activeKnowledgeBase.name}</strong></span>
            <button className="grid place-items-center p-0 text-app-muted bg-transparent border-0 focus-visible:outline-none focus-visible:text-app-text" onClick={onClearKnowledgeBase} aria-label="退出当前知识库"><X size={15} /></button>
          </div>
        )}
        {isKnowledgeAgent && !activeKnowledgeBase && (
          <div className="flex items-center gap-1.5 w-fit mt-0 mx-2 mb-0.5 px-2 py-1.5 text-app-danger bg-app-danger/[0.07] border border-app-border rounded text-xs">
            <Library size={15} /><span>请先选择一个知识库</span>
          </div>
        )}
        <textarea
          className="block w-full min-h-14 p-2 resize-none outline-0 border-0 text-app-text bg-transparent text-sm placeholder:text-app-muted disabled:cursor-not-allowed disabled:opacity-50"
          value={question}
          onChange={(event) => onQuestionChange(event.target.value)}
          onCompositionStart={() => { isComposingRef.current = true }}
          onCompositionEnd={() => { isComposingRef.current = false }}
          onKeyDown={handleKeyDown}
          disabled={isAsking || isStreaming}
          placeholder={isKnowledgeAgent ? (activeKnowledgeBase ? '输入问题' : '请先选择一个知识库') : '输入问题，开始对话'}
          rows={2}
        />
        <div className="flex items-center justify-between gap-2.5">
          <div className="relative" ref={knowledgeBasePickerRef}>
            <button className="py-1.5 px-2 text-[13px] text-app-muted bg-app-surface border border-app-border rounded focus-visible:outline-none focus-visible:border-focus-border" type="button" onClick={() => setIsKnowledgeBasePickerOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={isKnowledgeBasePickerOpen}>选择知识库</button>
            {isKnowledgeBasePickerOpen && (
              <div className="absolute z-10 bottom-[calc(100%+7px)] left-0 grid min-w-[220px] max-w-[280px] p-1.5 bg-app-surface border border-app-border-strong rounded-lg shadow-2xl" role="listbox" aria-label="选择知识库">
                {knowledgeBases.length === 0 ? <p className="m-1.5 px-2 text-app-muted text-xs leading-snug">暂无知识库，请先在知识库页创建。</p> : knowledgeBases.map((knowledgeBase) => (
                  <button type="button" role="option" aria-selected={knowledgeBase.id === activeKnowledgeBase?.id} className={cn('flex items-center gap-2 w-full py-2 px-2 text-app-text bg-transparent border-0 rounded text-left hover:bg-app-surface-muted focus-visible:outline-none focus-visible:bg-app-surface-muted', knowledgeBase.id === activeKnowledgeBase?.id && 'bg-app-surface-muted')} key={knowledgeBase.id} onClick={() => { onSelectKnowledgeBase(knowledgeBase); setIsKnowledgeBasePickerOpen(false) }}>
                    <Library size={14} /><span>{knowledgeBase.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <button className={cn('grid place-items-center w-[34px] h-[34px] text-app-surface bg-app-text border border-app-text rounded-md disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90 focus-visible:outline-none focus-visible:opacity-90', isStreaming && 'bg-app-danger border-app-danger hover:bg-red-600')} onClick={isStreaming ? onStop : onSubmit} disabled={!isStreaming && !canSend} aria-label={isStreaming ? '停止生成' : '发送问题'}>
              {isStreaming ? <X size={18} /> : <Send size={18} />}
            </button>
          </div>
        </div>
      </div>
      <p className="w-full max-w-[805px] mx-auto mt-2.5 text-app-muted text-center text-xs">Enter 发送，Shift + Enter 换行</p>
    </div>
  </section>;
}

interface AssistantMessageProps {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  isLast: boolean;
  onSelectCitation: (citation: Citation) => void;
  onRegenerate: (id: string) => void;
}

function AssistantMessage({ message, isLast, onSelectCitation, onRegenerate }: AssistantMessageProps) {
  const isFailed = message.status === 'failed';
  const isStopped = message.status === 'stopped';
  const showRetry = isFailed || isStopped;
  const showRegenerate = message.status === 'completed' && isLast;
  const showActions = message.status !== 'pending' && message.status !== 'streaming';
  return (
    <div className="flex gap-3.5 mt-6">
      <div className="min-w-0 max-w-[760px]">
        <div className="text-[15px]">
          {message.content ? (
            <Markdown text={message.content} />
          ) : message.status === 'pending' || message.status === 'streaming' ? null : (
            <p className="m-0 text-app-muted">（无内容）</p>
          )}
          {isFailed && (
            <span className="inline-flex items-center gap-1 mt-2 px-2 py-1 rounded text-xs text-app-danger bg-app-danger/10 border border-app-danger/20">
              生成失败
            </span>
          )}
          {isStopped && (
            <span className="inline-flex items-center gap-1 mt-2 px-2 py-1 rounded text-xs text-app-warning bg-app-warning/10 border border-app-warning/20">
              已停止
            </span>
          )}
        </div>
        {message.tools && message.tools.length > 0 && (
          <div className="mt-3.5 py-2.5 px-3 bg-app-surface-muted border border-app-border rounded-md">
            <div className="mb-1.5 text-app-muted text-xs font-semibold uppercase tracking-[0.06em]">工具调用</div>
            {message.tools.map((t: ToolCallState) => (
              <div key={t.toolCallId} className="flex items-center gap-2 py-1 text-[13px]">
                <span className="shrink-0 text-[14px]">{t.status === 'running' ? '⏳' : t.status === 'completed' ? '✅' : '❌'}</span>
                <span className="font-semibold">{t.toolName}</span>
                {t.status === 'running' && <span className="ml-auto text-app-muted text-xs">执行中…</span>}
                {t.status === 'completed' && <span className="ml-auto text-app-muted text-xs">已完成</span>}
                {t.status === 'failed' && <span className="ml-auto text-app-muted text-xs">失败 ({t.errorCode})</span>}
              </div>
            ))}
          </div>
        )}
        {message.citations.length > 0 && message.status === 'completed' && (
          <>
            <div className="mt-5 text-app-muted text-[12px] uppercase tracking-[0.06em]">引用来源（{message.citations.length}）</div>
            <div className="flex flex-wrap gap-2 mt-2">
              {message.citations.map((citation, index) => (
                <button onClick={() => onSelectCitation(citation)} className="flex items-center gap-1.5 py-1.5 px-2.5 text-[13px] text-app-text bg-transparent border border-app-border-strong rounded-md hover:border-app-text hover:bg-app-surface-muted focus-visible:outline-none focus-visible:border-focus-border focus-visible:bg-app-surface-muted" key={citation.chunkId}>
                  <span className="grid place-items-center w-4 h-4 border border-app-muted rounded-full text-[10px]">{index + 1}</span>
                  {citation.title} {citation.chapter}
                </button>
              ))}
            </div>
          </>
        )}
        {showActions && (
          <div className="flex flex-wrap gap-2 mt-4">
            {showRetry && <button className="inline-flex items-center gap-1 py-1 px-2.5 text-xs text-app-text bg-app-surface-muted border border-app-border rounded hover:bg-app-hover focus-visible:outline-none focus-visible:border-focus-border focus-visible:bg-app-hover" onClick={() => onRegenerate(message.id)}><RotateCcw size={14} />重试</button>}
            {showRegenerate && <button className="inline-flex items-center gap-1 py-1 px-2.5 text-xs text-app-text bg-app-surface-muted border border-app-border rounded hover:bg-app-hover focus-visible:outline-none focus-visible:border-focus-border focus-visible:bg-app-hover" onClick={() => onRegenerate(message.id)}><RefreshCw size={14} />重新生成</button>}
          </div>
        )}
      </div>
    </div>
  );
}
