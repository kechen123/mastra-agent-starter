# PR-3.3 Codex 实测记录（2026-09-04 起步，2026-09-07 PR-3.3.2 收尾，2026-09-07 PR-3.3.2.1 校正）

## 已验证（基线，2026-09-04）

- 后端 `npm run typecheck`、离线 `tests/unit/run.ts`、前端 `npm run build`、`git diff --check` 通过。前端保留 chunk-size / ineffective dynamic import 警告。
- 真实本机 PostgreSQL：`RUN_PG_TOOL_POLICY=1` 的 `tests/integration/tool-policy-pg.ts` 为 **107 passed, 0 failed**。该套故障注入仍使用 fake facade，不能算真实 SDK 容灾验收。
- 实际 Mastra Core **1.61.0** + 已配置 **DeepSeek** + 真实 HTTP/SSE：approve、decline、timeout 三条基础路径已跑通。不是 Anthropic，也不是已部署远端 staging。
- 真实进程重启：pending 后停止旧服务，再启动新进程并 approve，工具完成事件匹配原 toolCallId 和 nonce，Run completed。通过的 runId：`40585d53-f975-4b91-be22-312843518ba3`。

最终复跑基础三路径为 **3/3 passed**，approve 已使用加强后的工具结果断言：

| 场景 | Run ID | 终态 |
| --- | --- | --- |
| approve | `653092c5-0c46-42b8-8779-1d044925b2e9` | completed |
| decline | `393a13b2-2925-4726-8d9d-5264f3d4a137` | completed |
| timeout | `4658133e-7e43-422d-b0a2-f77f5be5377c` | completed；approval expired |

## PR-3.3.2 / 3.3.2.1 收尾代码已添加（2026-09-08，**已 Codex 实跑通过**）

本轮在保持 PR-3.3 已落地状态的前提下补齐硬崩溃容灾与并发安全代码；本轮新增的四项 PG 集成均已 Codex 实跑通过：

- `backend/tests/integration/executor-terminal-lease-fence.ts`：**`done / stopped / error` 三场景独立 seed 全部通过**（环境开关 `RUN_PG_TOOL_POLICY=1 RUN_PG_LEASE_FENCE=1`）。
- `backend/tests/integration/multi-process-resume.ts` + `multi-process-resume-child.ts`：**9 passed, 0 failed**（环境开关 `RUN_PG_MULTI_PROCESS=1`）。
- `backend/tests/integration/approval-reconcile-safety.ts`：**通过**（环境开关 `RUN_PG_TOOL_POLICY=1`）。
- `backend/tests/integration/hard-crash-lease-recovery.ts`：**32 passed, 0 failed**（环境开关 `RUN_PG_HARD_CRASH_LEASE=1`）。

测试细节：

- **执行器终态 lease fencing 集成测试**：在临时随机 schema 上驱动生产 `runResumeSchedulerOnce` + 注入 deferred `AsyncIterable` 的 FakeAgentFacade，**真实生产路径**上覆盖 `done` → `completeRun` / `stopped` → `stopRun` / `error` → `failRun` **三场景**。**stopped 场景使用真实生产入口 `abortRunByMessage(assistantMessageId)`（POST /messages/:id/stop 路由走的就是它）触发 AbortController.abort()**，而非 fake stream yield `{type:'stopped'}` raw chunk（`consumeAgentStream` 不识别 raw chunk）。每个场景在 stream 落地前手动 UPDATE `lease_owner='late-stale-worker-B'`，断言 Run.status NOT in 终态、messages.status NOT in 终态、对应 `run-*` 事件不存在、新 lease_owner 没被旧 worker 清掉、`approveToolCall` 仍只调用 1 次、Settle 判定用 `listActiveExecutions()` 轮询直到 runId 从活跃集里被移除（与 lease_owner DB 列状态解耦）。每场景断言对应日志路径（"completeRun 跳过" / "stopRun 跳过" / "failRun 跳过：Run 已终态或当前 worker 已丢失 lease"）。
- **多进程 resume SDK facade 竞争测试**： `fork` 两个独立 Node 子进程（不同 pid → 不同 `WORKER_ID`），通过 IPC `START` 信号同时调 `runResumeSchedulerOnce`；子进程把每次 `approveToolCall` 写入共享 `sdk_call_log` 表。**已 Codex 实跑通过（9 passed, 0 failed）**。测试**关键修复**（针对 Codex 2026-09-07 第一次 review + PR-3.3.2.1 第二次 review）：
  1. seed `approved` approval 时填写合法 `resolver_id = seedUserId`（避免 PG 23502 NOT NULL FK 违反）；
  2. 整个临时 schema 生命周期由最外层 `try/finally` 包裹——任意阶段失败（setup / seed / fork / 断言）都 kill 子进程、关 Pool、DROP schema、保留原始失败原因；
  3. watchdog 修复——不在第一个 child exit 时清除；两个 child 都结束后才 `clearTimeout`；超时后强杀两个 child 并以失败退出；
  4. 子进程轮询到达截止仍未收敛必须 `exit(3)`，收敛到非 `completed` 终态必须 `exit(4)`（不允许静默 `exit 0`）；
  5. **PR-3.3.2.1**：`backendRoot = pathResolve(here, '..', '..')`（上溯 2 层到 backend/）；tsx loader 路径解析为 `backend/node_modules/tsx/dist/loader.mjs`，绝对路径经 `pathToFileURL(...).href` 包装成 `file:///...` 后通过 `--import` 注入（Windows ESM 不接受 `E:\...`）；删除与最终值互相矛盾的中间变量（`tsxCli` / `childExecArgv` / `TSX_LOADER` 旧名 / `childExecArgvFinal`）；启动时校验 `CHILD_SCRIPT` 与 tsx loader 存在；ready 前 child exit 立即记 originalError；
  6. 不打印 DATABASE_URL 或其他秘密到日志。
- **reconciler 安全加固**：`backend/tests/integration/approval-reconcile-safety.ts`（环境开关 `RUN_PG_TOOL_POLICY=1`）**已 Codex 实跑通过**——覆盖非幂等 / 未注册 Tool 拒绝自动重试用例：reconciler 在调 `facade.listSuspendedRuns` **之前**用 `getToolDefinition(approval.toolId).metadata.idempotent` 校验 Tool 元数据，未注册或非幂等 Tool 直接 fail-closed。W2 自动重放**仅**适用于明确声明 `metadata.idempotent === true` 的 Tool（当前只有 `calculator`）。

## PR-3.3.2 硬崩溃容灾修复（2026-09-07，**生产代码已修改**）

**Codex 2026-09-07 第一次 review 指出**：原 `runResumeSchedulerOnce` 提交 `mastra_resume_started_at` + Run → `running` + worker 持有 lease 之后，若 worker 在 SDK 调用前 / 中 / 终态落库前被**直接杀死**（Node 进程死亡，JavaScript catch **不会**执行），则 `consumeResumeStream` 的 try/catch 永远不进，`markApprovalResumeIndeterminate` 不会被调用，`approval` 永远停在 `approved` + `mastra_resume_started_at NOT NULL`；`sweepExpiredLeases` 会把这种孤儿 Run 写成 `failed` + `LEASE_EXPIRED`，留下"approved + started_at NOT NULL + failed LEASE_EXPIRED"这种**永久无法自动恢复、也缺少明确审批人工介入标记**的孤儿状态——既不在 `listApprovalsPendingResume`（`started_at` 非空）也不在 `listApprovalsPendingReconcile`（status 不是 `approved_resume_indeterminate`）的扫描集里。

**修复**（`backend/src/core/execution/run-executor.ts` + `backend/src/core/execution/approval-resume-recovery.ts`）：

- 新增 `sweepExpiredApprovalResumeLeases()`（`backend/src/core/execution/approval-resume-recovery.ts`——PR-3.3.2.1 从 `modules/tool-policy/repository.ts` 拆分到 execution 层以消除跨聚合编排违反）—— 精确识别孤儿现场：
  - `agent_runs.status = 'running'`
  - `agent_runs.lease_expires_at < now()`
  - `tool_approval_requests.status IN ('approved', 'declined', 'expired')`
  - `tool_approval_requests.mastra_resume_started_at IS NOT NULL`
- 使用 `SELECT ... FOR UPDATE SKIP LOCKED` 让多个 sweeper 并发单飞——同一行不会被两个 sweeper 同时回收。
- 在普通 `sweepExpiredLeases` **之前**跑——避免普通 lease sweeper 把孤儿 Run 错误地写成 `failed` + `LEASE_EXPIRED`。
- 按 Tool 元数据 + approval 状态分流：
  - **approved + 幂等 Tool + attempts 未耗尽**：approval → `approved_resume_indeterminate` + `resume_attempts += 1` + `resolver_error` 写 `APPROVAL_RESUME_RECLAIMED_AFTER_HARD_CRASH: …` + 保留 `mastra_resume_started_at` + `lease_expires_at = now() + 30_000ms` backoff；Run → `waiting_approval` + 清 lease + 写 `run-resume-reclaimed` 事件。reconciler 后续在 lease 过期后接管。
  - **approved + 未注册 / 非幂等 Tool**：approval → `approved_resume_indeterminate` + 写 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_REQUIRED: tool <id> is not registered as idempotent; hard-crash reclaim refused automatic replay`；Run → `failed` + `error_code = APPROVAL_RESUME_RECLAIMED_MANUAL_INTERVENTION_REQUIRED` + 写 `run-failed` 事件。
  - **approved + attempts 耗尽**（`resume_attempts + 1 >= MAX_RESUME_ATTEMPTS`）：不再走重放；Run → `failed` + `error_code = APPROVAL_RESUME_RECLAIMED_ATTEMPTS_EXHAUSTED`；approval 写 `APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED: …`。
  - **declined / expired 硬崩溃**：**不**重放（用户决策已生效，decline 语义幂等）；Run → `failed` + `error_code = APPROVAL_RESUME_HARD_CRASH_FAIL_CLOSED_DECLINED` 或 `_EXPIRED`；`resolver_error` 写进程丢失诊断。
- 所有 SQL 同事务——approval / Run / `agent_run_events` 要么全部成功要么全部回滚；不会出现"approval 已改 + Run 未改"的脑裂状态。

**PR-3.3.2.1 跨实例并发修复（Codex 第二次 review 指出）**：上述"hard-crash 在普通 sweep 之前"仅在单进程下保证；跨进程下 hard-crash sweeper 与普通 `sweepExpiredLeases` 真并行，普通 sweeper 可能抢到 approval-resume Run 仍把它写成 `failed + LEASE_EXPIRED`。修复：普通 `sweepExpiredLeases` 的 SQL 增加 `NOT EXISTS` 子句**排除** approval-resume 行（`tool_approval_requests.status IN ('approved','declined','expired') AND mastra_resume_started_at IS NOT NULL`），**不**依赖调用顺序。同时清 `lease_owner / lease_expires_at / heartbeat_at`。
- 新增事件类型 `run-resume-reclaimed`：`init.sql` CHECK 约束、`RunEventType` TS 联合类型已同步。

新增真实 PG 集成测试 `backend/tests/integration/hard-crash-lease-recovery.ts`（环境开关 `RUN_PG_HARD_CRASH_LEASE=1`）覆盖 7 项验收，**已 Codex 实跑通过（32 passed, 0 failed）**：
  (a) approved + 幂等 Tool → 转 `approved_resume_indeterminate` + Run → `waiting_approval` + 写 `run-resume-reclaimed` 事件 + 清 lease + `resume_attempts += 1`；
  (b) approved + 非幂等 Tool → 人工介入 + Run → `failed` + `APPROVAL_RESUME_RECLAIMED_MANUAL_INTERVENTION_REQUIRED`；
  (c) attempts 耗尽 → 人工介入 + Run → `failed` + `APPROVAL_RESUME_RECLAIMED_ATTEMPTS_EXHAUSTED`；
  (d) 普通 running Run（无 approval 上下文）走原 `sweepExpiredLeases` 路径 → `failed` + `LEASE_EXPIRED`，不被 hard-crash sweeper 错误接管；
  (e) 两个 sweeper 并发：SKIP LOCKED 单飞，同一 Run 只回收一次；
  (f) 终态后不存在 `approved + mastra_resume_started_at NOT NULL + failed LEASE_EXPIRED` 孤儿组合；
  (g) **跨实例并发**：hard-crash sweeper 与普通 `sweepExpiredLeases` 真并行（`Promise.all`）时，approval-resume Run **不**得变 `failed + LEASE_EXPIRED`（依赖普通 sweeper 的 SQL `NOT EXISTS` 排除，**不**依赖调用顺序）；普通无审批 Run 仍被普通 sweeper 正确清理。

## crash window 准确语义（2026-09-07 校正）

之前 PR-3.3 文档中的 W1 / W2 / W3 描述**部分过时**。**Codex 2026-09-07 第一次 review 指出**：把"worker B 会从头消费 stream"作为默认行为是不准确的——这一描述仅在"claim 事务未提交"（W1）时成立；当 claim 事务已提交、worker 在 SDK 调用中 / 终态落库前被**直接杀死**时，JavaScript catch **不会**执行，必须依赖 lease sweeper 回收。

准确语义（已修正，见 `docs/architecture.md`）：

| 现场 | catch 是否能执行 | 恢复路径 |
|---|---|---|
| W1：claim 事务提交前进程退出 | N/A（事务 ROLLBACK） | scheduler 下次 tick 重新抢占；approval 留在终态 + `mastra_resume_started_at IS NULL` |
| W2：worker 调 `facade.approveToolCall` 抛 JavaScript 异常 | 是（try/catch 在 `consumeResumeStream` 内） | `markApprovalResumeIndeterminate` 原子写入；reconciler 在 lease 到期后调 `listSuspendedRuns` 严格校验（**仅限 `metadata.idempotent === true` 的 Tool**） |
| W2'：worker 调 `facade.declineToolCall` 抛 JavaScript 异常 | 是 | decline 语义幂等 → `run-failed` + 释放 lease；approval 状态不变；用户主动重发指令恢复 |
| W3：`consumeAgentStream` 在迭代中抛错 | 是（for await 的 try/catch） | 同 W2 / W2' |
| **W4（新增）：worker 进程被直接杀死**（Node 进程死亡 / OOM / 容器 kill）—— claim 事务已提交、`mastra_resume_started_at` 已写、Run 持 lease，但 worker 在 SDK 调用前 / 中 / 终态落库前死 | **否**（catch 不会执行） | **新加的 `sweepExpiredApprovalResumeLeases` 按 Tool 元数据 + approval 状态分流恢复**（见上节） |
| 迟到 worker 终态写入（`lease_owner` 已被其他 worker 接管） | N/A（worker 仍存活） | `completeRun / stopRun / failRun` 的 `WHERE lease_owner = WORKER_ID` 影响 0 行 → ROLLBACK |

**关键不变量**：JavaScript try/catch **只能**捕获同步 / 异步代码主动抛出的异常；Node 进程被直接杀死（SIGKILL / OOM / 主机重启）**不**会触发任何 catch。lease sweeper 是这种"硬崩溃"现场的唯一自动恢复机制。

## 本轮发现并修正

1. Agent 工厂忽略 tools；全局 Mastra.tools 不会自动注入 Agent。静态、请求级和模板工厂都必须显式设置 tools。
2. 打包后的异步初始化与 facade 装配存在竞态，重启时出现工具不存在却 Run completed。注册入口改为显式调用，后台按注册 → facade → scheduler 启动。
3. approve/decline 返回 MastraModelOutput，必须消费其 **fullStream**，不能迭代返回对象本身。
4. listSuspendedRuns 返回 `{ runs, total }`，每个 run 内是 `toolCalls[]`；按实际 SDK 类型转换，并严格检查身份。
5. runtime 创建审批漏写 NOT NULL resolver_id；修正为与 requester 同一真实初始身份。
6. live delta 拼接了无效 JSON；改用 JSON.stringify，并添加实际 publisher 回归测试。
7. 原验收脚本协议和终态判据错误；现在 approve 还必须验证工具结果，不能只看 completed。
8. 离线 Repository fixture 参数顺序过时，意外连接真实库；已修正。两个会重建 SQL 的旧 fixture 不再混入离线 runner，明确显示 skipped，不能当作通过。
9. **PR-3.3.2 收尾（2026-09-07 第一次 review）**：executor 终态 `completeRun / stopRun / failRun` 加 `lease_owner = WORKER_ID` fence（迟到 worker 无法覆盖终态）；reconciler 调 `listSuspendedRuns` 前置 `metadata.idempotent` 校验（非幂等 / 未注册 Tool 进人工介入）；生产路径测试覆盖 lease fencing（`executor-terminal-lease-fence.ts`）+ 多进程 SDK 单飞（`multi-process-resume.ts`）。
10. **PR-3.3.2.1 校正（2026-09-07 Codex 第二次 review）**：
    - 多进程测试的 approval seed 漏写 `resolver_id`（NOT NULL FK 违反）—— 已修正为 `resolver_id = seedUserId`；
    - 多进程测试缺少 schema 生命周期 try/finally 兜底 + watchdog 早清 bug —— 已修正；
    - 终态 lease fence 测试原本只覆盖 `done` → `completeRun` 单场景 —— 已扩展为 `done` / `stopped` / `error` 三场景独立 seed；
    - **生产代码真实存在阻塞级 crash window**：worker 进程被直接杀死时 JavaScript catch 不会执行，原 `sweepExpiredLeases` 会把孤儿 Run 错误地写成 `failed` + `LEASE_EXPIRED`，留下"approved + started_at NOT NULL + failed LEASE_EXPIRED"不可恢复的孤儿组合 —— 已加 `sweepExpiredApprovalResumeLeases` 专用 sweeper 修复。

## 未验证 / 限制

- **本轮新增的 PG 集成测试（`executor-terminal-lease-fence.ts` / `multi-process-resume.ts` + `child` / `approval-reconcile-safety.ts` / `hard-crash-lease-recovery.ts`）覆盖范围**：
  - `executor-terminal-lease-fence.ts` / `multi-process-resume.ts` + `child` / `approval-reconcile-safety.ts`：使用 FakeAgentFacade / fake resume stream，验证 worker 抢占层 + SDK 边界协议 + lease fencing + 跨进程资源抢占 + reconciler 安全防护；
  - `hard-crash-lease-recovery.ts`：**直接验证生产 `runHardCrashApprovalResumeSweeperOnce` 的 PostgreSQL 状态收敛**（不依赖 facade），覆盖 W4 hard-crash sweeper 7 项验收（含跨实例并发场景）；
  - `tool-policy-pg.ts`：真实 PG + FakeAgentFacade，覆盖 (a)~(h) + (x) + 跨重启 + 跨 workspace。
  上述测试**不是**完整真实 SDK 容灾验收。
- **多实例生产并发真实 SDK 行为未实测**：涉及 Mastra resume SDK/stream 边界的 PG 集成测试（`tool-policy-pg.ts` / `multi-process-resume.ts` / `executor-terminal-lease-fence.ts` / `approval-reconcile-safety.ts`）使用 FakeAgentFacade；`hard-crash-lease-recovery.ts` 直接验证生产 sweeper 的 PostgreSQL 状态收敛（不依赖 facade）。多实例生产部署下真实 Mastra SDK 并发去重、SSE 跨实例扇出、PostgresStore lock 行为未在本 PR 验收——属 PR-3.3 staging e2e 待办。
- 真实 SDK 网络结果不确定、流中断、浏览器 `ApprovalCard` 端到端联调仍未做——属 PR-3.3 staging e2e 待办。
- 终端 Run 清 `lease_owner / lease_expires_at / heartbeat_at` 的"清 lease"承诺：`backend/src/core/execution/run-executor.ts:1352-1509` 中 `completeRun / stopRun / failRun` 已显式 `lease_owner = NULL / lease_expires_at = NULL / heartbeat_at = NULL`；`backend/src/modules/runs/repository.ts::sweepExpiredLeases` 的 UPDATE 也显式清理这三列（`lease_owner = NULL / lease_expires_at = NULL / heartbeat_at = NULL`），同时 SQL 增加 `NOT EXISTS` 子句**排除** approval-resume Run（`tool_approval_requests.status IN ('approved','declined','expired') AND mastra_resume_started_at IS NOT NULL`），跨进程下 hard-crash sweeper 与普通 `sweepExpiredLeases` 真并行也安全（**不**依赖调用顺序）；hard-crash sweeper 路径同样显式清 lease 列。
- 当前环境档位只有 demo / production（production 禁止启动）。探针准确边界是"显式开启 + 非 production"，不是已具备 staging 身份认证的环境隔离。
- SDK 仍提示未配置 Memory、running snapshot 不参与 SDK 并发去重。不能宣称 exactly-once 业务副作用；外部写工具仍需要业务幂等键（PR-3.3.2 已收口 reconciler + hard-crash sweeper 的本地重试窗口，但**外部写 Tool 仍需业务幂等键**作为最后防线）。
- PG 集成按用户许可重建了本机 xuanshu 库，旧测试数据已清除，未创建备份。后续 HTTP 测试仅清理自己创建的会话；随机测试账号和失败现场可能保留。
- 没有 Docker、依赖升级、commit、push 或分支切换。

## 重启实验入口

`src/scripts/verify-local-approval.ts` 仅允许本机 xuanshu 库，创建专用随机账号；密码只驻留进程内。需要用户已授权启动的本机后端。

设置 `RUN_LOCAL_APPROVAL_ACCEPTANCE=1` 后执行 `node node_modules/tsx/dist/cli.mjs src/scripts/verify-local-approval.ts`。

重启场景额外设置 `STAGING_E2E_APPROVE_ONLY=1`、`STAGING_E2E_RESTART_PAUSE_MS=60000`、`STAGING_APPROVAL_E2E_APPROVAL_TTL_MS=300000`；服务端 TTL 必须一致。看到 restart-checkpoint 后只重启本次验收服务。脚本不会自行管理服务。

## 收尾 / 下次起点

- 用户要求现在收尾：不再进入 PR-4 开发。本轮测试服务已停止，4111 端口不再监听。
- 代码均在当前工作区，未提交、未推送；工作区还有用户 / Claude 既有的大量改动，不能把全部 diff 归为本轮新增，也不能回滚它们。
- 执行者仍为 Codex：后续审查、编码和验证不再交给 Claude Code。
- PR-3.3 仍需关注：真实网络抖动容灾、真实 SDK 并发去重、多实例 SSE 跨实例扇出、真实 `listSuspendedRuns` 在不同返回结构下的 fail-closed 行为；被离线 runner 明确排除的两个旧 PG fixture 尚未单独修订与验证；部分历史注释仍沿用旧 SDK / 全局工具自动注入的描述。
- 验收脚本目前第二次 SSE 订阅从头回放，因此报告包含重复历史事件；这不是已证明的重复执行。后续可用 Last-Event-ID 去重并加强消息持久化 / 拒绝不执行的断言。
- PR-4 只做了现状阅读，没有改代码：runtime 静态引用 knowledge service / retrieval，config 全局绑定 embedding 维度；bootstrap 与 schema 仍耦合 RAG。下一步先制定一个可独立验证的 Core/RAG 边界切片。
- 原阶段 4 包含存量向量六步迁移和回滚窗口，与当前"开发库可重新初始化、不维护旧库兼容"的项目规则不一致。先修订计划，不新增迁移链，不直接开展大范围 RAG 重写。
