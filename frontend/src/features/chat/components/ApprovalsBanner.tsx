/**
 * 待审批 Banner：折起态 / 展开态两形态，避免多卡片持续挤压 Composer。
 *
 * - 1 条审批：直接展开（高度可忽略）；
 * - 多条审批：默认折起为"待审批 N 条"按钮；点击 → 弹 Base UI Dialog，避免挤占 Composer。
 *
 * 不修改 approvals API、状态机、Workspace 隔离、服务端权限校验——本组件
 * 只负责呈现。
 */
import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { ShieldAlert, ChevronDown } from 'lucide-react';
import { ApprovalCard } from './ApprovalCard';
import type { ApprovalView } from '../../../types/approval';
import { cn } from '../../../lib/cn';

export interface ApprovalsBannerProps {
  approvals: ApprovalView[];
  busyApprovalId: string | null;
  onApprove: (approval: ApprovalView) => void;
  onDecline: (approval: ApprovalView) => void;
}

export function ApprovalsBanner({ approvals, busyApprovalId, onApprove, onDecline }: ApprovalsBannerProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const count = approvals.length
  if (count === 0) return null

  // 折叠区：多条 → Dialog；单条 → 内联卡片。
  if (count === 1) {
    const only = approvals[0]!
    return (
      <div
        data-testid="approvals-banner"
        className="w-full max-w-[768px] mx-auto mb-2 grid gap-2"
      >
        <ApprovalCard
          approval={only}
          busy={busyApprovalId === only.id}
          onApprove={onApprove}
          onDecline={onDecline}
        />
      </div>
    )
  }

  return (
    <div
      data-testid="approvals-banner"
      className="w-full max-w-[768px] mx-auto mb-2 flex items-center gap-2 py-2 px-3 bg-amber-50/40 dark:bg-amber-400/[0.08] border border-amber-300/60 rounded-lg"
    >
      <ShieldAlert size={16} className="shrink-0 text-amber-600" />
      <span className="text-[12.5px] text-app-text">
        当前有 <strong className="font-semibold">{count}</strong> 项待审批。
      </span>
      <button
        type="button"
        data-testid="approvals-open-dialog"
        onClick={() => setDialogOpen(true)}
        className={cn(
          'ml-auto inline-flex items-center gap-1 px-2.5 py-1 text-[12px] text-app-text',
          'bg-transparent border border-app-border rounded-md transition-colors duration-150',
          'hover:bg-app-hover focus-visible:bg-app-hover focus-visible:outline-none focus-visible:border-focus-border',
        )}
      >
        查看
        <ChevronDown size={13} className="-rotate-90" />
      </button>
      <Dialog.Root open={dialogOpen} onOpenChange={(next) => setDialogOpen(next)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Popup
            className={cn(
              'fixed inset-x-2 bottom-2 top-[10vh] z-50 mx-auto max-w-[640px] flex flex-col',
              'p-4 bg-app-bg border border-app-border rounded-2xl shadow-2xl outline-none overflow-hidden',
            )}
          >
            <div className="flex items-center justify-between mb-3">
              <Dialog.Title className="m-0 text-[15px] font-semibold">
                待审批（{count}）
              </Dialog.Title>
              <Dialog.Close
                aria-label="关闭待审批列表"
                className="grid place-items-center w-9 h-9 text-app-muted bg-transparent border-0 rounded-lg hover:text-app-text hover:bg-app-hover focus-visible:text-app-text focus-visible:bg-app-hover"
              >
                ×
              </Dialog.Close>
            </div>
            <Dialog.Description className="srOnly">
              当前 Run 命中的待审批请求。选择批准或拒绝后状态会实时更新。
            </Dialog.Description>
            <div className="flex-1 min-h-0 overflow-y-auto app-scroll grid gap-2">
              {approvals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  busy={busyApprovalId === approval.id}
                  onApprove={onApprove}
                  onDecline={onDecline}
                />
              ))}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
