# PR-3.3.1 — Staging Tool Approval e2e 验收 Runbook

> **状态更新（2026-09-04）**：已在本机真实 PG + Mastra 1.61 + DeepSeek 执行基础三路径和 pending 后重启批准。不是远端 staging 全矩阵验收，详见 [实测记录](2026-09-04-approval-verification.md)。
> 任何代码 / 文档 / 计划文档**不得**把 staging 验收写成"已通过"。

本 runbook 描述如何在 staging 环境跑 PR-3.3.1 的 Tool Approval 端到端
验收脚本，覆盖 **真实 Mastra 1.61 SDK + 真实模型 + 真实 HTTP/SSE**。

## 1. 覆盖范围与不覆盖范围

### 覆盖

| 路径 | 真实性 |
|---|---|
| `POST /v1/conversations` / `/v1/conversations/:id/messages` | 真实 HTTP |
| `GET /v1/runs/:runId/events` SSE | 真实 SSE |
| `GET /v1/approvals` / `/v1/approvals/:id` | 真实 HTTP |
| `POST /v1/approvals/:id/resolve` | 真实 HTTP |
| `requireToolApproval` Tool 挂起 → approval-requested → Run `waiting_approval` | 真实 Mastra SDK |
| `facade.approveToolCall` / `declineToolCall` resume stream | 真实 Mastra SDK |
| timeout worker → `expired` + scheduler 调 `declineToolCall(reason='expired')` | 真实 backend worker |
| `system-approval-worker` 平台用户 UUID 收敛身份 | 真实 DB |

### 不覆盖（属 PR-3.3.1 之外的边界）

| 边界 | 原因 |
|---|---|
| W2 approve SDK 抛错人为注入 | 自动化容灾演练属 PR-3.3 Replay Fix 之外的阶段 |
| 多 backend 实例并发抢占 | 需多进程演练；本脚本单连接 |
| 进程重启 / 跨重启 resume | `recoverSuspendedRunsOnce` 在 PR-3.3 Replay Fix 范围 |
| 浏览器 UI（`ApprovalCard` 渲染 / `useApprovals` 事件订阅） | 浏览器 E2E 属前端 runbook |
| Provider（DeepSeek 等）真实网络错误的容灾 | 自动化故障注入属 PR-3.3.2+ |
| 真实业务副作用 | Tool + Agent 均**零副作用**；probe 不读 DB / 不发请求 |

## 2. 前置条件

| 项 | 说明 |
|---|---|
| 部署档位 | `DEPLOYMENT_PROFILE=demo`（**绝不能** =`production`，启动会被拒） |
| 后端 | `ENABLE_STAGING_APPROVAL_PROBE=true` 启动 |
| 模型 | `LLM_PROVIDER` / `LLM_MODEL`（或旧 `AGENT_CHAT_MODEL`）已配置真实模型 |
| Mastra SDK | `@mastra/core` 1.61.0（已 lockfile 锁死，无需升级） |
| PostgreSQL | 已初始化；`system-approval-worker` 平台用户已 seed（init.sql 阶段 3.3 段） |
| 专用账号 | 一个 staging 凭据，建议专门建账号 `staging-e2e-probe`，密码与生产 / dev 完全独立 |

## 3. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `RUN_STAGING_TOOL_APPROVAL_E2E` | 是 | 必须为 `1`；缺省脚本立即 SKIP 退出 |
| `STAGING_E2E_BASE_URL` | 是 | staging 后端的公开 base URL（如 `https://staging.xuanshu.example`）；脚本只走此 URL |
| `STAGING_E2E_USERNAME` | 是 | 专用 staging 账号用户名；不要混用通用账号 |
| `STAGING_E2E_PASSWORD` | 是 | 密码；脚本内部仅用作 `POST /auth/login` 的请求体，**不**打印到 stdout |
| `STAGING_APPROVAL_E2E_APPROVAL_TTL_MS` | timeout 场景必填 | 1000–300000 整数；仅在 `ENABLE_STAGING_APPROVAL_PROBE=true` 且 `DEPLOYMENT_PROFILE != production` 时生效 |
| `DEPLOYMENT_PROFILE` | 后端启动已设 | 仅 `demo` 允许启用探针；`production` 时即便设了 ENABLE 也会被启动器拒绝 |
| `ENABLE_STAGING_APPROVAL_PROBE` | 后端启动已设 | 启用 staging 探针；缺省则 `/agents` 不暴露 `staging-approval-probe`，脚本立刻退出 |

## 5. 执行顺序

```bash
# 1. 部署 staging 后端（一次性）
export DEPLOYMENT_PROFILE=demo
export ENABLE_STAGING_APPROVAL_PROBE=true
export LLM_PROVIDER=deepseek        # 或已在用的 Provider
export LLM_MODEL=deepseek-v4-flash  # 与 Provider 匹配
# 数据库连接按既有运维流程注入。

cd backend && npm run start

# 2. 健康 / 就绪探针
curl -fsS https://staging.xuanshu.example/health
curl -fsS https://staging.xuanshu.example/readiness

# 3. 校验探针真的启用
curl -fsS --cookie 'session=<…>' https://staging.xuanshu.example/agents | jq '.agents[].id' | grep staging-approval-probe
curl -fsS --cookie 'session=<…>' https://staging.xuanshu.example/tools  | jq '.tools[]  | select(.id=="staging-approval-probe") | .metadata'

# 4. 跑 e2e（每场景一个独立 Run + 独立 SSE 订阅）
cd /path/to/backend
RUN_STAGING_TOOL_APPROVAL_E2E=1 \
STAGING_E2E_BASE_URL=https://staging.xuanshu.example \
STAGING_E2E_USERNAME=staging-e2e-probe \
STAGING_E2E_PASSWORD='<redacted>' \
STAGING_APPROVAL_E2E_APPROVAL_TTL_MS=30000 \
npx tsx src/scripts/staging-tool-approval-e2e.ts
```

## 4. 三条验收场景

### 4.1 approve

- 真实模型生成 `tool-call-approval` chunk → backend 写
  `tool_approval_requests(status='pending')` + `agent_run_events(type='approval-requested')`
  + Run `waiting_approval`；
- 脚本通过 `/v1/approvals/:id/resolve` `decision=approve`；
- 等待 `runResumeSchedulerOnce`（worker 1s tick）调
  `facade.approveToolCall({runId, toolCallId})` 拿回 resume stream；
- `consumeAgentStream` 真实消费 resume 流到 `done` → Run `completed`。

| 期望 SSE 事件 | 期望 Run 终态 | 期望 approval 终态 |
|---|---|---|
| `run-queued` → `run-started` → `approval-requested` → `run-resumed` → `run-completed` | `completed` | `approved` |

### 4.2 decline

- 同 4.1 前两段；
- 脚本通过 `/v1/approvals/:id/resolve` `decision=decline`；
- worker 调 `facade.declineToolCall({runId, toolCallId, reason})` 拿回 resume stream；
- `consumeAgentStream` 消费到 `done` / `error`，Run 进 `failed`（resume 流语义是 "tool was declined"，模型再产出文本则 Run `completed`，否则 `failed`）。

| 期望 SSE 事件 | 期望 Run 终态（任一） | 期望 approval 终态 |
|---|---|---|
| `run-queued` → `run-started` → `approval-requested` → `run-resumed` → `run-failed`（或 `run-completed`） | `failed` 或 `completed` | `declined` |

### 4.3 timeout（必设 STAGING_APPROVAL_E2E_APPROVAL_TTL_MS）

- 同 4.1 前两段；
- 脚本**不**调 resolve；让 approval 自然超时；
- 验证三件事：
  1. approval 终态 `expired`，`resolver_id = system-approval-worker`；
  2. timeout worker（15s tick）触发 `expireApproval` 把 pending 转 expired；
  3. resume scheduler 在下个 tick 调 `facade.declineToolCall(reason='expired')` 并消费 resume 流 → Run 进 `failed`（或 `completed`，与 decline 同语义）。

| 期望 SSE 事件 | 期望 Run 终态 | 期望 approval 终态 |
|---|---|---|
| `run-queued` → `run-started` → `approval-requested` → `run-resumed` → `run-failed`（或 `run-completed`） | `failed` 或 `completed` | `expired`（resolver=system-approval-worker） |

TTL 调短（建议 30_000ms）可让 timeout 场景在 60 秒内收尾；脚本 timeout = `max(60_000, ttl + 60_000)` 毫秒，覆盖 worker tick + scheduler tick + SDK 真实延迟。

## 6. 失败证据收集

| 现象 | 收集什么 |
|---|---|
| SSE 未收到 `approval-requested` | 复制脚本 stdout（其中包含 `sseEvents: [...]`，已脱敏）+ 后端 `agent_run_events` 表中 `runId` 对应的所有事件 + 真实模型最后一次 tool-call chunk（从后端日志） |
| approve 后 Run 未到 `completed` | 同上 + `/v1/approvals/:id` 当前状态 + 后端 `tool_approval_requests` 行 `resolver_error` |
| timeout 后 approval 仍是 `pending` | 后端 timeout worker 日志（`approval worker: 发现过期 pending`） + `listExpiredPendingApprovals` SQL 直查 |
| 模型未按指令调探针 | `agent_run_events` 中**没有** `tool-call-started`（toolId=`staging-approval-probe`） + 后端日志中模型完整 prompt 输出（已脱敏） |
| `listSuspendedRuns` 真实返回结构不符 | 后端 `runReconcileIndeterminateOnce` 日志 + mastra SDK 版本号（package.json） + 后端日志中 `agent.listSuspendedRuns(...)` 的 raw payload（脱敏） |

## 7. 清理边界

| 操作 | 允许 | 备注 |
|---|---|---|
| 删本脚本创建的 conversation + message + run + approval 行 | ✅ | 通过 `DELETE /v1/conversations/:id` 走标准业务路径 |
| DROP / TRUNCATE 任何表 | ❌ | 脚本不持有 SQL 客户端 |
| 删 staging 用户 / Workspace | ❌ | 脚本不调用户管理 API |
| 改既有用户 / Workspace 配置 | ❌ | 脚本只读 `/agents` `/tools` `/approvals` |
| 触发 mastra SDK 失败 / 网络分区 | ❌ | 属 PR-3.3.2 自动化容灾范围 |
| 多进程并发 | ❌ | 需手动起两个 backend 实例 + 共享 DB；非本阶段 |

## 8. 已知限制 / 边界

- **不**覆盖浏览器 UI（`ApprovalCard` / `useApprovals`）：属前端 runbook；
- **不**覆盖进程重启恢复（`recoverSuspendedRunsOnce`）；
- **不**覆盖多实例并发抢占；
- **不**覆盖 Provider 网络错误的容灾演练；
- 真实模型**必须**按指令调探针；若模型漏调，脚本 fail-fail，不重试；
- 真实 Mastra SDK 异常的具体表现（network error / partial response）**不**做容灾演练。

## 9. 维护

- 任何 Tool / Agent 字段调整需同时更新 §4 期望事件列表；
- 真实 SDK 升版需同时跑 PR-3.3 集成测试 + 本 runbook 三条场景；
- 新增 staging-only Tool / Agent 必须沿用 `ENABLE_STAGING_APPROVAL_PROBE` 与
  `DEPLOYMENT_PROFILE=production` 守卫，绝不能漏。
