import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_CAPABILITIES,
  UnauthenticatedError,
  createKnowledgeBase,
  deleteDocument,
  deleteKnowledgeBase,
  getCapabilities,
  getCurrentUser,
  listDocuments,
  listKnowledgeBases,
  login as loginApi,
  logout as logoutApi,
  uploadDocument,
  type Capabilities,
  type ChatAgentInfo,
  type Citation,
  type KnowledgeBase,
  type KnowledgeDocument,
  type SafeUser,
} from '../lib/api'
import { listAgents, listConversations, createConversation, getConversation, updateConversation, deleteConversation, streamAskMessage, stopMessage, regenerateMessage, type SSEEvent } from '../lib/conversations'
import type { ConversationSummary } from '../types/conversation'
import type { ChatMessage, ConversationState, Module, Theme } from '../types/ui'
import { cn } from '../lib/cn'
import { Sidebar } from '../components/layout/Sidebar'
import { CitationPanel } from '../features/chat/components/CitationPanel'
import { AssistantChatWorkspace } from '../features/chat/components/AssistantChatWorkspace'
import { KnowledgeBaseWorkspace } from '../features/knowledge/components/KnowledgeBaseWorkspace'
import { SkillsWorkspace } from '../features/capabilities/components/SkillsWorkspace'
import { LoginScreen } from '../features/auth/components/LoginScreen'
import { Menu } from 'lucide-react'

type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated'

function App() {
  const [theme, setTheme] = useState<Theme>('dark'); const [activeModule, setActiveModule] = useState<Module>('对话')
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationState, setConversationState] = useState<ConversationState>({ type: 'draft', agentId: 'general-chat', knowledgeBaseId: null })
  const [messages, setMessages] = useState<ChatMessage[]>([]); const [isAsking, setIsAsking] = useState(false); const [chatError, setChatError] = useState<string | null>(null); const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null)
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]); const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState<string | null>(null); const [documents, setDocuments] = useState<KnowledgeDocument[]>([]); const [isKnowledgeLoading, setIsKnowledgeLoading] = useState(false); const [isUploading, setIsUploading] = useState(false); const [showCreateKnowledgeBase, setShowCreateKnowledgeBase] = useState(false); const [knowledgeError, setKnowledgeError] = useState<string | null>(null); const [capabilities, setCapabilities] = useState<Capabilities>(DEFAULT_CAPABILITIES)
  const [chatAgents, setChatAgents] = useState<ChatAgentInfo[]>(DEFAULT_CAPABILITIES.chatAgents)

  // 认证状态机：见设计文档 § 前端。未认证仅渲染 <LoginScreen />，业务
  // 数据全部不加载；任意业务 API 返回 401 时清 currentUser 并回到登录页。
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking')
  const [currentUser, setCurrentUser] = useState<SafeUser | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

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

  // 任何业务 API 返回 401 时集中回到登录页。401 由 request() / SSE / stop 内置抛 UnauthenticatedError。
  const handleUnauthenticated = useCallback(() => {
    setCurrentUser(null)
    setAuthStatus('unauthenticated')
    setConversations([])
    setMessages([])
    setKnowledgeBases([])
    setDocuments([])
    setActiveModule('对话')
    setConversationState({ type: 'draft', agentId: 'general-chat', knowledgeBaseId: null })
    streamingAssistantIdRef.current = null
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
  }, [])

  // 启动时拉一次 /auth/me。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const user = await getCurrentUser()
        if (cancelled) return
        setCurrentUser(user)
        setAuthStatus('authenticated')
      } catch (error) {
        if (cancelled) return
        if (error instanceof UnauthenticatedError) {
          setCurrentUser(null)
          setAuthStatus('unauthenticated')
        } else {
          // 网络 / 后端崩溃：保持登录页，由用户重试。
          console.error('认证检查失败：', error)
          setCurrentUser(null)
          setAuthStatus('unauthenticated')
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  // 业务数据加载仅在已认证后触发。
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    void refreshConversations().catch((error) => {
      if (error instanceof UnauthenticatedError) handleUnauthenticated()
    })
  }, [authStatus, handleUnauthenticated])
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    if (activeModule === '知识库') {
      void refreshKnowledgeBases().catch((error) => {
        if (error instanceof UnauthenticatedError) handleUnauthenticated()
      })
    }
  }, [authStatus, activeModule, handleUnauthenticated])
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    let cancelled = false
    void getCapabilities()
      .then((caps) => { if (!cancelled) setCapabilities(caps) })
      .catch((error) => {
        if (cancelled) return
        if (error instanceof UnauthenticatedError) handleUnauthenticated()
        else setCapabilities(DEFAULT_CAPABILITIES)
      })
    return () => { cancelled = true }
  }, [authStatus, handleUnauthenticated])
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    let cancelled = false
    void listAgents()
      .then((agents) => {
        if (cancelled) return
        setChatAgents(agents.map((a) => ({ id: a.id, name: a.name, requiresKnowledgeBase: a.capabilities.knowledgeBase })))
      })
      .catch((error) => {
        if (cancelled) return
        if (error instanceof UnauthenticatedError) handleUnauthenticated()
        else setChatAgents(DEFAULT_CAPABILITIES.chatAgents)
      })
    return () => { cancelled = true }
  }, [authStatus, handleUnauthenticated])
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    if (activeModule === '知识库' && selectedKnowledgeBaseId) {
      void refreshDocuments(selectedKnowledgeBaseId).catch((error) => {
        if (error instanceof UnauthenticatedError) handleUnauthenticated()
      })
    }
  }, [authStatus, activeModule, selectedKnowledgeBaseId, handleUnauthenticated])

  async function refreshConversations() {
    try {
      setConversations(await listConversations())
    } catch (error) {
      if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }
      console.error('加载会话列表失败', error)
    }
  }
  async function refreshKnowledgeBases() { setIsKnowledgeLoading(true); try { setKnowledgeBases(await listKnowledgeBases()) } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); setIsKnowledgeLoading(false); return }; setKnowledgeError(toErrorMessage(error)) } finally { setIsKnowledgeLoading(false) } }
  async function refreshDocuments(id: string) { setIsKnowledgeLoading(true); try { setDocuments(await listDocuments(id)) } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); setIsKnowledgeLoading(false); return }; setKnowledgeError(toErrorMessage(error)) } finally { setIsKnowledgeLoading(false) } }
  async function openConversation(id: string) {
    if (streamingAssistantIdRef.current) {
      await handleStop()
    }
    setChatError(null); setSelectedCitation(null)
    try {
      const { messages: loadedMessages } = await getConversation(id)
      setConversationState({ type: 'persisted', id })
      setMessages(loadedMessages.map((m) => m.role === 'user' ? { id: m.id, role: 'user', content: m.content, status: m.status as 'completed' | 'failed' } : { id: m.id, role: 'assistant', content: m.content, citations: m.citations, status: m.status as Extract<ChatMessage, { role: 'assistant' }>['status'] }))
    } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }; setChatError(toErrorMessage(error)) }
  }
  function newChat() {
    if (streamingAssistantIdRef.current) {
      void handleStop()
    }
    setConversationState({ type: 'draft', agentId: 'general-chat', knowledgeBaseId: null }); setMessages([]); setChatError(null); setSelectedCitation(null)
  }
  async function switchAgent(agentId: string) {
    if (conversationState.type === 'draft') { setConversationState({ type: 'draft', agentId, knowledgeBaseId: agentId === 'general-chat' ? null : conversationState.knowledgeBaseId }); setChatError(null); return }
    try { const updated = await updateConversation(conversationState.id, { agentId }); setConversations((prev) => prev.map((c) => (c.id === updated.id ? { ...c, agentId: updated.agentId, knowledgeBaseId: updated.knowledgeBaseId } : c))); setChatError(null) } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }; setChatError(toErrorMessage(error)) }
  }
  async function selectKnowledgeBase(knowledgeBase: Pick<KnowledgeBase, 'id' | 'name'>) {
    if (conversationState.type === 'draft') { setConversationState({ type: 'draft', agentId: 'knowledge-base', knowledgeBaseId: knowledgeBase.id }); setChatError(null); return }
    try { const updated = await updateConversation(conversationState.id, { agentId: 'knowledge-base', knowledgeBaseId: knowledgeBase.id }); setConversations((prev) => prev.map((c) => (c.id === updated.id ? { ...c, agentId: updated.agentId, knowledgeBaseId: updated.knowledgeBaseId, knowledgeBaseName: knowledgeBase.name } : c))); setChatError(null) } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }; setChatError(toErrorMessage(error)) }
  }
  async function clearKnowledgeBase() {
    if (conversationState.type === 'draft') { setConversationState((prev) => prev.type === 'draft' ? { ...prev, knowledgeBaseId: null } : prev); return }
    try { const updated = await updateConversation(conversationState.id, { knowledgeBaseId: null }); setConversations((prev) => prev.map((c) => c.id === updated.id ? { ...c, knowledgeBaseId: null, knowledgeBaseName: null } : c)) } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }; setChatError(toErrorMessage(error)) }
  }

  async function handleStop() {
    const assistantId = streamingAssistantIdRef.current
    if (!assistantId) return
    abortControllerRef.current?.abort()
    try {
      await stopMessage(assistantId)
    } catch (error) {
      if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }
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
        const assistant = updated[idx] as Extract<ChatMessage, { role: 'assistant' }>
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
          status: event.data.status as Extract<ChatMessage, { role: 'assistant' }>['status'],
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
          status: event.data.status as Extract<ChatMessage, { role: 'assistant' }>['status'],
        }
        return updated
      })
      setChatError(event.data.error?.message ?? '生成失败，请重试。')
    } else if (event.event === 'tool-call-start') {
      setMessages((current) => {
        const idx = current.findIndex((m) => m.role === 'assistant' && (m.status === 'streaming' || m.status === 'pending'))
        if (idx === -1) return current
        const updated = current.slice()
        const assistant = updated[idx] as Extract<ChatMessage, { role: 'assistant' }>
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
        const assistant = updated[idx] as Extract<ChatMessage, { role: 'assistant' }>
        const tools = (assistant.tools ?? []).map((t) => t.toolCallId === event.data.toolCallId ? { ...t, status: 'completed' as const } : t)
        updated[idx] = { ...assistant, tools }
        return updated
      })
    } else if (event.event === 'tool-call-error') {
      setMessages((current) => {
        const idx = current.findIndex((m) => m.role === 'assistant')
        if (idx === -1) return current
        const updated = current.slice()
        const assistant = updated[idx] as Extract<ChatMessage, { role: 'assistant' }>
        const tools = (assistant.tools ?? []).map((t) => t.toolCallId === event.data.toolCallId ? { ...t, status: 'failed' as const, errorCode: event.data.errorCode } : t)
        updated[idx] = { ...assistant, tools }
        return updated
      })
    }
  }

  async function submitQuestion(content: string) {
    const trimmed = content.trim()
    if (!trimmed || isSubmittingRef.current || streamingAssistantIdRef.current) return
    const currentAgent = chatAgents.find((a) => a.id === currentAgentId)
    if (currentAgent?.requiresKnowledgeBase && !currentKnowledgeBaseId) { setChatError('请先选择一个知识库。'); return }
    setChatError(null)
    isSubmittingRef.current = true

    let convId: string
    if (conversationState.type === 'draft') {
      try {
        const created = await createConversation({ agentId: conversationState.agentId, knowledgeBaseId: conversationState.knowledgeBaseId })
        convId = created.id
        setConversationState({ type: 'persisted', id: convId })
        const summary: ConversationSummary = { id: created.id, title: created.title, agentId: created.agentId, knowledgeBaseId: created.knowledgeBaseId, knowledgeBaseName: created.knowledgeBaseName, createdAt: created.createdAt, updatedAt: created.updatedAt }
        setConversations((prev) => [summary, ...prev])
      } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); isSubmittingRef.current = false; return }; setChatError(toErrorMessage(error)); isSubmittingRef.current = false; return; }
    } else { convId = conversationState.id }

    // 立刻把用户消息渲染到 UI，避免等待首条 SSE 事件带来的"空档"
    const userMessageId = crypto.randomUUID()
    setMessages((current) => [...current, { id: userMessageId, role: 'user', content: trimmed, status: 'completed' }])
    setIsAsking(true)

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    try {
      await streamAskMessage(convId, trimmed, (event) => handleSSEEvent(event), abortController.signal)
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        const assistantId = streamingAssistantIdRef.current
        if (assistantId) {
          setMessages((current) => {
            const idx = current.findIndex((m) => m.id === assistantId && m.role === 'assistant')
            if (idx === -1) return current
            const updated = current.slice()
            const assistant = updated[idx] as Extract<ChatMessage, { role: 'assistant' }>
            updated[idx] = { ...assistant, status: 'stopped' }
            return updated
          })
        }
      } else if (error instanceof UnauthenticatedError) {
        handleUnauthenticated()
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
            const assistant = updated[idx] as Extract<ChatMessage, { role: 'assistant' }>
            updated[idx] = { ...assistant, status: 'stopped' }
            return updated
          })
        }
      } else if (error instanceof UnauthenticatedError) {
        handleUnauthenticated()
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
    try { await deleteConversation(id); setConversations((prev) => prev.filter((c) => c.id !== id)); if (conversationState.type === 'persisted' && conversationState.id === id) newChat() } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }; setChatError(toErrorMessage(error)) }
  }
  function enterChatFromKnowledgeBase(knowledgeBase: Pick<KnowledgeBase, 'id' | 'name'>) { setConversationState({ type: 'draft', agentId: 'knowledge-base', knowledgeBaseId: knowledgeBase.id }); setMessages([]); setChatError(null); setSelectedCitation(null); setActiveModule('对话') }
  function startChatWithAgent(agentId: string) {
    if (streamingAssistantIdRef.current) void handleStop()
    setConversationState({ type: 'draft', agentId, knowledgeBaseId: null })
    setMessages([])
    setChatError(null)
    setSelectedCitation(null)
    setActiveModule('对话')
  }
  async function createKnowledgeBaseFromForm(name: string, description: string) { setKnowledgeError(null); const created = await createKnowledgeBase({ name, ...(description ? { description } : {}) }); setKnowledgeBases((current) => [created, ...current]); setSelectedKnowledgeBaseId(created.id); setShowCreateKnowledgeBase(false) }
  async function handleUpload(file: File | undefined) { if (!file || !selectedKnowledgeBaseId || isUploading) return; setIsUploading(true); setKnowledgeError(null); try { await uploadDocument(selectedKnowledgeBaseId, file); await Promise.all([refreshDocuments(selectedKnowledgeBaseId), refreshKnowledgeBases()]) } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); setIsUploading(false); return }; setKnowledgeError(toErrorMessage(error)); } finally { setIsUploading(false) } }
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
    } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }; setKnowledgeError(toErrorMessage(error)) }
  }
  async function handleDeleteDocument(id: string) { if (!selectedKnowledgeBaseId || !window.confirm('确定删除此文档吗？')) return; setKnowledgeError(null); try { await deleteDocument(id); await Promise.all([refreshDocuments(selectedKnowledgeBaseId), refreshKnowledgeBases()]) } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }; setKnowledgeError(toErrorMessage(error)) } }
  function selectModule(module: Module) {
    if (module !== '对话' && streamingAssistantIdRef.current) {
      void handleStop()
    }
    setActiveModule(module); setSelectedCitation(null); if (module === '知识库') setKnowledgeError(null)
  }
  const selectedKnowledgeBase = knowledgeBases.find((item) => item.id === selectedKnowledgeBaseId) ?? null
  const isStreaming = !!streamingAssistantIdRef.current

  // 登录提交：成功后清错误并触发业务数据加载。
  const handleLogin = useCallback(async (username: string, password: string) => {
    setLoginBusy(true)
    setLoginError(null)
    try {
      const user = await loginApi({ username, password })
      setCurrentUser(user)
      setAuthStatus('authenticated')
      setLoginError(null)
    } catch (error) {
      const message = toErrorMessage(error)
      setLoginError(message)
      throw error
    } finally {
      setLoginBusy(false)
    }
  }, [])

  const handleLogout = useCallback(async () => {
    try {
      await logoutApi()
    } catch (error) {
      // 忽略：因为即使后端登出失败，前端也应该回到登录页。
      console.error('logout failed:', error)
    }
    handleUnauthenticated()
    setLoginError(null)
  }, [handleUnauthenticated])

  // 闸门：根据 authStatus 决定显示登录页 / 检查中 / 工作台。
  if (authStatus === 'checking') {
    return (
      <main className={cn('flex h-screen w-full items-center justify-center bg-app-bg text-app-muted', theme === 'dark' && 'dark')}>
        <p>加载中…</p>
      </main>
    )
  }
  if (authStatus === 'unauthenticated' || !currentUser) {
    return (
      <main className={cn('h-screen w-full bg-app-bg', theme === 'dark' && 'dark')}>
        <LoginScreen
          onLogin={handleLogin}
          errorMessage={loginError}
          busy={loginBusy}
          appName={appName}
        />
      </main>
    )
  }

  return <main className={cn('flex h-screen overflow-hidden text-app-text bg-app-bg', theme === 'dark' && 'dark')}>
    <button
      type="button"
      className="fixed z-30 top-2.5 left-2.5 hidden max-[760px]:grid place-items-center w-10 h-10 rounded-lg border-0 bg-app-bg text-app-text shadow-sm hover:bg-app-hover"
      onClick={() => setIsSidebarOpen(true)}
      aria-label="打开侧边栏"
    >
      <Menu size={20} />
    </button>
    {isSidebarOpen && (
      <button
        type="button"
        className="fixed inset-0 z-40 hidden max-[760px]:block border-0 bg-black/45"
        onClick={() => setIsSidebarOpen(false)}
        aria-label="关闭侧边栏遮罩"
      />
    )}
    <Sidebar
      appName={appName}
      avatarInitial={avatarInitial}
      activeModule={activeModule}
      knowledgeBases={knowledgeBases}
      selectedKnowledgeBaseId={selectedKnowledgeBaseId}
      conversations={conversations}
      currentConversationId={conversationState.type === 'persisted' ? conversationState.id : null}
      onSelectModule={(module) => { selectModule(module); setIsSidebarOpen(false) }}
      onSelectKnowledgeBase={(id) => { setSelectedKnowledgeBaseId(id); setShowCreateKnowledgeBase(false); setIsSidebarOpen(false) }}
      onNewChat={() => { newChat(); setIsSidebarOpen(false) }}
      onOpenConversation={(id) => { void openConversation(id); setIsSidebarOpen(false) }}
      onDeleteConversation={handleDeleteConversation}
      onNewKnowledgeBase={() => { setSelectedKnowledgeBaseId(null); setShowCreateKnowledgeBase(true) }}
      theme={theme}
      onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      currentUser={currentUser}
      onLogout={() => void handleLogout()}
      mobileOpen={isSidebarOpen}
      onCloseMobile={() => setIsSidebarOpen(false)}
    />
    {activeModule === '对话' && <AssistantChatWorkspace
      appShortName={appShortName}
      messages={messages}
      isAsking={isAsking}
      isStreaming={isStreaming}
      error={chatError}
      chatAgents={chatAgents}
      knowledgeBases={knowledgeBases}
      selectedAgentId={currentAgentId}
      defaultChatModel={capabilities.defaultChatModel}
      activeKnowledgeBase={activeKnowledgeBase}
      onSubmit={(text) => void submitQuestion(text)}
      onStop={() => void handleStop()}
      onRegenerate={handleRegenerate}
      onSwitchAgent={switchAgent}
      onSelectKnowledgeBase={selectKnowledgeBase}
      onClearKnowledgeBase={clearKnowledgeBase}
      onSelectCitation={setSelectedCitation}
    />}
    {activeModule === '知识库' && <KnowledgeBaseWorkspace selectedKnowledgeBase={selectedKnowledgeBase} documents={documents} isLoading={isKnowledgeLoading} isUploading={isUploading} showCreate={showCreateKnowledgeBase} error={knowledgeError} capabilities={capabilities} onCreate={createKnowledgeBaseFromForm} onBack={() => { setSelectedKnowledgeBaseId(null); setShowCreateKnowledgeBase(false) }} onEnterChat={enterChatFromKnowledgeBase} onUpload={handleUpload} onDeleteDocument={handleDeleteDocument} onDeleteKnowledgeBase={handleDeleteKnowledgeBase} />}
    {activeModule === '能力' && <SkillsWorkspace onStartChat={startChatWithAgent} />}
    {selectedCitation && <CitationPanel citation={selectedCitation} onClose={() => setSelectedCitation(null)} />}
  </main>
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

export default App
