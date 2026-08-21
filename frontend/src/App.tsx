import { useState } from 'react'
import { Bot, BookOpen, ChevronDown, ChevronRight, CircleHelp, FileText, Library, Menu, MoreHorizontal, Plus, Send, Settings, Sparkles, Sun, Moon, X } from 'lucide-react'
import './App.css'

type Theme = 'light' | 'dark'

const conversations = [['炼精化气是什么意思？', '刚刚'], ['金丹体系梳理', '昨天'], ['抱朴子核心观点', '2天前'], ['道教内丹修炼次序', '5天前']]
const sources = [
  { id: 1, title: '《道德经》', detail: '第 31 章', quote: '夫佳兵者，不祥之器，物或恶之，故有道者不处。' },
  { id: 2, title: '《悟真篇》', detail: '卷上', quote: '药物生玄窍，火候发阳炉。' },
  { id: 3, title: '《抱朴子内篇》', detail: '卷三', quote: '夫道也者，所以保精、养神、延年、益寿。' },
  { id: 4, title: '《性命圭旨》', detail: '卷一', quote: '性命之道，贵在返本还原。' },
]

function App() {
  const [theme, setTheme] = useState<Theme>('dark')
  const [drawer, setDrawer] = useState<number | null>(null)
  const [activeNav, setActiveNav] = useState('对话')
  const selected = sources.find((source) => source.id === drawer)

  return <main className={`app ${theme}`}>
    <aside className="rail" aria-label="主导航">
      <div className="brand"><Sparkles size={23} /><span>玄枢</span></div>
      <nav>{[['对话', Bot], ['知识库', Library], ['Agent', Sparkles], ['设置', Settings]].map(([name, Icon]) => <button key={name as string} className={activeNav === name ? 'nav-item active' : 'nav-item'} onClick={() => setActiveNav(name as string)}><Icon size={21} /><span>{name as string}</span></button>)}</nav>
      <div className="rail-bottom"><span className="avatar">玄</span><button className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="切换主题">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button></div>
    </aside>
    <aside className="conversation-panel">
      <button className="new-chat"><Plus size={18} />新建对话 <kbd>⌘K</kbd></button>
      <section><p className="side-heading"><CircleHelp size={15} />最近对话</p><div className="conversation-list">{conversations.map(([title, time], index) => <button className={index === 0 ? 'conversation selected' : 'conversation'} key={title}><span>{title}</span><small>{time}</small></button>)}</div><button className="all-chats">查看全部对话 <ChevronRight size={16} /></button></section>
      <div className="side-divider" /><section className="knowledge-section"><div className="side-heading">当前知识库 <button aria-label="添加知识库"><Plus size={17} /></button></div><button className="knowledge-card"><span className="book-icon"><Library size={21} /></span><span><strong>道教经典</strong><small>4 个文档 · 2.1 万条片段</small></span><MoreHorizontal size={18} /></button></section>
    </aside>
    <section className="workspace">
      <header className="topbar"><div className="mobile-menu"><Menu size={20} /></div><div className="top-controls"><label>智能体 <button>知识问答 Agent <ChevronDown size={15} /></button></label><label>模型 <button>DeepSeek-R1 32K <ChevronDown size={15} /></button></label><button className="settings-button"><Settings size={17} />设置</button></div></header>
      <div className="chat-scroll"><div className="chat-content"><h1>知识问答</h1>
        <div className="message user-message"><div><p>炼精化气是什么意思？</p></div></div>
        <div className="message assistant-message"><div><div className="answer"><p>“炼精化气”是道家内丹修炼中的一个重要阶段，属于炼精化气、炼气化神、炼神还虚、炼虚合道的四大阶段之首。</p><p>其意并非指将精在物理层面直接转化为气，而是通过调息、存思、导引等修炼方法，使身体的精微物质得以升华，转化为更为轻盈、活泼的气。</p><p>这里的“精”既指先天之精，也包括后天通过调摄积累的精微物质；“气”则是生命活动的基本动力。精和气的关系在于守精不泄、积精成聚，并借助心神的专注与内炼，使之在体内运行不息。</p><p>此过程强调涵养精气、持之以恒，并非一蹴而就，而是身心合一、顺应自然规律的内在修养。</p></div>
          <div className="source-label">引用来源（4）</div><div className="source-list">{sources.map((source) => <button onClick={() => setDrawer(source.id)} className={drawer === source.id ? 'source-chip active' : 'source-chip'} key={source.id}><span>{source.id}</span>{source.title} {source.detail}</button>)}</div>
          <div className="answer-actions"><button><Bot size={17} />继续追问</button><button><FileText size={17} />生成摘要</button><button><BookOpen size={17} />加入笔记</button><button><MoreHorizontal size={18} /></button></div>
        </div></div>
        <div className="composer"><textarea placeholder="输入问题，或使用 / 选择指令" rows={2} /><div className="composer-footer"><div className="prompt-tools"><button>/ 指令</button><button>@ 知识库</button><button># 笔记</button></div><div><button className="send-mode">Enter 发送 <ChevronDown size={14} /></button><button className="send"><Send size={18} /></button></div></div></div><p className="disclaimer">内容由 AI 生成，请参考原文</p>
      </div></div>
    </section>
    {selected && <aside className="source-drawer"><header><strong>引用来源</strong><button className="icon-button" onClick={() => setDrawer(null)} aria-label="关闭引用来源"><X size={20} /></button></header><article className="source-detail"><h2>{selected.title}</h2><p className="chapter">{selected.detail}</p><hr /><h3>原文</h3><p>{selected.quote}</p><p>君子居则贵左，用兵则贵右。兵者，不祥之器，非君子之器，不得已而用之。</p><h3>选中段落</h3><blockquote>{selected.quote}</blockquote><h3>元数据</h3><dl><dt>作者</dt><dd>老子</dd><dt>类型</dt><dd>道家经典</dd><dt>来源</dt><dd>道教经典 知识库</dd><dt>文档</dt><dd>daodejing.txt</dd></dl><button className="view-document">在知识库中查看文档 <ChevronRight size={17} /></button></article></aside>}
  </main>
}

export default App
