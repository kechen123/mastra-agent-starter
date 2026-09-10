/**
 * 重命名对话：Base UI Dialog。
 *
 * 设计要点：
 *   - input 默认选中当前标题（用户可直接键入替换）；
 *   - 空白 / 仅空白字符标题不可提交；
 *   - Escape / 外点 / Close 按钮统一由 Dialog 处理焦点回归；
 *   - onSubmit 返回 Promise；提交期间禁用按钮避免重复提交；
 *   - 仅暴露 onSubmit(title) 回调，调用方自行决定 PATCH / 错误处理 / UI 更新。
 */
import { Dialog } from '@base-ui/react/dialog';
import { useRef, useState } from 'react';
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

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } finally {
      setBusy(false);
    }
  }

  // 用户触发打开时重置 state + 选中；触发关闭（且不在提交中）走 onCancel。
  // 用 onOpenChange 处理而非 useEffect，避免 setState-in-effect 警告。
  function handleOpenChange(next: boolean) {
    if (next) {
      setValue(initialTitle);
      setBusy(false);
      window.setTimeout(() => inputRef.current?.select(), 30);
    } else if (!busy) {
      onCancel();
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
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
              if (event.key === 'Enter' && canSubmit) {
                event.preventDefault();
                void handleSubmit();
              }
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