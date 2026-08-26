import { useEffect, useRef, useState } from 'react'
import { ArrowDown, Bot, ChevronDown, CircleHelp, FileText, Library, Moon, Plus, RefreshCw, RotateCcw, Send, Sparkles, Sun, Trash2, Upload, Wrench, X } from 'lucide-react'
import { bindSkillToAgent, createKnowledgeBase, deleteDocument, deleteKnowledgeBase, getCapabilities, installMarketSkill, listDocuments, listKnowledgeBases, listPopularMarketSkills, listSkills, listTools, previewMarketSkill, removeSkill, searchMarketSkills, type Capabilities, type ChatAgentInfo, type Citation, type KnowledgeBase, type KnowledgeDocument, type MarketSkillInfo, type MarketSkillPreview, type SkillSummary, type ToolDefinition, unbindSkillFromAgent, uploadDocument } from './lib/api'
import { listAgents, listConversations, createConversation, getConversation, updateConversation, deleteConversation, streamAskMessage, stopMessage, regenerateMessage, type SSEEvent } from './lib/conversations'
import type { ConversationSummary } from './types/conversation'
import './App.css'

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

function App() {
  const [theme, setTheme] = useState<Theme>('dark'); const [activeModule, setActiveModule] = useState<Module>('对话')
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationState, setConversationState] = useState<ConversationState>({ type: 'draft', agentId: 'general-chat', knowledgeBaseId: null })
  const [messages, setMessages] = useState<Message[]>([]); const [isAsking, setIsAsking] = useState(false); const [chatError, setChatError] = useState<string | null>(null); const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null)
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]); const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState<string | null>(null); const [documents, setDocuments] = useState<KnowledgeDocument[]>([]); const [isKnowledgeLoading, setIsKnowledgeLoading] = useState(false); const [isUploading, setIsUploading] = useState(false); const [showCreateKnowledgeBase, setShowCreateKnowledgeBase] = useState(false); const [knowledgeError, setKnowledgeError] = useState<string | null>(null); const [capabilities, setCapabilities] = useState<Capabilities>({ documentFormats: ['txt', 'md'], mineruEnabled: false, chatAgents: [{ id: 'general-chat', name: '通用对话 Agent', requiresKnowledgeBase: false }, { id: 'knowledge-base', name: '知识库问答 Agent', requiresKnowledgeBase: true }], defaultChatModel: 'deepseek/deepseek-v4-flash' })
  const [question, setQuestion] = useState('')
  const [chatAgents, setChatAgents] = useState<ChatAgentInfo[]>([{ id: 'general-chat', name: '通用对话 Agent', requiresKnowledgeBase: false }, { id: 'knowledge-base', name: '知识库问答 Agent', requiresKnowledgeBase: true }])

  const streamingAssistantIdRef = useRef<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const isSubmittingRef = useRef(false)

  const currentAgentId = conversationState.type === 'draft' ? conversationState.agentId : (conversations.find((c) => c.id === conversationState.id)?.agentId ?? 'general-chat')
  const currentKnowledgeBaseId = conversationState.type === 'draft' ? conversationState.knowledgeBaseId : (conversations.find((c) => c.id === conversationState.id)?.knowledgeBaseId ?? null)
  const activeKnowledgeBase = currentKnowledgeBaseId ? knowledgeBases.find((kb) => kb.id === currentKnowledgeBaseId) ?? null : null

  useEffect(() => { void refreshConversations() }, [])
  useEffect(() => { if (activeModule === '知识库') void refreshKnowledgeBases() }, [activeModule])
  useEffect(() => { void getCapabilities().then(setCapabilities).catch(() => setCapabilities({ documentFormats: ['txt', 'md'], mineruEnabled: false, chatAgents: [{ id: 'general-chat', name: '通用对话 Agent', requiresKnowledgeBase: false }, { id: 'knowledge-base', name: '知识库问答 Agent', requiresKnowledgeBase: true }], defaultChatModel: 'deepseek/deepseek-v4-flash' })) }, [])
  useEffect(() => {
    void listAgents().then((agents) => {
      setChatAgents(agents.map((a) => ({ id: a.id, name: a.name, requiresKnowledgeBase: a.capabilities.knowledgeBase })))
    }).catch(() => {
      setChatAgents([{ id: 'general-chat', name: '通用对话 Agent', requiresKnowledgeBase: false }, { id: 'knowledge-base', name: '知识库问答 Agent', requiresKnowledgeBase: true }])
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

    // Immediately add user message to UI
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
  return <main className={`app ${theme}`}><Sidebar activeModule={activeModule} knowledgeBases={knowledgeBases} selectedKnowledgeBaseId={selectedKnowledgeBaseId} conversations={conversations} currentConversationId={conversationState.type === 'persisted' ? conversationState.id : null} onSelectModule={selectModule} onSelectKnowledgeBase={(id) => { setSelectedKnowledgeBaseId(id); setShowCreateKnowledgeBase(false) }} onNewChat={newChat} onOpenConversation={openConversation} onDeleteConversation={handleDeleteConversation} onNewKnowledgeBase={() => { setSelectedKnowledgeBaseId(null); setShowCreateKnowledgeBase(true) }} theme={theme} onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
    {activeModule === '对话' && <ChatWorkspace question={question} messages={messages} isAsking={isAsking} isStreaming={isStreaming} error={chatError} chatAgents={chatAgents} knowledgeBases={knowledgeBases} selectedAgentId={currentAgentId} defaultChatModel={capabilities.defaultChatModel} activeKnowledgeBase={activeKnowledgeBase} onQuestionChange={setQuestion} onSubmit={() => void submitQuestion()} onStop={() => void handleStop()} onRegenerate={handleRegenerate} onSwitchAgent={switchAgent} onSelectKnowledgeBase={selectKnowledgeBase} onClearKnowledgeBase={clearKnowledgeBase} onSelectCitation={setSelectedCitation} />}
    {activeModule === '知识库' && <KnowledgeBaseWorkspace selectedKnowledgeBase={selectedKnowledgeBase} documents={documents} isLoading={isKnowledgeLoading} isUploading={isUploading} showCreate={showCreateKnowledgeBase} error={knowledgeError} capabilities={capabilities} onCreate={createKnowledgeBaseFromForm} onBack={() => { setSelectedKnowledgeBaseId(null); setShowCreateKnowledgeBase(false) }} onEnterChat={enterChatFromKnowledgeBase} onUpload={handleUpload} onDeleteDocument={handleDeleteDocument} onDeleteKnowledgeBase={handleDeleteKnowledgeBase} />}
    {activeModule === '能力' && <SkillsWorkspace />}{selectedCitation && <CitationPanel citation={selectedCitation} onClose={() => setSelectedCitation(null)} />}</main>
}

function Sidebar({ activeModule, knowledgeBases, selectedKnowledgeBaseId, conversations, currentConversationId, onSelectModule, onSelectKnowledgeBase, onNewChat, onOpenConversation, onDeleteConversation, onNewKnowledgeBase, theme, onToggleTheme }: { activeModule: Module; knowledgeBases: KnowledgeBase[]; selectedKnowledgeBaseId: string | null; conversations: ConversationSummary[]; currentConversationId: string | null; onSelectModule: (module: Module) => void; onSelectKnowledgeBase: (id: string) => void; onNewChat: () => void; onOpenConversation: (id: string) => void; onDeleteConversation: (id: string) => void; onNewKnowledgeBase: () => void; theme: Theme; onToggleTheme: () => void }) { return <aside className="sidebar"><div className="sidebar-top"><div className="brand"><Sparkles size={22} /><span>玄枢</span></div>{activeModule === '对话' && <button className="new-chat" onClick={onNewChat}><Plus size={17} />新建对话</button>}{activeModule === '知识库' && <button className="new-chat" onClick={onNewKnowledgeBase}><Plus size={17} />新建知识库</button>}</div><div className="sidebar-content">{activeModule === '对话' && <section><p className="side-heading"><CircleHelp size={15} />最近对话</p>{conversations.length === 0 ? <p className="sidebar-empty">暂无已保存的对话</p> : <div className="knowledge-sidebar-list">{conversations.map((conv) => <div key={conv.id} className="sidebar-conversation-row"><button className={currentConversationId === conv.id ? 'sidebar-knowledge selected' : 'sidebar-knowledge'} onClick={() => onOpenConversation(conv.id)}><Bot size={17} /><span><strong>{conv.title}</strong><small>{conv.knowledgeBaseName ? `知识库：${conv.knowledgeBaseName}` : conv.agentId === 'general-chat' ? '通用对话' : '知识库问答'}</small></span></button><button className="icon-button delete-conversation" onClick={(e) => { e.stopPropagation(); void onDeleteConversation(conv.id); }} aria-label={`删除 ${conv.title}`}><Trash2 size={15} /></button></div>)}</div>}</section>}{activeModule === '知识库' && <section><p className="side-heading"><Library size={15} />知识库</p><div className="knowledge-sidebar-list">{knowledgeBases.length === 0 ? <p className="sidebar-empty">还没有知识库</p> : knowledgeBases.map((item) => <button key={item.id} className={selectedKnowledgeBaseId === item.id ? 'sidebar-knowledge selected' : 'sidebar-knowledge'} onClick={() => onSelectKnowledgeBase(item.id)}><Library size={17} /><span><strong>{item.name}</strong><small>{item.documentCount} 个文档</small></span></button>)}</div></section>}</div><nav className="sidebar-nav">{navigation.map(([name, Icon]) => <button key={name} className={activeModule === name ? 'nav-item active' : 'nav-item'} onClick={() => onSelectModule(name)}><Icon size={19} /><span>{name}</span></button>)}</nav><div className="sidebar-bottom"><span className="avatar">玄</span><button className="icon-button" onClick={onToggleTheme} aria-label="切换主题">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button></div></aside> }

function ChatWorkspace({ question, messages, isAsking, isStreaming, error, chatAgents, knowledgeBases, selectedAgentId, defaultChatModel, activeKnowledgeBase, onQuestionChange, onSubmit, onStop, onRegenerate, onSwitchAgent, onSelectKnowledgeBase, onClearKnowledgeBase, onSelectCitation }: { question: string; messages: Message[]; isAsking: boolean; isStreaming: boolean; error: string | null; chatAgents: ChatAgentInfo[]; knowledgeBases: KnowledgeBase[]; selectedAgentId: string; defaultChatModel: string; activeKnowledgeBase: Pick<KnowledgeBase, 'id' | 'name'> | null; onQuestionChange: (value: string) => void; onSubmit: () => void; onStop: () => void; onRegenerate: (assistantMessageId: string) => void; onSwitchAgent: (agentId: string) => void; onSelectKnowledgeBase: (knowledgeBase: KnowledgeBase) => void; onClearKnowledgeBase: () => void; onSelectCitation: (citation: Citation) => void }) {
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
  return <section className="chat-workspace"><header className="chat-header"><div><h1>{currentAgent?.name ?? '对话'}</h1></div><div className="top-controls"><div className="top-control-group" ref={agentPickerRef}><span className="top-control-label">智能体</span><button className="top-control-select" type="button" onClick={() => setIsAgentPickerOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={isAgentPickerOpen}>{currentAgent?.name ?? '选择智能体'}<ChevronDown size={15} /></button>{isAgentPickerOpen && <div className="agent-picker-menu" role="listbox" aria-label="选择智能体">{chatAgents.map((agent) => <button key={agent.id} className={agent.id === selectedAgentId ? 'selected' : ''} type="button" role="option" aria-selected={agent.id === selectedAgentId} onClick={() => { onSwitchAgent(agent.id); setIsAgentPickerOpen(false) }}><span>{agent.name}</span>{agent.requiresKnowledgeBase && <small>需知识库</small>}</button>)}</div>}</div><div className="top-control-group"><span className="top-control-label">当前模型</span><span className="top-control-value">{defaultChatModel}</span></div></div></header><div className="message-scroll-area"><div className="chat-content" ref={messageScrollRef} onScroll={handleMessageScroll}>{messages.length === 0 && <div className="empty-state"><Sparkles size={24} /><p>{isKnowledgeAgent ? '向知识库提问，玄枢会基于检索到的原文回答并附上引用来源。' : '你好，我是玄枢通用助手。有什么可以帮你的吗？'}</p></div>}{messages.map((message, index) => message.role === 'user' ? <div className="message user-message" key={message.id}><div><p>{message.content}</p></div></div> : <AssistantMessage key={message.id} message={message} isLast={index === lastAssistantIndex} onSelectCitation={onSelectCitation} onRegenerate={onRegenerate} />)}{isAsking && !isStreaming && <div className="message assistant-message"><div className="answer loading-answer"><span /><span /><span />{isKnowledgeAgent ? '正在检索知识库并生成回答…' : '正在思考…'}</div></div>}{error && <p className="request-error">{error}</p>}</div>{showJumpToLatest && <button className={`jump-to-latest ${isStreaming ? 'is-streaming' : ''}`} type="button" onClick={() => scrollToLatest()} aria-label="滚动到底部">{isStreaming && <span>正在回复</span>}<ArrowDown size={17} /></button>}</div><div className="composer-wrap"><div className="composer">{isKnowledgeAgent && activeKnowledgeBase && <div className="active-knowledge-base"><Library size={15} /><span>当前知识库：<strong>{activeKnowledgeBase.name}</strong></span><button onClick={onClearKnowledgeBase} aria-label="退出当前知识库"><X size={15} /></button></div>}{isKnowledgeAgent && !activeKnowledgeBase && <div className="active-knowledge-base is-required"><Library size={15} /><span>请先选择一个知识库</span></div>}<textarea value={question} onChange={(event) => onQuestionChange(event.target.value)} onCompositionStart={() => { isComposingRef.current = true }} onCompositionEnd={() => { isComposingRef.current = false }} onKeyDown={handleKeyDown} disabled={isAsking || isStreaming} placeholder={isKnowledgeAgent ? (activeKnowledgeBase ? '输入问题' : '请先选择一个知识库') : '输入问题，开始对话'} rows={2} /><div className="composer-footer"><div className="composer-knowledge-picker" ref={knowledgeBasePickerRef}><button type="button" onClick={() => setIsKnowledgeBasePickerOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={isKnowledgeBasePickerOpen}>选择知识库</button>{isKnowledgeBasePickerOpen && <div className="composer-knowledge-menu" role="listbox" aria-label="选择知识库">{knowledgeBases.length === 0 ? <p>暂无知识库，请先在知识库页创建。</p> : knowledgeBases.map((knowledgeBase) => <button type="button" role="option" aria-selected={knowledgeBase.id === activeKnowledgeBase?.id} className={knowledgeBase.id === activeKnowledgeBase?.id ? 'selected' : ''} key={knowledgeBase.id} onClick={() => { onSelectKnowledgeBase(knowledgeBase); setIsKnowledgeBasePickerOpen(false) }}><Library size={14} /><span>{knowledgeBase.name}</span></button>)}</div>}</div><div><button className={`send ${isStreaming ? 'streaming' : ''}`} onClick={isStreaming ? onStop : onSubmit} disabled={!isStreaming && !canSend} aria-label={isStreaming ? '停止生成' : '发送问题'}>{isStreaming ? <X size={18} /> : <Send size={18} />}</button></div></div></div><p className="disclaimer">Enter 发送，Shift + Enter 换行</p></div></section>
}

function KnowledgeBaseWorkspace({ selectedKnowledgeBase, documents, isLoading, isUploading, showCreate, error, capabilities, onCreate, onBack, onEnterChat, onUpload, onDeleteDocument, onDeleteKnowledgeBase }: { selectedKnowledgeBase: KnowledgeBase | null; documents: KnowledgeDocument[]; isLoading: boolean; isUploading: boolean; showCreate: boolean; error: string | null; capabilities: Capabilities; onCreate: (name: string, description: string) => Promise<void>; onBack: () => void; onEnterChat: (knowledgeBase: Pick<KnowledgeBase, 'id' | 'name'>) => void; onUpload: (file: File | undefined) => void; onDeleteDocument: (id: string) => void; onDeleteKnowledgeBase: (id: string) => void }) { const [name, setName] = useState(''); const [description, setDescription] = useState(''); const inputRef = useRef<HTMLInputElement>(null); async function submitCreate(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); if (name.trim()) { await onCreate(name.trim(), description.trim()); setName(''); setDescription('') } }
  const supportedLabels = capabilities.documentFormats.map((f) => ({ txt: 'TXT', md: 'Markdown', pdf: 'PDF', docx: 'DOCX' }[f] ?? f.toUpperCase()));
  const acceptMap: Record<string, string> = { txt: '.txt,text/plain', md: '.md,text/markdown', pdf: '.pdf,application/pdf', docx: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const acceptAttr = capabilities.documentFormats.map((f) => acceptMap[f]).filter(Boolean).join(',');
  const uploadHint = supportedLabels.length > 0 ? `支持 ${supportedLabels.join('、')}，单文件不超过 10 MB。` : '暂不支持文件上传。';
  return <section className="knowledge-workspace"><header className="page-heading"><div><h1>{selectedKnowledgeBase ? selectedKnowledgeBase.name : '知识库'}</h1><p>{selectedKnowledgeBase ? `${selectedKnowledgeBase.documentCount} 个文档 · ${selectedKnowledgeBase.chunkCount ?? 0} 个片段` : '从左侧选择或新建一个知识库。'}</p></div>{selectedKnowledgeBase && <div className="page-heading-actions"><button className="outline-button" onClick={onBack}>返回列表</button><button className="primary-button" onClick={() => onEnterChat(selectedKnowledgeBase)}><Bot size={17} />进入问答</button><button className="danger-button" onClick={() => onDeleteKnowledgeBase(selectedKnowledgeBase.id)}><Trash2 size={16} />删除</button></div>}</header>{error && <p className="request-error">{error}</p>}{!selectedKnowledgeBase && <>{showCreate && <form className="knowledge-create" onSubmit={(event) => void submitCreate(event)}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="知识库名称" maxLength={120} autoFocus /><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述（可选）" maxLength={2000} /><button className="primary-button" type="submit">创建</button></form>}<div className="empty-panel"><Library size={24} /><strong>还没有知识库</strong><p>创建知识库后，可以上传 TXT 或 Markdown，并让知识库问答基于资料回答。</p></div></>}{selectedKnowledgeBase && <><div className="upload-panel"><div><strong>上传文本资料</strong><p>{uploadHint}</p></div><input ref={inputRef} type="file" accept={acceptAttr} hidden onChange={(event) => onUpload(event.target.files?.[0])} /><button className="primary-button" onClick={() => inputRef.current?.click()} disabled={isUploading}><Upload size={17} />{isUploading ? '正在入库…' : '上传文档'}</button></div><div className="document-list">{isLoading ? <p className="muted-copy">正在加载文档…</p> : documents.length === 0 ? <div className="empty-panel"><FileText size={24} /><strong>还没有文档</strong><p>支持 TXT、Markdown；上传后会显示处理状态。</p></div> : documents.map((document) => <article className="document-row" key={document.id}><FileText size={21} /><div><strong>{document.name}</strong><small>{formatBytes(document.size)} · {document.chunkCount} 个片段 · {formatStatus(document.status)}</small>{document.errorMessage && <small className="document-error">{document.errorMessage}</small>}</div><button className="icon-button" onClick={() => onDeleteDocument(document.id)} aria-label={`删除 ${document.name}`}><Trash2 size={17} /></button></article>)}</div></>}</section> }
function AssistantMessage({ message, isLast, onSelectCitation, onRegenerate }: { message: Extract<Message, { role: 'assistant' }>; isLast: boolean; onSelectCitation: (citation: Citation) => void; onRegenerate: (id: string) => void }) {
  const isFailed = message.status === 'failed'
  const isStopped = message.status === 'stopped'
  const showRetry = isFailed || isStopped
  const showRegenerate = message.status === 'completed' && isLast
  const showActions = message.status !== 'pending' && message.status !== 'streaming'
  return (
    <div className="message assistant-message">
      <div>
        <div className="answer">
          {message.content ? message.content.split(/\n{2,}/).map((paragraph, i) => <p key={i}>{paragraph}</p>) : (message.status === 'pending' || message.status === 'streaming') ? null : <p style={{ color: 'var(--muted)' }}>（无内容）</p>}
          {isFailed && <span className="message-status-badge failed">生成失败</span>}
          {isStopped && <span className="message-status-badge stopped">已停止</span>}
        </div>
        {message.tools && message.tools.length > 0 && (
          <div className="tools-panel">
            <div className="tools-label">工具调用</div>
            {message.tools.map((t) => (
              <div key={t.toolCallId} className={`tools-row ${t.status}`}>
                <span className="tools-icon">{t.status === 'running' ? '⏳' : t.status === 'completed' ? '✅' : '❌'}</span>
                <span className="tools-name">{t.toolName}</span>
                {t.status === 'running' && <span className="tools-status">执行中…</span>}
                {t.status === 'completed' && <span className="tools-status">已完成</span>}
                {t.status === 'failed' && <span className="tools-status">失败 ({t.errorCode})</span>}
              </div>
            ))}
          </div>
        )}
        {message.citations.length > 0 && message.status === 'completed' && <>
          <div className="source-label">引用来源（{message.citations.length}）</div>
          <div className="source-list">{message.citations.map((citation, index) => <button onClick={() => onSelectCitation(citation)} className="source-chip" key={citation.chunkId}><span>{index + 1}</span>{citation.title} {citation.chapter}</button>)}</div>
        </>}
        {showActions && <div className="answer-actions">
          {showRetry && <button className="retry-button" onClick={() => onRegenerate(message.id)}><RotateCcw size={14} />重试</button>}
          {showRegenerate && <button className="regenerate-button" onClick={() => onRegenerate(message.id)}><RefreshCw size={14} />重新生成</button>}
        </div>}
      </div>
    </div>
  )
}

function CitationPanel({ citation, onClose }: { citation: Citation; onClose: () => void }) { return <aside className="citation-panel"><header><strong>引用来源</strong><button className="icon-button" onClick={onClose}><X size={20} /></button></header><div className="citation-panel-scroll"><article className="source-detail"><h2>{citation.documentName ?? citation.title}</h2><p className="chapter">{citation.heading ?? citation.chapter}</p><hr /><h3>原文</h3><p>{citation.content}</p><h3>元数据</h3><dl>{citation.documentId ? <><dt>文档</dt><dd>{citation.documentName}</dd><dt>片段</dt><dd>第 {(citation.chunkIndex ?? 0) + 1} 段</dd></> : <><dt>作者</dt><dd>{citation.author ?? '未标注'}</dd><dt>版本</dt><dd>{citation.version ?? '未标注'}</dd></>}<dt>类型</dt><dd>{citation.category || citation.type}</dd><dt>来源</dt><dd>{citation.source || '未标注'}</dd></dl></article></div></aside> }
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
    <section className="skills-workspace">
      <header className="page-heading"><div><h1>能力</h1><p>查看当前 Starter 已提供的 Skills 与 Tools。</p></div></header>
      {error && <p className="request-error">{error}</p>}
      <div className="skills-section">
        <h2>Tools</h2>
        {loading ? <p className="muted-copy">正在加载工具…</p> : tools.length === 0 ? <p className="muted-copy">当前没有可用工具。</p> : <div className="skills-list">{tools.map((tool) => <article className="skill-row" key={tool.id}><div><strong>{tool.displayName}</strong><span className="skill-badge builtin">内置</span><p className="muted-copy">{tool.description}</p><small className="tool-id">ID：{tool.id}</small></div><div className="tool-agent-list"><small>可用于</small>{agents.filter((agent) => agent.toolIds.includes(tool.id)).map((agent) => <span key={agent.id}>{agent.name}</span>)}</div></article>)}</div>}
      </div>
      <div className="skills-section">
        <h2>从 skills.sh 安装</h2>
        <div className="skill-install-form">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(searchQuery) }}
            placeholder="搜索 skills.sh 上的技能"
          />
          <button onClick={() => void handleSearch(searchQuery)} disabled={searchingMarket} type="button">搜索</button>
        </div>
        <div className="market-results">
          {searchingMarket ? <p className="muted-copy">搜索中…</p>
            : marketResults.length === 0 ? <p className="muted-copy">暂无结果，请尝试其他关键词。</p>
              : (
                <div className="market-list">
                  {marketResults.map((item) => (
                    <button
                      key={item.id}
                      className={`market-row ${selectedMarketSkill?.id === item.id ? 'selected' : ''}`}
                      type="button"
                      onClick={() => void handleSelectMarketSkill(item)}
                    >
                      <div>
                        <strong>{item.name}</strong>
                        <small>{item.owner}/{item.repo}/{item.skillName} · {item.installs} 安装</small>
                      </div>
                    </button>
                  ))}
                </div>
              )}
        </div>
        {previewLoading && <p className="muted-copy">正在拉取预览…</p>}
        {preview && selectedMarketSkill && (
          <div className="skill-preview">
            <strong>{preview.name}</strong>
            <p>{preview.description}</p>
            <p className="muted-copy">文件数：{preview.files.length}{preview.hasScripts ? ' · 包含脚本，将被标记为 requires-runtime，无法绑定' : ''}</p>
            <p className="muted-copy">兼容性：{preview.compatibility}</p>
            <button
              className="primary-button"
              type="button"
              disabled={installing}
              onClick={() => void handleInstall()}
            >{installing ? '安装中…' : '安装到本地'}</button>
          </div>
        )}
      </div>
      <div className="skills-section">
        <h2>已安装技能</h2>
        {loading ? <p className="muted-copy">加载中…</p>
          : skills.length === 0 ? <p className="muted-copy">暂无技能。</p>
            : (
              <div className="skills-list">
                {skills.map((skill) => (
                  <div key={skill.id} className="skill-row">
                    <div>
                      <strong>{skill.name}</strong>
                      <span className={`skill-badge ${skill.source}`}>{skill.source}</span>
                      <span className={`skill-badge ${skill.compatibility}`}>{skill.compatibility}</span>
                      <p className="muted-copy">{skill.description}</p>
                    </div>
                    <div className="skill-actions">
                      {skill.source !== 'builtin' && (
                        <button className="icon-button" onClick={() => handleRemove(skill.id)} aria-label={`卸载 ${skill.name}`}>
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
      </div>
      <div className="skills-section">
        <h2>Agent 技能绑定</h2>
        {loading ? <p className="muted-copy">加载中…</p>
          : agents.length === 0 ? <p className="muted-copy">暂无 Agent。</p>
            : (
              <div className="agent-bindings-list">
                {agents.map((agent) => {
                  const boundIds = agent.boundSkillIds ?? []
                  return (
                    <div key={agent.id} className="agent-bindings-row">
                      <strong>{agent.name}</strong>
                      <div className="bindings-list">
                        {skills.filter((s) => s.compatibility === 'compatible').length === 0 ? (
                          <p className="muted-copy">暂无可绑定的兼容技能。</p>
                        ) : (
                          skills.filter((s) => s.compatibility === 'compatible').map((skill) => {
                            const isBound = boundIds.includes(skill.id)
                            return (
                              <label key={skill.id} className="binding-item">
                                <input
                                  type="checkbox"
                                  checked={isBound}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      void handleBind(skill.id, agent.id)
                                    } else {
                                      void handleUnbind(skill.id, agent.id)
                                    }
                                  }}
                                />
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
    </section>
  )
}

function toErrorMessage(error: unknown): string { return error instanceof Error ? error.message : '请求失败，请稍后重试。' }
function formatStatus(status: KnowledgeDocument['status']): string { return ({ uploaded: '已上传', parsing: '解析中', chunking: '切分中', embedding: '向量生成中', completed: '已完成', failed: '处理失败' })[status] }
function formatBytes(size: number): string { return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB` }
export default App
