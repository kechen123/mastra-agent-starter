# Assistant-UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the xuanshu-agent frontend closer to the assistant-ui reference experience by adding a collapsible desktop sidebar, a Base UI menu / context menu for each conversation, and a Composer-level model selector — all while preserving PostgreSQL conversations, URL navigation, and SSE Run logic.

**Architecture:** Three orthogonal slices (A/B/C) layered onto existing components. State that crosses slice boundaries (e.g. `collapsed` toggling the brand header button vs. the chat header expand button) lives in `App.tsx` and is piped into the relevant components. All popup/overlay behaviour is delegated to Base UI primitives (`Menu`, `ContextMenu`, `Dialog`, `Select`) — no manual click-outside, document-level focus fixes, or absolute-positioned layers.

**Tech Stack:** React 19, TypeScript, Tailwind v4 (semantic tokens via `index.css`), `@assistant-ui/react@0.15.18`, `@base-ui/react@1.8.0` (`@base-ui/react/menu`, `@base-ui/react/context-menu`, `@base-ui/react/dialog`, `@base-ui/react/select`).

## Global Constraints

- Frontend-only changes; no backend / SQL / dependency / route / permission / menu changes.
- Sidebar collapse state key MUST be `xuanshu-agent.sidebar-collapsed`; on parse failure default to `false` (expanded).
- Keep `assistant-ui` owning Thread / Composer / Viewport; do **not** swap our server-backed `conversations` state for `ThreadListPrimitive`.
- Do **not** invent new model names, do **not** allow arbitrary model input; the Composer selector shows only `props.defaultChatModel` for now.
- Every new icon button MUST have `aria-label`, `title`, and a focus-visible style.
- Mobile drawer (≤ 760px) MUST keep its existing translate-based logic; desktop collapse must not block mobile drawer opening.
- Sidebar collapse MUST NOT crush Composer / Approvals / Citation panel — main chat column already lives in `<AssistantChatWorkspace />` which uses `flex-1 min-w-0`.
- Long conversation titles must truncate and must not produce a horizontal scrollbar.

---

## Task A1: Sidebar collapsed state plumbing

**Files:**
- Modify: `frontend/src/app/App.tsx:152-156` (add `sidebarCollapsed` state + localStorage sync)
- Modify: `frontend/src/components/layout/Sidebar.tsx:26-46` (props + className branch)

**Interfaces:**
- Consumes: `localStorage.getItem('xuanshu-agent.sidebar-collapsed')` returning `'true' | 'false' | null`.
- Produces: `<Sidebar collapsed?: boolean; onToggleCollapsed?: () => void; …>` (additive, optional so current callers still compile).

- [ ] **Step 1: Add state + persistence in `App.tsx`**

  Inside `App()` near the other `useState` calls (around line 153):
  ```tsx
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try { return window.localStorage.getItem('xuanshu-agent.sidebar-collapsed') === 'true' }
    catch { return false }
  })
  useEffect(() => {
    try { window.localStorage.setItem('xuanshu-agent.sidebar-collapsed', sidebarCollapsed ? 'true' : 'false') }
    catch { /* ignore */ }
  }, [sidebarCollapsed])
  const toggleSidebarCollapsed = useCallback(() => setSidebarCollapsed((v) => !v), [])
  ```

  Pass `collapsed={sidebarCollapsed}` and `onToggleCollapsed={toggleSidebarCollapsed}` into `<Sidebar />` (lines 957–977).

- [ ] **Step 2: Branch the `Sidebar` `aside` className**

  In `frontend/src/components/layout/Sidebar.tsx`, replace the `aside` className with:
  ```tsx
  cn(
    'flex shrink-0 h-full overflow-hidden bg-app-sidebar border-r border-app-border transition-[width,basis] duration-200',
    collapsed
      ? 'basis-[64px] min-w-[64px] max-[760px]:basis-[240px] max-[760px]:min-w-[240px]'
      : 'basis-[260px] min-w-0 max-[900px]:basis-[240px]',
    'max-[760px]:fixed max-[760px]:inset-y-0 max-[760px]:left-0 max-[760px]:z-50 max-[760px]:w-[280px] max-[760px]:basis-auto max-[760px]:shadow-2xl max-[760px]:transition-transform max-[760px]:duration-200',
    mobileOpen ? 'max-[760px]:translate-x-0' : 'max-[760px]:-translate-x-full',
  )
  ```

  Mobile (≤760px) is driven only by `mobileOpen`; desktop collapse (`basis-[64px]`) is bypassed on mobile so the drawer behaves exactly as before.

- [ ] **Step 3: Verify build/lint (Step A1 alone)**

  Run: `cd frontend && npm run lint && npm run build`
  Expected: no new errors; build succeeds.

---

## Task A2: Brand-area collapse button + collapsed-mode render

**Files:**
- Modify: `frontend/src/components/layout/Sidebar.tsx:80-113` (brand row + nav)

**Interfaces:**
- Consumes: `collapsed`, `onToggleCollapsed` props.
- Produces: an icon-only collapsed view that preserves nav buttons with `title` tooltips; on expand mode the existing text + collapse button render.

- [ ] **Step 1: Brand row renders either expand pill or brand+collapse button**

  Replace the existing `div className="shrink-0 px-3 pt-3 pb-2 …"` with:
  ```tsx
  <div className="shrink-0 flex items-center gap-1.5 px-2 pt-3 pb-2">
    {collapsed ? (
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label="展开 sidebar"
        title="展开 sidebar"
        className="grid place-items-center w-9 h-9 mx-auto rounded-lg bg-app-text text-app-surface transition-colors duration-150 hover:opacity-90 focus-visible:outline-2 focus-visible:outline focus-visible:outline-focus-ring"
        style={{ outlineOffset: 2 }}
      >
        <PanelLeftOpen size={16} />
      </button>
    ) : (
      <>
        <div className="flex items-center gap-2.5 min-w-0 text-[14px] font-semibold tracking-[-0.01em] text-app-text">
          <span className="grid place-items-center w-8 h-8 shrink-0 rounded-lg bg-app-text text-app-sidebar">
            <Sparkles size={16} strokeWidth={2.1} />
          </span>
          <span className="truncate">{appName}</span>
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="折叠 sidebar"
          title="折叠 sidebar"
          className="hidden md:grid place-items-center w-9 h-9 ml-auto text-app-muted bg-transparent border-0 rounded-lg transition-colors duration-150 hover:text-app-text hover:bg-app-hover focus-visible:text-app-text focus-visible:bg-app-hover"
        >
          <PanelLeftClose size={16} />
        </button>
        {onCloseMobile && (
          <button
            type="button"
            className="hidden max-[760px]:grid place-items-center w-8 h-8 text-app-muted bg-transparent border-0 rounded-lg hover:text-app-text hover:bg-app-hover"
            onClick={onCloseMobile}
            aria-label="关闭 sidebar"
          >
            <X size={16} />
          </button>
        )}
      </>
    )}
  </div>
  ```

  Add `PanelLeftClose, PanelLeftOpen` to the lucide-react import on line 1.

- [ ] **Step 2: Nav + secondary rows collapse to icons**

  In the nav (lines 99–113), when `collapsed` is true render only the icon, center it, and add `title={name}`:
  ```tsx
  <nav className={cn('grid gap-0.5 shrink-0 px-2 pb-2', collapsed && 'md:px-1')} aria-label="主功能">
    {navigation.map(([name, Icon]) => (
      <button
        key={name}
        title={name}
        className={cn(
          'flex items-center min-h-10 py-2 px-3 text-[14px] text-app-muted bg-transparent border-0 rounded-lg text-left transition-colors duration-150 hover:bg-app-hover hover:text-app-text focus-visible:bg-app-hover',
          collapsed ? 'md:justify-center md:px-0 md:w-10 md:mx-auto' : 'gap-3',
          activeModule === name && 'text-app-text bg-app-hover font-medium',
        )}
        onClick={() => onSelectModule(name)}
      >
        <Icon size={17} strokeWidth={1.9} />
        {!collapsed && <span className="truncate">{name}</span>}
      </button>
    ))}
  </nav>
  ```

  In the "+ 新建对话/知识库" button block (115–133), mirror the same `collapsed` branch — replace text with a centered Plus icon when `collapsed`, keeping the click target.

  In the footer user row (156–192), keep the logout / theme buttons always visible; hide username + avatar initial text when `collapsed`. Always keep the user area accessible.

- [ ] **Step 3: Update imports**

  Add `PanelLeftClose, PanelLeftOpen` from `lucide-react`.

- [ ] **Step 4: Verify**

  Run: `cd frontend && npm run lint && npm run build`
  Expected: success.

---

## Task A3: Main chat expand entry when collapsed

**Files:**
- Modify: `frontend/src/features/chat/components/AssistantChatWorkspace.tsx:28-56` (props)
- Modify: `frontend/src/features/chat/components/AssistantChatWorkspace.tsx:160-173` (header)

**Interfaces:**
- Consumes: `onExpandSidebar?: () => void` prop.
- Produces: a small icon button on the chat header (left side) shown only when `collapsed` is true.

- [ ] **Step 1: Add optional prop**

  Add to `AssistantChatWorkspaceProps`:
  ```tsx
  /** Desktop sidebar collapsed: render an expand entry in the chat header. */
  onExpandSidebar?: () => void;
  /** Desktop sidebar collapsed flag — needed to render the expand entry. */
  sidebarCollapsed?: boolean;
  ```

- [ ] **Step 2: Render expand button on chat header**

  In the `<header>` block (line 162), prepend:
  ```tsx
  {sidebarCollapsed && onExpandSidebar && (
    <button
      type="button"
      onClick={onExpandSidebar}
      aria-label="展开 sidebar"
      title="展开 sidebar"
      className="hidden md:grid place-items-center w-9 h-9 text-app-muted bg-transparent border-0 rounded-lg hover:text-app-text hover:bg-app-hover focus-visible:text-app-text focus-visible:bg-app-hover"
    >
      <PanelLeftOpen size={16} />
    </button>
  )}
  ```

  Import `PanelLeftOpen` from `lucide-react` at the top of the file (line 11).

- [ ] **Step 3: Wire prop in `App.tsx`**

  Pass `sidebarCollapsed={sidebarCollapsed}` and `onExpandSidebar={toggleSidebarCollapsed}` into the `<AssistantChatWorkspace />` invocation (lines 978–1000).

- [ ] **Step 4: Verify**

  Run: `cd frontend && npm run lint && npm run build`
  Expected: success.

---

## Task B1: ConversationMenu shared component

**Files:**
- Create: `frontend/src/features/chat/components/ConversationMenu.tsx`

**Interfaces:**
- Consumes: `{ conversation: ConversationSummary; onRename: () => void; onDelete: () => void; triggerClass?: string }`.
- Produces: a Base UI `Menu.Root` whose `Trigger` is a "more" icon button and which calls `onRename` / `onDelete` and closes via `Menu.Item`.

- [ ] **Step 1: Write the component**

  ```tsx
  /**
   * 会话操作菜单：Base UI Menu + ContextMenu 两个入口复用。
   * - More 按钮：Menu.Root 提供鼠标、键盘、Focus 操作；
   * - 右键/长按：ContextMenu.Root 提供鼠标右键触发；
   * - 两入口共享同一份 items（重命名、删除）；不允许添加无后端能力的菜单项。
   */
  import { Menu } from '@base-ui/react/menu';
  import { ContextMenu } from '@base-ui/react/context-menu';
  import { MoreHorizontal } from 'lucide-react';
  import type { ReactNode } from 'react';
  import type { ConversationSummary } from '../../../types/conversation';
  import { cn } from '../../../lib/cn';

  export interface ConversationMenuProps {
    conversation: ConversationSummary;
    onRename: () => void;
    onDelete: () => void;
    /** 触发按钮 className，便于父级定位。 */
    triggerClassName?: string;
    /** 外层 li 的 className。 */
    itemClassName?: string;
  }

  // 共享菜单项：避免在 Menu/ContextMenu 两处重复定义。
  function Items({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
    return (
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50">
          <Menu.Popup className="grid min-w-[160px] p-1 bg-app-surface border border-app-border rounded-lg shadow-2xl outline-none">
            <Menu.Item
              onClick={(event) => { event.preventDefault(); onRename(); }}
              className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-app-text rounded-md data-[highlighted]:bg-app-hover outline-none cursor-pointer"
            >
              重命名
            </Menu.Item>
            <Menu.Item
              onClick={(event) => { event.preventDefault(); onDelete(); }}
              className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-app-danger rounded-md data-[highlighted]:bg-app-danger/10 outline-none cursor-pointer"
            >
              删除
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    );
  }

  export function ConversationMenu({ conversation, onRename, onDelete, triggerClassName, itemClassName }: ConversationMenuProps): ReactNode {
    return (
      <div className={cn('relative min-w-0', itemClassName)}>
        <ContextMenu.Root>
          <ContextMenu.Trigger
            // ContextMenu.Trigger 默认监听右键；不阻止默认 click，避免与 Menu.Trigger 冲突。
            className="block w-full min-w-0"
          >
            <Menu.Root>
              <Menu.Trigger
                aria-label={`更多操作：${conversation.title}`}
                title="更多操作"
                className={cn(
                  'grid place-items-center w-8 h-8 text-app-muted bg-transparent border-0 rounded-md transition-colors duration-150',
                  'hover:text-app-text hover:bg-app-hover focus-visible:text-app-text focus-visible:bg-app-hover',
                  triggerClassName,
                )}
                // 阻止冒泡到外层“打开会话”按钮。
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal size={15} aria-hidden />
              </Menu.Trigger>
              <Items onRename={onRename} onDelete={onDelete} />
            </Menu.Root>
          </ContextMenu.Trigger>
          <Items onRename={onRename} onDelete={onDelete} />
        </ContextMenu.Root>
      </div>
    );
  }
  ```

- [ ] **Step 2: Verify build (component alone)**

  Run: `cd frontend && npm run lint && npm run build`
  Expected: success.

---

## Task B2: Rename dialog (Base UI Dialog)

**Files:**
- Create: `frontend/src/features/chat/components/RenameConversationDialog.tsx`

**Interfaces:**
- Consumes: `{ open: boolean; initialTitle: string; onCancel: () => void; onSubmit: (title: string) => Promise<void> | void }`.
- Produces: a controlled Dialog that trims input, blocks empty submissions, calls `onSubmit` and `onCancel`.

- [ ] **Step 1: Write the component**

  ```tsx
  /**
   * 重命名对话：Base UI Dialog。
   * - input 默认选中当前标题；空白标题不可提交；
   * - Escape / 外点关闭、焦点回归由 Dialog 处理；
   * - onSubmit 返回 Promise，提交期间禁用按钮避免重复提交。
   */
  import { Dialog } from '@base-ui/react/dialog';
  import { useEffect, useRef, useState } from 'react';
  import { cn } from '../../../lib/cn';

  export interface RenameConversationDialogProps {
    open: boolean;
    initialTitle: string;
    onCancel: () => void;
    onSubmit: (title: string) => Promise<void> | void;
  }

  export function RenameConversationDialog({ open, initialTitle, onCancel, onSubmit }: RenameConversationDialogProps) {
    const [value, setValue] = useState(initialTitle);
    const [busy, setBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    // 打开时重置 + 选中。
    useEffect(() => {
      if (!open) return;
      setValue(initialTitle);
      setBusy(false);
      const id = window.setTimeout(() => inputRef.current?.select(), 30);
      return () => window.clearTimeout(id);
    }, [open, initialTitle]);

    const trimmed = value.trim();
    const canSubmit = trimmed.length > 0 && !busy;

    async function handleSubmit() {
      if (!canSubmit) return;
      setBusy(true);
      try { await onSubmit(trimmed); }
      finally { setBusy(false); }
    }

    return (
      <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Popup
            className={cn(
              'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[min(420px,calc(100vw-32px))]',
              'p-5 bg-app-surface border border-app-border rounded-2xl shadow-2xl outline-none',
            )}
          >
            <Dialog.Title className="m-0 text-[15px] font-semibold">重命名对话</Dialog.Title>
            <Dialog.Description className="mt-1 mb-3 text-[12.5px] text-app-muted">
              修改对话标题。新标题会立即同步到侧边栏。
            </Dialog.Description>
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canSubmit) { event.preventDefault(); void handleSubmit(); }
              }}
              disabled={busy}
              aria-label="对话标题"
              className="w-full min-h-9 px-3 py-2 text-[14px] text-app-text bg-app-bg border border-app-border rounded-lg outline-none focus-visible:border-focus-border"
            />
            <div className="flex justify-end gap-2 mt-4">
              <Dialog.Close
                disabled={busy}
                className="inline-flex items-center justify-center min-h-9 px-3.5 text-[13px] text-app-text bg-transparent border border-app-border rounded-lg hover:bg-app-hover focus-visible:bg-app-hover disabled:opacity-50"
              >
                取消
              </Dialog.Close>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => void handleSubmit()}
                className="inline-flex items-center justify-center min-h-9 px-3.5 text-[13px] text-app-bg bg-app-text border-0 rounded-lg hover:opacity-90 disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
  ```

- [ ] **Step 2: Verify build (component alone)**

  Run: `cd frontend && npm run lint && npm run build`
  Expected: success.

---

## Task B3: Wire menu + rename into `Sidebar` + `App`

**Files:**
- Modify: `frontend/src/components/layout/Sidebar.tsx:26-46,197-247` (replace trash with menu; add `onRenameConversation` prop)
- Modify: `frontend/src/app/App.tsx` (state for rename dialog + `handleRenameConversation`)

**Interfaces:**
- Consumes: existing `onDeleteConversation`, new `onRenameConversation(id, title)`.
- Produces: `RenameConversationDialog` mounted in `App.tsx`; `ConversationMenu` rendered inside each conversation `<li>`.

- [ ] **Step 1: Extend Sidebar props**

  Add `onRenameConversation: (id: string, title: string) => void` to the `Sidebar` props and pass-through into `ConversationList`.

- [ ] **Step 2: Replace trash icon with `<ConversationMenu>` in the `<li>`**

  In `ConversationList` (lines 197–247), remove the standalone delete `<button>` and replace with `<ConversationMenu>`. Keep `<button>` for opening the conversation; the menu trigger sits inside the same `<li>`.

  ```tsx
  <li key={conv.id} className="relative min-w-0 group">
    <div className="flex items-center w-full min-w-0">
      <button
        className={cn(
          'flex-1 min-w-0 text-left min-h-10 py-2 pl-3 pr-1 text-[14px] text-app-text bg-transparent border-0 rounded-lg transition-colors duration-150 truncate hover:bg-app-hover focus-visible:bg-app-hover',
          isActive && 'bg-app-hover',
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
  </li>
  ```

  Import `ConversationMenu` at the top of `Sidebar.tsx`.

- [ ] **Step 3: Mount dialog and rename handler in App**

  In `App.tsx` near `confirmRequest`:
  ```tsx
  const [renameRequest, setRenameRequest] = useState<{ id: string; initialTitle: string } | null>(null)
  ```

  Add:
  ```tsx
  async function handleRenameConversation(id: string, title: string) {
    setRenameRequest({ id, initialTitle: title })
  }
  async function performRename(nextTitle: string) {
    const request = renameRequest
    if (!request) return
    try {
      const updated = await updateConversation(request.id, { title: nextTitle })
      setConversations((prev) => prev.map((c) => (c.id === updated.id ? { ...c, title: updated.title, updatedAt: updated.updatedAt } : c)))
      // 当前会话若是被改名的，要保证下一轮拉取使用新 updatedAt。
      if (conversationState.type === 'persisted' && conversationState.id === request.id) {
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
  ```

  Pass `onRenameConversation={handleRenameConversation}` to `<Sidebar />` (already wired through props) and mount `<RenameConversationDialog open={renameRequest !== null} initialTitle={renameRequest?.initialTitle ?? ''} onCancel={() => setRenameRequest(null)} onSubmit={performRename} />` next to the existing `<ConfirmDialog />` near line 1004.

- [ ] **Step 4: Verify**

  Run: `cd frontend && npm run lint && npm run build`
  Expected: success.

---

## Task C1: Composer ModelSelect component

**Files:**
- Create: `frontend/src/features/chat/components/ModelSelect.tsx`

**Interfaces:**
- Consumes: `{ defaultChatModel: string; llmDisplayName?: string }`.
- Produces: a Base UI `Select.Root` with a single option derived from `defaultChatModel`; `onValueChange` is intentionally a no-op stub (extensibility hook only).

- [ ] **Step 1: Write the component**

  ```tsx
  /**
   * Composer 模型入口：基于 @base-ui/react Select。
   *
   * 设计要点：
   *   - 当前只有一个可用模型（props.defaultChatModel），后端不允许切换；
   *   - 选项只是 props 的回显，不写后端、不伪造切换状态；
   *   - props.onChange 留作未来服务端白名单提供多个模型时挂接的扩展点；
   *   - 视觉与 AgentSelect / KnowledgeBasePicker 一致（按钮 + ChevronDown）。
   */
  import { Select } from '@base-ui/react/select';
  import { Check, ChevronDown, Cpu } from 'lucide-react';
  import { cn } from '../../../lib/cn';

  export interface ModelOption {
    /** 传给后端的稳定 id（与 capabilities.defaultChatModel 字符串一致）。 */
    id: string;
    /** 触发器显示文案。 */
    label: string;
    /** 列表项副标题，可选。 */
    description?: string;
  }

  export interface ModelSelectProps {
    defaultChatModel: string;
    llmDisplayName?: string;
    /** 仅扩展点：当前默认模型下不会调用。 */
    onChange?: (modelId: string) => void;
    ariaLabel?: string;
  }

  function buildOptions(defaultChatModel: string, llmDisplayName: string | undefined): ModelOption[] {
    return [{ id: defaultChatModel, label: llmDisplayName ?? defaultChatModel }];
  }

  export function ModelSelect({ defaultChatModel, llmDisplayName, onChange, ariaLabel = '选择模型' }: ModelSelectProps) {
    const options = buildOptions(defaultChatModel, llmDisplayName);
    return (
      <Select.Root value={defaultChatModel} onValueChange={(next) => { onChange?.(String(next ?? defaultChatModel)); }}>
        <Select.Trigger
          aria-label={ariaLabel}
          className={cn(
            'inline-flex items-center gap-1.5 min-h-9 py-1.5 px-3 text-[13px] text-app-muted bg-transparent border-0 rounded-full',
            'transition-colors duration-150 hover:text-app-text hover:bg-app-hover',
            'focus-visible:bg-app-hover data-[popup-open]:bg-app-hover data-[popup-open]:text-app-text',
          )}
        >
          <Cpu size={13} aria-hidden />
          <Select.Value>{options[0]?.label}</Select.Value>
          <Select.Icon>
            <ChevronDown size={13} className="shrink-0 pointer-events-none text-app-muted" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner sideOffset={6} align="start" className="z-30">
            <Select.Popup className="grid min-w-[var(--anchor-width)] max-w-[280px] p-1.5 bg-app-surface border border-app-border rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.28)] outline-none">
              {options.map((option) => (
                <Select.Item
                  key={option.id}
                  value={option.id}
                  className="flex items-center justify-between gap-3 min-h-10 py-2 px-3 text-[13.5px] text-app-text rounded-lg cursor-pointer data-[highlighted]:bg-app-hover outline-none"
                >
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={14} className="text-app-muted" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    );
  }
  ```

- [ ] **Step 2: Verify build (component alone)**

  Run: `cd frontend && npm run lint && npm run build`
  Expected: success.

---

## Task C2: Place ModelSelect in Composer

**Files:**
- Modify: `frontend/src/features/chat/components/AssistantChatWorkspace.tsx:128-137,297-302` (add prop, render into composer)

**Interfaces:**
- Consumes: `llmDisplayName?: string` (new optional prop) — when present, displayed as the option label.
- Produces: `<ModelSelect />` rendered next to `<KnowledgeBasePicker />` in the Composer bottom row.

- [ ] **Step 1: Add `llmDisplayName` to `AssistantChatWorkspaceProps`**

  ```tsx
  /** Capabilities.llm.displayName (例如 "DeepSeek")，缺省回退 defaultChatModel。 */
  llmDisplayName?: string;
  ```

- [ ] **Step 2: Destructure in `ThreadView`**

  Add `llmDisplayName` to the destructure of `props` (line 118-137) and reference it in the composer row.

- [ ] **Step 3: Replace the existing `defaultChatModel` `<span>` in the header**

  The current text render (lines 170-172) is moved into the Composer so the header gets the new expand button alone. Replace with the empty fragment so the header is just `<AgentSelect />` + (optionally) the expand button.

- [ ] **Step 4: Render `<ModelSelect>` in Composer bottom row**

  In the bottom row (lines 297-302):
  ```tsx
  <div className="flex items-center gap-1.5">
    <KnowledgeBasePicker ... />
    <ModelSelect defaultChatModel={defaultChatModel} llmDisplayName={llmDisplayName} />
    {/* 发送 / 停止按钮不变 */}
  </div>
  ```

  Import `ModelSelect` from `./ModelSelect`.

- [ ] **Step 5: Wire `llmDisplayName` from `App.tsx`**

  Pass `llmDisplayName={capabilities.llm?.displayName}` into `<AssistantChatWorkspace />` (line 978-1000).

- [ ] **Step 6: Verify**

  Run: `cd frontend && npm run lint && npm run build`
  Expected: success.

---

## Task D: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Build + lint + diff check**

  Run: `cd frontend && npm run lint && npm run build`
  Run: `git diff --check`
  Expected: zero new errors, no whitespace-only warnings.

- [ ] **Step 2: Inspect git status**

  Run: `git status`
  Expected: modifications only in `frontend/src/{app/App.tsx,components/layout/Sidebar.tsx,features/chat/components/{AssistantChatWorkspace.tsx,ConversationMenu.tsx,RenameConversationDialog.tsx,ModelSelect.tsx}}`. No edits to backend/, AGENTS.md, package.json / lock files, output/.

- [ ] **Step 3: Acceptance sanity**

  - Sidebar collapses → icon rail persists via localStorage `xuanshu-agent.sidebar-collapsed`.
  - Mobile (≤760px) drawer unaffected (still uses `mobileOpen` translate logic).
  - Each conversation shows the More icon; right-click and the More button both open the same Base UI Menu with 重命名 / 删除.
  - 重命名 opens Base UI Dialog; blank input disables save; submit calls `updateConversation({ title })`, syncs `conversations` and `document.title` if current.
  - 删除 still funnels through `onDeleteConversation` → `ConfirmDialog` flow.
  - Composer bottom row shows `DeepSeek` (or `defaultChatModel` fallback); model is **not** sent anywhere.
  - Knowledge base picker / send / stop / regenerate / Enter / Shift+Enter unchanged.

---

## Out-of-scope reminders

- No backend / SQL / dependency changes.
- No new Tailwind tokens, no new globals in `index.css`.
- No changes to `lib/conversations.ts`, `lib/api.ts`, `assistantAdapter.ts`, or any backend module.
- `ThreadListPrimitive` (assistant-ui) NOT introduced — Sidebar continues to render our server-backed conversation list.
- No new menu items (no archive / share / pin) because the backend has no equivalent.