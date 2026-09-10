import {
  Bot,
  Library,
  LogOut,
  MessageSquarePlus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Sparkles,
  Sun,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import type { ConversationSummary } from '../../types/conversation';
import type { Module, Theme } from '../../types/ui';
import type { SafeUser } from '../../features/auth/types';
import { ConversationContextMenu, ConversationMenu } from '../../features/chat/components/ConversationMenu';

const navigation: Array<[Module, typeof Bot]> = [
  ['对话', MessageSquarePlus],
  ['知识库', Library],
  ['能力', Wrench],
];

export function Sidebar(props: {
  appName: string;
  avatarInitial: string;
  activeModule: Module;
  conversations: ConversationSummary[];
  currentConversationId: string | null;
  onSelectModule: (module: Module) => void;
  onNewChat: () => void;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onRenameConversation: (id: string, currentTitle: string) => void;
  theme: Theme;
  onToggleTheme: () => void;
  currentUser: SafeUser | null;
  onLogout: () => void;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
  /** 桌面 sidebar 折叠状态；移动端 drawer 不受其影响。 */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const {
    appName,
    avatarInitial,
    activeModule,
    conversations,
    currentConversationId,
    onSelectModule,
    onNewChat,
    onOpenConversation,
    onDeleteConversation,
    onRenameConversation,
    theme,
    onToggleTheme,
    currentUser,
    onLogout,
    mobileOpen = false,
    onCloseMobile,
    collapsed = false,
    onToggleCollapsed,
  } = props;

  // mobileOpen 仅会在窄屏抽屉打开时为 true。此时必须完整展示侧栏内容，
  // 不能让桌面持久化的折叠状态把抽屉误渲染成 64px 图标栏。
  const displayCollapsed = collapsed && !mobileOpen;

  return (
    <aside
      className={cn(
        'flex flex-col shrink-0 h-full overflow-hidden bg-app-sidebar border-r border-app-border transition-[flex-basis] duration-200 ease-out motion-reduce:transition-none',
        // 桌面折叠 / 展开两种宽度。≤760px 时桌面宽度被 max-[760px]:basis-[240px] 完全覆盖，
        // 由 mobileOpen 控制 drawer 行为，确保移动端体验与折叠状态完全解耦。
        displayCollapsed
          ? 'basis-[64px] min-w-[64px] max-[760px]:basis-[240px] max-[760px]:min-w-[240px]'
          : 'basis-[260px] min-w-0 max-[900px]:basis-[240px]',
        'max-[760px]:fixed max-[760px]:inset-y-0 max-[760px]:left-0 max-[760px]:z-50 max-[760px]:w-[280px] max-[760px]:basis-auto max-[760px]:shadow-2xl max-[760px]:transition-transform max-[760px]:duration-200',
        mobileOpen ? 'max-[760px]:translate-x-0' : 'max-[760px]:-translate-x-full',
      )}
      aria-label="侧边导航"
      data-collapsed={displayCollapsed ? 'true' : undefined}
    >
      <div className={cn('shrink-0 flex items-center gap-1.5', displayCollapsed ? 'justify-center px-1' : 'px-3', 'pt-3 pb-2')}>
        {displayCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="展开 sidebar"
            title="展开 sidebar"
            className="grid place-items-center w-9 h-9 rounded-lg bg-app-text text-app-sidebar transition-opacity duration-150 hover:opacity-90 focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus-ring"
            style={{ outlineOffset: 2 }}
          >
            <PanelLeftOpen size={16} strokeWidth={1.9} aria-hidden />
          </button>
        ) : (
          <>
            <div className="flex items-center gap-2.5 min-w-0 text-[14px] font-semibold tracking-[-0.01em] text-app-text">
              <span className="grid place-items-center w-8 h-8 shrink-0 rounded-lg bg-app-text text-app-sidebar">
                <Sparkles size={16} strokeWidth={2.1} />
              </span>
              <span className="truncate">{appName}</span>
            </div>
            <div className="ml-auto flex items-center gap-1">
              {onToggleCollapsed && (
                <button
                  type="button"
                  onClick={onToggleCollapsed}
                  aria-label="折叠 sidebar"
                  title="折叠 sidebar"
                  className="hidden md:grid place-items-center w-9 h-9 text-app-muted bg-transparent border-0 rounded-lg transition-colors duration-150 hover:text-app-text hover:bg-app-hover focus-visible:text-app-text focus-visible:bg-app-hover"
                >
                  <PanelLeftClose size={16} strokeWidth={1.9} aria-hidden />
                </button>
              )}
              {onCloseMobile && (
                <button
                  type="button"
                  className="hidden max-[760px]:grid place-items-center w-8 h-8 text-app-muted bg-transparent border-0 rounded-lg hover:text-app-text hover:bg-app-hover"
                  onClick={onCloseMobile}
                  aria-label="关闭 sidebar"
                  title="关闭 sidebar"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <nav
        className={cn(
          'grid gap-0.5 shrink-0 pb-2',
          displayCollapsed ? 'md:px-1 px-2' : 'px-2',
        )}
        aria-label="主功能"
      >
        {navigation.map(([name, Icon]) => (
          <button
            key={name}
            title={name}
            aria-label={name}
            className={cn(
              'flex items-center min-h-10 py-2 text-[14px] text-app-muted bg-transparent border-0 rounded-lg text-left transition-colors duration-150 hover:bg-app-hover hover:text-app-text focus-visible:bg-app-hover',
              displayCollapsed ? 'md:justify-center md:w-10 md:h-10 md:mx-auto md:px-0' : 'gap-3 px-3',
              activeModule === name && 'text-app-text bg-app-hover font-medium',
            )}
            onClick={() => onSelectModule(name)}
          >
            <Icon size={17} strokeWidth={1.9} aria-hidden />
            {!displayCollapsed && <span className="truncate">{name}</span>}
          </button>
        ))}
      </nav>

      <div className={cn('shrink-0 pb-3', displayCollapsed ? 'md:px-1 px-2' : 'px-2')}>
        <button
          title="新建对话"
          aria-label="新建对话"
          className={cn(
            'flex items-center w-full min-h-10 py-2 text-[14px] text-app-text bg-transparent border-0 rounded-lg transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover',
            displayCollapsed ? 'md:justify-center md:w-10 md:h-10 md:mx-auto md:px-0' : 'gap-3 px-3',
          )}
          onClick={onNewChat}
        >
          <Plus size={17} strokeWidth={1.9} aria-hidden />
          {!displayCollapsed && <span className="truncate">新建对话</span>}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto app-scroll">
        <ConversationList
          conversations={conversations}
          currentConversationId={currentConversationId}
          onOpenConversation={onOpenConversation}
          onDeleteConversation={onDeleteConversation}
          onRenameConversation={onRenameConversation}
          collapsed={displayCollapsed}
        />
      </div>

      <div className={cn('shrink-0 flex items-center gap-2 p-2', displayCollapsed && 'md:flex-col md:gap-1')}>
        <div className={cn(
          'flex items-center gap-2.5 min-w-0 rounded-lg px-1',
          displayCollapsed && 'md:justify-center md:px-0',
        )}>
          <span className="grid place-items-center w-8 h-8 shrink-0 rounded-full text-app-sidebar bg-app-text text-[13px] font-semibold">
            {currentUser?.username?.slice(0, 1)?.toUpperCase() ?? avatarInitial}
          </span>
          {currentUser && !displayCollapsed && (
            <span
              className="truncate text-[13px] text-app-text"
              title={currentUser.username}
              data-testid="current-user"
            >
              {currentUser.username}
            </span>
          )}
        </div>
        <div className={cn('flex items-center gap-0.5', displayCollapsed && 'md:flex-col md:gap-1 md:w-full')}>
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
            title="切换主题"
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
  onRenameConversation,
  collapsed,
}: {
  conversations: ConversationSummary[];
  currentConversationId: string | null;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onRenameConversation: (id: string, currentTitle: string) => void;
  collapsed: boolean;
}) {
  // 会话名称没有对应的紧凑图标；桌面折叠时不渲染，避免标题挤入 64px 栏。
  // 窄屏 drawer 会通过 displayCollapsed=false 传入，因此仍完整展示。
  if (collapsed) return null;

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
              <li key={conv.id} className="relative min-w-0 group">
                <ConversationContextMenu
                  onRename={() => onRenameConversation(conv.id, conv.title)}
                  onDelete={() => onDeleteConversation(conv.id)}
                >
                  <div
                    className={cn(
                      'flex items-center w-full min-w-0 rounded-lg transition-colors duration-150 hover:bg-app-hover',
                      isActive && 'bg-app-hover',
                    )}
                  >
                    <button
                      className={cn(
                        'flex-1 min-w-0 text-left min-h-10 py-2 text-[14px] text-app-text bg-transparent border-0 truncate',
                        'pl-3 pr-1',
                      )}
                      onClick={() => onOpenConversation(conv.id)}
                      title={conv.title}
                    >
                      {conv.title}
                    </button>
                    <ConversationMenu
                      conversation={conv}
                      onRename={() => onRenameConversation(conv.id, conv.title)}
                      onDelete={() => onDeleteConversation(conv.id)}
                    />
                  </div>
                </ConversationContextMenu>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
