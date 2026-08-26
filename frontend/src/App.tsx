import { useEffect, useRef, useState } from 'react'
import { ArrowDown, Bot, ChevronDown, CircleHelp, FileText, Library, Moon, Plus, RefreshCw, RotateCcw, Send, Sparkles, Sun, Trash2, Upload, Wrench, X } from 'lucide-react'
import { DEFAULT_CAPABILITIES, bindSkillToAgent, createKnowledgeBase, deleteDocument, deleteKnowledgeBase, getCapabilities, installMarketSkill, listDocuments, listKnowledgeBases, listPopularMarketSkills, listSkills, listTools, previewMarketSkill, removeSkill, searchMarketSkills, type Capabilities, type ChatAgentInfo, type Citation, type KnowledgeBase, type KnowledgeDocument, type MarketSkillInfo, type MarketSkillPreview, type SkillSummary, type ToolDefinition, unbindSkillFromAgent, uploadDocument } from './lib/api'
import { listAgents, listConversations, createConversation, getConversation, updateConversation, deleteConversation, streamAskMessage, stopMessage, regenerateMessage, type SSEEvent } from './lib/conversations'
import type { ConversationSummary } from './types/conversation'
import { cn } from './lib/cn'

type Theme = 'light' | 'dark'
type Module = '对话' | '知识库' | '能力'

type ToolCallState =
  | { status: 'running'; toolCallId: string; toolName: string }
  | { status: 'completed'; toolCallId: string; toolName: string }
  | { status: 'failed'; toolCallId: string; toolName: string; errorCode: string };

type Message =
  | { id: string; role: 'user'; content: string; status: 'completed' | 'failed' }
  | { id: string; role: 'assistant'; content: string; citations: Citation[]; status: 'pending' | 'streaming' | 'completed' | 'stopped' | 'failed'; tools?: ToolCallState[] }

type ConversationState =
  | { type: 'draft'; agentId: string; knowledgeBaseId: string | null }
  | { type: 'persisted'; id: string }

const navigation: Array<[Module, typeof Bot]> = [['对话', Bot], ['知识库', Library], ['能力', Wrench]]

// 聊天气泡区滚动条：保留薄滚动条与拇指描边效果。
const chatContentScrollbarStyle = {
  scrollbarColor: 'var(--color-app-border-strong) transparent',
  scrollbarWidth: 'thin',
} as React.CSSProperties

function App() {
  const [theme, setTheme] = useState<Theme>('dark'); const [activeModule, setActiveModule] = useState<Module>('对话')
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationState, setConversationState] = useState<ConversationState>({ type: 'draft', agentId: 'general-chat', knowledgeBaseId: null })
  const [messages, setMessages] = useState<Message[]>([]); const [isAsking, setIsAsking] = useState(false); const [chatError, setChatError] = useState<string | null>(null); const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null)
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]); const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState<string | null>(null); const [documents, setDocuments] = useState<KnowledgeDocument[]>([]); const [isKnowledgeLoading, setIsKnowledgeLoading] = useState(false); const [isUploading, setIsUploading] = useState(false); const [showCreateKnowledgeBase, setShowCreateKnowledgeBase] = useState(false); const [knowledgeError, setKnowledgeError] = useState<string | null>(null); const [capabilities, setCapabilities] = useState<Capabilities>(DEFAULT_CAPABILITIES)
  const [question, setQuestion] = useState('')
  const [chatAgents, setChatAgents] = useState<ChatAgentInfo[]>(DEFAULT_CAPABILITIES.chatAgents)

  // 品牌字样：从 /capabilities 读取，缺失时回退到 DEFAULT_CAPABILITIES 里的中性值。
  const appName = capabilities.app?.name ?? DEFAULT_CAPABILITIES.app!.name
  const appShortName = capabilities.app?.shortName ?? DEFAULT_CAPABILITIES.app!.shortName
  // avatar 用 shortName 首字符，Unicode 安全取首字符。
  const avatarInitial = Array.from(appShortName)[0] ?? 'M'

  const streamingAssistantIdRef = useRef<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const isSubmittingRef = useRef(false)

  const currentAgentId = conversationState.type === 'draft' ? conversationState.agentId : (conversations.find((c) => c.id === conversationState.id)?.agentId ?? 'general-chat')
  const currentKnowledgeBaseId = conversationState.type === 'draft' ? conversationState.knowledgeBaseId : (conversations.find((c) => c.id === conversationState.id)?.knowledgeBaseId ?? null)
  const activeKnowledgeBase = currentKnowledgeBaseId ? knowledgeBases.find((kb) => kb.id === currentKnowledgeBaseId) ?? null : null

  useEffect(() => { void refreshConversations() }, [])
  useEffect(() => { if (activeModule === '知识库') void refreshKnowledgeBases() }, [activeModule])
  useEffect(() => { void getCapabilities().then(setCapabilities).catch(() => setCapabilities(DEFAULT_CAPABILITIES)) }, [])
  useEffect(() => {
    void listAgents().then((agents) => {
      setChatAgents(agents.map((a) => ({ id: a.id, name: a.name, requiresKnowledgeBase: a.capabilities.knowledgeBase })))
    }).catch(() => {
      setChatAgents(DEFAULT_CAPABILITIES.chatAgents)
    })
  }, [])
  useEffect(() => { if (activeModule === '知识库' && selectedKnowledgeBaseId) void refreshDocuments(selectedKnowledgeBaseId) }, [activeModule, selectedKnowledgeBaseId])

  async function refreshConversations() {
    try { setConversations(await listConversations()) } catch (error) { console.error('加载会话列表失败', error) }
  }
  async function refreshKnowledgeBases() { setIsKnowledgeLoading(true); try { setKnowledgeBases(await listKnowledgeBases()) } catch (error) { setKnowledgeError(toErrorMessage(error)) } finally { setIsKnowledgeLoading(false) } }
  async function refreshDocuments(id: string) { setIsKnowledgeLoading(true); try { setDocuments(await listDocuments(id)) } catch (error) { setKnowledgeError(toErrorMessage(error)) } finally { setIsKnowledgeLoading(false) } }
  async function openConversation(id: string) {
    if (streamingAssistantIdRef.current) {
      await handleStop()
    }
    setChatError(null); setSelectedCitation(null)
    try {
      const { messages: loadedMessages } = await getConversation(id)
      setConversationState({ type: 'persisted', id })
      setMessages(loadedMessages.map((m) => m.role === 'user' ? { id: m.id, role: 'user', content: m.content, status: m.status as 'completed' | 'failed' } : { id: m.id, role: 'assistant', content: m.content, citations: m.citations, status: m.status as Message['status'] }))
    } catch (error) { setChatError(toErrorMessage(error)) }
  }
  function newChat() {
    if (streamingAssistantIdRef.current) {
      void handleStop()
    }
    setConversationState({ type: 'draft', agentId: 'general-chat', knowledgeBaseId: null }); setMessages([]); setChatError(null); setSelectedCitation(null)
  }
  async function switchAgent(agentId: string) {
    if (conversationState.type === 'draft') { setConversationState({ type: 'draft', agentId, knowledgeBaseId: agentId === 'general-chat' ? null : conversationState.knowledgeBaseId }); setChatError(null); return }
    try { const updated = await updateConversation(conversationState.id, { agentId }); setConversations((prev) => prev.map((c) => (c.id === updated.id ? { ...c, agentId: updated.agentId, knowledgeBaseId: updated.knowledgeBaseId } : c))); setChatError(null) } catch (error) { setChatError(toErrorMessage(error)) }
  }
  async function selectKnowledgeBase(knowledgeBase: Pick<KnowledgeBase, 'id' | 'name'>) {
    if (conversationState.type === 'draft') { setConversationState({ type: 'draft', agentId: 'knowledge-base', knowledgeBaseId: knowledgeBase.id }); setChatError(null); return }
    try { const updated = await updateConversation(conversationState.id, { agentId: 'knowledge-base', knowledgeBaseId: knowledgeBase.id }); setConversations((prev) => prev.map((c) => (c.id === updated.id ? { ...c, agentId: updated.agentId, knowledgeBaseId: updated.knowledgeBaseId, knowledgeBaseName: knowledgeBase.name } : c))); setChatError(null) } catch (error) { setChatError(toErrorMessage(error)) }
  }
  async function clearKnowledgeBase() {
    if (conversationState.type === 'draft') { setConversationState((prev) => prev.type === 'draft' ? { ...prev, knowledgeBaseId: null } : prev); return }
    try { const updated = await updateConversation(conversationState.id, { knowledgeBaseId: null }); setConversations((prev) => prev.map((c) => (c.id === updated.id ? { ...c, knowledgeBaseId: null, knowledgeBaseName: null } : c))) } catch (error) { setChatError(toErrorMessage(error)) }
  }

  async function handleStop() {
    const assistantId = streamingAssistantIdRef.current
    if (!assistantId) return
    abortControllerRef.current?.abort()
    try {
      await stopMessage(assistantId)
    } catch (error) {
      console.error('Stop failed:', error)
    }
  }

  function handleSSEEvent(event: SSEEvent) {
    if (event.event === 'message-start') {
      streamingAssistantIdRef.current = event.data.id
      setMessages((current) => {
        const exists = current.some((m) => m.id === event.data.id && m.role === 'assistant')
        if (exists) return current
        return [...current, { id: event.data.id, role: 'assistant', content: '', citations: [], status: 'streaming' }]
      })
    } else if (event.event === 'content-delta') {
      setMessages((current) => {
        const idx = current.findIndex((m) => m.id === event.data.messageId && m.role === 'assistant')
        if (idx === -1) return current
        const updated = current.slice()
        const assistant = updated[idx] as Extract<Message, { role: 'assistant' }>
        updated[idx] = { ...assistant, content: assistant.content + event.data.text }
        return updated
      })
    } else if (event.event === 'message-complete') {
      streamingAssistantIdRef.current = null
      abortControllerRef.current = null
      setMessages((current) => {
        const idx = current.findIndex((m) => m.id === event.data.id && m.role === 'assistant')
        if (idx === -1) return current
        const updated = current.slice()
        updated[idx] = {
          id: event.data.id,
          role: 'assistant',
          content: event.data.content,
          citations: event.data.citations,
          status: event.data.status as Extract<Message, { role: 'assistant' }>['status'],
        }
        return updated
      })
      void refreshConversations()
    } else if (event.event === 'message-error') {
      streamingAssistantIdRef.current = null
      abortControllerRef.current = null
      setMessages((current) => {
        const idx = current.findIndex((m) => m.id === event.data.id && m.role === 'assistant')
        if (idx === -1) return current
        const updated = current.slice()
        updated[idx] = {
          id: event.data.id,
          role: 'assistant',
          content: event.data.content || '',
          citations: [],
          status: event.data.status as Extract<Message, { role: 'assistant' }>['status'],
        }
        return updated
      })
      setChatError(event.data.error?.message ?? '生成失败，请重试。')
    } else if (event.event === 'tool-call-start') {
      setMessages((current) => {
        const idx = current.findIndex((m) => m.role === 'assistant' && (m.status === 'streaming' || m.status === 'pending'))
        if (idx === -1) return current
        const updated = current.slice()
        const assistant = updated[idx] as Extract<Message, { role: 'assistant' }>
        const tools = [...(assistant.tools ?? [])]
        tools.push({ status: 'running', toolCallId: event.data.toolCallId, toolName: event.data.toolName })
        updated[idx] = { ...assistant, tools }
        return updated
      })
    } else if (event.event === 'tool-call-complete') {
      setMessages((current) => {
        const idx = current.findIndex((m) => m.role === 'assistant')
        if (idx === -1) return current
        const updated = current.slice()
        const assistant = updated[idx] as Extract<Message, { role: 'assistant' }>
        const tools = (assistant.tools ?? []).map((t) => t.toolCallId === event.data.toolCallId ? { ...t, status: 'completed' as const } : t)
        updated[idx] = { ...assistant, tools }
        return updated
      })
    } else if (event.event === 'tool-call-error') {
      setMessages((current) => {
        const idx = current.findIndex((m) => m.role === 'assistant')
        if (idx === -1) return current
        const updated = current.slice()
        const assistant = updated[idx] as Extract<Message, { role: 'assistant' }>
        const tools = (assistant.tools ?? []).map((t) => t.toolCallId === event.data.toolCallId ? { ...t, status: 'failed' as const, errorCode: event.data.errorCode } : t)
        updated[idx] = { ...assistant, tools }
        return updated
      })
    }
  }

  async function submitQuestion() {
    const content = question.trim()
    if (!content || isSubmittingRef.current || streamingAssistantIdRef.current) return
    const currentAgent = chatAgents.find((a) => a.id === currentAgentId)
    if (currentAgent?.requiresKnowledgeBase && !currentKnowledgeBaseId) { setChatError('请先选择一个知识库。'); return }
    setChatError(null)
    setQuestion('')
    isSubmittingRef.current = true

    let convId: string
    if (conversationState.type === 'draft') {
      try {
        const created = await createConversation({ agentId: conversationState.agentId, knowledgeBaseId: conversationState.knowledgeBaseId })
        convId = created.id
        setConversationState({ type: 'persisted', id: convId })
        const summary: ConversationSummary = { id: created.id, title: created.title, agentId: created.agentId, knowledgeBaseId: created.knowledgeBaseId, knowledgeBaseName: created.knowledgeBaseName, createdAt: created.createdAt, updatedAt: created.updatedAt }
        setConversations((prev) => [summary, ...prev])
      } catch (error) { setChatError(toErrorMessage(error)); isSubmittingRef.current = false; return; }
    } else { convId = conversationState.id }

    // 立刻把用户消息渲染到 UI，避免等待首条 SSE 事件带来的"空档"
    const userMessageId = crypto.randomUUID()
    setMessages((current) => [...current, { id: userMessageId, role: 'user', content, status: 'completed' }])
    setIsAsking(true)

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    try {
      await streamAskMessage(convId, content, (event) => handleSSEEvent(event), abortController.signal)
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        const assistantId = streamingAssistantIdRef.current
        if (assistantId) {
          setMessages((current) => {
            const idx = current.findIndex((m) => m.id === assistantId && m.role === 'assistant')
            if (idx === -1) return current
            const updated = current.slice()
            const assistant = updated[idx] as Extract<Message, { role: 'assistant' }>
            updated[idx] = { ...assistant, status: 'stopped' }
            return updated
          })
        }
      } else {
        setChatError(toErrorMessage(error))
      }
    } finally {
      setIsAsking(false)
      isSubmittingRef.current = false
      streamingAssistantIdRef.current = null
      abortControllerRef.current = null
    }
  }

  async function handleRegenerate(assistantMessageId: string) {
    if (streamingAssistantIdRef.current || isSubmittingRef.current) return
    isSubmittingRef.current = true
    setChatError(null)

    const abortController = new AbortController()
    abortControllerRef.current = abortController
    setIsAsking(true)

    try {
      await regenerateMessage(assistantMessageId, (event) => handleSSEEvent(event), abortController.signal)
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        const assistantId = streamingAssistantIdRef.current
        if (assistantId) {
          setMessages((current) => {
            const idx = current.findIndex((m) => m.id === assistantId && m.role === 'assistant')
            if (idx === -1) return current
            const updated = current.slice()
            const assistant = updated[idx] as Extract<Message, { role: 'assistant' }>
            updated[idx] = { ...assistant, status: 'stopped' }
            return updated
          })
        }
      } else {
        setChatError(toErrorMessage(error))
      }
    } finally {
      setIsAsking(false)
      isSubmittingRef.current = false
      streamingAssistantIdRef.current = null
      abortControllerRef.current = null
    }
  }

  async function handleDeleteConversation(id: string) {
    const conversation = conversations.find((item) => item.id === id)
    if (!window.confirm(`确定删除“${conversation?.title ?? '此对话'}”吗？此操作无法撤销。`)) return
    try { await deleteConversation(id); setConversations((prev) => prev.filter((c) => c.id !== id)); if (conversationState.type === 'persisted' && conversationState.id === id) newChat() } catch (error) { setChatError(toErrorMessage(error)) }
  }
  function enterChatFromKnowledgeBase(knowledgeBase: Pick<KnowledgeBase, 'id' | 'name'>) { setConversationState({ type: 'draft', agentId: 'knowledge-base', knowledgeBaseId: knowledgeBase.id }); setMessages([]); setChatError(null); setSelectedCitation(null); setActiveModule('对话') }
  async function createKnowledgeBaseFromForm(name: string, description: string) { setKnowledgeError(null); const created = await createKnowledgeBase({ name, ...(description ? { description } : {}) }); setKnowledgeBases((current) => [created, ...current]); setSelectedKnowledgeBaseId(created.id); setShowCreateKnowledgeBase(false) }
  async function handleUpload(file: File | undefined) { if (!file || !selectedKnowledgeBaseId || isUploading) return; setIsUploading(true); setKnowledgeError(null); try { await uploadDocument(selectedKnowledgeBaseId, file); await Promise.all([refreshDocuments(selectedKnowledgeBaseId), refreshKnowledgeBases()]) } catch (error) { setKnowledgeError(toErrorMessage(error)) } finally { setIsUploading(false) } }
  async function handleDeleteKnowledgeBase(id: string) {
    const knowledgeBase = knowledgeBases.find((item) => item.id === id)
    if (!window.confirm(`确定删除知识库“${knowledgeBase?.name ?? ''}”吗？其中的文档也会被删除。`)) return
    setKnowledgeError(null)
    try {
      await deleteKnowledgeBase(id)
      setKnowledgeBases((current) => current.filter((item) => item.id !== id))
      setDocuments([])
      if (selectedKnowledgeBaseId === id) setSelectedKnowledgeBaseId(null)
      if (currentKnowledgeBaseId === id) {
        if (conversationState.type === 'draft') setConversationState({ type: 'draft', agentId: 'knowledge-base', knowledgeBaseId: null })
        else {
          const updated = await updateConversation(conversationState.id, { knowledgeBaseId: null })
          setConversations((current) => current.map((item) => item.id === updated.id ? { ...item, knowledgeBaseId: null, knowledgeBaseName: null } : item))
        }
      }
    } catch (error) { setKnowledgeError(toErrorMessage(error)) }
  }
  async function handleDeleteDocument(id: string) { if (!selectedKnowledgeBaseId || !window.confirm('确定删除此文档吗？')) return; setKnowledgeError(null); try { await deleteDocument(id); await Promise.all([refreshDocuments(selectedKnowledgeBaseId), refreshKnowledgeBases()]) } catch (error) { setKnowledgeError(toErrorMessage(error)) } }
  function selectModule(module: Module) {
    if (module !== '对话' && streamingAssistantIdRef.current) {
      void handleStop()
    }
    setActiveModule(module); setSelectedCitation(null); if (module === '知识库') setKnowledgeError(null)
  }
  const selectedKnowledgeBase = knowledgeBases.find((item) => item.id === selectedKnowledgeBaseId) ?? null
  const isStreaming = !!streamingAssistantIdRef.current
  return <main className={cn('flex h-screen overflow-hidden text-app-text bg-app-bg', theme === 'dark' && 'dark')}>
    <Sidebar
      appName={appName}
      avatarInitial={avatarInitial}
      activeModule={activeModule}
      knowledgeBases={knowledgeBases}
      selectedKnowledgeBaseId={selectedKnowledgeBaseId}
      conversations={conversations}
      currentConversationId={conversationState.type === 'persisted' ? conversationState.id : null}
      onSelectModule={selectModule}
      onSelectKnowledgeBase={(id) => { setSelectedKnowledgeBaseId(id); setShowCreateKnowledgeBase(false) }}
      onNewChat={newChat}
      onOpenConversation={openConversation}
      onDeleteConversation={handleDeleteConversation}
      onNewKnowledgeBase={() => { setSelectedKnowledgeBaseId(null); setShowCreateKnowledgeBase(true) }}
      theme={theme}
      onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    />
    {activeModule === '对话' && <ChatWorkspace
      appShortName={appShortName}
      question={question}
      messages={messages}
      isAsking={isAsking}
      isStreaming={isStreaming}
      error={chatError}
      chatAgents={chatAgents}
      knowledgeBases={knowledgeBases}
      selectedAgentId={currentAgentId}
      defaultChatModel={capabilities.defaultChatModel}
      activeKnowledgeBase={activeKnowledgeBase}
      onQuestionChange={setQuestion}
      onSubmit={() => void submitQuestion()}
      onStop={() => void handleStop()}
      onRegenerate={handleRegenerate}
      onSwitchAgent={switchAgent}
      onSelectKnowledgeBase={selectKnowledgeBase}
      onClearKnowledgeBase={clearKnowledgeBase}
      onSelectCitation={setSelectedCitation}
    />}
    {activeModule === '知识库' && <KnowledgeBaseWorkspace selectedKnowledgeBase={selectedKnowledgeBase} documents={documents} isLoading={isKnowledgeLoading} isUploading={isUploading} showCreate={showCreateKnowledgeBase} error={knowledgeError} capabilities={capabilities} onCreate={createKnowledgeBaseFromForm} onBack={() => { setSelectedKnowledgeBaseId(null); setShowCreateKnowledgeBase(false) }} onEnterChat={enterChatFromKnowledgeBase} onUpload={handleUpload} onDeleteDocument={handleDeleteDocument} onDeleteKnowledgeBase={handleDeleteKnowledgeBase} />}
    {activeModule === '能力' && <SkillsWorkspace />}
    {selectedCitation && <CitationPanel citation={selectedCitation} onClose={() => setSelectedCitation(null)} />}
  </main>
}

function Sidebar({ appName, avatarInitial, activeModule, knowledgeBases, selectedKnowledgeBaseId, conversations, currentConversationId, onSelectModule, onSelectKnowledgeBase, onNewChat, onOpenConversation, onDeleteConversation, onNewKnowledgeBase, theme, onToggleTheme }: { appName: string; avatarInitial: string; activeModule: Module; knowledgeBases: KnowledgeBase[]; selectedKnowledgeBaseId: string | null; conversations: ConversationSummary[]; currentConversationId: string | null; onSelectModule: (module: Module) => void; onSelectKnowledgeBase: (id: string) => void; onNewChat: () => void; onOpenConversation: (id: string) => void; onDeleteConversation: (id: string) => void; onNewKnowledgeBase: () => void; theme: Theme; onToggleTheme: () => void }) {
  return <aside className="flex shrink-0 basis-[272px] min-w-0 flex-col h-full overflow-hidden border-r border-app-border bg-app-surface max-[900px]:basis-[230px]">
    <div className="shrink-0 px-4 pt-5 pb-3.5">
      <div className="flex items-center gap-2 px-1 pb-5 text-xl font-bold tracking-wider">
        <Sparkles size={22} />
        <span>{appName}</span>
      </div>
      {activeModule === '对话' && <button className="flex items-center justify-center gap-2 w-full py-2.5 text-app-text bg-transparent border border-app-border-strong rounded-lg hover:bg-app-surface-muted" onClick={onNewChat}>
        <Plus size={17} />新建对话
      </button>}
      {activeModule === '知识库' && <button className="flex items-center justify-center gap-2 w-full py-2.5 text-app-text bg-transparent border border-app-border-strong rounded-lg hover:bg-app-surface-muted" onClick={onNewKnowledgeBase}>
        <Plus size={17} />新建知识库
      </button>}
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
      {activeModule === '对话' && <section>
        <p className="flex items-center gap-2 mx-2 my-2.5 text-app-muted text-[13px]"><CircleHelp size={15} />最近对话</p>
        {conversations.length === 0 ? <p className="m-2 text-app-muted text-xs">暂无已保存的对话</p> : (
          <div className="grid gap-0.5">
            {conversations.map((conv) => (
              <div key={conv.id} className="flex items-center gap-0.5">
                <button className={cn('flex items-center gap-2.5 flex-1 py-2.5 px-2 text-app-text bg-transparent border-0 rounded-md text-left hover:bg-app-surface-muted', currentConversationId === conv.id && 'bg-app-surface-muted')} onClick={() => onOpenConversation(conv.id)}>
                  <Bot size={17} />
                  <span className="grid gap-1 min-w-0">
                    <strong className="text-sm truncate">{conv.title}</strong>
                    <small className="text-app-muted text-xs">{conv.knowledgeBaseName ? `知识库：${conv.knowledgeBaseName}` : conv.agentId === 'general-chat' ? '通用对话' : '知识库问答'}</small>
                  </span>
                </button>
                <button className="grid place-items-center p-1 text-app-muted bg-transparent border-0 rounded-md hover:text-app-text hover:bg-app-hover" onClick={(e) => { e.stopPropagation(); void onDeleteConversation(conv.id); }} aria-label={`删除 ${conv.title}`}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        )}
      </section>}
      {activeModule === '知识库' && <section>
        <p className="flex items-center gap-2 mx-2 my-2.5 text-app-muted text-[13px]"><Library size={15} />知识库</p>
        <div className="grid gap-0.5">
          {knowledgeBases.length === 0 ? <p className="m-2 text-app-muted text-xs">还没有知识库</p> : knowledgeBases.map((item) => (
            <button key={item.id} className={cn('flex items-center gap-2.5 w-full py-2.5 px-2 text-app-text bg-transparent border-0 rounded-md text-left hover:bg-app-surface-muted', selectedKnowledgeBaseId === item.id && 'bg-app-surface-muted')} onClick={() => onSelectKnowledgeBase(item.id)}>
              <Library size={17} />
              <span className="grid gap-1 min-w-0">
                <strong className="text-sm truncate">{item.name}</strong>
                <small className="text-app-muted text-xs">{item.documentCount} 个文档</small>
              </span>
            </button>
          ))}
        </div>
      </section>}
    </div>
    <nav className="grid grid-cols-4 gap-0.5 shrink-0 pt-2.5 px-3 border-t border-app-border">
      {navigation.map(([name, Icon]) => (
        <button key={name} className={cn('grid place-items-center gap-1 py-2 px-0.5 text-app-muted bg-transparent border-0 rounded-md text-[11px] hover:bg-app-surface-muted', activeModule === name && 'text-app-text font-semibold bg-app-surface-muted')} onClick={() => onSelectModule(name)}>
          <Icon size={19} /><span>{name}</span>
        </button>
      ))}
    </nav>
    <div className="flex items-center justify-between shrink-0 pt-2.5 px-4 pb-3.5">
      <span className="grid place-items-center w-8 h-8 rounded-full text-app-surface bg-app-text text-[13px] font-bold">{avatarInitial}</span>
      <button className="grid place-items-center p-2 text-app-muted bg-transparent border-0 rounded-md hover:text-app-text hover:bg-app-hover" onClick={onToggleTheme} aria-label="切换主题">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
    </div>
  </aside>
}

function ChatWorkspace({ appShortName, question, messages, isAsking, isStreaming, error, chatAgents, knowledgeBases, selectedAgentId, defaultChatModel, activeKnowledgeBase, onQuestionChange, onSubmit, onStop, onRegenerate, onSwitchAgent, onSelectKnowledgeBase, onClearKnowledgeBase, onSelectCitation }: { appShortName: string; question: string; messages: Message[]; isAsking: boolean; isStreaming: boolean; error: string | null; chatAgents: ChatAgentInfo[]; knowledgeBases: KnowledgeBase[]; selectedAgentId: string; defaultChatModel: string; activeKnowledgeBase: Pick<KnowledgeBase, 'id' | 'name'> | null; onQuestionChange: (value: string) => void; onSubmit: () => void; onStop: () => void; onRegenerate: (assistantMessageId: string) => void; onSwitchAgent: (agentId: string) => void; onSelectKnowledgeBase: (knowledgeBase: KnowledgeBase) => void; onClearKnowledgeBase: () => void; onSelectCitation: (citation: Citation) => void }) {
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false)
  const [isKnowledgeBasePickerOpen, setIsKnowledgeBasePickerOpen] = useState(false)
  const agentPickerRef = useRef<HTMLDivElement>(null)
  const knowledgeBasePickerRef = useRef<HTMLDivElement>(null)
  const messageScrollRef = useRef<HTMLDivElement>(null)
  const followsLatestRef = useRef(true)
  const isComposingRef = useRef(false)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  useEffect(() => {
    function closePickers(event: MouseEvent) {
      if (!agentPickerRef.current?.contains(event.target as Node)) setIsAgentPickerOpen(false)
      if (!knowledgeBasePickerRef.current?.contains(event.target as Node)) setIsKnowledgeBasePickerOpen(false)
    }
    document.addEventListener('mousedown', closePickers)
    return () => document.removeEventListener('mousedown', closePickers)
  }, [])
  function scrollToLatest(behavior: ScrollBehavior = 'smooth') {
    const element = messageScrollRef.current
    if (!element) return
    followsLatestRef.current = true
    setShowJumpToLatest(false)
    element.scrollTo({ top: element.scrollHeight, behavior })
  }
  function handleMessageScroll() {
    const element = messageScrollRef.current
    if (!element) return
    const isAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48
    followsLatestRef.current = isAtBottom
    setShowJumpToLatest(!isAtBottom)
  }
  useEffect(() => {
    if (!followsLatestRef.current) return
    const frame = requestAnimationFrame(() => scrollToLatest('auto'))
    return () => cancelAnimationFrame(frame)
  }, [messages, isAsking])
  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !isComposingRef.current) {
      event.preventDefault()
      if (isStreaming) {
        onStop()
      } else {
        onSubmit()
      }
    }
  }
  const currentAgent = chatAgents.find((agent) => agent.id === selectedAgentId)
  const isKnowledgeAgent = currentAgent?.requiresKnowledgeBase ?? false
  const canSend = question.trim().length > 0 && !isAsking && !isStreaming && (!isKnowledgeAgent || !!activeKnowledgeBase)
  const lastAssistantIndex = messages.reduce((idx, m, i) => m.role === 'assistant' ? i : idx, -1)
  return <section className="flex flex-1 min-w-0 min-h-0 overflow-hidden flex-col bg-app-bg">
    <header className="flex items-center justify-between gap-4 shrink-0 min-h-[68px] py-3 px-6 border-b border-app-border bg-app-surface">
      <div><h1 className="m-0 text-lg">{currentAgent?.name ?? '对话'}</h1></div>
      <div className="flex items-center gap-3">
        <div className="relative flex items-center gap-1.5" ref={agentPickerRef}>
          <span className="text-app-muted text-xs">智能体</span>
          <button className="relative flex items-center justify-between gap-4 min-w-[138px] min-h-[30px] py-1.5 px-2 text-xs text-app-text bg-app-surface border border-app-border-strong rounded-md cursor-pointer hover:bg-app-hover hover:border-app-text" type="button" onClick={() => setIsAgentPickerOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={isAgentPickerOpen}>
            {currentAgent?.name ?? '选择智能体'}
            <ChevronDown size={15} className="static shrink-0 pointer-events-none" />
          </button>
          {isAgentPickerOpen && <div className="absolute z-10 top-[calc(100%+5px)] right-0 grid min-w-[184px] p-1 bg-app-surface border border-app-border-strong rounded-md shadow-2xl" role="listbox" aria-label="选择智能体">
            {chatAgents.map((agent) => (
              <button key={agent.id} className={cn('flex items-center justify-between gap-2.5 py-1.5 px-2 text-xs text-app-text bg-transparent border-0 rounded text-left hover:bg-app-surface-muted', agent.id === selectedAgentId && 'bg-app-surface-muted font-semibold')} type="button" role="option" aria-selected={agent.id === selectedAgentId} onClick={() => { onSwitchAgent(agent.id); setIsAgentPickerOpen(false) }}>
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
            <div className="flex gap-3.5 flex-row-reverse" key={message.id}>
              <div className="flex flex-col items-end">
                <p className="m-0 py-3 px-3.5 bg-app-surface-muted rounded-md text-[15px]">{message.content}</p>
              </div>
            </div>
          ) : <AssistantMessage key={message.id} message={message} isLast={index === lastAssistantIndex} onSelectCitation={onSelectCitation} onRegenerate={onRegenerate} />)}
          {isAsking && !isStreaming && (
            <div className="flex gap-3.5 mt-7">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[15px] leading-[1.9] text-app-muted">
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
      <div className="w-full max-w-[805px] mx-auto p-2.5 border border-app-border-strong rounded-xl bg-app-surface">
        {isKnowledgeAgent && activeKnowledgeBase && (
          <div className="flex items-center gap-1.5 w-fit mt-0 mx-2 mb-0.5 px-2 py-1.5 bg-app-surface-muted border border-app-border rounded text-xs">
            <Library size={15} /><span>当前知识库：<strong>{activeKnowledgeBase.name}</strong></span>
            <button className="grid place-items-center p-0 text-app-muted bg-transparent border-0" onClick={onClearKnowledgeBase} aria-label="退出当前知识库"><X size={15} /></button>
          </div>
        )}
        {isKnowledgeAgent && !activeKnowledgeBase && (
          <div className="flex items-center gap-1.5 w-fit mt-0 mx-2 mb-0.5 px-2 py-1.5 text-app-danger bg-app-danger/[0.07] border border-app-border rounded text-xs">
            <Library size={15} /><span>请先选择一个知识库</span>
          </div>
        )}
        <textarea
          className="block w-full min-h-14 p-2 resize-none outline-0 text-app-text bg-transparent border-0 text-sm placeholder:text-app-muted disabled:cursor-not-allowed disabled:opacity-50"
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
            <button className="py-1.5 px-2 text-[13px] text-app-muted bg-app-surface border border-app-border rounded" type="button" onClick={() => setIsKnowledgeBasePickerOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={isKnowledgeBasePickerOpen}>选择知识库</button>
            {isKnowledgeBasePickerOpen && (
              <div className="absolute z-10 bottom-[calc(100%+7px)] left-0 grid min-w-[220px] max-w-[280px] p-1.5 bg-app-surface border border-app-border-strong rounded-lg shadow-2xl" role="listbox" aria-label="选择知识库">
                {knowledgeBases.length === 0 ? <p className="m-1.5 px-2 text-app-muted text-xs leading-snug">暂无知识库，请先在知识库页创建。</p> : knowledgeBases.map((knowledgeBase) => (
                  <button type="button" role="option" aria-selected={knowledgeBase.id === activeKnowledgeBase?.id} className={cn('flex items-center gap-2 w-full py-2 px-2 text-app-text bg-transparent border-0 rounded text-left hover:bg-app-surface-muted', knowledgeBase.id === activeKnowledgeBase?.id && 'bg-app-surface-muted')} key={knowledgeBase.id} onClick={() => { onSelectKnowledgeBase(knowledgeBase); setIsKnowledgeBasePickerOpen(false) }}>
                    <Library size={14} /><span>{knowledgeBase.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <button className={cn('grid place-items-center w-[34px] h-[34px] text-app-surface bg-app-text border-0 rounded-md disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90', isStreaming && 'bg-app-danger hover:bg-red-600')} onClick={isStreaming ? onStop : onSubmit} disabled={!isStreaming && !canSend} aria-label={isStreaming ? '停止生成' : '发送问题'}>
              {isStreaming ? <X size={18} /> : <Send size={18} />}
            </button>
          </div>
        </div>
      </div>
      <p className="w-full max-w-[805px] mx-auto mt-2.5 text-app-muted text-center text-xs">Enter 发送，Shift + Enter 换行</p>
    </div>
  </section>
}

function AssistantMessage({ message, isLast, onSelectCitation, onRegenerate }: { message: Extract<Message, { role: 'assistant' }>; isLast: boolean; onSelectCitation: (citation: Citation) => void; onRegenerate: (id: string) => void }) {
  const isFailed = message.status === 'failed'
  const isStopped = message.status === 'stopped'
  const showRetry = isFailed || isStopped
  const showRegenerate = message.status === 'completed' && isLast
  const showActions = message.status !== 'pending' && message.status !== 'streaming'
  return (
    <div className="flex gap-3.5 mt-7">
      <div className="min-w-0">
        <div className="text-[15px] leading-[1.9]">
          {message.content ? message.content.split(/\n{2,}/).map((paragraph, i) => <p key={i} className="m-0 mb-4">{paragraph}</p>) : (message.status === 'pending' || message.status === 'streaming') ? null : <p className="m-0 mb-4 text-app-muted">（无内容）</p>}
          {isFailed && <span className="inline-flex items-center gap-1 mt-1.5 px-2 py-1 rounded text-xs text-app-danger bg-app-danger/10 border border-app-danger/20">生成失败</span>}
          {isStopped && <span className="inline-flex items-center gap-1 mt-1.5 px-2 py-1 rounded text-xs text-app-warning bg-app-warning/10 border border-app-warning/20">已停止</span>}
        </div>
        {message.tools && message.tools.length > 0 && (
          <div className="mt-3 py-2.5 px-3 bg-app-surface-muted border border-app-border rounded-md">
            <div className="mb-1.5 text-app-muted text-xs font-semibold">工具调用</div>
            {message.tools.map((t) => (
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
            <div className="mt-4 text-app-muted text-[13px]">引用来源（{message.citations.length}）</div>
            <div className="flex flex-wrap gap-2 mt-2">
              {message.citations.map((citation, index) => (
                <button onClick={() => onSelectCitation(citation)} className="flex items-center gap-1.5 py-1.5 px-2.5 text-[13px] text-app-text bg-transparent border border-app-border-strong rounded-md hover:border-app-text hover:bg-app-surface-muted" key={citation.chunkId}>
                  <span className="grid place-items-center w-4 h-4 border border-app-muted rounded-full text-[10px]">{index + 1}</span>
                  {citation.title} {citation.chapter}
                </button>
              ))}
            </div>
          </>
        )}
        {showActions && (
          <div className="flex flex-wrap gap-2.5 mt-4">
            {showRetry && <button className="inline-flex items-center gap-1 mt-0 py-1 px-2.5 text-xs text-app-text bg-app-surface-muted border border-app-border rounded hover:bg-app-hover" onClick={() => onRegenerate(message.id)}><RotateCcw size={14} />重试</button>}
            {showRegenerate && <button className="inline-flex items-center gap-1 mt-0 py-1 px-2.5 text-xs text-app-text bg-app-surface-muted border border-app-border rounded hover:bg-app-hover" onClick={() => onRegenerate(message.id)}><RefreshCw size={14} />重新生成</button>}
          </div>
        )}
      </div>
    </div>
  )
}

function KnowledgeBaseWorkspace({ selectedKnowledgeBase, documents, isLoading, isUploading, showCreate, error, capabilities, onCreate, onBack, onEnterChat, onUpload, onDeleteDocument, onDeleteKnowledgeBase }: { selectedKnowledgeBase: KnowledgeBase | null; documents: KnowledgeDocument[]; isLoading: boolean; isUploading: boolean; showCreate: boolean; error: string | null; capabilities: Capabilities; onCreate: (name: string, description: string) => Promise<void>; onBack: () => void; onEnterChat: (knowledgeBase: Pick<KnowledgeBase, 'id' | 'name'>) => void; onUpload: (file: File | undefined) => void; onDeleteDocument: (id: string) => void; onDeleteKnowledgeBase: (id: string) => void }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const inputRef = useRef<HTMLInputElement>(null);
  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim()) {
      await onCreate(name.trim(), description.trim());
      setName('');
      setDescription('');
    }
  }
  const supportedLabels = capabilities.documentFormats.map((f) => ({ txt: 'TXT', md: 'Markdown', pdf: 'PDF', docx: 'DOCX' }[f] ?? f.toUpperCase()));
  const acceptMap: Record<string, string> = { txt: '.txt,text/plain', md: '.md,text/markdown', pdf: '.pdf,application/pdf', docx: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const acceptAttr = capabilities.documentFormats.map((f) => acceptMap[f]).filter(Boolean).join(',');
  const uploadHint = supportedLabels.length > 0 ? `支持 ${supportedLabels.join('、')}，单文件不超过 10 MB。` : '暂不支持文件上传。';
  return <section className="flex-1 min-w-0 min-h-0 overflow-y-auto py-8 px-7 bg-app-bg">
    <div className="w-full max-w-[920px] mx-auto">
      <header className="flex items-start justify-between gap-4 mb-7">
        <div>
          <h1 className="m-0 text-2xl">{selectedKnowledgeBase ? selectedKnowledgeBase.name : '知识库'}</h1>
          <p className="mt-2 text-app-muted text-sm">{selectedKnowledgeBase ? `${selectedKnowledgeBase.documentCount} 个文档 · ${selectedKnowledgeBase.chunkCount ?? 0} 个片段` : '从左侧选择或新建一个知识库。'}</p>
        </div>
        {selectedKnowledgeBase && (
          <div className="flex gap-2">
            <button className="inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm text-app-text bg-transparent border border-app-border-strong" onClick={onBack}>返回列表</button>
            <button className="inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm text-app-surface bg-app-text border border-app-text" onClick={() => onEnterChat(selectedKnowledgeBase)}><Bot size={17} />进入问答</button>
            <button className="inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm text-app-danger bg-transparent border border-app-danger/50" onClick={() => onDeleteKnowledgeBase(selectedKnowledgeBase.id)}><Trash2 size={16} />删除</button>
          </div>
        )}
      </header>
      {error && <p className="my-4 py-2.5 px-3 text-app-danger bg-app-danger/[0.07] border border-app-danger/33 rounded-md text-[13px]">{error}</p>}
      {!selectedKnowledgeBase && (
        <>
          {showCreate && (
            <form className="grid grid-cols-[1fr_1.5fr_auto] gap-2.5 mb-5" onSubmit={(event) => void submitCreate(event)}>
              <input className="min-w-0 py-2.5 px-2.5 text-app-text bg-app-surface border border-app-border-strong rounded-md outline-0" value={name} onChange={(event) => setName(event.target.value)} placeholder="知识库名称" maxLength={120} autoFocus />
              <input className="min-w-0 py-2.5 px-2.5 text-app-text bg-app-surface border border-app-border-strong rounded-md outline-0" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述（可选）" maxLength={2000} />
              <button className="inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm text-app-surface bg-app-text border border-app-text disabled:cursor-not-allowed disabled:opacity-55" type="submit">创建</button>
            </form>
          )}
          <div className="grid place-items-center gap-2 py-9 px-6 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">
            <Library size={24} />
            <strong className="text-app-text">还没有知识库</strong>
            <p className="max-w-md m-0 leading-relaxed">创建知识库后，可以上传 TXT 或 Markdown，并让知识库问答基于资料回答。</p>
          </div>
        </>
      )}
      {selectedKnowledgeBase && (
        <>
          <div className="flex items-center justify-between p-4 mb-4 text-app-text bg-app-surface border border-app-border rounded-xl">
            <div>
              <strong>上传文本资料</strong>
              <p className="mt-2 text-app-muted text-sm">{uploadHint}</p>
            </div>
            <input ref={inputRef} type="file" accept={acceptAttr} hidden onChange={(event) => onUpload(event.target.files?.[0])} />
            <button className="inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm text-app-surface bg-app-text border border-app-text disabled:cursor-not-allowed disabled:opacity-55" onClick={() => inputRef.current?.click()} disabled={isUploading}><Upload size={17} />{isUploading ? '正在入库…' : '上传文档'}</button>
          </div>
          <div className="grid gap-2.5">
            {isLoading ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">正在加载文档…</p>
              : documents.length === 0 ? (
                <div className="grid place-items-center gap-2 py-9 px-6 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">
                  <FileText size={24} />
                  <strong className="text-app-text">还没有文档</strong>
                  <p className="max-w-md m-0 leading-relaxed">支持 TXT、Markdown；上传后会显示处理状态。</p>
                </div>
              ) : documents.map((document) => (
                <article className="flex items-center gap-3.5 p-4 text-app-text bg-app-surface border border-app-border rounded-xl" key={document.id}>
                  <FileText size={21} />
                  <div className="grid gap-1 min-w-0">
                    <strong className="truncate">{document.name}</strong>
                    <small className="text-app-muted text-xs">{formatBytes(document.size)} · {document.chunkCount} 个片段 · {formatStatus(document.status)}</small>
                    {document.errorMessage && <small className="text-app-danger">{document.errorMessage}</small>}
                  </div>
                  <button className="grid place-items-center ml-auto p-2 text-app-muted bg-transparent border-0 rounded-md hover:text-app-text hover:bg-app-hover" onClick={() => onDeleteDocument(document.id)} aria-label={`删除 ${document.name}`}><Trash2 size={17} /></button>
                </article>
              ))}
          </div>
        </>
      )}
    </div>
  </section>
}

function CitationPanel({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  return <aside className="flex shrink-0 basis-[380px] min-w-0 h-full overflow-hidden flex-col border-l border-app-border bg-app-surface max-[900px]:basis-[330px]">
    <header className="flex items-center justify-between shrink-0 min-h-[68px] px-5 border-b border-app-border text-lg">
      <strong>引用来源</strong>
      <button className="grid place-items-center p-2 text-app-muted bg-transparent border-0 rounded-md hover:text-app-text hover:bg-app-hover" onClick={onClose}><X size={20} /></button>
    </header>
    <div className="flex-1 min-h-0 overflow-y-auto">
      <article className="m-4 p-4 border border-app-border-strong rounded-xl text-sm leading-[1.75]">
        <h2 className="m-0 text-lg">{citation.documentName ?? citation.title}</h2>
        <p className="mt-1 mb-3 text-app-muted">{citation.heading ?? citation.chapter}</p>
        <hr className="border-0 border-t border-app-border" />
        <h3 className="mt-4 mb-1 text-app-muted text-[13px] font-medium">原文</h3>
        <p className="m-0 mb-2 whitespace-pre-wrap">{citation.content}</p>
        <h3 className="mt-4 mb-1 text-app-muted text-[13px] font-medium">元数据</h3>
        <dl className="grid grid-cols-[60px_1fr] gap-2 mt-2">
          {citation.documentId ? (
            <>
              <dt className="text-app-muted">文档</dt><dd className="m-0 break-words">{citation.documentName}</dd>
              <dt className="text-app-muted">片段</dt><dd className="m-0 break-words">第 {(citation.chunkIndex ?? 0) + 1} 段</dd>
            </>
          ) : (
            <>
              <dt className="text-app-muted">作者</dt><dd className="m-0 break-words">{citation.author ?? '未标注'}</dd>
              <dt className="text-app-muted">版本</dt><dd className="m-0 break-words">{citation.version ?? '未标注'}</dd>
            </>
          )}
          <dt className="text-app-muted">类型</dt><dd className="m-0 break-words">{citation.category || citation.type}</dd>
          <dt className="text-app-muted">来源</dt><dd className="m-0 break-words">{citation.source || '未标注'}</dd>
        </dl>
      </article>
    </div>
  </aside>
}

function SkillsWorkspace() {
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [tools, setTools] = useState<ToolDefinition[]>([])
  const [agents, setAgents] = useState<import('./types/conversation').AgentDefinition[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [marketResults, setMarketResults] = useState<MarketSkillInfo[]>([])
  const [searchingMarket, setSearchingMarket] = useState(false)
  const [selectedMarketSkill, setSelectedMarketSkill] = useState<MarketSkillInfo | null>(null)
  const [preview, setPreview] = useState<MarketSkillPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  async function refresh() {
    setLoading(true)
    try {
      const [s, a, t] = await Promise.all([listSkills(), listAgents(), listTools()])
      setSkills(s)
      setAgents(a)
      setTools(t)
      setError(null)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  async function loadPopular() {
    setSearchingMarket(true)
    try {
      const r = await listPopularMarketSkills()
      setMarketResults(r.results)
      setError(null)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setSearchingMarket(false)
    }
  }

  async function handleSearch(query: string) {
    const trimmed = query.trim()
    if (!trimmed) {
      void loadPopular()
      return
    }
    setSearchingMarket(true)
    try {
      const r = await searchMarketSkills(trimmed)
      setMarketResults(r.results)
      setError(null)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setSearchingMarket(false)
    }
  }

  async function handleSelectMarketSkill(item: MarketSkillInfo) {
    setSelectedMarketSkill(item)
    setPreview(null)
    setPreviewLoading(true)
    try {
      const p = await previewMarketSkill(item.owner, item.repo, item.skillName)
      setPreview(p)
      setError(null)
    } catch (err) {
      setError(toErrorMessage(err))
      setPreview(null)
    } finally {
      setPreviewLoading(false)
    }
  }

  async function handleInstall() {
    if (!selectedMarketSkill || !preview) return
    setInstalling(true)
    try {
      await installMarketSkill(selectedMarketSkill.owner, selectedMarketSkill.repo, selectedMarketSkill.skillName)
      setSelectedMarketSkill(null)
      setPreview(null)
      await refresh()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setInstalling(false)
    }
  }

  async function handleRemove(id: string) {
    if (!confirm('确定要卸载此技能吗？')) return
    try {
      await removeSkill(id)
      await refresh()
    } catch (err) {
      setError(toErrorMessage(err))
    }
  }

  async function handleBind(skillId: string, agentId: string) {
    try {
      await bindSkillToAgent(skillId, agentId)
      await refresh()
    } catch (err) {
      setError(toErrorMessage(err))
    }
  }

  async function handleUnbind(skillId: string, agentId: string) {
    try {
      await unbindSkillFromAgent(skillId, agentId)
      await refresh()
    } catch (err) {
      setError(toErrorMessage(err))
    }
  }

  useEffect(() => { void refresh() }, [])
  useEffect(() => { void loadPopular() }, [])

  return (
    <section className="flex-1 min-w-0 min-h-0 overflow-y-auto py-8 px-7 bg-app-bg">
      <div className="w-full max-w-[920px] mx-auto">
        <header className="flex items-start justify-between gap-4 mb-7">
          <div>
            <h1 className="m-0 text-2xl">能力</h1>
            <p className="mt-2 text-app-muted text-sm">查看当前 Starter 已提供的 Skills 与 Tools。</p>
          </div>
        </header>
        {error && <p className="my-4 py-2.5 px-3 text-app-danger bg-app-danger/[0.07] border border-app-danger/33 rounded-md text-[13px]">{error}</p>}
        <div className="mt-7">
          <h2 className="flex items-center gap-2 m-0 mb-3.5 text-[17px]">Tools</h2>
          {loading ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">正在加载工具…</p>
            : tools.length === 0 ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">当前没有可用工具。</p>
              : (
                <div className="grid gap-2.5">
                  {tools.map((tool) => (
                    <article className="flex items-start justify-between gap-3 p-3.5 bg-app-surface border border-app-border rounded-xl" key={tool.id}>
                      <div className="min-w-0">
                        <strong className="text-[15px]">{tool.displayName}</strong>
                        <span className="inline-flex items-center ml-2 py-0.5 px-2 rounded-full text-[11px] font-semibold text-app-skill-builtin bg-app-skill-builtin/10">内置</span>
                        <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">{tool.description}</p>
                        <small className="text-app-muted text-xs">ID：{tool.id}</small>
                      </div>
                      <div className="grid gap-1 shrink-0 w-40 text-app-muted text-xs">
                        <small>可用于</small>
                        {agents.filter((agent) => agent.toolIds.includes(tool.id)).map((agent) => <span key={agent.id} className="text-app-text">{agent.name}</span>)}
                      </div>
                    </article>
                  ))}
                </div>
              )}
        </div>
        <div className="mt-7">
          <h2 className="flex items-center gap-2 m-0 mb-3.5 text-[17px]">从 skills.sh 安装</h2>
          <div className="flex gap-2.5 items-center flex-wrap">
            <input
              className="min-w-[180px] py-2.5 px-2.5 text-sm text-app-text bg-app-surface border border-app-border-strong rounded-md outline-0"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(searchQuery) }}
              placeholder="搜索 skills.sh 上的技能"
            />
            <button className="py-2.5 px-3 text-sm text-app-surface bg-app-text border border-app-text rounded-md cursor-pointer disabled:cursor-not-allowed disabled:opacity-55" onClick={() => void handleSearch(searchQuery)} disabled={searchingMarket} type="button">搜索</button>
          </div>
          <div className="mt-3.5">
            {searchingMarket ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">搜索中…</p>
              : marketResults.length === 0 ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">暂无结果，请尝试其他关键词。</p>
                : (
                  <div className="grid gap-2.5">
                    {marketResults.map((item) => (
                      <button
                        key={item.id}
                        className={cn('flex items-center gap-3 p-3.5 bg-app-surface border border-app-border rounded-xl text-left hover:bg-app-surface-muted', selectedMarketSkill?.id === item.id && 'bg-app-surface-muted')}
                        type="button"
                        onClick={() => void handleSelectMarketSkill(item)}
                      >
                        <div className="min-w-0">
                          <strong className="text-[15px]">{item.name}</strong>
                          <small className="block text-app-muted text-xs">{item.owner}/{item.repo}/{item.skillName} · {item.installs} 安装</small>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
          </div>
          {previewLoading && <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">正在拉取预览…</p>}
          {preview && selectedMarketSkill && (
            <div className="mt-3.5 p-3.5 bg-app-surface-muted border border-app-border rounded-md">
              <strong className="block mb-1.5 text-[15px]">{preview.name}</strong>
              <p className="m-0 text-app-muted text-[13px] leading-relaxed">{preview.description}</p>
              <p className="m-0 text-app-muted text-[13px] leading-relaxed">文件数：{preview.files.length}{preview.hasScripts ? ' · 包含脚本，将被标记为 requires-runtime，无法绑定' : ''}</p>
              <p className="m-0 text-app-muted text-[13px] leading-relaxed">兼容性：{preview.compatibility}</p>
              <button className="mt-2 inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm text-app-surface bg-app-text border border-app-text disabled:cursor-not-allowed disabled:opacity-55" type="button" disabled={installing} onClick={() => void handleInstall()}>{installing ? '安装中…' : '安装到本地'}</button>
            </div>
          )}
        </div>
        <div className="mt-7">
          <h2 className="flex items-center gap-2 m-0 mb-3.5 text-[17px]">已安装技能</h2>
          {loading ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">加载中…</p>
            : skills.length === 0 ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">暂无技能。</p>
              : (
                <div className="grid gap-2.5">
                  {skills.map((skill) => (
                    <div className="flex items-start justify-between gap-3 p-3.5 bg-app-surface border border-app-border rounded-xl" key={skill.id}>
                      <div className="min-w-0">
                        <strong className="text-[15px]">{skill.name}</strong>
                        <span className={cn('inline-flex items-center ml-2 py-0.5 px-2 rounded-full text-[11px] font-semibold',
                          skill.source === 'builtin' && 'text-app-skill-builtin bg-app-skill-builtin/10',
                          skill.source === 'marketplace' && 'text-app-skill-marketplace bg-app-skill-marketplace/10',
                          skill.source === 'local' && 'text-app-skill-local bg-app-skill-local/10',
                        )}>{skill.source}</span>
                        <span className={cn('inline-flex items-center ml-2 py-0.5 px-2 rounded-full text-[11px] font-semibold',
                          skill.compatibility === 'compatible' && 'text-app-success bg-app-success/10',
                          skill.compatibility === 'requires-runtime' && 'text-app-warning bg-app-warning/10',
                          skill.compatibility === 'unsupported' && 'text-app-danger bg-app-danger/10',
                          skill.compatibility === 'unknown' && 'text-gray-500 bg-gray-500/10',
                        )}>{skill.compatibility}</span>
                        <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">{skill.description}</p>
                      </div>
                      <div className="shrink-0">
                        {skill.source !== 'builtin' && (
                          <button className="grid place-items-center p-2 text-app-muted bg-transparent border-0 rounded-md hover:text-app-text hover:bg-app-hover" onClick={() => handleRemove(skill.id)} aria-label={`卸载 ${skill.name}`}>
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
        </div>
        <div className="mt-7">
          <h2 className="flex items-center gap-2 m-0 mb-3.5 text-[17px]">Agent 技能绑定</h2>
          {loading ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">加载中…</p>
            : agents.length === 0 ? <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">暂无 Agent。</p>
              : (
                <div className="grid gap-3.5">
                  {agents.map((agent) => {
                    const boundIds = agent.boundSkillIds ?? []
                    return (
                      <div className="p-3.5 bg-app-surface border border-app-border rounded-xl" key={agent.id}>
                        <strong className="block mb-2.5 text-[15px]">{agent.name}</strong>
                        <div className="flex flex-wrap gap-2.5">
                          {skills.filter((s) => s.compatibility === 'compatible').length === 0 ? (
                            <p className="py-7 px-7 text-app-muted border border-dashed border-app-border-strong rounded-xl text-center">暂无可绑定的兼容技能。</p>
                          ) : (
                            skills.filter((s) => s.compatibility === 'compatible').map((skill) => {
                              const isBound = boundIds.includes(skill.id)
                              return (
                                <label key={skill.id} className="flex items-center gap-1.5 py-1.5 px-2.5 bg-app-surface-muted border border-app-border rounded text-[13px] cursor-pointer">
                                  <input type="checkbox" className="cursor-pointer" checked={isBound} onChange={(e) => {
                                    if (e.target.checked) {
                                      void handleBind(skill.id, agent.id)
                                    } else {
                                      void handleUnbind(skill.id, agent.id)
                                    }
                                  }} />
                                  <span>{skill.name}</span>
                                </label>
                              )
                            })
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
        </div>
      </div>
    </section>
  )
}

function toErrorMessage(error: unknown): string { return error instanceof Error ? error.message : '请求失败，请稍后重试。' }
function formatStatus(status: KnowledgeDocument['status']): string { return ({ uploaded: '已上传', parsing: '解析中', chunking: '切分中', embedding: '向量生成中', completed: '已完成', failed: '处理失败' })[status] }
function formatBytes(size: number): string { return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB` }
export default App
