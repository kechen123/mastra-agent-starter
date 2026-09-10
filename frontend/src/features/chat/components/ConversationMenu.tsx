/**
 * 会话操作菜单：Base UI Menu + ContextMenu 双入口复用同一份菜单项。
 *
 * 设计要点：
 *   - 展开态：可见 More 图标按钮（Menu.Trigger）；整行右键由
 *     ConversationContextMenu 在列表项外层提供。
 *   - 两入口操作一致：重命名、删除；不允许新增无后端能力支持的菜单项（无归档 / 分享）。
 *   - 删除继续走父级 ConfirmDialog 流程，本组件仅负责打开菜单 + 触发回调。
 *   - 长标题已由父级 button truncate 处理；菜单本身不展示标题。
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
}

export function ConversationMenu({ conversation, onRename, onDelete }: ConversationMenuProps): ReactNode {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`更多操作：${conversation.title}`}
        title="更多操作"
        className={cn(
          'grid place-items-center w-8 h-8 mr-1 text-app-muted bg-transparent border-0 rounded-md transition-colors duration-150 shrink-0',
          'hover:text-app-text hover:bg-app-hover focus-visible:text-app-text focus-visible:bg-app-hover',
        )}
      >
        <MoreHorizontal size={15} aria-hidden />
      </Menu.Trigger>
      <ConversationMenuItems onRename={onRename} onDelete={onDelete} />
    </Menu.Root>
  );
}

/** 整行右键 / 长按入口；根菜单按指针位置定位，不绑定到三点按钮。 */
export function ConversationContextMenu({
  children,
  onRename,
  onDelete,
}: {
  children: ReactNode;
  onRename: () => void;
  onDelete: () => void;
}): ReactNode {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger className="contents">{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner sideOffset={4} className="z-50">
          <ContextMenu.Popup className="grid min-w-[160px] p-1 bg-app-surface border border-app-border rounded-lg shadow-2xl outline-none">
            <ContextMenu.Item
              onClick={(event) => { event.preventDefault(); onRename(); }}
              className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-app-text rounded-md data-[highlighted]:bg-app-hover outline-none cursor-pointer"
            >
              重命名
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={(event) => { event.preventDefault(); onDelete(); }}
              className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-app-danger rounded-md data-[highlighted]:bg-app-danger/10 outline-none cursor-pointer"
            >
              删除
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * Menu 入口的 items（More 按钮点击时弹出）。
 * 与 ContextMenu 的 Popup 内容完全一致；只暴露操作回调，不再嵌入标题。
 */
export function ConversationMenuItems({
  onRename,
  onDelete,
}: {
  onRename: () => void;
  onDelete: () => void;
}): ReactNode {
  return (
    <Menu.Portal>
      <Menu.Positioner side="right" align="start" sideOffset={8} className="z-50">
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
