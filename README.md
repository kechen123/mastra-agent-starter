# Mastra Agent Starter

面向业务团队的 [Mastra](https://mastra.ai/) 智能应用起步模板。它把对话、知识库、工具调用、技能编排和 Workspace 数据隔离整合为一套可直接运行的基础平台，帮助团队把精力放在业务 Agent 和业务能力本身，而不是重复搭建底层链路。

> 当前仅适合本地开发或受信任网络中的已认证演示环境；生产级租户治理、Tool 审批等能力仍在演进中。详细边界见 [架构文档](docs/architecture.md)。

## 开箱即用

- **可追溯的智能对话**：支持通用问答、SSE 流式输出、停止生成与重新生成。
- **带引用的知识库问答**：文档经 PostgreSQL + pgvector 检索后生成回答，并保留来源引用。
- **可组合的 Agent 能力**：按 Agent 组合知识库、Tool 和 Skill，避免为不同业务复制运行时。
- **受控的工具与技能体系**：Tool 统一注册、执行留痕；Skill 支持内置、本地业务和 skills.sh 市场来源。
- **开箱即用的个人工作区**：本地账号登录后自动拥有独立 Workspace，业务数据按 Workspace 隔离。

运行时已经具备持久化 Run、断点续传、Tool 策略（Workspace 隔离 + 三态评估 + activeTools 过滤）与 Tool 审批闭环（高风险 Tool 触发 `/v1/approvals` 收件箱；approve → Mastra `approveToolCall` 返回的 resume stream 接口、decline/expire → `declineToolCall` 返回的 resume stream 接口（代码通过 facade 调用 SDK，而**非** `streamAgent(prompt)` 重发）；超时 worker 仅做 DB-only `expired` 决策登记；Run Executor scheduler/reconciler 是唯一 SDK 调用与 stream 消费方）的能力；完整实现范围与仍在演进的能力请以 [当前架构](docs/architecture.md) 为准。

> **PR-3.3.2 / 3.3.2.1 验证状态（2026-09-08）**：本仓库 `backend/tests/integration/tool-policy-pg.ts` 在真实 PostgreSQL + `FakeAgentFacade`（fake resume stream）下覆盖 (a) waiting_approval 保留、(b) approve 后真实消费 resume stream 推 Run → completed、(c) decline 终态、(c-2) expire 走 `system-approval-worker` 平台身份、(d) W2 SDK transient fail → approve 进入 `approved_resume_indeterminate` + Run 推回 `waiting_approval` 等 reconciler 接管、(e) scheduler 原子事务单飞、(f) `listSuspendedRuns` fail-closed、(g) 跨重启接管、(h) W2 attempts 耗尽 → `APPROVAL_RECONCILE_MANUAL_INTERVENTION_ATTEMPTS_EXHAUSTED` 收敛、(x) `created_by` NULL 拒绝创建审批，**107 passed, 0 failed**（Codex 于 2026-09-08 使用真实 PostgreSQL 本轮重跑通过；测试 facade / resume stream 为 fake）。
>
> 本轮（PR-3.3.2 / 3.3.2.1）：
> - **生产代码修复**（Codex 2026-09-07 第一次 review 发现阻塞级 crash window；PR-3.3.2.1 第二次 review 指出跨聚合编排违反 + 跨实例并发竞态）：新增 `sweepExpiredApprovalResumeLeases`（`backend/src/core/execution/approval-resume-recovery.ts`——从 `modules/tool-policy/repository.ts` 拆分到 execution 层以消除跨聚合编排违反）按 Tool 元数据 + approval 状态分流恢复 worker 进程被直接杀死（JavaScript catch 不执行）的孤儿现场；新增事件类型 `run-resume-reclaimed`。普通 `sweepExpiredLeases` 的 SQL 增加 `NOT EXISTS` 子句**排除** approval-resume Run，跨进程下两个 sweeper 真并行也安全；写入时清 `lease_owner / lease_expires_at / heartbeat_at`。
> - **测试已 Codex 实跑通过**：`approval-reconcile-safety.ts`（真实 PG + FakeAgentFacade）覆盖 reconciler lease fencing / backoff / **非幂等或未注册 Tool 拒绝自动重试** / 原子回滚 / 终态手工介入行退出扫描集；`executor-terminal-lease-fence.ts`（真实 PG + 真实 `runResumeSchedulerOnce` + deferred AsyncIterable stream，**`done / stopped / error` 三场景独立 seed**——`stopped` 用真实生产入口 `abortRunByMessage(assistantMessageId)` 触发、Settle 用 `listActiveExecutions()` 轮询、三场景均断言对应 `XxxRun 跳过：Run 已终态或当前 worker 已丢失 lease` 日志路径）覆盖执行器终态写入 `lease_owner = WORKER_ID` fence 在生产路径下生效；`multi-process-resume.ts` + `multi-process-resume-child.ts`（两个独立 Node 子进程 + IPC 同步屏障 + 共享 schema + 显式 tsx loader 注入 `backend/node_modules/tsx/dist/loader.mjs` 转 file URL 后 `--import` + 全 schema 生命周期 try/finally 兜底 + watchdog 仅在两个 child 都结束后清除 + ready 前 early-exit 兜底）覆盖跨进程 `approveToolCall` 单飞；`hard-crash-lease-recovery.ts`（真实 PG + 直接调生产 `runHardCrashApprovalResumeSweeperOnce`）覆盖 W4 hard-crash sweeper 7 项验收（含跨实例并发场景：hard-crash sweeper 与普通 `sweepExpiredLeases` 真并行时，approval-resume Run **不**变 `failed + LEASE_EXPIRED`）。
>
> **基线**（PR-3.3.1 / PR-3.3 / PR-3.3.2 / 3.3.2.1）：Backend `npm run typecheck` 通过；Backend unit fixtures 通过；`git diff --check` 通过；frontend production build 通过（保留既有 chunk-size warning 与 ineffective dynamic import；**仅**是 warning，**不**是 error / failure）。
>
> **Codex 实测结果（本轮 PR-3.3.2.1）**：
> - `tool-policy-pg.ts`：**107 passed, 0 failed**（Codex 于 2026-09-08 使用真实 PostgreSQL 本轮重跑通过；测试 facade / resume stream 为 fake）；
> - `hard-crash-lease-recovery.ts`：**32 passed, 0 failed**；
> - `multi-process-resume.ts`：**9 passed, 0 failed**；
> - `executor-terminal-lease-fence.ts`：`done` / `stopped` / `error` 三场景全部通过；
> - `approval-reconcile-safety.ts`：通过。
>
> **验证边界（保留）**：涉及 Mastra resume SDK/stream 边界的 PG 集成测试（`tool-policy-pg.ts` / `multi-process-resume.ts` / `executor-terminal-lease-fence.ts` / `approval-reconcile-safety.ts`）使用 `FakeAgentFacade` / fake stream——验证的是 worker 抢占层 + SDK 边界协议 + lease fencing + 跨进程资源抢占；`hard-crash-lease-recovery.ts` 直接验证生产 sweeper 的 PostgreSQL 状态收敛（不依赖 facade）。已通过本机真实 Mastra Core 1.61.0 + DeepSeek 的 approve / decline / timeout HTTP/SSE 三条基础路径以及 pending 后进程重启再批准的工具结果校验。**完整容灾与多实例真实 SDK e2e 尚未验证**：真实网络故障、真实 SDK 多实例并发去重、真实 `listSuspendedRuns` 返回结构、SSE 跨实例扇出、真实浏览器 UI 联调、真实 staging 部署、PostgresStore 在多实例下的 lock 行为——这些属 PR-3.3 staging e2e 待办，**不是** PR-3.3.2 / 3.3.2.1 的功能缺口。详见 [实测记录](docs/runbooks/2026-09-04-approval-verification.md) 与 [架构](docs/architecture.md)。

## 快速开始

开始前请准备：

- Node.js 22+
- PostgreSQL 15+
- Docker（可选；用于启动本地 PostgreSQL）
- DeepSeek API Key 和 Embedding Provider 凭据

### 配置本地环境

PowerShell：

```powershell
Copy-Item backend/.env.example backend/.env
# 编辑 backend/.env，填写本地凭据；不要提交该文件
docker compose up -d
```

首次创建数据库数据卷时会执行 `backend/database/init.sql`。如需手动初始化或重建本地数据库，请先阅读 [开发指南](docs/development.md)，避免对共享数据库执行初始化。

### 启动服务

```powershell
Set-Location backend
npm ci
npm run migrate
npm run users:create -- --username alice
npm run dev
```

创建账号时，密码会在交互式终端中输入，不会作为命令行参数保存。

在另一个终端执行：

```powershell
Set-Location frontend
npm ci
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)，使用刚创建的账号登录。

### 提交前检查

```powershell
Set-Location backend
npm run typecheck

Set-Location frontend
npm run lint
npm run build
```

服务可用性可通过 `GET /healthz` 检查进程，通过 `GET /readyz` 检查数据库、LLM 与 Embedding 基础配置；后者在依赖未就绪时会返回 `503`，且不会泄露凭据。

## 在此基础上扩展

业务实现应落在既有扩展点中，避免直接耦合 Mastra Runtime：

| 目标 | 入口 |
| --- | --- |
| 新增 Agent | `backend/src/agents/`：复制 `_template`，再在 `backend/src/agents/index.ts` 注册 |
| 新增 Tool | `backend/src/tools/`：复制 `_template`，在 `backend/src/tools/index.ts` 注册，并配置对应 Agent 的 `toolIds` |
| 新增本地业务 Skill | `backend/src/skills/local/<your-skill>/SKILL.md`：重启后端后自动发现，再通过 API 绑定 |
| 安装市场 Skill | 前端 Skills 页面；安装内容存放在 `backend/market-skills/` |
| 新增业务模块 | `backend/src/modules/`：保持与核心运行时分层，按 Workspace 传递并校验归属 |
| 新增 HTTP API | `backend/src/server/routes/`：并在 `backend/src/server/bootstrap.ts` 的 `apiRoutes` 注册 |
| 修改品牌或默认模型 | `backend/src/config.ts` 与环境变量 `APP_NAME`、`APP_SHORT_NAME`、`LLM_PROVIDER`、`LLM_MODEL` |

新增 Agent、Tool 或 Skill 的常规路径是“复制模板 → 填写业务定义 → 在唯一入口注册”。开发约束与完整示例见 [扩展指南](docs/extending.md)。后端代码改动至少执行 `npm run typecheck`，前端代码改动至少执行 `npm run build`；不要把真实密钥、Token 或共享数据库配置提交到仓库。

## 深入了解

- [当前实现架构](docs/architecture.md)：已落地能力、数据流、安全边界和已知未验证项。
- [目标架构（V2）](docs/architecture-v2.md)：后续演进设计，不代表当前已经实现。
- [实施计划](docs/implementation-plan.md)：从现状到 V2 的阶段与 PR 切片。
- [Agent 系统](docs/agents.md)
- [Tool 系统](docs/tools.md)
- [Skill 系统](docs/skills.md)
- [开发指南](docs/development.md)
- [扩展指南](docs/extending.md)

文档表述冲突时，以 `docs/architecture.md` 记录的当前实现事实为准。

## 许可证

MIT
