import { Bot, CircleHelp, Library, Moon, Plus, Sparkles, Sun, Trash2, Wrench } from 'lucide-react';
import type { KnowledgeBase } from '../../lib/api';
import { cn } from '../../lib/cn';
import type { ConversationSummary } from '../../types/conversation';
import type { Module, Theme } from '../../types/ui';

const navigation: Array<[Module, typeof Bot]> = [['对话', Bot], ['知识库', Library], ['能力', Wrench]];

export function Sidebar(props: {
  appName: string;
  avatarInitial: string;
  activeModule: Module;
  knowledgeBases: KnowledgeBase[];
  selectedKnowledgeBaseId: string | null;
  conversations: ConversationSummary[];
  currentConversationId: string | null;
  onSelectModule: (module: Module) => void;
  onSelectKnowledgeBase: (id: string) => void;
  onNewChat: () => void;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onNewKnowledgeBase: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const { appName, avatarInitial, activeModule, knowledgeBases, selectedKnowledgeBaseId, conversations, currentConversationId, onSelectModule, onSelectKnowledgeBase, onNewChat, onOpenConversation, onDeleteConversation, onNewKnowledgeBase, theme, onToggleTheme } = props;
  return <aside className="flex shrink-0 basis-[272px] min-w-0 flex-col h-full overflow-hidden border-r border-app-border bg-app-surface max-[900px]:basis-[230px]">
    <div className="shrink-0 px-4 pt-5 pb-3.5">
      <div className="flex items-center gap-2 px-1 pb-5 text-xl font-bold tracking-wider"><Sparkles size={22} /><span>{appName}</span></div>
      {activeModule === '对话' && <button className="flex items-center justify-center gap-2 w-full py-2.5 text-app-text bg-transparent border border-app-border-strong rounded-lg hover:bg-app-surface-muted" onClick={onNewChat}><Plus size={17} />新建对话</button>}
      {activeModule === '知识库' && <button className="flex items-center justify-center gap-2 w-full py-2.5 text-app-text bg-transparent border border-app-border-strong rounded-lg hover:bg-app-surface-muted" onClick={onNewKnowledgeBase}><Plus size={17} />新建知识库</button>}
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
      {activeModule === '对话' && <section><p className="flex items-center gap-2 mx-2 my-2.5 text-app-muted text-[13px]"><CircleHelp size={15} />最近对话</p>{conversations.length === 0 ? <p className="m-2 text-app-muted text-xs">暂无已保存的对话</p> : <div className="grid gap-0.5">{conversations.map((conv) => <div key={conv.id} className="flex items-center gap-0.5"><button className={cn('flex items-center gap-2.5 flex-1 py-2.5 px-2 text-app-text bg-transparent border-0 rounded-md text-left hover:bg-app-surface-muted', currentConversationId === conv.id && 'bg-app-surface-muted')} onClick={() => onOpenConversation(conv.id)}><Bot size={17} /><span className="grid gap-1 min-w-0"><strong className="text-sm truncate">{conv.title}</strong><small className="text-app-muted text-xs">{conv.knowledgeBaseName ? `知识库：${conv.knowledgeBaseName}` : conv.agentId === 'general-chat' ? '通用对话' : '知识库问答'}</small></span></button><button className="grid place-items-center p-1 text-app-muted bg-transparent border-0 rounded-md hover:text-app-text hover:bg-app-hover" onClick={(event) => { event.stopPropagation(); onDeleteConversation(conv.id); }} aria-label={`删除 ${conv.title}`}><Trash2 size={15} /></button></div>)}</div>}</section>}
      {activeModule === '知识库' && <section><p className="flex items-center gap-2 mx-2 my-2.5 text-app-muted text-[13px]"><Library size={15} />知识库</p><div className="grid gap-0.5">{knowledgeBases.length === 0 ? <p className="m-2 text-app-muted text-xs">还没有知识库</p> : knowledgeBases.map((item) => <button key={item.id} className={cn('flex items-center gap-2.5 w-full py-2.5 px-2 text-app-text bg-transparent border-0 rounded-md text-left hover:bg-app-surface-muted', selectedKnowledgeBaseId === item.id && 'bg-app-surface-muted')} onClick={() => onSelectKnowledgeBase(item.id)}><Library size={17} /><span className="grid gap-1 min-w-0"><strong className="text-sm truncate">{item.name}</strong><small className="text-app-muted text-xs">{item.documentCount} 个文档</small></span></button>)}</div></section>}
    </div>
    <nav className="grid grid-cols-4 gap-0.5 shrink-0 pt-2.5 px-3 border-t border-app-border">{navigation.map(([name, Icon]) => <button key={name} className={cn('grid place-items-center gap-1 py-2 px-0.5 text-app-muted bg-transparent border-0 rounded-md text-[11px] hover:bg-app-surface-muted', activeModule === name && 'text-app-text font-semibold bg-app-surface-muted')} onClick={() => onSelectModule(name)}><Icon size={19} /><span>{name}</span></button>)}</nav>
    <div className="flex items-center justify-between shrink-0 pt-2.5 px-4 pb-3.5"><span className="grid place-items-center w-8 h-8 rounded-full text-app-surface bg-app-text text-[13px] font-bold">{avatarInitial}</span><button className="grid place-items-center p-2 text-app-muted bg-transparent border-0 rounded-md hover:text-app-text hover:bg-app-hover" onClick={onToggleTheme} aria-label="切换主题">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button></div>
  </aside>;
}
