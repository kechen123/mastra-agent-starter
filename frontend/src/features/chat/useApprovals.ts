/** Approval inbox: authenticated load, explicit SSE handler, server-confirmed mutations. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { listApprovals, resolveApproval, type ApprovalView } from '../../lib/api';
import type { V2RunEvent } from '../../lib/conversations';

export function useApprovals(opts: { sessionKey: string | null }) {
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [loadedSession, setLoadedSession] = useState<string | null>(null);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const mounted = useRef(false);
  const busy = useRef(false);
  const sessionKey = opts.sessionKey;

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!sessionKey) return;
    try {
      const result = await listApprovals();
      if (!mounted.current || seq !== requestSeq.current) return;
      setApprovals(result.approvals);
      setLoadedSession(sessionKey);
      setError(null);
    } catch (err) {
      if (!mounted.current || seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : '加载审批列表失败。');
    }
  }, [sessionKey]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; requestSeq.current++; };
  }, [refresh]);

  // 必须由真正的流事件入口调用，不能只在 effect 中创建一个无人使用的 handler。
  const onRunEvent = useCallback((event: V2RunEvent) => {
    if (['approval-requested', 'approval-resolved', 'run-resumed', 'run-completed', 'run-failed', 'run-stopped'].includes(event.type)) {
      void refresh();
    }
  }, [refresh]);

  const decide = useCallback(async (approval: ApprovalView, decision: 'approve' | 'decline') => {
    if (busy.current || !sessionKey) return;
    busy.current = true;
    setBusyApprovalId(approval.id);
    setError(null);
    try {
      await resolveApproval(approval.id, decision);
      await refresh();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '审批操作失败。');
    } finally {
      busy.current = false;
      if (mounted.current) setBusyApprovalId(null);
    }
  }, [refresh, sessionKey]);

  const visible = sessionKey && loadedSession === sessionKey ? approvals : [];
  return {
    approvals: visible,
    pendingApprovals: visible.filter((a) => a.status === 'pending'),
    busyApprovalId,
    error: sessionKey ? error : null,
    refresh,
    onRunEvent,
    approve: (approval: ApprovalView) => decide(approval, 'approve'),
    decline: (approval: ApprovalView) => decide(approval, 'decline'),
  };
}
