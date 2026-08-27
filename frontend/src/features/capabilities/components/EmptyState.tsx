import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/cn';

/**
 * 通用空态 / 加载态 / 错误态容器。
 *
 * 设计原则：
 * - 不是营销页 hero，密度要紧凑（min-height 仅够展示 2 行说明）。
 * - 不用大圆角虚框；用 1px 实线 border + 居中 icon + 标题 + 描述 + 可选操作。
 * - 不抢戏：颜色用 muted，icon 用 muted，避免视觉权重压过真实内容。
 */
export function EmptyState(props: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  const { icon: Icon, title, description, action, className } = props;
  return (
    <div
      className={cn(
        'grid place-items-center gap-2.5 py-9 px-6 border border-dashed border-app-border-strong rounded-md text-app-muted text-center',
        className,
      )}
    >
      <Icon size={20} strokeWidth={1.5} />
      <strong className="text-[13px] font-semibold text-app-text">{title}</strong>
      {description && <p className="m-0 max-w-md text-[12.5px] leading-[1.6]">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
