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
import { listAgents, listConversations, createConversation, getConversation, ConversationAccessError, updateConversation, deleteConversation, streamAskMessage, stopMessage, regenerateMessage, type SSEEvent } from '../lib/conversations'
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

// URL ↔ 当前会话的工具函数。`?conversation=<uuid>` 是当前已持久化会话的
// URL 来源；draft 不写 URL。其它既有 query 参数必须保留不被误删。
const CONVERSATION_QUERY_KEY = 'conversation'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.history !== 'undefined'
}

// 把 URL 解析为三态：absent / invalid / valid(id)。启动恢复、popstate 都靠
// 这个判别走不同分支，避免把"参数缺失"和"参数非法"混在一起掩盖。
type ConversationUrlState =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; id: string };

function readConversationUrlState(): ConversationUrlState {
  if (!isBrowser()) return { kind: 'absent' }
  const params = new URLSearchParams(window.location.search)
  if (!params.has(CONVERSATION_QUERY_KEY)) return { kind: 'absent' }
  const raw = params.get(CONVERSATION_QUERY_KEY)
  if (!raw || !isUuid(raw)) return { kind: 'invalid' }
  return { kind: 'valid', id: raw }
}

function buildUrlWithConversation(id: string | null): string {
  const url = new URL(window.location.href)
  if (id === null) url.searchParams.delete(CONVERSATION_QUERY_KEY)
  else url.searchParams.set(CONVERSATION_QUERY_KEY, id)
  const search = url.searchParams.toString()
  return url.pathname + (search ? `?${search}` : '') + url.hash
}

function currentLocationMatches(target: string): boolean {
  return window.location.pathname + window.location.search + window.location.hash === target
}

// 用户主动操作（新对话、打开会话、首条消息创建后）写历史栈。
function setConversationUrl(id: string): void {
  if (!isBrowser()) return
  const next = buildUrlWithConversation(id)
  if (currentLocationMatches(next)) return
  window.history.pushState({ [CONVERSATION_QUERY_KEY]: id }, '', next)
}

// 用户主动点"新对话" / 删除当前会话时：写入 draft 历史栈，避免浏览器回退
// 时反复回到已被清理的会话。
function clearConversationUrl(): void {
  if (!isBrowser()) return
  const next = buildUrlWithConversation(null)
  if (currentLocationMatches(next)) return
  window.history.pushState(null, '', next)
}

// 启动恢复 / 解析失败 / 404 / 跨 Workspace 无权：用 replaceState 清理无效
// 参数，避免污染浏览历史。
function replaceConversationUrl(id: string | null): void {
  if (!isBrowser()) return
  const next = buildUrlWithConversation(id)
  if (currentLocationMatches(next)) return
  if (id === null) window.history.replaceState(null, '', next)
  else window.history.replaceState({ [CONVERSATION_QUERY_KEY]: id }, '', next)
}

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
  // 加载指定 conversation 的请求序号：用户在请求返回前切换会话 / 登出 /
  // 进入新对话时，过期响应不得覆盖最新 UI。
  const loadConversationSeqRef = useRef(0)
  const refreshConversationsSeqRef = useRef(0)
  // 启动恢复是否已执行：避免依赖 authStatus 反复触发。
  const startupRecoveryDoneRef = useRef(false)

  const currentAgentId = conversationState.type === 'draft' ? conversationState.agentId : (conversations.find((c) => c.id === conversationState.id)?.agentId ?? 'general-chat')
  const currentKnowledgeBaseId = conversationState.type === 'draft' ? conversationState.knowledgeBaseId : (conversations.find((c) => c.id === conversationState.id)?.knowledgeBaseId ?? null)
  const activeKnowledgeBase = currentKnowledgeBaseId ? knowledgeBases.find((kb) => kb.id === currentKnowledgeBaseId) ?? null : null

  // 任何业务 API 返回 401 时集中回到登录页。401 由 request() / SSE / stop 内置抛 UnauthenticatedError。
  // 同时让所有在途 getConversation / listConversations 响应作废，并允许
  // 重新登录后再次执行启动恢复。注意：不清 URL，等用户重新登录后再判定权限。
  const handleUnauthenticated = useCallback(() => {
    loadConversationSeqRef.current += 1
    refreshConversationsSeqRef.current += 1
    startupRecoveryDoneRef.current = false
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

  // 启动恢复：首次认证成功后根据 ?conversation=<uuid> 加载会话。
  // - valid(id)：loadConversation(replace) 写入 UI；用 replace 不污染历史栈。
  // - invalid：URL 有 conversation 参数但不是合法 UUID → replace 清掉 + 回 draft。
  // - absent：URL 无参数 → 保持 draft，不动 URL。
  // - 401 走 handleUnauthenticated；其它错误保留 chatError 不卡死页面。
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    if (startupRecoveryDoneRef.current) return
    startupRecoveryDoneRef.current = true
    const urlState = readConversationUrlState()
    if (urlState.kind === 'invalid') {
      enterDraft({ clearUrl: 'replace', message: null })
      return
    }
    if (urlState.kind === 'absent') return
    void loadConversation(urlState.id, 'replace')
    // loadConversation 闭包会引用组件最新状态，但启动恢复只跑一次，
    // 不会在依赖更新时反复执行。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus])

  // 浏览器前进 / 后退：URL 是真相，状态必须跟随。
  // 注意 pushState/replaceState 不会触发 popstate，只有浏览器导航才会。
  // popstate 内部要读最新的 conversationState / authStatus，所以用 ref 转发，
  // 避免闭包持有过期值。
  const conversationStateRef = useRef(conversationState)
  conversationStateRef.current = conversationState
  const authStatusRef = useRef(authStatus)
  authStatusRef.current = authStatus
  useEffect(() => {
    function onPopState() {
      // 未认证就忽略；登录页本身不参与 URL 会话恢复。
      if (authStatusRef.current !== 'authenticated') return
      const urlState = readConversationUrlState()
      if (urlState.kind === 'invalid') {
        // URL 有 conversation 参数但非法：replace 清掉，回到 draft。
        enterDraft({ clearUrl: 'replace', message: null })
        return
      }
      if (urlState.kind === 'absent') {
        // 用户回退到无参数状态：不动 URL，回到 draft。
        enterDraft({ clearUrl: 'none', message: null })
        return
      }
      // valid：切到与当前相同就避免重复请求。
      const current = conversationStateRef.current
      if (current.type === 'persisted' && current.id === urlState.id) return
      void loadConversation(urlState.id, 'none')
    }
    window.addEventListener('popstate', onPopState)
    return () => { window.removeEventListener('popstate', onPopState) }
  }, [])

  async function refreshConversations() {
    const seq = ++refreshConversationsSeqRef.current
    try {
      const list = await listConversations()
      if (seq !== refreshConversationsSeqRef.current) return
      setConversations(list)
    } catch (error) {
      if (seq !== refreshConversationsSeqRef.current) return
      if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }
      console.error('加载会话列表失败', error)
    }
  }
  // 统一进入 draft 的入口。所有"放弃当前会话回到空白"路径都必须走这里，
  // 避免 404 / 非法 URL / popstate / 新对话 / 删除当前会话各自复制代码。
  // options:
  //   agentId / knowledgeBaseId：默认 general-chat / null；用于知识库 / Agent 入口
  //   clearUrl: 'push' 用户主动（新对话、删除当前会话）；'replace' 启动恢复 /
  //     解析失败 / 404（不污染历史栈）；'none' 不动 URL
  //   message: undefined 不动 chatError；null 清空；string 设为指定提示
  function enterDraft(options?: {
    agentId?: string;
    knowledgeBaseId?: string | null;
    clearUrl?: 'push' | 'replace' | 'none';
    message?: string | null;
  }) {
    if (streamingAssistantIdRef.current) void handleStop()
    // 让任何还在飞的 getConversation 响应作废。
    loadConversationSeqRef.current += 1
    setConversationState({
      type: 'draft',
      agentId: options?.agentId ?? 'general-chat',
      knowledgeBaseId: options?.knowledgeBaseId ?? null,
    })
    setMessages([])
    setSelectedCitation(null)
    if (options?.message !== undefined) setChatError(options.message)
    const clearUrl = options?.clearUrl ?? 'none'
    if (clearUrl === 'push') clearConversationUrl()
    else if (clearUrl === 'replace') replaceConversationUrl(null)
  }
  async function refreshKnowledgeBases() { setIsKnowledgeLoading(true); try { setKnowledgeBases(await listKnowledgeBases()) } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); setIsKnowledgeLoading(false); return }; setKnowledgeError(toErrorMessage(error)) } finally { setIsKnowledgeLoading(false) } }
  async function refreshDocuments(id: string) { setIsKnowledgeLoading(true); try { setDocuments(await listDocuments(id)) } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); setIsKnowledgeLoading(false); return }; setKnowledgeError(toErrorMessage(error)) } finally { setIsKnowledgeLoading(false) } }
  // 加载指定 conversation。navigation 决定是否写 URL：
  // - 'push'：用户主动从侧边栏点击 / 首条消息创建后；写历史栈。
  // - 'replace'：启动恢复；不写历史栈（避免首屏就 push 一条空记录）。
  // - 'none'：浏览器前进/后退 / popstate 触发；URL 已经变了，不需要再写。
  // 不允许并发旧响应覆盖最新 UI（序号检查）；401 走 handleUnauthenticated；
  // 404 / 跨 Workspace 静默清 URL + 友好提示，不抛未处理错误。
  async function loadConversation(id: string, navigation: 'push' | 'replace' | 'none') {
    const seq = ++loadConversationSeqRef.current
    if (streamingAssistantIdRef.current) {
      await handleStop()
    }
    if (seq !== loadConversationSeqRef.current) return
    setChatError(null); setSelectedCitation(null)
    try {
      const { messages: loadedMessages } = await getConversation(id)
      if (seq !== loadConversationSeqRef.current) return
      setConversationState({ type: 'persisted', id })
      setMessages(loadedMessages.map((m) => m.role === 'user' ? { id: m.id, role: 'user', content: m.content, status: m.status as 'completed' | 'failed' } : { id: m.id, role: 'assistant', content: m.content, citations: m.citations, status: m.status as Extract<ChatMessage, { role: 'assistant' }>['status'] }))
      if (navigation === 'push') setConversationUrl(id)
      else if (navigation === 'replace') replaceConversationUrl(id)
    } catch (error) {
      if (seq !== loadConversationSeqRef.current) return
      if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }
      if (error instanceof ConversationAccessError && error.status === 404) {
        // 404 或跨 Workspace 隐藏成 404：URL / 消息 / 高亮必须同时回到 draft，
        // 不残留旧 persisted conversationState 或旧 messages。
        enterDraft({ clearUrl: 'replace', message: '该会话不存在或已无权访问。' })
        return
      }
      setChatError(toErrorMessage(error))
    }
  }
  // 侧边栏点击：用户主动操作 → push URL。
  async function openConversation(id: string) {
    if (streamingAssistantIdRef.current) {
      await handleStop()
    }
    if (conversationState.type === 'persisted' && conversationState.id === id) {
      // 点击当前会话：保持消息不动；如果 URL 还没写或不一致，补 push 一次。
      setConversationUrl(id)
      return
    }
    await loadConversation(id, 'push')
  }
  function newChat() {
    // 用户主动操作：用 push 清 URL，让浏览器"返回"能回到刚刚清掉的状态。
    enterDraft({ clearUrl: 'push', message: null })
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
      // 列表刷新由 submitQuestion / handleRegenerate 的 finally 统一触发，
      // 这里不重复调用，避免 message-complete + finally 双触发。
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
        // 首条消息创建成功后立即把 URL 写进 history，便于刷新恢复 / 复制链接。
        setConversationUrl(convId)
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
      // 不论正常终态、message-error、网络错误、AbortError，都刷新一次会话
      // 列表，让服务端 updatedAt / 后端自动生成的标题能同步到侧边栏。
      // refreshConversations 自身会按 seq 丢弃过期响应，401 走 handleUnauthenticated，
      // 其它错误仅 console.error，不会覆盖当前聊天内容。
      void refreshConversations()
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
      // 同 submitQuestion：保证任意终态都会触发一次会话列表同步。
      void refreshConversations()
    }
  }

  async function handleDeleteConversation(id: string) {
    const conversation = conversations.find((item) => item.id === id)
    if (!window.confirm(`确定删除“${conversation?.title ?? '此对话'}”吗？此操作无法撤销。`)) return
    try { await deleteConversation(id); setConversations((prev) => prev.filter((c) => c.id !== id)); if (conversationState.type === 'persisted' && conversationState.id === id) newChat() } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }; setChatError(toErrorMessage(error)) }
  }
  function enterChatFromKnowledgeBase(knowledgeBase: Pick<KnowledgeBase, 'id' | 'name'>) {
    enterDraft({ agentId: 'knowledge-base', knowledgeBaseId: knowledgeBase.id, clearUrl: 'push', message: null })
    setActiveModule('对话')
  }
  function startChatWithAgent(agentId: string) {
    enterDraft({ agentId, knowledgeBaseId: null, clearUrl: 'push', message: null })
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
