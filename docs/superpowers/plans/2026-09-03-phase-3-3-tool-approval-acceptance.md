# PR-3.3 Tool Approval Closed-Loop（含 Replay Fix + W2 Reconciliation）— Acceptance Verification Report

> 验收日期：2026-09-04
> 范围：仅修复 PR-3.3 Tool Approval Closed-Loop 的验收阻塞项（含 Replay Fix 后的真实 resume stream 消费、Crash Window W2 reconciliation、人工介入终态保护）。未进入阶段 4，未修改 RAG / Provider / 业务模块；未升级依赖；未提交或推送。

## 0. 职责严格分层（**当前真实拓扑**）

| 模块 | 责任 | 是否调 Mastra SDK | 是否消费 stream |
|---|---|---|---|
| `server/routes/approvals.ts`（`/v1/approvals`、`/v1/approvals/:id`、`/v1/approvals/:id/resolve`） | 鉴权 / workspace 隔离 / 输入校验 / 路由决策到 `state-machine` | **否** | **否** |
| `modules/tool-policy/state-machine.ts`（`resolveApproval` / `expireApproval` / `reconcileInflightApprovals`） | DB-only 状态收敛（`status` / `resolver_id` / `resolved_at` / `mastra_resume_started_at` / `resume_attempts` / `resolver_error`） | **否** | **否** |
| `modules/tool-policy/timeout-worker.ts`（15 秒周期） | DB-only：扫 `expires_at < now()` → `state-machine.expireApproval` | **否** | **否** |
| `core/execution/run-executor.ts::runResumeSchedulerOnce` | **唯一 SDK 调用方**：扫 `('approved' \| 'declined' \| 'expired') AND mastra_resume_started_at IS NULL` → 原子推 Run → 'running' + `run-resumed` + 写 `mastra_resume_started_at` → 调 `facade.approveToolCall` / `declineToolCall` 拿 `AsyncIterable<unknown>` | **是** | — |
| `core/execution/run-executor.ts::runReconcileIndeterminateOnce` | **唯一 reconciler SDK 调用方**：扫 `('approved_resume_indeterminate') AND lease_expires_at < now() AND resume_attempts < MAX AND resolver_error NOT LIKE 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_%'` → 调 `facade.listSuspendedRuns` 严格校验 → revert `approved` 或 fail-closed 写人工介入错误 | **是** | — |
| `core/agent/runtime.ts::consumeAgentStream` | **唯一 stream 消费方**：首次 Run (`agent.stream().fullStream`) 与 resume (`agent.approveToolCall()` / `declineToolCall()` 返回的 `AsyncIterable<unknown>`) 共享同一消费 | — | **是** |

> 因此"timeout worker saga 直接调 `declineToolCall`"是**不**存在的——它只写 DB `status='expired'`，由 `runResumeSchedulerOnce` 下次 tick 拾起并完成 SDK 调用 + stream 消费 + Run 收尾。
> "HTTP route 直接调用 SDK"、"state-machine 直接消费/丢弃 resume stream"也不存在；这两条都已重构到 `run-executor.ts`。

---

## 1. 已修复的 6 项验收阻塞项（全部已与当前代码对齐）

| # | 阻塞项 | 修复位置（当前） | 真实 PG 已验证？ |
|---|---|---|---|
| #1 | Run Executor 在 approval-requested 后调 stopRun，破坏 waiting_approval | `backend/src/core/execution/run-executor.ts` approval-requested 分支不再写 `exitType='stopped'`；终态路径跳过 `stopRun/completeRun/failRun`，仅清理 `activeExecutions` | ✅ `tests/integration/tool-policy-pg.ts` (a) |
| #2 | 批准后未真正接管 resume stream，依赖第二套不一致的运行时写路径 | `run-executor.ts` 新增 `runResumeSchedulerOnce`（被 `runResumeSchedulerInterval` 1s tick 驱动）；新增 `listApprovalsPendingResume` + `markMastraResumeStarted`；事件类型 `run-resumed`；**真实消费** `facade.approveToolCall` / `declineToolCall` 返回的 `AsyncIterable`（不再 `streamAgent(prompt)`） | ✅ (b) / (c) / (c-2) |
| #3 | SDK 临时失败直接写终态 `declined`，违反"用户主动 decline 才算 declined" | W1：保留 `approving` + `resolver_error`；W2 approve：写 `approved_resume_indeterminate` + `resume_attempts += 1` + Run 推回 `waiting_approval`（**保留** `mastra_resume_started_at`）；W2 reconcile：fail-closed 校验 `runId` / `toolCallId` / `workspaceId` / `threadId` / `resourceId` / `agentId` → revert `approved` 或耗尽写 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_*` | ✅ (d) / (f) / (h) |
| #4 | `getAgentIdByRun` 返回 null 时退化到 `'general-chat'`，造成静默越权；`listSuspendedRuns` 缺 workspaceId 时返回空数组 | `mastra-facade.ts` `resolveAgentId` 缺失/null **抛错**；`listSuspendedRuns` 缺 workspaceId / agentId / threadId / resourceId **抛错**（不再退化空数组） | ✅ (f) |
| #5 | `requester_id` / `resolver_id` FK 约束（system-initiated 路径也要落真实 user） | `init.sql` 阶段 3.3 段：插入真实 `app_users` 行 `id=00000000-0000-0000-0000-0000000000a1, username='system-approval-worker'`；`requester_id` / `resolver_id` 保持 **NOT NULL FK**（**未**改 nullable）；system-initiated 路径走预设 UUID `00000000-0000-0000-0000-0000000000a1`；`createApprovalRequest` 强制 `requesterId` 非空、`agent_runs.created_by` NULL 时拒绝 | ✅ (c-2) / (x) |
| #6 | 测试用 in-memory replica 而非真实 state-machine | `tool-policy-state-machine.ts` + `tool-policy-timeout.ts` 真实 PG + 真实 state-machine；`tests/integration/tool-policy-pg.ts` 真实 PG 端到端 + FakeAgentFacade（fake resume stream yield `text-delta` + `done`） | ✅ (a)~(h) + `tests/unit/tool-policy-{state-machine,timeout}.ts` 改用真实 PG |

---

## 2. 真实 PG 已验证项（107 项断言通过）

测试命令：
```bash
cd backend && RUN_PG_TOOL_POLICY=1 npx tsx tests/integration/tool-policy-pg.ts
```
输出：**`Result: 107 passed, 0 failed`**

覆盖：

- **(a) 审批创建 + waiting_approval 保留**：executor **不**调 `stopRun`，Run 状态保持 `waiting_approval`；approval row 写入完整；`requesterId` 非空、`requester_id` 写入。
- **(b) 批准后真实消费 resume stream → Run → completed**：approve → `runResumeSchedulerOnce` 抢占 → 原子推 Run → 'running' + INSERT `run-resumed` 事件 + 写 `mastra_resume_started_at`（同事务）→ `facade.approveToolCall` 拿 `AsyncIterable<unknown>` → `consumeAgentStream` **真实消费** resume stream（fake yield `text-delta` + `done`）→ Run → `completed` + `messages.status='completed'` + SSE 事件。
- **(c) 拒绝（declined）**：用户 decline → `state-machine.resolveApproval` 写 `status='declined'` + `resolver_id` 落人类用户 UUID + `lease_owner` 清空 + `resolved_at` 写入 + `runResumeSchedulerOnce` 下次 tick 拾起 → `facade.declineToolCall` → `consumeAgentStream` → Run → `completed`。
- **(c-2) 超时平台身份（system-approval-worker）**：timeout worker 扫 `expires_at < now()` → `state-machine.expireApproval` **DB-only** 写 `status='expired'` + `resolver_id=00000000-0000-0000-0000-0000000000a1`（**不是** all-zero 占位）；`runResumeSchedulerOnce` 下次 tick 拾起 → `facade.declineToolCall(reason='expired')` → Run → `completed`。
- **(d) **W2 approve SDK 抛错 → reconciler 接管**：第一次 reconcile 路径写入 `approved_resume_indeterminate` + `resume_attempts=1` + `resolver_error='APPROVE_SDK_INDETERMINATE: …'` + Run 推回 `waiting_approval`（**保留** `mastra_resume_started_at`）；scheduler 不直接重调 SDK；`runReconcileIndeterminateOnce` 通过 `listSuspendedRuns` fail-closed 校验（fake 返回 `convH` 对应的 `SuspendedRunSnapshot`），校验通过 → `revertApprovalForReconcile` 写 `status='approved'` + 清 `mastra_resume_started_at` → scheduler 自然接管。
- **(e) scheduler 原子事务单飞**：Run 已不 `waiting_approval` 时 scheduler 跳过；同一 tick 内多 approval 并发抢占由部分唯一索引 (`mastra_resume_started_at IS NULL`) + 事务原子性兜底。
- **(f) `listSuspendedRuns` fail-closed**：缺 `workspaceId` / `agentId` / `threadId` / `resourceId` 即抛错（**不**返回空数组、**不**走 `general-chat` 兜底）。
- **(g) 跨重启接管**：模拟 lease 过期 + dead worker → `runReconcileIndeterminateOnce` 接管；原 decision / `resolver_id` / `resume_attempts` 保留。
- **(h) **W2 attempts 耗尽 + 人工介入终态保护**：3 次 W2 失败 → `resume_attempts >= MAX_RESUME_ATTEMPTS=3` → fail-closed：保留 `approved_resume_indeterminate` + 保留 `mastra_resume_started_at` + 覆盖 `resolver_error` 为 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED: …`；Run → `failed` + 相应 `error_code` + `run-failed` 事件 + `messages.status='failed'`（同事务）。**后续多次 tick 不再调 SDK / `listSuspendedRuns`**（`resume_attempts >= MAX` + `resolver_error NOT LIKE 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_%'` 双重防护）；approval 行、`mastra_resume_started_at`、人工介入错误信息全部保留供检索。
- **(x) `created_by` NULL 拒绝创建**：`repository.createApprovalRequest` 检测 `agent_runs.created_by` NULL → 拒绝；保证 `requester_id` 永远有合法 owner。
- **跨 workspace 隔离**：用 ws1 读 ws2 的 approval → `null`（不暴露存在性）；用 ws1 调 `resolveApproval` → `not_found`，SDK 未被调用。

---

## 3. W2 Reconciliation 闭合模型（PR-3.3 Replay Fix 后的真实形态）

| 触发 | 入口 | 行为 |
|---|---|---|
| W1（approve / `declineToolCall` 同步 throw，未产生 partial stream） | `runResumeSchedulerOnce` 调 SDK 立即抛错 | `runResumeSchedulerOnce` catch → 推 Run → `failed` + `error_code='SDK_RESUME_FAILED'` + `run-failed` 事件 + 释放 lease；**approval.status 不变**（仍 `approved` / `declined`） |
| W2（approve / `declineToolCall` 返回 stream，首个 yield 前抛错） | `consumeAgentStream` 在首个 `next()` 时抛错 | `runResumeSchedulerOnce` catch → 同事务写：`approval.status='approved_resume_indeterminate'` + `resume_attempts += 1` + `resolver_error='APPROVE_SDK_INDETERMINATE: …'` + Run 推回 `waiting_approval`（**保留** `mastra_resume_started_at`）+ `run-resume-failed` 事件 |
| W3（`consumeAgentStream` 在消费中途抛错） | `consumeAgentStream` 中段抛错 | `runResumeSchedulerOnce` catch → 推 Run → `failed` + `error_code='STREAM_CONSUMPTION_FAILED'`；approval 保持 `approved_resume_indeterminate`；W2 后续路径接管 |

`runReconcileIndeterminateOnce`（lease 到期后）：
1. **双重过滤**：`status='approved_resume_indeterminate' AND lease_expires_at < now() AND resume_attempts < MAX_RESUME_ATTEMPTS=3 AND (resolver_error IS NULL OR resolver_error NOT LIKE 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_%')`——人工介入记录**永久**退出扫描集
2. 调 `facade.listSuspendedRuns({ workspaceId, agentId, threadId, resourceId })`，**缺一即抛错**
3. `validateSuspendedRunsSnapshot` 严格校验 `runId` / `toolCallId` / `threadId` / `resourceId`，**缺一即抛错**
4. 校验通过 → DB-only `revertApprovalForReconcile`：`status='approved'` + 清 `mastra_resume_started_at` → `runResumeSchedulerOnce` 下次 tick 自然接管
5. 校验失败 / `resume_attempts >= MAX` → fail-closed：保留 `approved_resume_indeterminate` + 保留 `mastra_resume_started_at` + 覆盖 `resolver_error` 为 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED: …`（listSuspend 校验失败）或 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED: …`（attempts 耗尽）；**同事务**写 Run → `failed` + 相应 `error_code` + `messages.status='failed'` + `run-failed` 事件
6. 退避：`RESUME_RECONCILE_BACKOFF_MS = 30_000`，两次 reconcile 间隔不少于该值

---

## 4. 仍使用 fake Mastra 的边界（**PR-3.3 staging e2e 待办，非 Phase 4**）

| 边界 | 为何当前 fake | 何时替换为真实 Mastra |
|---|---|---|
| `MastraAgentFacade.approveToolCall / declineToolCall` | 测试只需验证状态机 ↔ SDK 边界协议（claim → mark started → SDK call → mark done → stream consumption → terminal）；fake stream yield `text-delta` + `done` 已覆盖完整路径 | staging 环境以真 SDK + 当前配置的真实 Provider（本机为 DeepSeek）跑 (a)~(h) — **属于 PR-3.3 staging e2e**，非 Phase 4 |
| `MastraAgentFacade.listSuspendedRuns` | fake 仅在 `threadId === convH.id` 时返回一条匹配 `SuspendedRunSnapshot`；fail-closed 抛错分支已覆盖 | staging 环境实测真实 Mastra 返回结构 |
| `consumeAgentStream` 三种 stream 异常形态 | W1 / W2 / W3 的兜底逻辑已实现并有 fake 失败用例覆盖；生产端 SDK 异常的具体形态（network error / rate limit / partial response）未做容灾演练 | staging 实测 |

> **禁止把 fake stream 集成测试称为真实生产 e2e**——这是当前验证状态的真实边界；e2e 在 staging 环境以真 SDK + 真模型跑完才算 PR-3.3 完整闭环。

---

## 5. 新增 / 修改的文件清单

### 后端核心
- `backend/database/init.sql` — 阶段 3.3 段插入 `app_users(id=00000000-0000-0000-0000-0000000000a1, username='system-approval-worker')`；`tool_approval_requests` 增 `mastra_resume_started_at` + `updated_at` + `resolver_error`；**保持** `requester_id` / `resolver_id` NOT NULL FK（**未**改 nullable）；`agent_run_events.type` 增 `run-resumed` / `run-resume-failed`。
- `backend/src/modules/tool-policy/types.ts` — `ApprovalRequestRow` 增 `mastraResumeStartedAt` / `resolverError` / `resumeAttempts`；`ResolveApprovalOutcome` 收窄为 `'approved' | 'declined' | 'not_found' | 'already_resolved' | 'lease_contended'`（**移除** `sdk_failed` / `lease_lost_during_sdk`）。
- `backend/src/modules/tool-policy/repository.ts` — `rowToApproval` 兼容 `mastraResumeStartedAt` / `resolverError` / `resumeAttempts`；`listApprovalsPendingResume`（**替换** `listApprovalsAwaitingResume` 旧名）；`listApprovalsPendingReconcile` 含 `resolver_error NOT LIKE 'APPROVAL_RECONCILE_MANUAL_INTERVENTION_%'` 过滤；`markMastraResumeStarted`；`markApprovalResumeIndeterminate`（W2 写 `approved_resume_indeterminate` + `resume_attempts += 1` + `resolver_error` + 保留 `mastra_resume_started_at`）；`revertApprovalForReconcile`（revert `approved` + 清 `mastra_resume_started_at`）；`markApprovalManualIntervention`（attempts 耗尽 / 校验失败终态）。
- `backend/src/modules/tool-policy/state-machine.ts` — **严格 DB-only**（不调 SDK、不消费 stream）；`resolveApproval` / `expireApproval` 仅写 DB；`reconcileInflightApprovals` 启动期扫 `('approving' | 'declining')`（`reconcileInflightApprovals()` 不再传 `leaseMs`）；`runApprovalSagas` 不再存在（旧 saga 被替换为 `runResumeSchedulerOnce`）。
- `backend/src/modules/tool-policy/timeout-worker.ts` — **严格 DB-only**（`startApprovalTimeoutWorker` / `runOnceSafely` / `expirePendingOnce` / `reconcileOnce` 全部移除 `leaseMs` 参数）；移除 `lease_contended` / `sdk_failed` / `lease_lost_during_sdk` outcome 分支；`summary.dbOnlyTakenOver` 取代 `summary.takenOver / summary.sdkFailed`。
- `backend/src/modules/tool-policy/mastra-facade.ts` — `resolveAgentId` 缺失/null **抛错**；`listSuspendedRuns({ workspaceId, agentId, threadId, resourceId })` 缺一即抛错；`MastraAgentFacade.approveToolCall / declineToolCall: (...) => Promise<AsyncIterable<unknown>>`。
- `backend/src/core/execution/run-executor.ts` — **唯一 SDK 调用 + stream 消费方**；approval-requested 分支不再写 `exitType='stopped'`；新增 `armedForResume` 标志 + 终态路径跳过；`runResumeSchedulerOnce`（resume scheduler）+ `runReconcileIndeterminateOnce`（W2 reconciler）；W2 exhausted 分支同事务写 approval + Run + messages + run-failed 事件；移除 `s.workspaceId` 检查；直接 `logger.{info,warn,error}` 取代 `logRequest`（无 `approvalId` 参数）。
- `backend/src/core/agent/runtime.ts` — 抽取 `consumeAgentStream(execution, stream)` 公共能力（首次 Run 与 resume 共享）；`persistApprovalRequested` 强制 `requesterId` 非空、`agent_runs.created_by` NULL 时**拒绝**创建（保证 `requester_id` 与 `resolver_id` 始终为 NOT NULL FK）；`requireToolApproval` 经 Tool Gateway 注入 `agent.stream()`。
- `backend/src/core/agent/tool-approval-gateway.ts`（新增）— Tool Gateway 包装层，写 `tool_approval_requests(status='pending')` + `agent_run_events(type='approval-requested')` + 通知 Mastra SDK 挂起。
- `backend/src/modules/runs/repository.ts` — `RunEventType` 增 `'run-resumed'` / `'run-resume-failed'`。
- `backend/src/server/routes/approvals.ts` — HTTP 层 **不**调 SDK、不持有 stream 句柄；`resolveApprovalHandler` 仅映射 `ResolveApprovalOutcome` 收窄 union；`rowToView` 序列化 `requesterId`（NOT NULL FK）+ `mastraResumeStartedAt` 给前端。
- `backend/src/server/bootstrap.ts` — 注册 approval routes + 安装 production facade + 启动 timeout worker。

### 测试
- `backend/tests/integration/tool-policy-pg.ts` — **真实 PG + FakeAgentFacade / fake stream**（107 项断言通过）；覆盖 (a)~(h) + (x) + 跨 workspace + 跨重启。
- `backend/tests/unit/tool-policy-state-machine.ts` — **重写**：in-memory replica → 真实 PG + 真实 state-machine；当前 DB-only `resolveApproval` / `expireApproval` + lease / 终态语义。
- `backend/tests/unit/tool-policy-timeout.ts` — **重写**：in-memory replica → 真实 PG + 真实 state-machine；当前 DB-only outcome。
- `backend/tests/unit/approvals-route.ts` — 路由 UUID 校验 + `rowToView` 映射 + 当前 `resolveApproval` union 收窄。
- `backend/tests/unit/tool-policy-repository.ts` — schema / FK / UNIQUE / partial 索引 / workspace 隔离 / 原子 resolve。
- `backend/tests/unit/tool-policy-evaluator.ts` + `tool-policy-resolver.ts` — 策略三态决策 + activeTools 过滤。
- `backend/tests/unit/dynamic-tool-resolution.ts` — run-time workspaceId 注入。
- `backend/tests/unit/tool-policy-runtime-filtering.ts` — gateway 注入 + Mastra SDK 路径。
- `backend/tests/unit/tool-policy-schema.ts` — schema 断言：status 含 `approving/declining/approved/approved_resume_indeterminate/declined/expired`；`requester_id` / `resolver_id` NOT NULL FK；`resolver_error` 人工介入前缀。
- `backend/tests/unit/tool-policy-sanitize.ts` — Tool 摘要脱敏 + SHA-256 hash 不变性。

---

## 6. 已知未验证项 / Codex 复查点

| 项 | 说明 |
|---|---|
| 真实 Mastra SDK 调用 | 当前测试 fake 注入；建议 staging 环境以真 SDK + 当前配置的真实 Provider（本机为 DeepSeek）跑 (a)~(h) — **属 PR-3.3 staging e2e**，**不**是 Phase 4 |
| `listSuspendedRuns` 在真实 Mastra 返回结构上实测 | fake 仅在 `threadId === convH.id` 时返回匹配快照；staging 应实测真实返回结构 + 缺字段抛错行为 |
| **W1 / W2 / W3 / W4 容灾形态** | W1（claim 事务提交前进程退出）由 scheduler 下次 tick 重新抢占；W2（approve SDK 抛 JavaScript 异常）由 `markApprovalResumeIndeterminate` + reconciler 接管；W2'（decline SDK 抛错）由 `failRun` 收尾；W3（stream 迭代抛错）同 W2 / W2'；**W4（worker 进程被直接杀死，JavaScript catch 不执行）由新加的 `sweepExpiredApprovalResumeLeases` 按 Tool 元数据 + approval 状态分流恢复**。W1 / W2 / W3 已有 fake 失败用例覆盖；**W4 已 Codex 实跑通过（`hard-crash-lease-recovery.ts`，32 passed, 0 failed）**。生产端 SDK 异常的具体形态（network error / rate limit / partial response）未做容灾演练。 |
| **多进程 resume SDK facade 单飞** | **PR-3.3.2 / 3.3.2.1 已 Codex 实跑通过**（`backend/tests/integration/multi-process-resume.ts` + `multi-process-resume-child.ts`，9 passed, 0 failed）。两个独立 Node 子进程 + IPC `START` 同步屏障 + 共享 `sdk_call_log` 表 + 全局 try/finally 兜底 schema 生命周期 + Windows ESM `--import` 经 `pathToFileURL` 包装 + ready 前 early-exit 兜底。**多实例生产部署下真实 Mastra SDK 并发去重、SSE 跨实例扇出、PostgresStore lock 行为仍未实测**——本测试**不能**被引用为"多实例生产并发 SDK 已验证"，仅验证 facade 层跨进程资源抢占（原子 `UPDATE ... WHERE mastra_resume_started_at IS NULL`）。 |
| **执行器终态 lease fencing** | **PR-3.3.2 / 3.3.2.1 已 Codex 实跑通过**（`backend/tests/integration/executor-terminal-lease-fence.ts`，`done / stopped / error` 三场景独立 seed 全部通过）。覆盖 `done` / `stopped` / `error` 三场景独立 seed，每个场景在 stream 落地前手动 UPDATE `lease_owner` 为外部 owner，断言 `completeRun / stopRun / failRun` 的 `lease_owner = WORKER_ID` fence 阻断对应终态写入；三场景均断言对应 `XxxRun 跳过：Run 已终态或当前 worker 已丢失 lease` 日志路径。**真实 stream 落地下迟到 worker 终态写入行为仍未实测**。 |
| **W2 reconciliation 非幂等 / 未注册 Tool 拒绝自动重试** | **PR-3.3.2 已收口**：`runReconcileIndeterminateOnce` 在调 `facade.listSuspendedRuns` **之前**校验 `getToolDefinition(approval.toolId).metadata.idempotent === true`，未注册或非幂等 Tool 直接 fail-closed 写 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED: tool <id> is not registered as idempotent; automatic approve replay is forbidden` + Run → `failed`，**不**调 SDK、不查 `listSuspendedRuns`。当前只有 `calculator`（`metadata.idempotent === true`）允许 W2 自动重放。生产路径测试：`backend/tests/integration/approval-reconcile-safety.ts`（**已 Codex 实跑通过**）。 |
| **W4 hard-crash 恢复** | **PR-3.3.2.1 生产代码已修复**（Codex 第二次 review 发现阻塞级 crash window）：新增 `sweepExpiredApprovalResumeLeases`（`backend/src/core/execution/approval-resume-recovery.ts`——PR-3.3.2.1 从 `modules/tool-policy/repository.ts` 拆分到 execution 层以消除跨聚合编排违反），由 `runLeaseSweeperOnce` / `sweepOnce` 在普通 `sweepExpiredLeases` **之前**调用；普通 `sweepExpiredLeases` 的 SQL 增加 `NOT EXISTS` 子句**排除** approval-resume Run，跨进程下两个 sweeper 真并行也安全（**不**依赖调用顺序），写入时清 `lease_owner / lease_expires_at / heartbeat_at`。`backend/tests/integration/hard-crash-lease-recovery.ts`（环境开关 `RUN_PG_HARD_CRASH_LEASE=1`）覆盖 7 项验收：(a) 幂等 Tool → `approved_resume_indeterminate` + Run → `waiting_approval`、(b) 非幂等 Tool → 人工介入 + Run → `failed`、(c) attempts 耗尽 → 人工介入、(d) 普通 running Run 仍走 `LEASE_EXPIRED`、(e) 两个 hard-crash sweeper 并发 SKIP LOCKED 单飞、(f) 终态后不存在 `approved + started_at + failed LEASE_EXPIRED` 孤儿组合、(g) hard-crash sweeper 与普通 `sweepExpiredLeases` 并发时 approval-resume Run **不**变 `failed + LEASE_EXPIRED`。**已 Codex 实跑通过（32 passed, 0 failed）。** |
| 前端 ApprovalCard ↔ 后端 approvals API 的真实 SSE 端到端联调 | **PR-3.3 已实现** `ApprovalCard` + `useApprovals` + `/v1/approvals` API + SSE `approval-requested` / `approval-resolved` 事件订阅（见 `frontend/src/features/chat/{components/ApprovalCard.tsx, useApprovals.ts, components/AssistantChatWorkspace.tsx}` + `frontend/src/types/approval.ts` + `frontend/src/lib/api.ts`）；当前唯一未验证的是**真实浏览器 + 真实后端 + 真实 SSE 推送的端到端联调**——属 PR-3.3 staging e2e 待办（与 Mastra SDK + 真模型 staging e2e 同批），**不**是 Phase 5 替代项，也**不**是 PR-3.3 功能未实现。前端 production build 已通过（保留 chunk-size / ineffective dynamic import warning，**仅**是 warning）。 |
| `system-approval-worker` 平台用户 UUID provisioning | 当前 init.sql 硬编码 `00000000-0000-0000-0000-0000000000a1`；多环境 provisioning 应抽到 seed script |

### PR-3.3.2 / 3.3.2.1 收尾新增测试（**Codex 已实跑通过**）

| 测试 | 路径 | 环境开关 | 验证范围 | 状态 |
|---|---|---|---|---|
| `approval-reconcile-safety.ts` | `backend/tests/integration/` | `RUN_PG_TOOL_POLICY=1` | lease fencing / reconciler backoff / **非幂等或未注册 Tool 拒绝自动重试** / 原子回滚 / 终态手工介入行退出扫描集 | **已 Codex 实跑通过** |
| `executor-terminal-lease-fence.ts` | `backend/tests/integration/` | `RUN_PG_TOOL_POLICY=1 RUN_PG_LEASE_FENCE=1` | 生产 `runResumeSchedulerOnce` + deferred `AsyncIterable` 路径下 `done / stopped / error` 三场景独立 seed，`completeRun / stopRun / failRun` 的 `lease_owner` fence 阻断对应终态写入；三场景均断言对应日志路径 | **已 Codex 实跑通过（三场景全部通过）** |
| `multi-process-resume.ts` + `multi-process-resume-child.ts` | `backend/tests/integration/` | `RUN_PG_MULTI_PROCESS=1` | 两个独立 Node 子进程并发接管同一 approval；`approveToolCall` 总计只调用 1 次；子进程 `exit 0`；全 schema 生命周期 try/finally 兜底；watchdog 仅在两个 child 都结束后才清除；Windows ESM `--import` 经 `pathToFileURL` 包装 | **已 Codex 实跑通过（9 passed, 0 failed）** |
| `hard-crash-lease-recovery.ts` | `backend/tests/integration/` | `RUN_PG_HARD_CRASH_LEASE=1` | W4 hard-crash sweeper：approved + 幂等 Tool → `approved_resume_indeterminate` + Run → `waiting_approval`；approved + 非幂等 Tool → 人工介入 + Run → `failed`；attempts 耗尽 → 人工介入；普通 running Run 仍走 `LEASE_EXPIRED`；两个 sweeper 并发 SKIP LOCKED 单飞；终态后不存在孤儿组合；跨实例并发（hard-crash 与普通 sweeper `Promise.all`）下 approval-resume Run **不**变 `failed + LEASE_EXPIRED` | **已 Codex 实跑通过（32 passed, 0 failed）** |

---

## 7. 类型 / 构建 / 测试状态（2026-09-08 收尾）

- `cd backend && npm run typecheck` → EXIT=0（全部通过）。
- `cd backend && npm run test:unit` → 全部通过。
- `cd backend && RUN_PG_TOOL_POLICY=1 npx tsx tests/integration/tool-policy-pg.ts` → **`107 passed, 0 failed`**（Codex 于 2026-09-08 使用真实 PostgreSQL 本轮重跑通过；测试 facade / resume stream 为 fake）。
- `cd backend && RUN_PG_TOOL_POLICY=1 npx tsx tests/integration/approval-reconcile-safety.ts` → **通过**（PR-3.3.2 收尾，真实 PG + FakeAgentFacade）。
- `cd backend && RUN_PG_TOOL_POLICY=1 RUN_PG_LEASE_FENCE=1 npx tsx tests/integration/executor-terminal-lease-fence.ts` → **`done / stopped / error` 三场景全部通过**（PR-3.3.2 收尾，真实 PG + 真实生产 `runResumeSchedulerOnce` + 注入 deferred AsyncIterable 的 FakeAgentFacade）。
- `cd backend && RUN_PG_MULTI_PROCESS=1 npx tsx tests/integration/multi-process-resume.ts` → **`9 passed, 0 failed`**（PR-3.3.2 / 3.3.2.1 收尾，两个独立 Node 子进程 + IPC 同步屏障 + 共享 schema + `sdk_call_log` 跨进程计数器）。
- `cd backend && RUN_PG_HARD_CRASH_LEASE=1 npx tsx tests/integration/hard-crash-lease-recovery.ts` → **`32 passed, 0 failed`**（PR-3.3.2.1 收尾，真实 PG + 直接调生产 `runHardCrashApprovalResumeSweeperOnce`）。
- `cd frontend && npm run build` → 成功（保留既有 chunk-size warning 与 ineffective dynamic import；**仅**是 warning，**不**是 error / failure）。
- `git diff --check` → 无非空白冲突。