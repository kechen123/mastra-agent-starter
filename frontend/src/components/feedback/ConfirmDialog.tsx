/**
 * 通用确认对话框：基于 @base-ui/react AlertDialog。
 *
 * 替代 window.confirm —— 它无法定制样式、不能融入设计 token、阻塞渲染。
 * 用法：
 *   const [pending, setPending] = useState<ConfirmRequest | null>(null)
 *   <ConfirmDialog request={pending} onCancel={...} onConfirm={...} />
 *
 * request 为 null 时对话框关闭；onConfirm 回调返回 Promise 即可；loading 状态
 * 由父组件控制 confirm 按钮 disabled。
 */
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { cn } from '../../lib/cn';

export interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 显示红色"危险"按钮。默认 false。 */
  destructive?: boolean;
}

export interface ConfirmDialogProps {
  request: ConfirmRequest | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({ request, busy = false, onCancel, onConfirm }: ConfirmDialogProps) {
  const open = request !== null;
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Popup
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[min(420px,calc(100vw-32px))]',
            'p-5 bg-app-surface border border-app-border rounded-2xl shadow-2xl outline-none',
          )}
        >
          <AlertDialog.Title className="m-0 text-[15px] font-semibold text-app-text">
            {request?.title ?? ''}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 mb-0 text-[13px] leading-6 text-app-muted">
            {request?.description ?? ''}
          </AlertDialog.Description>
          <div className="flex justify-end gap-2 mt-5">
            <AlertDialog.Close
              disabled={busy}
              className={cn(
                'inline-flex items-center justify-center min-h-9 px-3.5 text-[13px] text-app-text bg-transparent border border-app-border rounded-lg',
                'hover:bg-app-hover focus-visible:bg-app-hover disabled:opacity-50',
              )}
            >
              {request?.cancelLabel ?? '取消'}
            </AlertDialog.Close>
            <button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              className={cn(
                'inline-flex items-center justify-center min-h-9 px-3.5 text-[13px] text-white border-0 rounded-lg',
                'hover:opacity-90 disabled:opacity-50',
                request?.destructive ? 'bg-app-danger' : 'bg-app-text text-app-bg',
              )}
            >
              {request?.confirmLabel ?? '确认'}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
