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
import {
  listAgents,
  listConversations,
  createDraftConversation,
  getConversation,
  ConversationAccessError,
  updateConversation,
  deleteConversation,
  stopMessage,
  regenerateMessage,
  postMessage,
  streamRunEvents,
  readPersistedLastEventId,
  clearPersistedLastEventId,
  type SSEEvent,
  type V2RunEvent,
  type RunStreamHandle,
} from '../lib/conversations'
import type { ConversationSummary } from '../types/conversation'
import type { ChatMessage, ConversationState, Module, Theme } from '../types/ui'
import {
  applyCheckpoint as applyCheckpointToRenderer,
  applyDelta as applyDeltaToRenderer,
  createRendererState,
  markTerminal as markTerminalToRenderer,
  resetRenderer as resetRendererState,
  flush as flushRenderer,
  type RendererOps,
  type RendererState,
} from '../lib/streaming-renderer'
import { cn } from '../lib/cn'
import { Sidebar } from '../components/layout/Sidebar'
import { CitationPanel } from '../features/chat/components/CitationPanel'
import { AssistantChatWorkspace } from '../features/chat/components/AssistantChatWorkspace'
import { KnowledgeBaseWorkspace } from '../features/knowledge/components/KnowledgeBaseWorkspace'
import { SkillsWorkspace } from '../features/capabilities/components/SkillsWorkspace'
import { LoginScreen } from '../features/auth/components/LoginScreen'
import { Menu } from 'lucide-react'

type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated'

// 双通道 SSE（PR-2.4）：
//   - 后端 LISTEN/NOTIFY 推送实时 content-delta（小批次低延迟）；
//   - 同时持久化 content-checkpoint 用于断线恢复 / 跨实例兜底。
// 前端策略：
//   - content-delta：直接追加到当前 streaming 文本；通过 requestAnimationFrame
//     合并渲染；缺失允许（不会被 checkpoint 回退覆盖）。
//   - content-checkpoint：是权威完整快照；若它比当前文本更长，必须收敛；
//     若它比当前文本短或非前缀，保留当前文本（已经被更长的实时 delta 推进过）。

// URL ↔ 当前会话的工具函数。V2 阶段 2 起统一为 `/chat/new` / `/chat/<uuid>` 路径式。
// 旧 `?conversation=<uuid>` 查询参数保留解析能力，但不再主动写入。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.history !== 'undefined'
}

// 把 URL 解析为三态：draft (new) / invalid / valid (id)。启动恢复、popstate
// 都靠这个判别走不同分支，避免把"路径缺失 / 路径非法"混在一起掩盖。
type ConversationUrlState =
  | { kind: 'draft' }
  | { kind: 'invalid' }
  | { kind: 'valid'; id: string };

function readConversationUrlState(): ConversationUrlState {
  if (!isBrowser()) return { kind: 'draft' }
  const path = window.location.pathname.replace(/\/+$/, '')
  if (path === '' || path === '/chat' || path === '/chat/new') return { kind: 'draft' }
  const segments = path.split('/').filter(Boolean)
  if (segments.length >= 2 && segments[0] === 'chat' && isUuid(segments[1])) {
    return { kind: 'valid', id: segments[1] }
  }
  // 兼容旧 query ?conversation=<uuid>（不要污染迁移期间的用户体验）
  const params = new URLSearchParams(window.location.search)
  if (params.has('conversation')) {
    const raw = params.get('conversation')
    if (raw && isUuid(raw)) return { kind: 'valid', id: raw }
    return { kind: 'invalid' }
  }
  if (segments[0] === 'chat' && segments[1]) return { kind: 'invalid' }
  return { kind: 'draft' }
}

function buildChatPath(id: string | null): string {
  // 保留 query / hash 不被误删。
  const url = new URL(window.location.href)
  url.pathname = id === null ? '/chat/new' : `/chat/${id}`
  // 旧查询参数清掉，避免"路径 + 查询"双通道并存
  url.searchParams.delete('conversation')
  return url.pathname + url.search + url.hash
}

function currentLocationMatches(target: string): boolean {
  return window.location.pathname + window.location.search + window.location.hash === target
}

// 用户主动操作（首条消息创建后）写历史栈。
function setConversationUrl(id: string): void {
  if (!isBrowser()) return
  const next = buildChatPath(id)
  if (currentLocationMatches(next)) return
  window.history.pushState({ conversationId: id }, '', next)
}

// 用户主动点"新对话" / 删除当前会话时：写入 draft 历史栈，避免浏览器回退
// 时反复回到已被清理的会话。
function clearConversationUrl(): void {
  if (!isBrowser()) return
  const next = buildChatPath(null)
  if (currentLocationMatches(next)) return
  window.history.pushState(null, '', next)
}

// 启动恢复 / 解析失败 / 404 / 跨 Workspace 无权：用 replaceState 清理无效
// 路径，避免污染浏览历史。
function replaceConversationUrl(id: string | null): void {
  if (!isBrowser()) return
  const next = buildChatPath(id)
  if (currentLocationMatches(next)) return
  if (id === null) window.history.replaceState(null, '', next)
  else window.history.replaceState({ conversationId: id }, '', next)
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
  // V2 Run 流句柄（GET SSE）；由 streamRunEvents 持有，重连 / 切会话时关闭。
  const runStreamRef = useRef<RunStreamHandle | null>(null)
  const currentRunIdRef = useRef<string | null>(null)
  // 双通道渲染状态机（PR-2.4 修复后）：单一权威 targetText + rAF flush；
  // 不再维护"实时文本末尾 / checkpoint 文本末尾"两个并行的字段以避免
  // 重复追加。详见 `lib/streaming-renderer.ts`。
  const rendererStateRef = useRef<RendererState>(createRendererState())
  // `/chat/new` 建 draft 的单飞 Promise：自动建 draft 与用户立即发送首条消息
  // 共用它，避免产生两条空会话。
  const draftCreationPromiseRef = useRef<Promise<string> | null>(null)

  const currentAgentId = conversationState.type === 'draft' ? conversationState.agentId : (conversations.find((c) => c.id === conversationState.id)?.agentId ?? 'general-chat')
  const currentKnowledgeBaseId = conversationState.type === 'draft' ? conversationState.knowledgeBaseId : (conversations.find((c) => c.id === conversationState.id)?.knowledgeBaseId ?? null)
  const activeKnowledgeBase = currentKnowledgeBaseId ? knowledgeBases.find((kb) => kb.id === currentKnowledgeBaseId) ?? null : null

  // 绑定 renderer ops。`useCallback` 内访问的 setMessages 由 React 提供稳定引用。
  const rendererOpsRef = useRef<RendererOps | null>(null)
  if (rendererOpsRef.current === null) {
    rendererOpsRef.current = {
      writeToDom: (fullText: string) => {
        updateStreamingAssistantContent(fullText)
      },
      setTerminalStatus: (status) => {
        updateStreamingAssistantContent(rendererStateRef.current.targetText, status)
        streamingAssistantIdRef.current = null
      },
      scheduleRaf: (cb) => requestAnimationFrame(cb),
      cancelRaf: (h) => cancelAnimationFrame(h),
    }
  }

  function cancelStreamingRender() {
    resetRendererState(rendererStateRef.current, rendererOpsRef.current!)
  }

  function updateStreamingAssistantContent(content: string, status: 'streaming' | 'completed' | 'stopped' | 'failed' = 'streaming') {
    const assistantId = streamingAssistantIdRef.current
    if (!assistantId) return
    setMessages((current) => current.map((message) => (
      message.role === 'assistant' && message.id === assistantId
        ? { ...message, content, status }
        : message
    )))
  }

  function appendLiveDelta(text: string) {
    applyDeltaToRenderer(rendererStateRef.current, text, rendererOpsRef.current!)
  }

  function applyCheckpoint(text: string) {
    applyCheckpointToRenderer(rendererStateRef.current, text, rendererOpsRef.current!)
  }

  // 任何业务 API 返回 401 时集中回到登录页。401 由 request() / SSE / stop 内置抛 UnauthenticatedError。
  // 同时让所有在途 getConversation / listConversations 响应作废，并允许
  // 重新登录后再次执行启动恢复。注意：不清 URL，等用户重新登录后再判定权限。
  const handleUnauthenticated = useCallback(() => {
    if (runStreamRef.current) {
      runStreamRef.current.close()
      runStreamRef.current = null
    }
    currentRunIdRef.current = null
    cancelStreamingRender()
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
    if (urlState.kind === 'draft') {
      // /chat/new → 仅确保 URL 路径一致；保留查询参数 / hash 不动。
      if (isBrowser() && window.location.pathname !== '/chat/new') {
        replaceConversationUrl(null)
      }
      return
    }
    void loadConversation(urlState.id, 'replace')
    // loadConversation 闭包会引用组件最新状态，但启动恢复只跑一次，
    // 不会在依赖更新时反复执行。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus])

  // Phase 2：`/chat/new` 的事实来源必须是服务端 draft，而不是前端临时状态。
  // 有具体会话 ID 时由 loadConversation 接管，不能在恢复历史会话期间额外创建 draft。
  useEffect(() => {
    if (authStatus !== 'authenticated' || conversationState.type !== 'draft') return
    if (readConversationUrlState().kind !== 'draft') return
    void ensureServerDraftConversation().catch((error) => {
      if (error instanceof UnauthenticatedError) {
        handleUnauthenticated()
      } else {
        setChatError(toErrorMessage(error))
      }
    })
    // conversationState 是 draft 时需要捕获当时选择的 agent / knowledge base。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, conversationState])

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
        // URL 路径非法：replace 清掉，回到 draft。
        enterDraft({ clearUrl: 'replace', message: null })
        return
      }
      if (urlState.kind === 'draft') {
        // 用户回退到 /chat/new：不动 URL，回到 draft。
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
    if (runStreamRef.current) {
      runStreamRef.current.close()
      runStreamRef.current = null
    }
    currentRunIdRef.current = null
    cancelStreamingRender()
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

  async function ensureServerDraftConversation(): Promise<string> {
    if (conversationState.type === 'persisted') return conversationState.id
    if (draftCreationPromiseRef.current) return draftCreationPromiseRef.current

    const { agentId, knowledgeBaseId } = conversationState
    const creation = createDraftConversation({ agentId, knowledgeBaseId })
      .then((created) => {
        setConversationState({ type: 'persisted', id: created.id })
        setConversations((current) => {
          if (current.some((item) => item.id === created.id)) return current
          const summary: ConversationSummary = {
            id: created.id,
            title: '新对话',
            agentId: created.agentId,
            knowledgeBaseId: created.knowledgeBaseId,
            knowledgeBaseName: null,
            createdAt: created.createdAt,
            updatedAt: created.createdAt,
          }
          return [summary, ...current]
        })
        replaceConversationUrl(created.id)
        return created.id
      })
    draftCreationPromiseRef.current = creation
    try {
      return await creation
    } finally {
      if (draftCreationPromiseRef.current === creation) {
        draftCreationPromiseRef.current = null
      }
    }
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
    if (runStreamRef.current) {
      runStreamRef.current.close()
      runStreamRef.current = null
    }
    currentRunIdRef.current = null
    cancelStreamingRender()
    if (seq !== loadConversationSeqRef.current) return
    setChatError(null); setSelectedCitation(null)
    try {
      const { messages: loadedMessages } = await getConversation(id)
      if (seq !== loadConversationSeqRef.current) return
      setConversationState({ type: 'persisted', id })
      setMessages(loadedMessages.map((m) => m.role === 'user' ? { id: m.id, role: 'user', content: m.content, status: m.status as 'completed' | 'failed' } : { id: m.id, role: 'assistant', content: m.content, citations: m.citations, status: m.status as Extract<ChatMessage, { role: 'assistant' }>['status'] }))
      if (navigation === 'push') setConversationUrl(id)
      else if (navigation === 'replace') replaceConversationUrl(id)
      // V2 SSE 重连：最后一条 assistant message 若仍携带 currentRunId，
      // 立即 EventSource 续上；lastEventId 优先取 sessionStorage 持久值。
      const lastAssistant = [...loadedMessages].reverse().find((m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming'))
      const currentRunId = lastAssistant?.currentRunId ?? null
      if (currentRunId) {
        const eventsUrl = buildEventsUrl(currentRunId)
        const persisted = readPersistedLastEventId(currentRunId)
        startRunStream({ runId: currentRunId, eventsUrl, lastEventId: persisted })
      }
    } catch (error) {
      if (seq !== loadConversationSeqRef.current) return
      if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }
      if (error instanceof ConversationAccessError && error.status === 404) {
        // 404 或跨 Workspace 隐藏成 404：URL / 消息 / 高亮必须同步回到 draft，
        // 不残留旧 persisted conversationState 或旧 messages。
        enterDraft({ clearUrl: 'replace', message: '该会话不存在或已无权访问。' })
        return
      }
      setChatError(toErrorMessage(error))
    }
  }

  // V2 Run 流。EventSource + sessionStorage lastEventId 实现断线 / 刷新恢复。
  function buildEventsUrl(runId: string): string {
    return `/v1/v2alpha/runs/${runId}/events`
  }

  // 起 / 续 EventSource 监听 runId 的事件流。
  // 必须先关闭上一个流；引用 token 失败时事件会被 EventSource 静默丢弃。
  function startRunStream(args: { runId: string; eventsUrl: string; lastEventId: number }) {
    if (runStreamRef.current) {
      runStreamRef.current.close()
      runStreamRef.current = null
    }
    currentRunIdRef.current = args.runId
    runStreamRef.current = streamRunEvents(
      args.eventsUrl,
      args.runId,
      {
        onEvent: (event) => handleRunStreamEvent(event, args.runId),
        onError: (err) => {
          console.error('Run SSE 异常', err)
        },
      },
      args.lastEventId,
    )
  }

  function handleRunStreamEvent(event: V2RunEvent, runId: string) {
    // 终态事件 → 关闭 EventSource、清理 sessionStorage 缓存；
    // 不再尝试重连，避免重复消费同一事件。
    if (event.type === 'run-completed' || event.type === 'run-stopped' || event.type === 'run-failed') {
      if (event.type === 'run-failed') {
        // 终态前先展示后端给的错误信息；run-stopped 不报错。
        const failedPayload = event.payload
        setChatError(failedPayload.message ?? '生成失败，请重试。')
      }
      if (event.type === 'run-completed' || event.type === 'run-stopped') {
        // 最终 checkpoint 先于终态事件到达；flush 实时 delta 后再把消息置终态。
        markTerminalToRenderer(
          rendererStateRef.current,
          event.type === 'run-completed' ? 'completed' : 'stopped',
          rendererOpsRef.current!,
        )
      } else {
        // run-failed：直接把当前 targetText 渲染并切到 stopped；error UX 在 PR-2.4 不变。
        flushRenderer(rendererStateRef.current, rendererOpsRef.current!)
        updateStreamingAssistantContent(rendererStateRef.current.targetText, 'stopped')
        rendererStateRef.current.renderedPrefixLength = rendererStateRef.current.targetText.length
      }
      if (event.type === 'run-failed') streamingAssistantIdRef.current = null
      abortControllerRef.current = null
      setIsAsking(false)
      clearPersistedLastEventId(runId)
      runStreamRef.current?.close()
      runStreamRef.current = null
      currentRunIdRef.current = null
      void refreshConversations()
      return
    }
    if (event.type === 'run-queued') {
      streamingAssistantIdRef.current = event.payload.assistantMessageId
      cancelStreamingRender()
      setMessages((current) => {
        const exists = current.some((m) => m.id === event.payload.assistantMessageId && m.role === 'assistant')
        if (exists) return current
        return [...current, {
          id: event.payload.assistantMessageId,
          role: 'assistant',
          content: '',
          citations: [],
          status: 'pending',
        }]
      })
      setIsAsking(true)
      return
    }
    if (event.type === 'run-started') {
      setMessages((current) => current.map((m) => m.role === 'assistant' && m.id === streamingAssistantIdRef.current ? { ...m, status: 'streaming' } : m))
      return
    }
    if (event.type === 'content-checkpoint') {
      applyCheckpoint(event.payload.text)
      return
    }
    if (event.type === 'content-delta') {
      // 实时增量：直接合并到 React state；缺失允许——下一次 checkpoint
      // 仍会通过 applyCheckpoint 收敛。
      appendLiveDelta(event.payload.text)
      return
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
    } finally {
      // V2：关 SSE 流；终端事件 run-stopped 才会真正收尾。
      runStreamRef.current?.close()
      runStreamRef.current = null
      currentRunIdRef.current = null
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

    // 阶段 2：`/chat/new` 已自动创建服务端 draft；这里保留单飞兜底，
    // 覆盖用户在初始化请求返回前立即发送第一条消息的场景。
    let convId: string
    if (conversationState.type === 'draft') {
      try {
        convId = await ensureServerDraftConversation()
      } catch (error) { if (error instanceof UnauthenticatedError) { handleUnauthenticated(); isSubmittingRef.current = false; return }; setChatError(toErrorMessage(error)); isSubmittingRef.current = false; return; }
    } else {
      convId = conversationState.id
    }

    // 立刻把用户消息渲染到 UI，避免等待首条 SSE 事件带来的"空档"
    const userMessageId = crypto.randomUUID()
    setMessages((current) => [...current, { id: userMessageId, role: 'user', content: trimmed, status: 'completed' }])
    setIsAsking(true)

    try {
      const result = await postMessage(convId, trimmed)
      // 服务端同步返回 runId / assistantMessageId；立即起流，无需客户端 polling。
      // lastEventId 默认 0；新 Run 没有可重连历史，sessionStorage 内也没有值。
      startRunStream({
        runId: result.runId,
        eventsUrl: result.eventsUrl,
        lastEventId: readPersistedLastEventId(result.runId),
      })
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        handleUnauthenticated()
      } else if ((error as Error).name === 'ConversationActiveRunError') {
        // 已有活跃 Run：提示用户；不要清空用户消息。
        setChatError((error as Error).message)
      } else {
        setChatError(toErrorMessage(error))
      }
    } finally {
      isSubmittingRef.current = false
      // 不论正常终态、message-error、网络错误，都刷新一次会话
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
