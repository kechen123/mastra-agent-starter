# PR-3.3 Tool Approval Closed-Loop Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "requires-approval" Tools a real recoverable closed loop — request approval → suspend → approve/decline → resume or terminate → SSE/UI visible → timeout converges → restart-recovery is safe.

**Architecture:** Recoverable saga over (DB `tool_approval_requests` + Mastra `agent.approveToolCall/declineToolCall/listSuspendedRuns`). DB holds the durable intent; Mastra SDK calls are not transactional — claim/lock + intermediate `approving`/`declining` states + idempotent recovery worker close the loop. All hot-path state changes go through a single state-machine module so the two data stores can never drift permanently.

**Tech Stack:** TypeScript · `@mastra/core@1.61.0` · `pg` · Hono (via `@mastra/core/server`) · existing Run Executor / SSE pipeline.

## Global Constraints

- `@mastra/core@1.61.0` is the actual installed version; do not invent API surface.
- Mastra SDK calls use object form: `agent.approveToolCall({ runId, toolCallId })` and `agent.declineToolCall({ runId, toolCallId, reason })`. `agent.listSuspendedRuns({ threadId, resourceId })` is the only cross-restart reconciliation entry.
- `tool_approval_requests` keeps no `suspension_id` — Mastra 1.61 has no such token. Recovery key is `(run_id, tool_call_id)` only.
- `agent_runs(id, workspace_id)` has a UNIQUE index already — used by FK to enforce same-workspace integrity.
- Database is initialized fresh via `backend/database/init.sql`; no migration chain.
- All SQL schema changes go in `init.sql` only.
- Requires-approval Tools must remain fail-closed (no silent bypass).
- `requires-approval` Tools MUST enter `activeTools` and be gated by `requireToolApproval` (no second Tool Dispatcher).
- Original sensitive tool inputs are never persisted; only redacted summary + SHA-256 hash.
- No new destructive Tool in tests; use fake Tool via `_setPerRequestFactoryOverrideForTesting`.

## Phase plan

### Task 1 (PR-3.3.0): Approval state machine foundation

**Files:**
- Modify: `backend/database/init.sql` (status check + adding intermediate columns + claim/lock fields)
- Modify: `backend/src/modules/tool-policy/types.ts`
- Modify: `backend/src/modules/tool-policy/repository.ts`
- Create: `backend/src/modules/tool-policy/state-machine.ts` (decide / claim / finalize)
- Create: `backend/src/modules/tool-policy/sanitize.ts` (sanitize tool inputs → summary + hash)
- Create: `backend/tests/unit/tool-policy-state-machine.ts`
- Create: `backend/tests/unit/tool-policy-sanitize.ts`

**Schema changes (init.sql):**
- Widen `tool_approval_requests.status` CHECK to include `'approving'`, `'declining'`.
- Add columns: `decision TEXT`, `resolver_error TEXT`, `mastra_call_started_at TIMESTAMPTZ`, `mastra_call_completed_at TIMESTAMPTZ`, `lease_owner TEXT`, `lease_expires_at TIMESTAMPTZ`.
- Partial unique index on `(run_id, tool_call_id) WHERE status IN ('approving','declining')` to enforce single-flight.

### Task 2 (PR-3.3 Runtime): Tool Gateway wiring

**Files:**
- Modify: `backend/src/core/agent/runtime.ts`
- Create: `backend/src/core/agent/tool-approval-gateway.ts` (requireToolApproval + result consume)
- Modify: `backend/src/core/agent/types.ts` (stream event for `approval-requested`)
- Modify: `backend/src/core/execution/stream-events.ts`
- Create: `backend/tests/unit/tool-policy-runtime-approval.ts`

### Task 3 (PR-3.3 Approval API): Routes

**Files:**
- Create: `backend/src/server/routes/approvals.ts`
- Modify: `backend/src/server/bootstrap.ts` (register approval routes)
- Create: `backend/src/modules/tool-policy/api-handlers.ts`
- Modify: `backend/src/modules/tool-policy/state-machine.ts` (public surface)

### Task 4 (PR-3.3 Timeout / Recovery): Worker + restart reconciliation

**Files:**
- Create: `backend/src/modules/tool-policy/timeout-worker.ts`
- Create: `backend/src/modules/tool-policy/restart-reconciler.ts`
- Modify: `backend/src/core/execution/run-executor.ts` (handle `waiting_approval` lease)
- Modify: `backend/src/server/bootstrap.ts` (start worker)
- Create: `backend/tests/unit/tool-policy-timeout-worker.ts`
- Create: `backend/tests/unit/tool-policy-restart-reconciler.ts`

### Task 5 (PR-3.3 Frontend): Approvals UI

**Files:**
- Create: `frontend/src/features/approvals/` (components, hook)
- Modify: `frontend/src/features/chat/components/AssistantChatWorkspace.tsx`

### Task 6 (PR-3.3 Docs + verification): Update documentation truthfully

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/architecture-v2.md`
- Modify: `docs/implementation-plan.md`

### Task 7 (PR-3.3 Replay Fix): Real resume stream consumption (not wrong replay)

**Scope:** 修正"批准后调用 `streamAgent(prompt)` 重发模型请求"的错误重放路径——approve/decline 必须消费 `Agent.approveToolCall() / Agent.declineToolCall()` 返回的真实 resume `AsyncIterable<StreamEvent>`。

**Files:**
- Modify: `backend/src/core/agent/runtime.ts`（抽取 `consumeAgentStream(execution, stream)` 公共能力；首次 Run 与 resume 共用）
- Modify: `backend/src/core/execution/run-executor.ts`（`resumeAwaitingRunsOnce` 真正消费 stream 而非重发 prompt；导出 `runResumeSchedulerOnce()` / `runLeaseSweeperOnce()` 测试入口）
- Modify: `backend/src/modules/tool-policy/state-machine.ts`（MastraAgentFacade 接口表达真实 SDK 类型：approveToolCall/declineToolCall 返回 `AsyncIterable<unknown>`；新增 `listSuspendedRuns` 实例方法；fail-closed 校验；新增 `_getMastraFacade()` 供 executor 使用）
- Modify: `backend/src/modules/tool-policy/mastra-facade.ts`（`listSuspendedRuns` 在 Agent 实例上调用；`validateSuspendedRunsSnapshot` 严格校验 `runId/toolCallId/threadId/resourceId`）
- Modify: `backend/src/modules/tool-policy/repository.ts`（`createApprovalRequest` 强制 `requesterId` 非空；默认 `resolverId = requesterId`；`takeoverInflightLease` 同步写 `mastra_resume_started_at`，避免 takeover 后被 scheduler 再次调度）
- Modify: `backend/src/modules/tool-policy/types.ts`（`requesterId: string` / `resolverId: string` 非空）
- Modify: `backend/database/init.sql`（恢复 `requester_id UUID NOT NULL REFERENCES app_users(id)` 与 `resolver_id UUID NOT NULL REFERENCES app_users(id)`；document `system-approval-worker` 语义）
- Modify: `backend/src/server/routes/approvals.ts`（`ApprovalView.requesterId: string`；`sdk_failed` 路径使用 `requesterId: authCtx.userId`）
- Modify: `backend/tests/unit/tool-policy-schema.ts`（断言 NOT NULL FK）
- Modify: `backend/tests/unit/approvals-route.ts`（测试 row 用非空 requesterId/resolverId）
- Rewrite: `backend/tests/integration/tool-policy-pg.ts`（真实 PG + fake Agent stream，覆盖 (a) waiting_approval 保留 / (b) approve resume stream 消费 / (c) decline / (c-2) expire system-approval / (d) SDK transient fail → preserve → reconcile / (e) scheduler 抢占透明 / (f) listSuspendedRuns fail-closed / (g) 跨重启 / (x) created_by NULL → 拒绝）

**Crash windows handled:**
- W1 — facade.approveToolCall 抛错 → failRun + 释放 lease；
- W2 — 拿到 stream 但首个 yield 前抛错 → 同 W1；
- W3 — consumeAgentStream 迭代中抛错 → 同 W1。

**Verification:**
- `cd backend && npm run typecheck`：通过；
- `cd backend && npm run test:unit`：22 个 suite 全部 passed；
- `cd backend && RUN_PG_TOOL_POLICY=1 npx tsx tests/integration/tool-policy-pg.ts`：48 passed, 0 failed；
- `cd frontend && npm run build`：成功（仅 chunk-size warning，无 error）；
- `git diff --check`：无非空白冲突。

---