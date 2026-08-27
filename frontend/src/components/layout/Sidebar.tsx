import {
  Bot,
  Library,
  LogOut,
  MessageSquarePlus,
  Moon,
  Plus,
  Sparkles,
  Sun,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import type { KnowledgeBase } from '../../lib/api';
import { cn } from '../../lib/cn';
import type { ConversationSummary } from '../../types/conversation';
import type { Module, Theme } from '../../types/ui';
import type { SafeUser } from '../../features/auth/types';

const navigation: Array<[Module, typeof Bot]> = [
  ['对话', MessageSquarePlus],
  ['知识库', Library],
  ['能力', Wrench],
];

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
  currentUser: SafeUser | null;
  onLogout: () => void;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}) {
  const {
    appName,
    avatarInitial,
    activeModule,
    knowledgeBases,
    selectedKnowledgeBaseId,
    conversations,
    currentConversationId,
    onSelectModule,
    onSelectKnowledgeBase,
    onNewChat,
    onOpenConversation,
    onDeleteConversation,
    onNewKnowledgeBase,
    theme,
    onToggleTheme,
    currentUser,
    onLogout,
    mobileOpen = false,
    onCloseMobile,
  } = props;

  const isChat = activeModule === '对话';

  return (
    <aside
      className={cn(
        'flex shrink-0 basis-[260px] min-w-0 flex-col h-full overflow-hidden bg-app-sidebar max-[900px]:basis-[240px]',
        'max-[760px]:fixed max-[760px]:inset-y-0 max-[760px]:left-0 max-[760px]:z-50 max-[760px]:w-[280px] max-[760px]:basis-auto max-[760px]:shadow-2xl max-[760px]:transition-transform max-[760px]:duration-200',
        mobileOpen ? 'max-[760px]:translate-x-0' : 'max-[760px]:-translate-x-full',
      )}
      aria-label="侧边导航"
    >
      <div className="shrink-0 px-3 pt-3 pb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0 text-[14px] font-semibold tracking-[-0.01em] text-app-text">
          <span className="grid place-items-center w-8 h-8 shrink-0 rounded-lg bg-app-text text-app-sidebar">
            <Sparkles size={16} strokeWidth={2.1} />
          </span>
          <span className="truncate">{appName}</span>
        </div>
        {onCloseMobile && (
          <button
            type="button"
            className="hidden max-[760px]:grid place-items-center w-8 h-8 text-app-muted bg-transparent border-0 rounded-lg hover:text-app-text hover:bg-app-hover"
            onClick={onCloseMobile}
            aria-label="关闭侧边栏"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <nav className="grid gap-0.5 shrink-0 px-2 pb-2" aria-label="主功能">
        {navigation.map(([name, Icon]) => (
          <button
            key={name}
            className={cn(
              'flex items-center gap-3 min-h-10 py-2 px-3 text-[14px] text-app-muted bg-transparent border-0 rounded-lg text-left transition-colors duration-150 hover:bg-app-hover hover:text-app-text focus-visible:bg-app-hover',
              activeModule === name && 'text-app-text bg-app-hover font-medium',
            )}
            onClick={() => onSelectModule(name)}
          >
            <Icon size={17} strokeWidth={1.9} />
            {name}
          </button>
        ))}
      </nav>

      <div className="shrink-0 px-2 pb-3">
        {isChat ? (
          <button
            className="flex items-center gap-3 w-full min-h-10 py-2 px-3 text-[14px] text-app-text bg-transparent border-0 rounded-lg transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover"
            onClick={onNewChat}
          >
            <Plus size={17} strokeWidth={1.9} />
            新建对话
          </button>
        ) : activeModule === '知识库' ? (
          <button
            className="flex items-center gap-3 w-full min-h-10 py-2 px-3 text-[14px] text-app-text bg-transparent border-0 rounded-lg transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover"
            onClick={onNewKnowledgeBase}
          >
            <Plus size={17} strokeWidth={1.9} />
            新建知识库
          </button>
        ) : null}
      </div>

      <div className={cn('flex-1 min-h-0', activeModule === '能力' ? 'overflow-hidden' : 'overflow-y-auto app-scroll')}>
        {isChat && (
          <ConversationList
            conversations={conversations}
            currentConversationId={currentConversationId}
            onOpenConversation={onOpenConversation}
            onDeleteConversation={onDeleteConversation}
          />
        )}
        {activeModule === '知识库' && (
          <KnowledgeBaseList
            knowledgeBases={knowledgeBases}
            selectedKnowledgeBaseId={selectedKnowledgeBaseId}
            onSelectKnowledgeBase={onSelectKnowledgeBase}
          />
        )}
        {activeModule === '能力' && (
          <div id="capability-agent-rail" className="h-full min-h-0" />
        )}
      </div>

      <div className="shrink-0 flex items-center justify-between gap-2 p-2">
        <div className="flex items-center gap-2.5 min-w-0 rounded-lg px-1">
          <span className="grid place-items-center w-8 h-8 shrink-0 rounded-full text-app-sidebar bg-app-text text-[13px] font-semibold">
            {currentUser?.username?.slice(0, 1)?.toUpperCase() ?? avatarInitial}
          </span>
          {currentUser && (
            <span
              className="truncate text-[13px] text-app-text"
              title={currentUser.username}
              data-testid="current-user"
            >
              {currentUser.username}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {currentUser && (
            <button
              type="button"
              className="grid place-items-center w-9 h-9 text-app-muted bg-transparent border-0 rounded-lg transition-colors duration-150 hover:text-app-text hover:bg-app-hover focus-visible:text-app-text focus-visible:bg-app-hover"
              onClick={onLogout}
              aria-label="退出登录"
              title="退出登录"
              data-testid="logout-button"
            >
              <LogOut size={16} />
            </button>
          )}
          <button
            className="grid place-items-center w-9 h-9 text-app-muted bg-transparent border-0 rounded-lg transition-colors duration-150 hover:text-app-text hover:bg-app-hover focus-visible:text-app-text focus-visible:bg-app-hover"
            onClick={onToggleTheme}
            aria-label="切换主题"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </div>
    </aside>
  );
}

function ConversationList({
  conversations,
  currentConversationId,
  onOpenConversation,
  onDeleteConversation,
}: {
  conversations: ConversationSummary[];
  currentConversationId: string | null;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
}) {
  return (
    <section className="px-2 pb-4">
      <p className="mx-3 mb-2 mt-1 text-app-muted text-[12px] font-medium">
        最近对话
      </p>
      {conversations.length === 0 ? (
        <p className="mx-3 my-2 text-app-muted text-[13px]">暂无已保存的对话</p>
      ) : (
        <ul className="m-0 p-0 list-none grid gap-0.5">
          {conversations.map((conv) => {
            const isActive = currentConversationId === conv.id;
            return (
              <li key={conv.id} className="relative group">
                <button
                  className={cn(
                    'flex items-center w-full min-w-0 min-h-10 py-2 pl-3 pr-10 text-app-text bg-transparent border-0 rounded-lg text-left transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover',
                    isActive && 'bg-app-hover',
                  )}
                  onClick={() => onOpenConversation(conv.id)}
                >
                  <span className="min-w-0 text-[14px] truncate">{conv.title}</span>
                </button>
                <button
                  className="absolute right-1 top-1/2 -translate-y-1/2 grid place-items-center w-8 h-8 text-app-muted bg-app-hover border-0 rounded-md opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-app-danger focus-visible:opacity-100 focus-visible:text-app-danger"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteConversation(conv.id);
                  }}
                  aria-label={`删除 ${conv.title}`}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function KnowledgeBaseList({
  knowledgeBases,
  selectedKnowledgeBaseId,
  onSelectKnowledgeBase,
}: {
  knowledgeBases: KnowledgeBase[];
  selectedKnowledgeBaseId: string | null;
  onSelectKnowledgeBase: (id: string) => void;
}) {
  return (
    <section className="px-2 pb-4">
      <p className="mx-3 mb-2 mt-1 text-app-muted text-[12px] font-medium">
        知识库
      </p>
      {knowledgeBases.length === 0 ? (
        <p className="mx-3 my-2 text-app-muted text-[13px]">还没有知识库</p>
      ) : (
        <ul className="m-0 p-0 list-none grid gap-0.5">
          {knowledgeBases.map((item) => (
            <li key={item.id}>
              <button
                className={cn(
                  'flex items-center gap-3 w-full min-h-12 py-2 px-3 text-app-text bg-transparent border-0 rounded-lg text-left transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover',
                  selectedKnowledgeBaseId === item.id && 'bg-app-hover',
                )}
                onClick={() => onSelectKnowledgeBase(item.id)}
              >
                <Library size={16} className="shrink-0 text-app-muted" />
                <span className="grid gap-0.5 min-w-0">
                  <strong className="text-[14px] truncate font-medium">{item.name}</strong>
                  <small className="text-app-muted text-[12px] truncate">{item.documentCount} 个文档</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
