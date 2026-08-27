import { cn } from '../../../lib/cn';

/**
 * 紧凑 Tab 切换条：underline 风格（无填充背景），与 IDE tab 一致。
 *
 * 设计原则：
 * - 没有大圆角胶囊背景；选中态仅底部 2px underline。
 * - tab 间用 1px 分隔线，避免 hover 时抖动。
 * - 高度固定 33px，与 sub-header 视觉对齐。
 */
export function TabBar<T extends string>(props: {
  tabs: Array<{ id: T; label: string; count?: number; disabled?: boolean }>;
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  const { tabs, active, onChange, className } = props;
  return (
    <div
      role="tablist"
      className={cn('flex items-stretch gap-1 h-11 border-b border-app-divider bg-app-bg overflow-x-auto app-scroll', className)}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`tab-panel-${tab.id}`}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={cn(
              'relative grid place-items-center px-3 text-[13.5px] whitespace-nowrap bg-transparent border-0 cursor-pointer',
              'transition-colors duration-150',
              'focus-visible:outline-none focus-visible:bg-app-hover',
              selected
                ? 'text-app-text font-medium'
                : 'text-app-muted hover:text-app-text',
              tab.disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-app-muted',
            )}
          >
            <span className="flex items-center gap-1.5">
              <span>{tab.label}</span>
              {typeof tab.count === 'number' && (
                <span className={cn('text-[11px] app-tnum', selected ? 'text-app-text' : 'text-app-muted')}>
                  {tab.count}
                </span>
              )}
            </span>
            {selected && (
              <span className="absolute left-3 right-3 bottom-[-1px] h-[2px] rounded-full bg-app-text" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );
}
