import { useState } from 'react'
import {
  Bot, BookOpen, ChevronDown, ChevronRight, CircleHelp, FileText, Library,
  Menu, MoreHorizontal, Plus, Send, Settings, Sparkles, Sun, Moon, X,
} from 'lucide-react'
import { askKnowledge, type Citation } from './lib/api'
import './App.css'

type Theme = 'light' | 'dark'
type Message =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; content: string; citations: Citation[] }

const conversations = [['炼精化气是什么意思？', '刚刚'], ['金丹体系梳理', '昨天'], ['抱朴子核心观点', '2天前'], ['道教内丹修炼次序', '5天前']]

function App() {
  const [theme, setTheme] = useState<Theme>('dark')
  const [activeNav, setActiveNav] = useState('对话')
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [isAsking, setIsAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null)

  async function submitQuestion() {
    const content = question.trim()
    if (!content || isAsking) return

    setError(null)
    setQuestion('')
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content }])
    setIsAsking(true)
    try {
      const result = await askKnowledge(content)
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.answer,
        citations: result.citations,
      }])
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '请求失败，请稍后重试。')
    } finally {
      setIsAsking(false)
    }
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submitQuestion()
    }
  }

  return <main className={`app ${theme}`}>
    <aside className="rail" aria-label="主导航">
      <div className="brand"><Sparkles size={23} /><span>玄枢</span></div>
      <nav>{[['对话', Bot], ['知识库', Library], ['Agent', Sparkles], ['设置', Settings]].map(([name, Icon]) => <button key={name as string} className={activeNav === name ? 'nav-item active' : 'nav-item'} onClick={() => setActiveNav(name as string)}><Icon size={21} /><span>{name as string}</span></button>)}</nav>
      <div className="rail-bottom"><span className="avatar">玄</span><button className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="切换主题">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button></div>
    </aside>

    <aside className="conversation-panel">
      <button className="new-chat" onClick={() => { setMessages([]); setError(null); setSelectedCitation(null) }}><Plus size={18} />新建对话 <kbd>⌘K</kbd></button>
      <section><p className="side-heading"><CircleHelp size={15} />最近对话</p><div className="conversation-list">{conversations.map(([title, time], index) => <button className={index === 0 ? 'conversation selected' : 'conversation'} key={title}><span>{title}</span><small>{time}</small></button>)}</div><button className="all-chats">查看全部对话 <ChevronRight size={16} /></button></section>
      <div className="side-divider" /><section className="knowledge-section"><div className="side-heading">当前知识库 <button aria-label="添加知识库"><Plus size={17} /></button></div><button className="knowledge-card"><span className="book-icon"><Library size={21} /></span><span><strong>道教经典</strong><small>4 个文档 · 2.1 万条片段</small></span><MoreHorizontal size={18} /></button></section>
    </aside>

    <section className="workspace">
      <header className="topbar"><div className="mobile-menu"><Menu size={20} /></div><div className="top-controls"><label>智能体 <button>知识问答 Agent <ChevronDown size={15} /></button></label><label>模型 <button>DeepSeek-R1 32K <ChevronDown size={15} /></button></label><button className="settings-button"><Settings size={17} />设置</button></div></header>
      <div className="chat-scroll"><div className="chat-content"><h1>知识问答</h1>
        {messages.length === 0 && <div className="empty-state"><Sparkles size={24} /><p>向知识库提问，玄枢会基于检索到的原文回答并附上引用来源。</p></div>}
        {messages.map((message) => message.role === 'user'
          ? <div className="message user-message" key={message.id}><div><p>{message.content}</p></div></div>
          : <AssistantMessage key={message.id} message={message} onSelectCitation={setSelectedCitation} />,
        )}
        {isAsking && <div className="message assistant-message"><div className="answer loading-answer"><span /><span /><span />正在检索知识库并生成回答…</div></div>}
        {error && <p className="request-error" role="alert">{error}</p>}
        <div className="composer"><textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={handleComposerKeyDown} disabled={isAsking} placeholder="输入问题，或使用 / 选择指令" rows={2} /><div className="composer-footer"><div className="prompt-tools"><button type="button">/ 指令</button><button type="button">@ 知识库</button><button type="button"># 笔记</button></div><div><button type="button" className="send-mode">Enter 发送 <ChevronDown size={14} /></button><button type="button" className="send" onClick={() => void submitQuestion()} disabled={isAsking || !question.trim()} aria-label="发送问题"><Send size={18} /></button></div></div></div><p className="disclaimer">内容由 AI 生成，请参考原文</p>
      </div></div>
    </section>

    {selectedCitation && <CitationDrawer citation={selectedCitation} onClose={() => setSelectedCitation(null)} />}
  </main>
}

function AssistantMessage({ message, onSelectCitation }: { message: Extract<Message, { role: 'assistant' }>; onSelectCitation: (citation: Citation) => void }) {
  return <div className="message assistant-message"><div><div className="answer">{message.content.split(/\n{2,}/).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
    {message.citations.length > 0 && <><div className="source-label">引用来源（{message.citations.length}）</div><div className="source-list">{message.citations.map((citation, index) => <button type="button" onClick={() => onSelectCitation(citation)} className="source-chip" key={citation.chunkId}><span>{index + 1}</span>{citation.title} {citation.chapter}</button>)}</div></>}
    <div className="answer-actions"><button type="button"><Bot size={17} />继续追问</button><button type="button"><FileText size={17} />生成摘要</button><button type="button"><BookOpen size={17} />加入笔记</button><button type="button"><MoreHorizontal size={18} /></button></div>
  </div></div>
}

function CitationDrawer({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  return <aside className="source-drawer"><header><strong>引用来源</strong><button className="icon-button" onClick={onClose} aria-label="关闭引用来源"><X size={20} /></button></header><article className="source-detail"><h2>{citation.title}</h2><p className="chapter">{citation.chapter}</p><hr /><h3>原文</h3><p>{citation.content}</p><h3>元数据</h3><dl><dt>作者</dt><dd>{citation.author ?? '未标注'}</dd><dt>版本</dt><dd>{citation.version ?? '未标注'}</dd><dt>类型</dt><dd>{citation.category || citation.type}</dd><dt>来源</dt><dd>{citation.source || '未标注'}</dd></dl><button type="button" className="view-document">在知识库中查看文档 <ChevronRight size={17} /></button></article></aside>
}

export default App
