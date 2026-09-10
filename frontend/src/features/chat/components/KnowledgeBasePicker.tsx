/**
 * 知识库选择器：基于 @base-ui/react Popover。
 *
 * 设计要点：
 *   - 替代 AssistantChatWorkspace Composer 里手写的 button + absolute listbox +
 *     document mousedown 关闭逻辑；
 *   - 知识库列表可能较长（每个 KB 一行），不适合 compact Select；Popover 提供
 *     更稳定的滚动与移动端定位（默认 align=start, side=top 避让 Composer）；
 *   - 原生具备 Escape 关闭、焦点恢复、键盘导航、外部点击关闭；
 *   - 空态：渲染文案提示而非禁用（用户仍可查看占位）；
 *   - PR-UI-1.0.5 F3：选中条目后立刻关闭 Popover；通过 `Popover.Close` 的
 *     `render` prop 复用我们的 `<button>` 样式同时挂上 close 行为；保留
 *     Escape / 外部点击 / 焦点恢复 / 键盘导航所有原有行为。
 */
import { Popover } from '@base-ui/react/popover';
import { Library } from 'lucide-react';
import type { KnowledgeBase } from '../../../lib/api';
import { cn } from '../../../lib/cn';

export interface KnowledgeBasePickerProps {
  knowledgeBases: KnowledgeBase[];
  activeId: string | null;
  onSelect: (knowledgeBase: KnowledgeBase) => void;
  ariaLabel?: string;
}

export function KnowledgeBasePicker({ knowledgeBases, activeId, onSelect, ariaLabel = '选择知识库' }: KnowledgeBasePickerProps) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex items-center gap-1.5 min-h-9 py-1.5 px-3 text-[13px] text-app-muted bg-transparent border-0 rounded-full',
          'transition-colors duration-150 hover:text-app-text hover:bg-app-hover',
          'focus-visible:bg-app-hover data-[popup-open]:bg-app-hover data-[popup-open]:text-app-text',
        )}
      >
        <Library size={13} />知识库
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={9} side="top" align="start" className="z-30">
          <Popover.Popup
            className="grid min-w-[220px] max-w-[280px] max-h-[60vh] overflow-y-auto p-1.5 bg-app-surface border border-app-border-strong rounded-xl shadow-2xl outline-none app-scroll"
          >
            {knowledgeBases.length === 0 ? (
              <p className="m-1.5 px-2 py-1 text-app-muted text-xs leading-snug">暂无知识库，请先在知识库页创建。</p>
            ) : (
              knowledgeBases.map((knowledgeBase) => (
                <Popover.Close
                  key={knowledgeBase.id}
                  render={
                    <button
                      type="button"
                      data-active={knowledgeBase.id === activeId ? 'true' : undefined}
                      onClick={() => onSelect(knowledgeBase)}
                      className={cn(
                        'flex items-center gap-2 w-full py-2 px-2.5 text-[12.5px] text-app-text bg-transparent border-0 rounded-lg text-left',
                        'hover:bg-app-surface-muted focus-visible:bg-app-surface-muted focus-visible:outline-none',
                        knowledgeBase.id === activeId && 'bg-app-surface-muted',
                      )}
                    >
                      <Library size={14} />
                      <span className="truncate">{knowledgeBase.name}</span>
                    </button>
                  }
                />
              ))
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
