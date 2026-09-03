# Mastra Agent Starter

> **当前进度（2026-09-02）**：
> - 阶段 1（Workspace 隔离与 Skill 三层模型）已合并落地；
> - 阶段 2（持久化 Run、幂等 POST、SSE 断点续传与服务端 Draft）已合并落地；
> - **阶段 3.0（Durable Agent Runtime）进行中**：
>   - 已落地：Mastra 接入 `@mastra/pg` PostgresStore（独立 schema `mastra_runtime`）；
>     Tool 走 Mastra 公共注册路径（`Mastra({ tools })` + per-request `activeTools`）；
>     业务 ↔ Mastra 标识映射（`agent_runs.id`→`runId`、`conversations.id`→`threadId`、
>     `workspaces.id`→`resourceId`）已通过 `agent.stream()` 公开 streamOptions 透传；
>     `infrastructure/mastra/instance.ts` 工厂隔离 server / Skill / run executor 副作用。
>   - **未实测**："跨重启恢复审批 Run" 的端到端集成（v1.x 公开 API 已具备
>     关键字段，但完整 snapshot 持久化与跨进程恢复未在本分支跑过真实
>     PostgreSQL 集成测试）；`storage: false` 业务 ID 缺一即标识映射失效。
> - 阶段 3.x 仍未实现：审批表、审批 API、审批 UI、Tool Policy；本次仅为前置条件。
>
> 协议与目标以 [`docs/architecture-v2.md`](docs/architecture-v2.md) 为准，已实现事实以 [`docs/architecture.md`](docs/architecture.md) 为准。

Mastra Agent Starter 是一个基于 [Mastra](https://mastra.ai/) 框架的智能对话平台，支持通用对话与知识库问答两种模式，具备可扩展的 Tool Registry、Skill Registry 和 Agent 能力绑定系统。

## 当前保留的能力

- 通用对话 Agent
- 知识库问答 Agent（基于 PostgreSQL + pgvector 的语义检索，回答附带引用来源）
- 流式对话（SSE）、停止生成、重新生成
- Tool 注册表与执行审计（每次 Tool 调用持久化到 `tool_executions`）
- Skill 注册表（内置 / 本地 / skills.sh 市场）与 Skill → Agent 绑定
- 会话持久化、历史管理
- 本地账号密码登录，以及按个人 Workspace 隔离的业务数据
- **阶段 3.0（进行中）**：Mastra 持久化运行时（Mastra 公共注册路径 + PostgresStore schema 隔离 + Tool 全局注册 + 业务↔Mastra 标识映射），为后续 Tool Policy / 审批建立可恢复基础。跨重启恢复审批 Run 尚未做端到端实测；详见 `docs/architecture.md` § Phase 3.0 与 `docs/architecture-v2.md` §5。

## 功能特性

- **通用对话 Agent**：日常问答、百科、技术支持
- **知识库问答 Agent**：基于 PostgreSQL + pgvector 的语义检索，回答附带引用来源
- **Tool Registry**：统一注册与安全管理内置及自定义工具（计算器、时间获取等）
- **Skill Registry**：模块化指令技能系统，支持内置技能与 skills.sh 市场安装
- **Agent-Skill 绑定**：为不同 Agent 动态绑定/解绑技能组合
- **流式对话**：Server-Sent Events (SSE) 实时推送生成内容
- **工具执行审计**：所有 Tool 调用持久化到数据库，前端实时展示执行状态
- **会话管理**：完整的对话历史持久化、停止生成、重新生成

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Mastra (~1.61.0), TypeScript, PostgreSQL |
| 前端 | React 19, Vite, Tailwind CSS 4, TypeScript |
| AI | DeepSeek（当前唯一正式启用的 LLM Provider） |

## 品牌与 LLM 配置

产品名、默认模型都通过 `backend/src/config.ts` + `backend/src/infrastructure/llm/` 集中管理，并可通过环境变量覆盖。

**当前 Starter 唯一正式支持的 LLM Provider 是 DeepSeek**；OpenAI、Anthropic、Gemini、Azure、Ollama 以及 OpenAI-compatible 部署的真实调用均**不在本阶段范围内**——它们只在 `infrastructure/llm/` 中预留了清晰的扩展边界。

| 字段 | 环境变量 | 默认值 | 用途 |
|------|---------|-------|------|
| `appName` | `APP_NAME` | `Mastra Agent Starter` | 前端 UI 主标题、`GET /capabilities` 返回的产品名 |
| `appShortName` | `APP_SHORT_NAME` | `Mastra` | 侧边栏 logo、空状态文案中的简称 |
| `chatProvider` | `LLM_PROVIDER` | `deepseek` | 当前 Registry 仅注册 `deepseek`；未注册值在首次解析模型时被明确拒绝 |
| `chatModel` | `LLM_MODEL` | `deepseek-v4-flash` | **不含** `deepseek/` 前缀的模型短名；完整 ID 由 Adapter 拼接 |
| `DEEPSEEK_API_KEY` | — | 无默认 | DeepSeek 凭据；缺失时 Agent 工厂首次被调用会抛错（不输出 key 本身） |
| `DEPLOYMENT_PROFILE` | `demo` | `demo` | 当前只允许本地或受信任网络演示；`production` 会拒绝启动，防止匿名模板被误部署到公网 |

历史变量 `AGENT_CHAT_MODEL` 形如 `deepseek/<model>` 时仍可解析为对应模型并输出弃用警告，但推荐改用 `LLM_PROVIDER` + `LLM_MODEL`；`XUANSHU_CHAT_MODEL` 仅作为更旧变量的弃用警告。

新增 Provider 时**无需**修改任何 Agent、Runtime、Route、Frontend 业务代码：在 `backend/src/infrastructure/llm/providers/<provider>.ts` 新建 Adapter，并在 `infrastructure/llm/registry.ts` 显式注册即可。

## 快速开始

### 前置要求

- Node.js 22+
- PostgreSQL 15+
- Docker（可选，用于一键启动数据库）

### 安装与启动

PowerShell：

```powershell
# 1. 创建本地配置并填写真实的 DeepSeek / Embedding 凭据
Copy-Item backend/.env.example backend/.env

# 2. 启动本地 PostgreSQL；首次创建数据卷时会自动执行 Schema 基线
docker compose up -d

# 3. 安装后端依赖；初始化数据库（执行唯一 init.sql）
Set-Location backend
npm ci
npm run migrate

# 4. 创建第一个本地登录账号（密码通过交互式终端输入，不走命令行参数）
npm run users:create -- --username alice

# 5. 启动后端
npm run dev
```

Git Bash：

```bash
# 1. 创建本地配置并填写真实的 DeepSeek / Embedding 凭据
cp backend/.env.example backend/.env

# 2. 启动本地 PostgreSQL；首次创建数据卷时会自动执行 Schema 基线
docker compose up -d

# 3. 安装后端依赖；初始化数据库（执行唯一 init.sql）
cd backend
npm ci
npm run migrate

# 4. 创建第一个本地登录账号
npm run users:create -- --username alice

# 5. 启动后端
npm run dev
```

新终端启动前端：

```bash
cd frontend
npm ci
npm run dev
```

访问 http://localhost:5173，使用刚才创建的用户名 / 密码登录。

### 验证

后端类型检查：

```bash
cd backend
npm run typecheck
```

前端 Lint 与构建：

```bash
cd frontend
npm run lint
cd frontend
npm run build
```

CLI 调试：

```bash
cd backend
npm run ask
```

服务探针：

- `GET /healthz`：仅确认后端进程存活。
- `GET /readyz`：检查数据库、LLM 凭据与 Embedding 基础配置；任一缺失时返回 `503`，且不会泄露凭据。

## 项目文档

> **三份架构文档的定位**（避免混读）：
> [`docs/architecture.md`](docs/architecture.md) 描述**当前已实现**的系统（as-built），本 README 陈述的所有能力都以它为准；
> [`docs/architecture-v2.md`](docs/architecture-v2.md) 是**尚未实现**的目标架构设计（V2.3.5），只作为演进依据，**不描述任何现有代码**；
> [`docs/implementation-plan.md`](docs/implementation-plan.md) 是从当前实现走到 V2 的落地路径（阶段 0～5 的 PR 切片）。
> 三者冲突时，**以 `architecture.md` 为当前事实**。

- [架构总览（当前实现）](docs/architecture.md)
- [V2 目标架构设计（未实现）](docs/architecture-v2.md)
- [V2 实施计划（阶段 0～5 / PR 切片）](docs/implementation-plan.md)
- [Agent 系统](docs/agents.md)
- [Tool 系统](docs/tools.md)
- [Skill 系统](docs/skills.md)
- [开发指南](docs/development.md)
- [扩展指南](docs/extending.md)

## 二次开发从哪里开始

| 想要做的事 | 改哪里 |
|------------|--------|
| 新增 Agent | `backend/src/agents/`（复制 `_template` 后改 `agent.ts` / `instructions.ts`，再到 `backend/src/agents/index.ts` 注册） |
| 新增 Tool | `backend/src/tools/`（复制 `_template` 后改 `tool.ts`，再到 `backend/src/tools/index.ts` 注册，并把它加入对应 Agent 的 `toolIds`） |
| 新增业务 Skill | `backend/src/skills/local/<your-skill>/SKILL.md`（无需写 TS，重启后自动发现，再通过 `POST /skills/:id/bind` 绑定） |
| 安装市场 Skill | 前端 Skills 页面（搜索 skills.sh → 预览 → 安装），实际落盘目录是 `backend/market-skills/` |
| 平台能力 | `backend/src/core/`、`backend/src/modules/` —— 框架无关的注册表、运行时、Session / KB / Document 业务模块；普通二开不应修改 |
| HTTP 路由 | `backend/src/server/routes/`（新增路由后追加到 `backend/src/server/bootstrap.ts` 的 `apiRoutes`） |
| 品牌/默认模型 | `backend/src/config.ts` + 环境变量 `APP_NAME` / `APP_SHORT_NAME` / `LLM_PROVIDER` / `LLM_MODEL` |

> 新增 Agent / Tool / Skill 的最短路径：复制 `_template` → 改少量字段 → 在唯一注册入口追加一行 → 重启后端。具体步骤与示例见 `docs/extending.md`。

## 核心概念

### Capability Resolver

Mastra Agent Starter 采用 Capability Resolver 模式处理 Agent 能力：

```
Conversation → AgentDefinition → Tool Registry + DB Bindings → Skill Registry → Mastra Runtime
```

每个 Agent 定义包含能力矩阵（`knowledgeBase` / `citations` / `tools` / `skills`），运行时根据当前会话状态动态解析所需的 Tools 和 Skills，而非静态绑定。所有差异由能力矩阵与工厂方法承担，**严禁**在 Runtime 中按 `agentId` 硬编码分支。

### Tool 与 Skill 的区别

| 维度 | Tool | Skill |
|------|------|-------|
| 作用方式 | 执行代码函数 | 注入 system prompt 指令 |
| 生命周期 | 运行中即时调用 | 随 Agent 初始化加载 |
| 审计 | 完整记录（输入/输出/耗时） | 无独立审计 |
| 安全边界 | 白名单校验、正则过滤 | 兼容性检测、脚本扫描 |

## 用户与登录

- 第一期仅实现本地账号密码登录；公开注册与密码找回**未实现**。
- 账号通过 `cd backend && npm run users:create -- --username <username>` 创建，密码通过交互式终端两次输入。
- 浏览器自动携带 HttpOnly Cookie（`mastra_session`）；前端 JavaScript 不可读、不可写。
- 同一账号允许多设备同时登录；退出只吊销当前会话，其它设备不受影响。
- 每个已登录账号拥有个人 Workspace；会话、知识库、文档、分块、工具执行与 Agent-Skill 绑定按 Workspace 隔离，跨 Workspace 访问统一隐藏为 404。
- 当前不实现组织共享 Workspace、角色授权、资源级 ACL 或公开注册。
- 不引入第三方认证依赖；密码哈希使用 Node 内置 `crypto.scrypt`，会话 token 仅存 SHA-256。
- `DEPLOYMENT_PROFILE=production` 仍拒绝启动：限流、租户隔离、Tool 风险治理等生产条件尚未完成。

## 安全提示

- Calculator 工具使用正则白名单 `/^[\d+\-*/().]+$/` 拒绝代码注入
- Skill 安装时根据 skills.sh 官方 API 返回的真实文件列表扫描脚本依赖；任何 `scripts/` 目录或 `.sh|.py|.js|.ts|...` 文件都被标记为 `requires-runtime`，**无法被 `bindSkillToAgent` 绑定**
- skills.sh API 返回的文件名经过 `assertSafeFilePath()` 验证，拒绝任何绝对路径或 `..` 路径穿越
- 卸载接口使用 `isPathStrictlyUnder()` 校验目标严格位于 `backend/market-skills/` 之内，防止越界
- SSE 仅推送最小安全载荷（`toolCallId` / `toolName` / `status`），完整 input / output / error 仅持久化在 `tool_executions` 表中
- 所有数据库操作使用参数化查询
- 禁止保存密钥、Token、Header 到日志或数据库

## 当前安全边界（必读）

当前版本定位为 **本地开发或受信任网络中的已认证 Starter**；每个账号使用自己的个人 Workspace，但尚未具备完整的组织租户、角色与生产级治理能力。

`DEPLOYMENT_PROFILE=production` 当前会明确拒绝启动。这是防止误部署的保护措施，不是认证实现；待认证、租户隔离和限流完成后才会开放生产档位。

- 不适用于公网直接部署——虽然本地账号认证与 Workspace 隔离已实现，但速率限制、组织级租户治理、Tool 风险治理和审批流尚未完成。
- 不适用于组织级多租户或精细资源授权场景——当前仅提供个人 Workspace 隔离；归属列 `workspace_id` 已加到 6 张业务表（`conversations` / `knowledge_bases` / `documents` / `document_chunks` / `tool_executions` / `agent_skill_bindings`）。
- 后续接入审批、限流、审计时，必须复用现成的 `withAuthenticatedWorkspace(handler)` 包装器与 `authCtx.workspaceId` 上下文——不要另起一套身份/租户机制。归属列的目标形态与隔离语义见 [`docs/architecture-v2.md`](docs/architecture-v2.md) §5 与 [`docs/implementation-plan.md`](docs/implementation-plan.md)。
- `ToolDefinition.metadata`（`readOnly` / `destructive` / `idempotent` / `openWorld` / `requiresRuntime`）当前只是能力声明与 UI 展示信息，不是生产级授权系统。任何自定义 Tool 不得返回密码、Token、Cookie、Authorization Header 或其他 secret。`destructive: true` 或 `openWorld: true` 的 Tool 在引入生产业务前必须接入身份认证、租户/资源归属校验、用户确认或策略审批，以及输入输出脱敏与审计。
- 在没有真实身份提供方之前，**禁止** 把 `requiresAuth: false` 批量替换为 `true`——那会造成伪安全或系统不可用。

详细说明见 `docs/architecture.md` § 当前安全边界 与 `docs/tools.md` § Tool Metadata 的真实定位。

## 许可证

MIT
