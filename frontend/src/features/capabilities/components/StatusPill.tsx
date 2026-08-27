import { cn } from '../../../lib/cn';

type StatusPillTone = 'neutral' | 'builtin' | 'marketplace' | 'local' | 'success' | 'warning' | 'danger' | 'muted' | 'info';

const TONE_CLASS: Record<StatusPillTone, string> = {
  neutral: 'text-app-text bg-app-surface-muted border-app-border',
  builtin: 'text-app-info bg-app-info/10 border-app-info/25',
  marketplace: 'text-app-skill-marketplace bg-app-skill-marketplace/10 border-app-skill-marketplace/25',
  local: 'text-app-success bg-app-success/10 border-app-success/25',
  success: 'text-app-success bg-app-success/10 border-app-success/25',
  warning: 'text-app-warning bg-app-warning/10 border-app-warning/25',
  danger: 'text-app-danger bg-app-danger/10 border-app-danger/25',
  muted: 'text-app-muted bg-app-surface-muted border-app-border',
  info: 'text-app-info bg-app-info/10 border-app-info/25',
};

/**
 * 统一的状态 / 来源 / 兼容性徽章。原子组件，所有 Tab 都复用。
 *
 * 设计约束：
 * - 紧凑（高度 20px），不上圆角胶囊，用 4px 直角保持"工作台"感。
 * - 文本等宽数字 / 全大写首字母，便于在密集列表里扫读。
 */
export function StatusPill(props: {
  children: React.ReactNode;
  tone?: StatusPillTone;
  uppercase?: boolean;
  title?: string;
  className?: string;
}) {
  const { children, tone = 'neutral', uppercase = false, title, className } = props;
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 h-[20px] text-[10.5px] leading-none font-medium border rounded-[3px] app-tnum',
        uppercase && 'uppercase tracking-[0.04em]',
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
