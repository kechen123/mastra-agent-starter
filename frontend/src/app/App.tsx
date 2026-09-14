import { useCallback, useEffect, useRef, useState } from 'react'
import { useMediaQuery } from '@base-ui/react/unstable-use-media-query'
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
  regenerateMessageV2,
  postMessage,
  streamRunEvents,
  readPersistedLastEventId,
  clearPersistedLastEventId,
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
import { CitationPanel, MobileCitationDialog } from '../features/chat/components/CitationPanel'
import { AssistantChatWorkspace } from '../features/chat/components/AssistantChatWorkspace'
import { KnowledgeBaseWorkspace } from '../features/knowledge/components/KnowledgeBaseWorkspace'
import { SkillsWorkspace } from '../features/capabilities/components/SkillsWorkspace'
import { LoginScreen } from '../features/auth/components/LoginScreen'
import { useApprovals } from '../features/chat/useApprovals'
import { ConfirmDialog, type ConfirmRequest } from '../components/feedback/ConfirmDialog'
import { RenameConversationDialog } from '../features/chat/components/RenameConversationDialog'
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

// URL ↔ 应用视图的工具函数。保留原生 History API，避免为三个一级页面引入
// 一套并不需要的路由依赖。旧 `?conversation=<uuid>` 仅保留解析兼容，不再写入。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.history !== 'undefined'
}

type AppRoute =
  | { kind: 'chat-draft' }
  | { kind: 'chat-conversation'; id: string }
  | { kind: 'knowledge-list' }
  | { kind: 'knowledge-detail'; id: string }
  | { kind: 'skills' }
  | { kind: 'invalid' };

type NavigationMode = 'push' | 'replace' | 'none'

function readAppRoute(): AppRoute {
  if (!isBrowser()) return { kind: 'chat-draft' }
  const path = window.location.pathname.replace(/\/+$/, '')
  if (path === '' || path === '/chat' || path === '/chat/new') return { kind: 'chat-draft' }
  const segments = path.split('/').filter(Boolean)
  if (segments[0] === 'chat') {
    if (segments.length === 2 && isUuid(segments[1])) return { kind: 'chat-conversation', id: segments[1] }
    return { kind: 'invalid' }
  }
  if (segments[0] === 'knowledge-bases') {
    if (segments.length === 1) return { kind: 'knowledge-list' }
    if (segments.length === 2 && isUuid(segments[1])) return { kind: 'knowledge-detail', id: segments[1] }
    return { kind: 'invalid' }
  }
  if (segments.length === 1 && segments[0] === 'skills') {
    return { kind: 'skills' }
  }
  // 兼容旧 query ?conversation=<uuid>（不要污染迁移期间的用户体验）
  const params = new URLSearchParams(window.location.search)
  if (params.has('conversation')) {
    const raw = params.get('conversation')
    if (raw && isUuid(raw)) return { kind: 'chat-conversation', id: raw }
    return { kind: 'invalid' }
  }
  return { kind: 'invalid' }
}

function buildRoutePath(route: Exclude<AppRoute, { kind: 'invalid' }>): string {
  // 保留 query / hash 不被误删。
  const url = new URL(window.location.href)
  if (route.kind === 'chat-draft') url.pathname = '/chat/new'
  else if (route.kind === 'chat-conversation') url.pathname = `/chat/${route.id}`
  else if (route.kind === 'knowledge-list') url.pathname = '/knowledge-bases'
  else if (route.kind === 'knowledge-detail') url.pathname = `/knowledge-bases/${route.id}`
  else url.pathname = '/skills'
  // 旧查询参数清掉，避免"路径 + 查询"双通道并存
  url.searchParams.delete('conversation')
  return url.pathname + url.search + url.hash
}

function currentLocationMatches(target: string): boolean {
  return window.location.pathname + window.location.search + window.location.hash === target
}

function writeRoute(route: Exclude<AppRoute, { kind: 'invalid' }>, mode: 'push' | 'replace'): void {
  if (!isBrowser()) return
  const next = buildRoutePath(route)
  if (currentLocationMatches(next)) return
  const state = route.kind === 'chat-conversation' ? { conversationId: route.id } : null
  if (mode === 'push') window.history.pushState(state, '', next)
  else window.history.replaceState(state, '', next)
}

// 用户主动操作（首条消息创建后）写历史栈。
function setConversationUrl(id: string): void {
  writeRoute({ kind: 'chat-conversation', id }, 'push')
}

// 用户主动点"新对话" / 删除当前会话时：写入 draft 历史栈，避免浏览器回退
// 时反复回到已被清理的会话。
function clearConversationUrl(): void {
  writeRoute({ kind: 'chat-draft' }, 'push')
}

// 启动恢复 / 解析失败 / 404 / 跨 Workspace 无权：用 replaceState 清理无效
// 路径，避免污染浏览历史。
function replaceConversationUrl(id: string | null): void {
  writeRoute(id === null ? { kind: 'chat-draft' } : { kind: 'chat-conversation', id }, 'replace')
}

function App() {
  const [theme, setTheme] = useState<Theme>('dark'); const [activeModule, setActiveModule] = useState<Module>('对话')
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  // 桌面 sidebar 折叠状态：仅适用于 ≥760px。localStorage key 与项目其他设置保持命名空间一致。
  // 移动端 drawer 不受此状态影响（仍由 isSidebarOpen 控制）。
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try { return window.localStorage.getItem('xuanshu-agent.sidebar-collapsed') === 'true' }
    catch { return false }
  })
  // Base UI 的 Menu / ContextMenu / Dialog / Select 通过 Portal 挂到 body。
  // 主题若只写在 <main>，这些弹层不会继承 .dark 变量，导致暗色模式仍显示亮色菜单。
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    return () => root.classList.remove('dark')
  }, [theme])
  useEffect(() => {
    try { window.localStorage.setItem('xuanshu-agent.sidebar-collapsed', sidebarCollapsed ? 'true' : 'false') }
    catch { /* localStorage 不可用时静默忽略 */ }
  }, [sidebarCollapsed])
  const toggleSidebarCollapsed = useCallback(() => setSidebarCollapsed((value) => !value), [])
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationState, setConversationState] = useState<ConversationState>({ type: 'draft', agentId: 'general-chat', knowledgeBaseId: null })
  const [messages, setMessages] = useState<ChatMessage[]>([]); const [isAsking, setIsAsking] = useState(false); const [chatError, setChatError] = useState<string | null>(null); const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null)
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]); const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState<string | null>(null); const [documents, setDocuments] = useState<KnowledgeDocument[]>([]); const [isKnowledgeLoading, setIsKnowledgeLoading] = useState(false); const [isUploading, setIsUploading] = useState(false); const [showCreateKnowledgeBase, setShowCreateKnowledgeBase] = useState(false); const [knowledgeError, setKnowledgeError] = useState<string | null>(null); const [capabilities, setCapabilities] = useState<Capabilities>(DEFAULT_CAPABILITIES)
  // ConfirmDialog 集中状态：所有 window.confirm 替代品走这里。
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const [isConfirming, setIsConfirming] = useState(false)
  // RenameConversationDialog 状态：null → 关闭；非 null → 弹出并预填 initialTitle。
  const [renameRequest, setRenameRequest] = useState<{ id: string; initialTitle: string } | null>(null)
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
  const refreshKnowledgeBasesSeqRef = useRef(0)
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

  const approvals = useApprovals({
    sessionKey: authStatus === 'authenticated' ? currentUser?.id ?? null : null,
  })

  // 集中保存 ConfirmDialog 的待处理动作；ref 而非 state 防止重渲染。
  const pendingDeleteRef = useRef<{ kind: 'conversation' | 'knowledge-base' | 'document'; id: string } | null>(null)
  const pendingConfirmActionRef = useRef<(() => Promise<void>) | null>(null)

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

  // PR-4.2 §8.1：仅对处于中间态（queued / parsing / chunking / embedding /
  // finalizing）的文档做 1.5s 轮询；所有文档终态（ready / failed / cancelled）
  // 后停止轮询，避免无谓请求。离开知识库视图或切换 KB 时清空计时器。
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    if (activeModule !== '知识库' || !selectedKnowledgeBaseId) return
    const hasInFlight = documents.some(
      (doc) =>
        doc.status === 'queued' ||
        doc.status === 'parsing' ||
        doc.status === 'chunking' ||
        doc.status === 'embedding' ||
        doc.status === 'finalizing',
    )
    if (!hasInFlight) return
    const timer = window.setInterval(() => {
      void refreshDocuments(selectedKnowledgeBaseId).catch((error) => {
        if (error instanceof UnauthenticatedError) handleUnauthenticated()
      })
    }, 1_500)
    return () => window.clearInterval(timer)
  }, [authStatus, activeModule, selectedKnowledgeBaseId, documents, handleUnauthenticated])

  // 启动恢复：认证完成后由 URL 决定当前一级页面与详情选择。
  // 非法地址统一 replace 到聊天草稿，避免把未知路径伪装成有效页面。
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    if (startupRecoveryDoneRef.current) return
    startupRecoveryDoneRef.current = true
    applyRoute(readAppRoute(), 'replace')
    // loadConversation 闭包会引用组件最新状态，但启动恢复只跑一次，
    // 不会在依赖更新时反复执行。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus])

  // Phase 2：`/chat/new` 的事实来源必须是服务端 draft，而不是前端临时状态。
  // 有具体会话 ID 时由 loadConversation 接管，不能在恢复历史会话期间额外创建 draft。
  useEffect(() => {
    if (authStatus !== 'authenticated' || activeModule !== '对话' || conversationState.type !== 'draft') return
    if (readAppRoute().kind !== 'chat-draft') return
    void ensureServerDraftConversation().catch((error) => {
      if (error instanceof UnauthenticatedError) {
        handleUnauthenticated()
      } else {
        setChatError(toErrorMessage(error))
      }
    })
    // conversationState 是 draft 时需要捕获当时选择的 agent / knowledge base。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, activeModule, conversationState])

  // 浏览器前进 / 后退：URL 是真相，状态必须跟随。
  // 注意 pushState/replaceState 不会触发 popstate，只有浏览器导航才会。
  // popstate 内部要读最新的 conversationState / authStatus，所以用 ref 转发，
  // 避免闭包持有过期值。
  const conversationStateRef = useRef(conversationState)
  conversationStateRef.current = conversationState
  const authStatusRef = useRef(authStatus)
  authStatusRef.current = authStatus
  const applyRouteRef = useRef<(route: AppRoute, navigation: NavigationMode) => void>(() => {})
  applyRouteRef.current = applyRoute
  useEffect(() => {
    function onPopState() {
      // 未认证就忽略；登录页本身不参与 URL 会话恢复。
      if (authStatusRef.current !== 'authenticated') return
      applyRouteRef.current(readAppRoute(), 'none')
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
    setActiveModule('对话')
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
  async function refreshKnowledgeBases() {
    const seq = ++refreshKnowledgeBasesSeqRef.current
    setIsKnowledgeLoading(true)
    try {
      const list = await listKnowledgeBases()
      if (seq !== refreshKnowledgeBasesSeqRef.current) return
      setKnowledgeBases(list)
      if (selectedKnowledgeBaseId && !list.some((knowledgeBase) => knowledgeBase.id === selectedKnowledgeBaseId)) {
        setKnowledgeError('该知识库不存在或已无权访问。')
        enterKnowledgeBaseList('replace')
      }
    } catch (error) {
      if (seq !== refreshKnowledgeBasesSeqRef.current) return
      if (error instanceof UnauthenticatedError) { handleUnauthenticated(); setIsKnowledgeLoading(false); return }
      setKnowledgeError(toErrorMessage(error))
    } finally {
      if (seq === refreshKnowledgeBasesSeqRef.current) setIsKnowledgeLoading(false)
    }
  }
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
      setMessages(loadedMessages.map((m) => m.role === 'user' ? { id: m.id, role: 'user', content: m.content, status: m.status as 'completed' | 'failed', createdAt: m.createdAt } : { id: m.id, role: 'assistant', content: m.content, citations: m.citations, status: m.status as Extract<ChatMessage, { role: 'assistant' }>['status'], createdAt: m.createdAt, tools: m.tools }))
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
    approvals.onRunEvent(event)
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
          createdAt: new Date().toISOString(),
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
    if (event.type === 'tool-call-started' || event.type === 'tool-call-completed' || event.type === 'tool-call-failed') {
      setMessages((current) => current.map((message) => {
        if (message.role !== 'assistant' || message.id !== streamingAssistantIdRef.current) return message
        const nextTool = event.type === 'tool-call-started'
          ? { toolCallId: event.payload.toolCallId, toolName: event.payload.toolName, status: 'running' as const }
          : event.type === 'tool-call-completed'
            ? { toolCallId: event.payload.toolCallId, toolName: event.payload.toolName, status: 'completed' as const }
            : { toolCallId: event.payload.toolCallId, toolName: event.payload.toolName, status: 'failed' as const, errorCode: event.payload.errorCode }
        const tools = message.tools ?? []
        const existingIndex = tools.findIndex((tool) => tool.toolCallId === nextTool.toolCallId)
        const nextTools = existingIndex === -1
          ? [...tools, nextTool]
          : tools.map((tool, index) => index === existingIndex ? nextTool : tool)
        return { ...message, tools: nextTools }
      }))
      return
    }
  }

  // 侧边栏点击：用户主动操作 → push URL。
  async function openConversation(id: string) {
    setActiveModule('对话')
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

  function enterKnowledgeBaseList(navigation: NavigationMode, showCreate = false) {
    if (streamingAssistantIdRef.current) void handleStop()
    setActiveModule('知识库')
    setSelectedCitation(null)
    setSelectedKnowledgeBaseId(null)
    setDocuments([])
    setShowCreateKnowledgeBase(showCreate)
    setKnowledgeError(null)
    if (navigation !== 'none') writeRoute({ kind: 'knowledge-list' }, navigation)
  }

  function openKnowledgeBase(id: string, navigation: NavigationMode) {
    if (streamingAssistantIdRef.current) void handleStop()
    setActiveModule('知识库')
    setSelectedCitation(null)
    setSelectedKnowledgeBaseId(id)
    setDocuments([])
    setShowCreateKnowledgeBase(false)
    setKnowledgeError(null)
    if (navigation !== 'none') writeRoute({ kind: 'knowledge-detail', id }, navigation)
  }

  function enterSkills(navigation: NavigationMode) {
    if (streamingAssistantIdRef.current) void handleStop()
    setActiveModule('能力')
    setSelectedCitation(null)
    if (navigation !== 'none') writeRoute({ kind: 'skills' }, navigation)
  }

  // 启动恢复与浏览器前进/后退共用这个入口；组件内部状态永远跟随 URL，
  // 用户主动点击则由对应的 enter/open 函数选择 pushState。
  function applyRoute(route: AppRoute, navigation: NavigationMode) {
    if (route.kind === 'invalid') {
      enterDraft({ clearUrl: 'replace', message: null })
      return
    }
    if (route.kind === 'chat-draft') {
      enterDraft({ clearUrl: navigation, message: null })
      return
    }
    if (route.kind === 'chat-conversation') {
      const current = conversationStateRef.current
      setActiveModule('对话')
      if (current.type === 'persisted' && current.id === route.id) return
      void loadConversation(route.id, navigation)
      return
    }
    if (route.kind === 'knowledge-list') {
      enterKnowledgeBaseList(navigation)
      return
    }
    if (route.kind === 'knowledge-detail') {
      openKnowledgeBase(route.id, navigation)
      return
    }
    enterSkills(navigation)
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

  async function submitQuestion(content: string) {
    const trimmed = content.trim()
    if (!trimmed || isSubmittingRef.current || streamingAssistantIdRef.current) return
    const currentAgent = chatAgents.find((a) => a.id === currentAgentId)
    if (currentAgent?.requiresKnowledgeBase && !currentKnowledgeBaseId) { setChatError('请先选择一个知识库。'); return }
    setChatError(null)
    isSubmittingRef.current = true
    // 连服务端 draft 也可能有网络等待；先显示占位，避免用户点击发送后界面静止。
    setIsAsking(true)
    // 先渲染用户气泡，让等待占位从第一帧起就处于最终对话流的位置。
    // 不能等 draft 创建完成再追加，否则空态 → 消息列表切换会让占位明显下跳。
    const userMessageId = crypto.randomUUID()
    setMessages((current) => [...current, {
      id: userMessageId,
      role: 'user',
      content: trimmed,
      status: 'completed',
      createdAt: new Date().toISOString(),
    }])

    // 阶段 2：`/chat/new` 已自动创建服务端 draft；这里保留单飞兜底，
    // 覆盖用户在初始化请求返回前立即发送第一条消息的场景。
    let convId: string
    if (conversationState.type === 'draft') {
      try {
        convId = await ensureServerDraftConversation()
      } catch (error) {
        setIsAsking(false)
        setMessages((current) => current.map((message) => message.id === userMessageId && message.role === 'user' ? { ...message, status: 'failed' } : message))
        if (error instanceof UnauthenticatedError) { handleUnauthenticated(); isSubmittingRef.current = false; return }
        setChatError(toErrorMessage(error)); isSubmittingRef.current = false; return
      }
    } else {
      convId = conversationState.id
    }

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
      setIsAsking(false)
      setMessages((current) => current.map((message) => message.id === userMessageId && message.role === 'user' ? { ...message, status: 'failed' } : message))
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
    setIsAsking(true)

    try {
      // V2 重新生成：服务端在单事务内替换 assistant 消息、创建新 Run 并返回 runId。
      // 前端不再依赖旧 SSE；拿到 runId 后立即 EventSource 订阅，沿用 V2 渲染管线。
      const result = await regenerateMessageV2(assistantMessageId)
      // 替换本地 assistant message：旧条目切 stopped 并降权，新条目接入 streaming 渲染。
      setMessages((current) => {
        const idx = current.findIndex((m) => m.id === assistantMessageId && m.role === 'assistant')
        if (idx === -1) return current
        const updated = current.slice()
        updated[idx] = { ...(updated[idx] as Extract<ChatMessage, { role: 'assistant' }>), status: 'stopped' }
        if (!updated.some((m) => m.id === result.assistantMessageId && m.role === 'assistant')) {
          updated.push({
            id: result.assistantMessageId,
            role: 'assistant',
            content: '',
            citations: [],
            status: 'pending',
            createdAt: new Date().toISOString(),
          })
        }
        return updated
      })
      startRunStream({
        runId: result.runId,
        eventsUrl: result.eventsUrl,
        lastEventId: readPersistedLastEventId(result.runId),
      })
    } catch (error) {
      // 请求失败时没有后续 Run 终态事件，必须立即收起加载占位。
      setIsAsking(false)
      if (error instanceof UnauthenticatedError) {
        handleUnauthenticated()
      } else if ((error as Error).name === 'ConversationActiveRunError') {
        setChatError((error as Error).message)
      } else {
        setChatError(toErrorMessage(error))
      }
    } finally {
      isSubmittingRef.current = false
      // 同 submitQuestion：保证任意终态都会触发一次会话列表同步。
      void refreshConversations()
    }
  }

  // 重命名会话：仅触发 Dialog；实际提交由 RenameConversationDialog onSubmit 回调完成。
  function handleRenameConversation(id: string, currentTitle: string) {
    setRenameRequest({ id, initialTitle: currentTitle })
  }
  async function performRenameConversation(nextTitle: string) {
    const request = renameRequest
    if (!request) return
    try {
      const updated = await updateConversation(request.id, { title: nextTitle })
      setConversations((prev) => prev.map((c) => (c.id === updated.id ? { ...c, title: updated.title, updatedAt: updated.updatedAt } : c)))
      // 当前会话若被重命名，更新 document.title 让浏览器 tab 同步。
      if (conversationState.type === 'persisted' && conversationState.id === request.id && typeof document !== 'undefined') {
        document.title = `${updated.title} · ${appName}`
      }
      setChatError(null)
    } catch (error) {
      if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }
      setChatError(toErrorMessage(error))
    } finally {
      setRenameRequest(null)
    }
  }

  async function handleDeleteConversation(id: string) {
    const conversation = conversations.find((item) => item.id === id)
    setConfirmRequest({
      title: '删除对话',
      description: `确定删除“${conversation?.title ?? '此对话'}”吗？此操作无法撤销。`,
      confirmLabel: '删除',
      destructive: true,
    })
    // 把待删除 id 暂存到 component-level closure 用的 Promise resolve 里。
    pendingDeleteRef.current = { kind: 'conversation', id }
  }
  async function performConfirm() {
    if (isConfirming) return
    const customAction = pendingConfirmActionRef.current
    if (customAction) {
      setIsConfirming(true)
      try {
        await customAction()
      } finally {
        pendingConfirmActionRef.current = null
        setIsConfirming(false)
        setConfirmRequest(null)
      }
      return
    }
    const pending = pendingDeleteRef.current
    if (!pending) { setConfirmRequest(null); return }
    setIsConfirming(true)
    try {
      if (pending.kind === 'conversation') {
        await deleteConversation(pending.id)
        setConversations((prev) => prev.filter((c) => c.id !== pending.id))
        if (conversationState.type === 'persisted' && conversationState.id === pending.id) newChat()
      } else if (pending.kind === 'knowledge-base') {
        await deleteKnowledgeBase(pending.id)
        setKnowledgeBases((current) => current.filter((item) => item.id !== pending.id))
        setDocuments([])
        if (selectedKnowledgeBaseId === pending.id) enterKnowledgeBaseList('replace')
        if (currentKnowledgeBaseId === pending.id) {
          if (conversationState.type === 'draft') setConversationState({ type: 'draft', agentId: 'knowledge-base', knowledgeBaseId: null })
          else {
            const updated = await updateConversation(conversationState.id, { knowledgeBaseId: null })
            setConversations((current) => current.map((item) => item.id === updated.id ? { ...item, knowledgeBaseId: null, knowledgeBaseName: null } : item))
          }
        }
      } else if (pending.kind === 'document') {
        if (!selectedKnowledgeBaseId) return
        await deleteDocument(pending.id)
        await Promise.all([refreshDocuments(selectedKnowledgeBaseId), refreshKnowledgeBases()])
      }
    } catch (error) {
      if (error instanceof UnauthenticatedError) { handleUnauthenticated(); return }
      setKnowledgeError(toErrorMessage(error))
    } finally {
      pendingDeleteRef.current = null
      setIsConfirming(false)
      setConfirmRequest(null)
    }
  }
  function enterChatFromKnowledgeBase(knowledgeBase: Pick<KnowledgeBase, 'id' | 'name'>) {
    enterDraft({ agentId: 'knowledge-base', knowledgeBaseId: knowledgeBase.id, clearUrl: 'push', message: null })
  }
  function startChatWithAgent(agentId: string) {
    enterDraft({ agentId, knowledgeBaseId: null, clearUrl: 'push', message: null })
  }
  async function createKnowledgeBaseFromForm(name: string, description: string) {
    setKnowledgeError(null)
    const created = await createKnowledgeBase({ name, ...(description ? { description } : {}) })
    // 作废在创建前启动的列表请求，避免旧结果把刚创建的详情误判为不存在。
    refreshKnowledgeBasesSeqRef.current += 1
    setKnowledgeBases((current) => [created, ...current])
    openKnowledgeBase(created.id, 'push')
  }
  async function handleUpload(file: File | undefined) {
    if (!file || !selectedKnowledgeBaseId || isUploading) return
    setIsUploading(true)
    setKnowledgeError(null)
    try {
      // PR-4.2 §8.1：HTTP 202 异步路径——上传只返回 documentId + jobId +
      // 当前 status。轮询由 KnowledgeBaseWorkspace 之外的 1.5s 定时器接管。
      await uploadDocument(selectedKnowledgeBaseId, file)
      await Promise.all([refreshDocuments(selectedKnowledgeBaseId), refreshKnowledgeBases()])
    } catch (error) {
      if (error instanceof UnauthenticatedError) { handleUnauthenticated(); setIsUploading(false); return }
      setKnowledgeError(toErrorMessage(error))
    } finally {
      setIsUploading(false)
    }
  }
  async function handleDeleteKnowledgeBase(id: string) {
    const knowledgeBase = knowledgeBases.find((item) => item.id === id)
    setConfirmRequest({
      title: '删除知识库',
      description: `确定删除知识库“${knowledgeBase?.name ?? ''}”吗？其中的文档也会被删除。`,
      confirmLabel: '删除',
      destructive: true,
    })
    pendingDeleteRef.current = { kind: 'knowledge-base', id }
  }
  async function handleDeleteDocument(id: string) {
    if (!selectedKnowledgeBaseId) return
    setConfirmRequest({
      title: '删除文档',
      description: '确定删除此文档吗？此操作无法撤销。',
      confirmLabel: '删除',
      destructive: true,
    })
    pendingDeleteRef.current = { kind: 'document', id }
  }
  function requestSkillRemoval(name: string, action: () => Promise<void>) {
    pendingDeleteRef.current = null
    pendingConfirmActionRef.current = action
    setConfirmRequest({
      title: '卸载技能',
      description: `确定卸载技能“${name}”吗？此操作会移除本地安装内容。`,
      confirmLabel: '卸载',
      destructive: true,
    })
  }
  function selectModule(module: Module) {
    if (module === '对话') {
      const current = conversationStateRef.current
      setActiveModule('对话')
      setSelectedCitation(null)
      writeRoute(current.type === 'persisted' ? { kind: 'chat-conversation', id: current.id } : { kind: 'chat-draft' }, 'push')
      return
    }
    if (module === '知识库') {
      enterKnowledgeBaseList('push')
      return
    }
    enterSkills('push')
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
      conversations={conversations}
      currentConversationId={conversationState.type === 'persisted' ? conversationState.id : null}
      onSelectModule={(module) => { selectModule(module); setIsSidebarOpen(false) }}
      onNewChat={() => { newChat(); setIsSidebarOpen(false) }}
      onOpenConversation={(id) => { void openConversation(id); setIsSidebarOpen(false) }}
      onDeleteConversation={handleDeleteConversation}
      onRenameConversation={handleRenameConversation}
      theme={theme}
      onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      currentUser={currentUser}
      onLogout={() => void handleLogout()}
      mobileOpen={isSidebarOpen}
      onCloseMobile={() => setIsSidebarOpen(false)}
      collapsed={sidebarCollapsed}
      onToggleCollapsed={toggleSidebarCollapsed}
    />
    {activeModule === '对话' && <AssistantChatWorkspace
      appShortName={appShortName}
      messages={messages}
      isAsking={isAsking}
      isStreaming={isStreaming}
      error={chatError ?? approvals.error}
      chatAgents={chatAgents}
      knowledgeBases={knowledgeBases}
      selectedAgentId={currentAgentId}
      defaultChatModel={capabilities.defaultChatModel}
      llmDisplayName={capabilities.llm?.displayName}
      activeKnowledgeBase={activeKnowledgeBase}
      onSubmit={(text) => void submitQuestion(text)}
      onStop={() => void handleStop()}
      onRegenerate={handleRegenerate}
      onSwitchAgent={switchAgent}
      onSelectKnowledgeBase={selectKnowledgeBase}
      onClearKnowledgeBase={clearKnowledgeBase}
      onSelectCitation={setSelectedCitation}
      pendingApprovals={approvals.pendingApprovals}
      busyApprovalId={approvals.busyApprovalId}
      onApproveApproval={(approval) => void approvals.approve(approval)}
      onDeclineApproval={(approval) => void approvals.decline(approval)}
      sidebarCollapsed={sidebarCollapsed}
      onExpandSidebar={toggleSidebarCollapsed}
    />}
    {activeModule === '知识库' && <KnowledgeBaseWorkspace knowledgeBases={knowledgeBases} selectedKnowledgeBase={selectedKnowledgeBase} documents={documents} isLoading={isKnowledgeLoading} isUploading={isUploading} showCreate={showCreateKnowledgeBase} error={knowledgeError} capabilities={capabilities} onCreate={createKnowledgeBaseFromForm} onSelectKnowledgeBase={(id) => openKnowledgeBase(id, 'push')} onShowCreate={() => enterKnowledgeBaseList('push', true)} onBack={() => enterKnowledgeBaseList('push')} onEnterChat={enterChatFromKnowledgeBase} onUpload={handleUpload} onDeleteDocument={handleDeleteDocument} onDeleteKnowledgeBase={handleDeleteKnowledgeBase} />}
    {activeModule === '能力' && <SkillsWorkspace onStartChat={startChatWithAgent} onRequestRemoveSkill={requestSkillRemoval} />}
    {selectedCitation && <CitationResponsive citation={selectedCitation} onClose={() => setSelectedCitation(null)} />}
    <ConfirmDialog
      request={confirmRequest}
      busy={isConfirming}
      onCancel={() => { pendingDeleteRef.current = null; pendingConfirmActionRef.current = null; setIsConfirming(false); setConfirmRequest(null) }}
      onConfirm={() => void performConfirm()}
    />
    <RenameConversationDialog
      open={renameRequest !== null}
      initialTitle={renameRequest?.initialTitle ?? ''}
      onCancel={() => setRenameRequest(null)}
      onSubmit={(nextTitle) => void performRenameConversation(nextTitle)}
    />
  </main>
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

/**
 * 引用详情响应式分发：窄屏 → Base UI Dialog；宽屏 → 桌面侧栏。
 * 断点 900px 与 CitationPanel 内部一致；切换瞬间的 flicker 由父组件引用
 * 是否仍挂载决定（selectedCitation 由父组件管理）。
 */
function CitationResponsive({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const isNarrow = useMediaQuery('(max-width: 1180px)', { defaultMatches: false })
  if (isNarrow) return <MobileCitationDialog citation={citation} onClose={onClose} />
  return <CitationPanel citation={citation} onClose={onClose} />
}

export default App
