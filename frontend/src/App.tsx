import { useEffect, useRef, useState } from 'react'
import { Bot, BookOpen, ChevronDown, CircleHelp, FileText, Library, MoreHorizontal, Moon, Plus, Send, Settings, Sparkles, Sun, Trash2, Upload, X } from 'lucide-react'
import { createKnowledgeBase, deleteDocument, getCapabilities, listDocuments, listKnowledgeBases, uploadDocument, type Capabilities, type ChatAgentInfo, type Citation, type KnowledgeBase, type KnowledgeDocument } from './lib/api'
import { listAgents, listConversations, createConversation, getConversation, updateConversation, deleteConversation, askMessage } from './lib/conversations'
import type { ConversationSummary } from './types/conversation'
import './App.css'

type Theme = 'light' | 'dark'
type Module = '对话' | '知识库' | '设置'

type Message =
  | { id: string; role: 'user'; content: string; status: 'completed' | 'failed' }
  | { id: string; role: 'assistant'; content: string; citations: Citation[]; status: 'completed' | 'failed' }

type ConversationState =
  | { type: 'draft'; agentId: string; knowledgeBaseId: string | null }
  | { type: 'persisted'; id: string }

const navigation: Array<[Module, typeof Bot]> = [['对话', Bot], ['知识库', Library], ['设置', Settings]]

function App() {
  const [theme, setTheme] = useState<Theme>('dark'); const [activeModule, setActiveModule] = useState<Module>('对话')
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationState, setConversationState] = useState<ConversationState>({ type: 'draft', agentId: 'general-chat', knowledgeBaseId: null })
  const [messages, setMessages] = useState<Message[]>([]); const [isAsking, setIsAsking] = useState(false); const [chatError, setChatError] = useState<string | null>(null); const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null)
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]); const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState<string | null>(null); const [documents, setDocuments] = useState<KnowledgeDocument[]>([]); const [isKnowledgeLoading, setIsKnowledgeLoading] = useState(false); const [isUploading, setIsUploading] = useState(false); const [showCreateKnowledgeBase, setShowCreateKnowledgeBase] = useState(false); const [knowledgeError, setKnowledgeError] = useState<string | null>(null); const [capabilities, setCapabilities] = useState<Capabilities>({ documentFormats: ['txt', 'md'], mineruEnabled: false, chatAgents: [{ id: 'general-chat', name: '通用对话 Agent', requiresKnowledgeBase: false }, { id: 'knowledge-base', name: '知识库问答 Agent', requiresKnowledgeBase: true }], defaultChatModel: 'deepseek/deepseek-v4-flash' })
  const [question, setQuestion] = useState('')
  const [chatAgents, setChatAgents] = useState<ChatAgentInfo[]>([{ id: 'general-chat', name: '通用对话 Agent', requiresKnowledgeBase: false }, { id: 'knowledge-base', name: '知识库问答 Agent', requiresKnowledgeBase: true }])

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
    setChatError(null); setSelectedCitation(null)
    try {
      const { messages: loadedMessages } = await getConversation(id)
      setConversationState({ type: 'persisted', id })
      setMessages(loadedMessages.map((m) => m.role === 'user' ? { id: m.id, role: 'user', content: m.content, status: m.status } : { id: m.id, role: 'assistant', content: m.content, citations: m.citations, status: m.status }))
    } catch (error) { setChatError(toErrorMessage(error)) }
  }
  function newChat() { setConversationState({ type: 'draft', agentId: 'general-chat', knowledgeBaseId: null }); setMessages([]); setChatError(null); setSelectedCitation(null) }
  async function switchAgent(agentId: string) {
    if (conversationState.type === 'draft') { setConversationState({ type: 'draft', agentId, knowledgeBaseId: agentId === 'general-chat' ? null : conversationState.knowledgeBaseId }); setChatError(null); return }
    try { const updated = await updateConversation(conversationState.id, { agentId }); setConversations((prev) => prev.map((c) => (c.id === updated.id ? { ...c, agentId: updated.agentId, knowledgeBaseId: updated.knowledgeBaseId } : c))); setChatError(null) } catch (error) { setChatError(toErrorMessage(error)) }
  }
  async function selectKnowledgeBase(knowledgeBase: Pick<KnowledgeBase, 'id' | 'name'>) {
    if (conversationState.type === 'draft') { setConversationState({ type: 'draft', agentId: 'knowledge-base', knowledgeBaseId: knowledgeBase.id }); setChatError(null); return }
    try { const updated = await updateConversation(conversationState.id, { knowledgeBaseId: knowledgeBase.id }); setConversations((prev) => prev.map((c) => (c.id === updated.id ? { ...c, knowledgeBaseId: updated.knowledgeBaseId, knowledgeBaseName: knowledgeBase.name } : c))); setChatError(null) } catch (error) { setChatError(toErrorMessage(error)) }
  }
  async function clearKnowledgeBase() {
    if (conversationState.type === 'draft') { setConversationState((prev) => prev.type === 'draft' ? { ...prev, knowledgeBaseId: null } : prev); return }
    try { const updated = await updateConversation(conversationState.id, { knowledgeBaseId: null }); setConversations((prev) => prev.map((c) => (c.id === updated.id ? { ...c, knowledgeBaseId: null, knowledgeBaseName: null } : c))) } catch (error) { setChatError(toErrorMessage(error)) }
  }
  async function submitQuestion() {
    const content = question.trim(); if (!content || isAsking) return
    const currentAgent = chatAgents.find((a) => a.id === currentAgentId)
    if (currentAgent?.requiresKnowledgeBase && !currentKnowledgeBaseId) { setChatError('请先选择一个知识库。'); return }
    setChatError(null); setQuestion('')
    let convId: string
    if (conversationState.type === 'draft') {
      try {
        const created = await createConversation({ agentId: conversationState.agentId, knowledgeBaseId: conversationState.knowledgeBaseId })
        convId = created.id
        setConversationState({ type: 'persisted', id: convId })
        const summary: ConversationSummary = { id: created.id, title: created.title, agentId: created.agentId, knowledgeBaseId: created.knowledgeBaseId, knowledgeBaseName: created.knowledgeBaseName, createdAt: created.createdAt, updatedAt: created.updatedAt }
        setConversations((prev) => [summary, ...prev])
      } catch (error) { setChatError(toErrorMessage(error)); return }
    } else { convId = conversationState.id }
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content, status: 'completed' }]); setIsAsking(true)
    try {
      const result = await askMessage(convId, content)
      setMessages((current) => [...current, { id: result.id, role: 'assistant', content: result.content, citations: result.citations, status: result.status }])
      await refreshConversations()
    } catch (error) { setChatError(toErrorMessage(error)) } finally { setIsAsking(false) }
  }
  async function handleDeleteConversation(id: string) {
    try { await deleteConversation(id); setConversations((prev) => prev.filter((c) => c.id !== id)); if (conversationState.type === 'persisted' && conversationState.id === id) newChat() } catch (error) { setChatError(toErrorMessage(error)) }
  }
  function enterChatFromKnowledgeBase(knowledgeBase: Pick<KnowledgeBase, 'id' | 'name'>) { setConversationState({ type: 'draft', agentId: 'knowledge-base', knowledgeBaseId: knowledgeBase.id }); setMessages([]); setChatError(null); setSelectedCitation(null); setActiveModule('对话') }
  async function createKnowledgeBaseFromForm(name: string, description: string) { setKnowledgeError(null); const created = await createKnowledgeBase({ name, ...(description ? { description } : {}) }); setKnowledgeBases((current) => [created, ...current]); setSelectedKnowledgeBaseId(created.id); setShowCreateKnowledgeBase(false) }
  async function handleUpload(file: File | undefined) { if (!file || !selectedKnowledgeBaseId || isUploading) return; setIsUploading(true); setKnowledgeError(null); try { await uploadDocument(selectedKnowledgeBaseId, file); await Promise.all([refreshDocuments(selectedKnowledgeBaseId), refreshKnowledgeBases()]) } catch (error) { setKnowledgeError(toErrorMessage(error)) } finally { setIsUploading(false) } }
  async function handleDeleteDocument(id: string) { if (!selectedKnowledgeBaseId) return; setKnowledgeError(null); try { await deleteDocument(id); await Promise.all([refreshDocuments(selectedKnowledgeBaseId), refreshKnowledgeBases()]) } catch (error) { setKnowledgeError(toErrorMessage(error)) } }
  function selectModule(module: Module) { setActiveModule(module); setSelectedCitation(null); if (module === '知识库') setKnowledgeError(null) }
  const selectedKnowledgeBase = knowledgeBases.find((item) => item.id === selectedKnowledgeBaseId) ?? null
  return <main className={`app ${theme}`}><Sidebar activeModule={activeModule} knowledgeBases={knowledgeBases} selectedKnowledgeBaseId={selectedKnowledgeBaseId} conversations={conversations} currentConversationId={conversationState.type === 'persisted' ? conversationState.id : null} onSelectModule={selectModule} onSelectKnowledgeBase={(id) => { setSelectedKnowledgeBaseId(id); setShowCreateKnowledgeBase(false) }} onNewChat={newChat} onOpenConversation={openConversation} onDeleteConversation={handleDeleteConversation} onNewKnowledgeBase={() => { setSelectedKnowledgeBaseId(null); setShowCreateKnowledgeBase(true) }} theme={theme} onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
    {activeModule === '对话' && <ChatWorkspace question={question} messages={messages} isAsking={isAsking} error={chatError} chatAgents={chatAgents} knowledgeBases={knowledgeBases} selectedAgentId={currentAgentId} defaultChatModel={capabilities.defaultChatModel} activeKnowledgeBase={activeKnowledgeBase} onQuestionChange={setQuestion} onSubmit={() => void submitQuestion()} onSwitchAgent={switchAgent} onSelectKnowledgeBase={selectKnowledgeBase} onClearKnowledgeBase={clearKnowledgeBase} onSelectCitation={setSelectedCitation} />}
    {activeModule === '知识库' && <KnowledgeBaseWorkspace selectedKnowledgeBase={selectedKnowledgeBase} documents={documents} isLoading={isKnowledgeLoading} isUploading={isUploading} showCreate={showCreateKnowledgeBase} error={knowledgeError} capabilities={capabilities} onCreate={createKnowledgeBaseFromForm} onBack={() => { setSelectedKnowledgeBaseId(null); setShowCreateKnowledgeBase(false) }} onEnterChat={enterChatFromKnowledgeBase} onUpload={handleUpload} onDeleteDocument={handleDeleteDocument} />}
    {activeModule === '设置' && <PlaceholderWorkspace title="设置" description="工作台设置将在后续版本开放。" icon={<Settings size={28} />} />}{selectedCitation && <CitationPanel citation={selectedCitation} onClose={() => setSelectedCitation(null)} />}</main>
}

function Sidebar({ activeModule, knowledgeBases, selectedKnowledgeBaseId, conversations, currentConversationId, onSelectModule, onSelectKnowledgeBase, onNewChat, onOpenConversation, onDeleteConversation, onNewKnowledgeBase, theme, onToggleTheme }: { activeModule: Module; knowledgeBases: KnowledgeBase[]; selectedKnowledgeBaseId: string | null; conversations: ConversationSummary[]; currentConversationId: string | null; onSelectModule: (module: Module) => void; onSelectKnowledgeBase: (id: string) => void; onNewChat: () => void; onOpenConversation: (id: string) => void; onDeleteConversation: (id: string) => void; onNewKnowledgeBase: () => void; theme: Theme; onToggleTheme: () => void }) { return <aside className="sidebar"><div className="sidebar-top"><div className="brand"><Sparkles size={22} /><span>玄枢</span></div>{activeModule === '对话' && <button className="new-chat" onClick={onNewChat}><Plus size={17} />新建对话 <kbd>⌘K</kbd></button>}{activeModule === '知识库' && <button className="new-chat" onClick={onNewKnowledgeBase}><Plus size={17} />新建知识库</button>}</div><div className="sidebar-content">{activeModule === '对话' && <section><p className="side-heading"><CircleHelp size={15} />最近对话</p>{conversations.length === 0 ? <p className="sidebar-empty">暂无已保存的对话</p> : <div className="knowledge-sidebar-list">{conversations.map((conv) => <div key={conv.id} className="sidebar-conversation-row" style={{ display: 'flex', alignItems: 'center', gap: '2px' }}><button className={currentConversationId === conv.id ? 'sidebar-knowledge selected' : 'sidebar-knowledge'} style={{ flex: 1 }} onClick={() => onOpenConversation(conv.id)}><Bot size={17} /><span><strong>{conv.title}</strong><small>{conv.knowledgeBaseName ? `📚 ${conv.knowledgeBaseName}` : conv.agentId === 'general-chat' ? '通用对话' : '知识库问答'}</small></span></button><button className="icon-button" style={{ padding: '4px' }} onClick={(e) => { e.stopPropagation(); onDeleteConversation(conv.id); }} aria-label={`删除 ${conv.title}`}><Trash2 size={15} /></button></div>)}</div>}</section>}{activeModule === '知识库' && <section><p className="side-heading"><Library size={15} />知识库</p><div className="knowledge-sidebar-list">{knowledgeBases.length === 0 ? <p className="sidebar-empty">还没有知识库</p> : knowledgeBases.map((item) => <button key={item.id} className={selectedKnowledgeBaseId === item.id ? 'sidebar-knowledge selected' : 'sidebar-knowledge'} onClick={() => onSelectKnowledgeBase(item.id)}><Library size={17} /><span><strong>{item.name}</strong><small>{item.documentCount} 个文档</small></span></button>)}</div></section>}{activeModule === '设置' && <SidebarPlaceholder icon={<Settings size={20} />} text="选择一个设置项后在主区域配置" />}</div><nav className="sidebar-nav">{navigation.map(([name, Icon]) => <button key={name} className={activeModule === name ? 'nav-item active' : 'nav-item'} onClick={() => onSelectModule(name)}><Icon size={19} /><span>{name}</span></button>)}</nav><div className="sidebar-bottom"><span className="avatar">玄</span><button className="icon-button" onClick={onToggleTheme} aria-label="切换主题">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button></div></aside> }
function SidebarPlaceholder({ icon, text }: { icon: React.ReactNode; text: string }) { return <div className="sidebar-placeholder">{icon}<p>{text}</p></div> }

function ChatWorkspace({ question, messages, isAsking, error, chatAgents, knowledgeBases, selectedAgentId, defaultChatModel, activeKnowledgeBase, onQuestionChange, onSubmit, onSwitchAgent, onSelectKnowledgeBase, onClearKnowledgeBase, onSelectCitation }: { question: string; messages: Message[]; isAsking: boolean; error: string | null; chatAgents: ChatAgentInfo[]; knowledgeBases: KnowledgeBase[]; selectedAgentId: string; defaultChatModel: string; activeKnowledgeBase: Pick<KnowledgeBase, 'id' | 'name'> | null; onQuestionChange: (value: string) => void; onSubmit: () => void; onSwitchAgent: (agentId: string) => void; onSelectKnowledgeBase: (knowledgeBase: KnowledgeBase) => void; onClearKnowledgeBase: () => void; onSelectCitation: (citation: Citation) => void }) {
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false)
  const [isKnowledgeBasePickerOpen, setIsKnowledgeBasePickerOpen] = useState(false)
  const agentPickerRef = useRef<HTMLDivElement>(null)
  const knowledgeBasePickerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function closePickers(event: MouseEvent) {
      if (!agentPickerRef.current?.contains(event.target as Node)) setIsAgentPickerOpen(false)
      if (!knowledgeBasePickerRef.current?.contains(event.target as Node)) setIsKnowledgeBasePickerOpen(false)
    }
    document.addEventListener('mousedown', closePickers)
    return () => document.removeEventListener('mousedown', closePickers)
  }, [])
  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSubmit()
    }
  }
  const currentAgent = chatAgents.find((agent) => agent.id === selectedAgentId)
  const isKnowledgeAgent = currentAgent?.requiresKnowledgeBase ?? false
  const canSend = question.trim().length > 0 && !isAsking && (!isKnowledgeAgent || !!activeKnowledgeBase)
  return <section className="chat-workspace"><header className="chat-header"><div><h1>{currentAgent?.name ?? '对话'}</h1></div><div className="top-controls"><div className="top-control-group" ref={agentPickerRef}><span className="top-control-label">智能体</span><button className="top-control-select" type="button" onClick={() => setIsAgentPickerOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={isAgentPickerOpen}>{currentAgent?.name ?? '选择智能体'}<ChevronDown size={15} /></button>{isAgentPickerOpen && <div className="agent-picker-menu" role="listbox" aria-label="选择智能体">{chatAgents.map((agent) => <button key={agent.id} className={agent.id === selectedAgentId ? 'selected' : ''} type="button" role="option" aria-selected={agent.id === selectedAgentId} onClick={() => { onSwitchAgent(agent.id); setIsAgentPickerOpen(false) }}><span>{agent.name}</span>{agent.requiresKnowledgeBase && <small>需知识库</small>}</button>)}</div>}</div><div className="top-control-group"><span className="top-control-label">当前模型</span><span className="top-control-value">{defaultChatModel}</span></div></div></header><div className="message-scroll-area"><div className="chat-content">{messages.length === 0 && <div className="empty-state"><Sparkles size={24} /><p>{isKnowledgeAgent ? '向知识库提问，玄枢会基于检索到的原文回答并附上引用来源。' : '你好，我是玄枢通用助手。有什么可以帮你的吗？'}</p></div>}{messages.map((message) => message.role === 'user' ? <div className="message user-message" key={message.id}><div><p>{message.content}</p></div></div> : <AssistantMessage key={message.id} message={message} onSelectCitation={onSelectCitation} />)}{isAsking && <div className="message assistant-message"><div className="answer loading-answer"><span /><span /><span />{isKnowledgeAgent ? '正在检索知识库并生成回答…' : '正在思考…'}</div></div>}{error && <p className="request-error">{error}</p>}</div></div><div className="composer-wrap"><div className="composer">{isKnowledgeAgent && activeKnowledgeBase && <div className="active-knowledge-base"><Library size={15} /><span>当前知识库：<strong>{activeKnowledgeBase.name}</strong></span><button onClick={onClearKnowledgeBase} aria-label="退出当前知识库"><X size={15} /></button></div>}{isKnowledgeAgent && !activeKnowledgeBase && <div className="active-knowledge-base" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}><Library size={15} /><span>请先选择一个知识库</span></div>}<textarea value={question} onChange={(event) => onQuestionChange(event.target.value)} onKeyDown={handleKeyDown} disabled={isAsking} placeholder={isKnowledgeAgent ? (activeKnowledgeBase ? '输入问题，或使用 / 选择指令' : '请先选择一个知识库') : '输入问题，开始对话'} rows={2} /><div className="composer-footer"><div className="prompt-tools"><button type="button">/ 指令</button><div className="composer-knowledge-picker" ref={knowledgeBasePickerRef}><button type="button" onClick={() => setIsKnowledgeBasePickerOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={isKnowledgeBasePickerOpen}>@ 知识库</button>{isKnowledgeBasePickerOpen && <div className="composer-knowledge-menu" role="listbox" aria-label="选择知识库">{knowledgeBases.length === 0 ? <p>暂无知识库，请先在知识库页创建。</p> : knowledgeBases.map((knowledgeBase) => <button type="button" role="option" aria-selected={knowledgeBase.id === activeKnowledgeBase?.id} className={knowledgeBase.id === activeKnowledgeBase?.id ? 'selected' : ''} key={knowledgeBase.id} onClick={() => { onSelectKnowledgeBase(knowledgeBase); setIsKnowledgeBasePickerOpen(false) }}><Library size={14} /><span>{knowledgeBase.name}</span></button>)}</div>}</div><button type="button"># 笔记</button></div><div><button className="send-mode" type="button">Enter 发送 <ChevronDown size={14} /></button><button className="send" onClick={onSubmit} disabled={!canSend} aria-label="发送问题"><Send size={18} /></button></div></div></div><p className="disclaimer">内容由 AI 生成，仅供参考</p></div></section>
}

function KnowledgeBaseWorkspace({ selectedKnowledgeBase, documents, isLoading, isUploading, showCreate, error, capabilities, onCreate, onBack, onEnterChat, onUpload, onDeleteDocument }: { selectedKnowledgeBase: KnowledgeBase | null; documents: KnowledgeDocument[]; isLoading: boolean; isUploading: boolean; showCreate: boolean; error: string | null; capabilities: Capabilities; onCreate: (name: string, description: string) => Promise<void>; onBack: () => void; onEnterChat: (knowledgeBase: Pick<KnowledgeBase, 'id' | 'name'>) => void; onUpload: (file: File | undefined) => void; onDeleteDocument: (id: string) => void }) { const [name, setName] = useState(''); const [description, setDescription] = useState(''); const inputRef = useRef<HTMLInputElement>(null); async function submitCreate(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); if (name.trim()) { await onCreate(name.trim(), description.trim()); setName(''); setDescription('') } }
  const supportedLabels = capabilities.documentFormats.map((f) => ({ txt: 'TXT', md: 'Markdown', pdf: 'PDF', docx: 'DOCX' }[f] ?? f.toUpperCase()));
  const acceptMap: Record<string, string> = { txt: '.txt,text/plain', md: '.md,text/markdown', pdf: '.pdf,application/pdf', docx: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const acceptAttr = capabilities.documentFormats.map((f) => acceptMap[f]).filter(Boolean).join(',');
  const uploadHint = supportedLabels.length > 0 ? `支持 ${supportedLabels.join('、')}，单文件不超过 10 MB。` : '暂不支持文件上传。';
  return <section className="knowledge-workspace"><header className="page-heading"><div><h1>{selectedKnowledgeBase ? selectedKnowledgeBase.name : '知识库'}</h1><p>{selectedKnowledgeBase ? `${selectedKnowledgeBase.documentCount} 个文档 · ${selectedKnowledgeBase.chunkCount ?? 0} 个片段` : '从左侧选择或新建一个知识库。'}</p></div>{selectedKnowledgeBase && <div className="page-heading-actions"><button className="outline-button" onClick={onBack}>返回列表</button><button className="primary-button" onClick={() => onEnterChat(selectedKnowledgeBase)}><Bot size={17} />进入问答</button></div>}</header>{error && <p className="request-error">{error}</p>}{!selectedKnowledgeBase && <>{showCreate && <form className="knowledge-create" onSubmit={(event) => void submitCreate(event)}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="知识库名称" maxLength={120} autoFocus /><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述（可选）" maxLength={2000} /><button className="primary-button" type="submit">创建</button></form>}<p className="muted-copy">从左侧知识库列表选择一个知识库，查看文档并开始问答。</p></>}{selectedKnowledgeBase && <><div className="upload-panel"><div><strong>上传文本资料</strong><p>{uploadHint}</p></div><input ref={inputRef} type="file" accept={acceptAttr} hidden onChange={(event) => onUpload(event.target.files?.[0])} /><button className="primary-button" onClick={() => inputRef.current?.click()} disabled={isUploading}><Upload size={17} />{isUploading ? '正在入库…' : '上传文档'}</button></div><div className="document-list">{isLoading ? <p className="muted-copy">正在加载文档…</p> : documents.length === 0 ? <p className="muted-copy">暂无文档。上传 TXT 或 Markdown 后会在此显示处理状态。</p> : documents.map((document) => <article className="document-row" key={document.id}><FileText size={21} /><div><strong>{document.name}</strong><small>{formatBytes(document.size)} · {document.chunkCount} 个片段 · {formatStatus(document.status)}</small>{document.errorMessage && <small className="document-error">{document.errorMessage}</small>}</div><button className="icon-button" onClick={() => onDeleteDocument(document.id)} aria-label={`删除 ${document.name}`}><Trash2 size={17} /></button></article>)}</div></>}</section> }
function PlaceholderWorkspace({ title, description, icon }: { title: string; description: string; icon: React.ReactNode }) { return <section className="placeholder-workspace"><div>{icon}<h1>{title}</h1><p>{description}</p></div></section> }
function AssistantMessage({ message, onSelectCitation }: { message: Extract<Message, { role: 'assistant' }>; onSelectCitation: (citation: Citation) => void }) { return <div className="message assistant-message"><div><div className="answer">{message.content.split(/\n{2,}/).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}{message.status === 'failed' && <span style={{ color: '#ef4444', fontSize: '0.85em', marginTop: '4px', display: 'block' }}>(发送失败)</span>}</div>{message.citations.length > 0 && <><div className="source-label">引用来源（{message.citations.length}）</div><div className="source-list">{message.citations.map((citation, index) => <button onClick={() => onSelectCitation(citation)} className="source-chip" key={citation.chunkId}><span>{index + 1}</span>{citation.title} {citation.chapter}</button>)}</div></>}<div className="answer-actions"><button><Bot size={17} />继续追问</button><button><FileText size={17} />生成摘要</button><button><BookOpen size={17} />加入笔记</button><button><MoreHorizontal size={18} /></button></div></div></div> }
function CitationPanel({ citation, onClose }: { citation: Citation; onClose: () => void }) { return <aside className="citation-panel"><header><strong>引用来源</strong><button className="icon-button" onClick={onClose}><X size={20} /></button></header><div className="citation-panel-scroll"><article className="source-detail"><h2>{citation.documentName ?? citation.title}</h2><p className="chapter">{citation.heading ?? citation.chapter}</p><hr /><h3>原文</h3><p>{citation.content}</p><h3>元数据</h3><dl>{citation.documentId ? <><dt>文档</dt><dd>{citation.documentName}</dd><dt>片段</dt><dd>第 {(citation.chunkIndex ?? 0) + 1} 段</dd></> : <><dt>作者</dt><dd>{citation.author ?? '未标注'}</dd><dt>版本</dt><dd>{citation.version ?? '未标注'}</dd></>}<dt>类型</dt><dd>{citation.category || citation.type}</dd><dt>来源</dt><dd>{citation.source || '未标注'}</dd></dl></article></div></aside> }
function toErrorMessage(error: unknown): string { return error instanceof Error ? error.message : '请求失败，请稍后重试。' }
function formatStatus(status: KnowledgeDocument['status']): string { return ({ uploaded: '已上传', parsing: '解析中', chunking: '切分中', embedding: '向量生成中', completed: '已完成', failed: '处理失败' })[status] }
function formatBytes(size: number): string { return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB` }
export default App
