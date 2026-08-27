import { cn } from '../../../lib/cn';

/**
 * 紧凑 section 标题：左侧 uppercase 小标题 + 计数，右侧可选操作。
 *
 * 用法：
 *   <SectionHeader label="Tools" count={5}>右侧操作按钮</SectionHeader>
 *
 * 设计：11px 大写 + 字间距，跟正文形成层级，但不抢主标题。
 */
export function SectionHeader(props: {
  label: string;
  count?: number;
  trailing?: React.ReactNode;
  className?: string;
}) {
  const { label, count, trailing, className } = props;
  return (
    <div className={cn('flex items-center justify-between gap-3 pb-2 border-b border-app-divider', className)}>
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-app-muted">{label}</span>
        {typeof count === 'number' && (
          <span className="text-[11px] app-tnum text-app-muted">{count}</span>
        )}
      </div>
      {trailing && <div className="flex items-center gap-1.5 shrink-0">{trailing}</div>}
    </div>
  );
}
