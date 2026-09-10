import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { Citation } from '../../../lib/api';
import { cn } from '../../../lib/cn';

/**
 * 引用详情面板：
 *   - 桌面宽屏（≥ 1181px）：右侧固定侧栏（aside）；
 *   - 中小屏（≤ 1180px）：Base UI Dialog 浮层，避免稳定侧栏 + 引用栏共同挤压聊天正文。
 *
 * 桌面布局直接挂 aside 即可——`max-[1180px]:hidden` 兜底；中小屏父组件改用
 * `MobileCitationDialog` 渲染 Dialog 形态。
 */
export function CitationPanel({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  return (
    <aside className="hidden min-[1181px]:flex shrink-0 basis-[380px] min-w-0 h-full overflow-hidden flex-col border-l border-app-divider bg-app-bg">
      <Body citation={citation} onClose={onClose} />
    </aside>
  );
}

interface BodyProps {
  citation: Citation;
  onClose: () => void;
}

/** 共享的引用展示内容；侧栏与 Dialog 共用。 */
function Body({ citation, onClose }: BodyProps) {
  return (
    <>
      <header className="flex items-center justify-between shrink-0 min-h-14 px-4">
        <strong className="text-[15px] font-semibold">引用来源</strong>
        <button
          className="grid place-items-center w-9 h-9 text-app-muted bg-transparent border-0 rounded-lg transition-colors duration-150 hover:text-app-text hover:bg-app-hover focus-visible:text-app-text focus-visible:bg-app-hover"
          onClick={onClose}
          aria-label="关闭引用来源"
        >
          <X size={18} />
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto app-scroll">
        <article className="m-3 p-4 bg-app-surface rounded-2xl text-[14px] leading-7">
          <h2 className="m-0 text-[17px] font-semibold">{citation.documentName ?? citation.title}</h2>
          <p className="mt-1 mb-4 text-app-muted">{citation.heading ?? citation.chapter}</p>
          <hr className="border-0 border-t border-app-divider" />
          <h3 className="mt-4 mb-1 text-app-muted text-[13px] font-medium">原文</h3>
          <p className="m-0 mb-2 whitespace-pre-wrap">{citation.content}</p>
          <h3 className="mt-4 mb-1 text-app-muted text-[13px] font-medium">元数据</h3>
          <dl className="grid grid-cols-[60px_1fr] gap-2 mt-2">
            {citation.documentId ? (
              <>
                <dt className="text-app-muted">文档</dt>
                <dd className="m-0 break-words">{citation.documentName}</dd>
                <dt className="text-app-muted">片段</dt>
                <dd className="m-0 break-words">
                  第 {(() => {
                    const m = /^chunk-(\d+)/.exec(citation.chunkId);
                    return m ? Number(m[1]) + 1 : 1;
                  })()} 段
                </dd>
              </>
            ) : (
              <>
                <dt className="text-app-muted">作者</dt>
                <dd className="m-0 break-words">{citation.author ?? '未标注'}</dd>
                <dt className="text-app-muted">版本</dt>
                <dd className="m-0 break-words">{citation.version ?? '未标注'}</dd>
              </>
            )}
            <dt className="text-app-muted">类型</dt>
            <dd className="m-0 break-words">{citation.category || citation.type}</dd>
            <dt className="text-app-muted">来源</dt>
            <dd className="m-0 break-words">{citation.source || '未标注'}</dd>
          </dl>
        </article>
      </div>
    </>
  );
}

/**
 * 窄屏引用详情：Base UI Dialog。
 *
 * 父组件 App 用 `useMediaQuery('(max-width: 900px)')` 之类的判断分支渲染：
 *   - ≤1180px → <MobileCitationDialog ...>（居中 Dialog）
 *   - 宽屏 → <CitationPanel ...>（侧栏）
 *
 * Dialog 自带 Escape 关闭、焦点恢复、背景遮罩、scroll lock，移动端不会
 * 遮挡 Composer 或挤压主聊天区。
 */
export function MobileCitationDialog({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Popup
          className={cn(
            'fixed inset-x-2 bottom-2 top-[10vh] z-50 mx-auto max-w-[560px] flex flex-col',
            'p-0 bg-app-bg border border-app-border rounded-2xl shadow-2xl outline-none overflow-hidden',
          )}
        >
          <Body citation={citation} onClose={onClose} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
