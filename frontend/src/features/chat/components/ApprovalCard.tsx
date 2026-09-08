/**
 * PR-3.3 — 单条审批卡片。
 *
 * 渲染一份 approval request 的核心信息（Tool 名、已脱敏输入摘要、
 * 过期时间、状态徽标）+ Approve / Decline 按钮（仅 pending 时显示）。
 *
 * 数据来源：父组件传入 `approval: ApprovalView` 与 resolve 回调；
 * 本组件**不**直接 fetch——列表状态由 useApprovals hook 管理，
 * SSE 增量更新会触发重渲染。
 *
 * 关键边界：
 *   - inputsSummary 是后端 sanitize 后的 `{kind, preview, count?}` 结构；
 *     渲染时按 kind 决定呈现（string 显示预览；object/array 显示 count；
 *     truncated 显示 '…' 截断提示）。
 *   - 原始敏感输入**永不**进入前端；UI 层不再做二次脱敏——这是后端
 *     sanitize.ts 的责任。
 *   - 不在卡片内调 resolve；只调父组件 onApprove / onDecline 闭包，
 *     方便父组件统一处理错误与 SSE 协调。
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, X, ShieldAlert, ShieldCheck, ShieldX, Clock4 } from 'lucide-react';
import type { ApprovalSummary, ApprovalSummaryLeaf, ApprovalView } from '../../../types/approval';
import { cn } from '../../../lib/cn';

export interface ApprovalCardProps {
  approval: ApprovalView;
  onApprove: (approval: ApprovalView) => void;
  onDecline: (approval: ApprovalView) => void;
  busy: boolean;
}

const STATUS_LABELS: Record<ApprovalView['status'], { label: string; tone: 'pending' | 'inflight' | 'success' | 'fail' | 'expired' }> = {
  pending: { label: '待审批', tone: 'pending' },
  approving: { label: '审批中…', tone: 'inflight' },
  declining: { label: '拒绝中…', tone: 'inflight' },
  approved: { label: '已批准', tone: 'success' },
  declined: { label: '已拒绝', tone: 'fail' },
  expired: { label: '已过期', tone: 'expired' },
};

export function ApprovalCard(props: ApprovalCardProps) {
  const { approval, onApprove, onDecline, busy } = props;
  const meta = STATUS_LABELS[approval.status];
  // 过期倒计时：以 state 形式保存 now，每秒刷新一次；Date.now 不能直接在 render 中调用。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (approval.status !== 'pending') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [approval.status]);
  const expiresIn = useMemo(
    () => formatRemaining(new Date(approval.expiresAt).getTime() - now),
    [approval.expiresAt, now],
  );

  const isPending = approval.status === 'pending';
  const isInflight = approval.status === 'approving' || approval.status === 'declining';
  const isFinalized = approval.status === 'approved' || approval.status === 'declined' || approval.status === 'expired';

  return (
    <div
      data-testid="approval-card"
      data-approval-id={approval.id}
      data-approval-status={approval.status}
      className={cn(
        'rounded-md border p-3 text-sm',
        meta.tone === 'pending' && 'border-amber-300 bg-amber-50/40',
        meta.tone === 'inflight' && 'border-blue-300 bg-blue-50/40',
        meta.tone === 'success' && 'border-emerald-300 bg-emerald-50/40',
        meta.tone === 'fail' && 'border-rose-300 bg-rose-50/40',
        meta.tone === 'expired' && 'border-slate-300 bg-slate-50/40',
      )}
    >
      <div className="flex items-center gap-2">
        <ToolIcon status={approval.status} />
        <span className="font-medium text-app-fg">{approval.toolId}</span>
        <StatusBadge tone={meta.tone} label={meta.label} />
        <span className="ml-auto text-xs text-app-fg-muted">
          {isPending && expiresIn ? (
            <>
              <Clock4 className="mr-1 inline h-3 w-3" />
              {expiresIn} 后过期
            </>
          ) : (
            <>run={approval.runId.slice(0, 8)}</>
          )}
        </span>
      </div>
      <ApprovalSummaryView summary={approval.inputsSummary} />
      {approval.resolverError && (
        <p className="mt-2 text-xs text-rose-700" data-testid="approval-resolver-error">
          系统错误：{approval.resolverError}
        </p>
      )}
      {(isPending || isInflight) && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            data-testid="approval-approve"
            disabled={!isPending || busy}
            onClick={() => onApprove(approval)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-medium transition-colors',
              isPending && !busy
                ? 'border-emerald-400 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                : 'cursor-not-allowed border-app-border bg-app-surface text-app-fg-muted',
            )}
          >
            <Check className="h-3 w-3" />
            批准
          </button>
          <button
            type="button"
            data-testid="approval-decline"
            disabled={!isPending || busy}
            onClick={() => onDecline(approval)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-medium transition-colors',
              isPending && !busy
                ? 'border-rose-400 bg-rose-50 text-rose-700 hover:bg-rose-100'
                : 'cursor-not-allowed border-app-border bg-app-surface text-app-fg-muted',
            )}
          >
            <X className="h-3 w-3" />
            拒绝
          </button>
        </div>
      )}
      {isFinalized && approval.resolvedAt && (
        <p className="mt-2 text-[11px] text-app-fg-muted">
          终态时间：{new Date(approval.resolvedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function ToolIcon({ status }: { status: ApprovalView['status'] }) {
  if (status === 'approved') return <ShieldCheck className="h-4 w-4 text-emerald-600" />;
  if (status === 'declined') return <ShieldX className="h-4 w-4 text-rose-600" />;
  if (status === 'expired') return <Clock4 className="h-4 w-4 text-slate-500" />;
  return <ShieldAlert className="h-4 w-4 text-amber-600" />;
}

function StatusBadge({ tone, label }: { tone: 'pending' | 'inflight' | 'success' | 'fail' | 'expired'; label: string }) {
  return (
    <span
      data-testid="approval-status"
      data-tone={tone}
      className={cn(
        'rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide',
        tone === 'pending' && 'bg-amber-100 text-amber-800',
        tone === 'inflight' && 'bg-blue-100 text-blue-800',
        tone === 'success' && 'bg-emerald-100 text-emerald-800',
        tone === 'fail' && 'bg-rose-100 text-rose-800',
        tone === 'expired' && 'bg-slate-200 text-slate-700',
      )}
    >
      {label}
    </span>
  );
}

function ApprovalSummaryView({ summary }: { summary: ApprovalSummary }) {
  const keys = Object.keys(summary);
  if (keys.length === 0) {
    return <p className="mt-2 text-[11.5px] text-app-fg-muted">无输入参数。</p>;
  }
  return (
    <dl className="mt-2 grid grid-cols-1 gap-y-1 text-[12px]" data-testid="approval-summary">
      {keys.map((key) => (
        <SummaryRow key={key} field={key} leaf={summary[key]!} />
      ))}
    </dl>
  );
}

function SummaryRow({ field, leaf }: { field: string; leaf: ApprovalSummaryLeaf }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="font-mono text-app-fg-muted">{field}</dt>
      <dd className="flex-1 truncate">
        <SummaryLeaf leaf={leaf} />
      </dd>
    </div>
  );
}

function SummaryLeaf({ leaf }: { leaf: ApprovalSummaryLeaf }) {
  switch (leaf.kind) {
    case 'string':
      return <span className="text-app-fg">&ldquo;{leaf.preview}&rdquo;</span>;
    case 'number':
    case 'boolean':
      return <span className="text-app-fg">{leaf.preview}</span>;
    case 'null':
      return <span className="text-app-fg-muted">null</span>;
    case 'array':
      return <span className="text-app-fg-muted">[{leaf.count ?? 0} 项]</span>;
    case 'object':
      return <span className="text-app-fg-muted">{'{ '}{leaf.count ?? 0} {' 字段}'}</span>;
    case 'empty':
      return <span className="text-app-fg-muted">∅</span>;
    case 'truncated':
      return <span className="italic text-amber-700">已截断：{leaf.preview}</span>;
    case 'other':
      return <span className="text-app-fg-muted">{leaf.preview}</span>;
  }
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '已过期';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时`;
}