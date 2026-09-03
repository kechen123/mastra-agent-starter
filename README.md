# Mastra Agent Starter

一个基于 [Mastra](https://mastra.ai/) 的可扩展智能对话与知识库平台模板。它提供可登录、可隔离的个人 Workspace，让业务项目可以在此基础上快速组合 Agent、知识库、Tool 和 Skill，而不必从对话流、检索链路或工具审计重新搭建。

> 当前仅适合本地开发或受信任网络中的已认证演示环境；生产级租户治理、Tool 审批等能力仍在演进中。详细边界见 [架构文档](docs/architecture.md)。

## 有哪些功能

- 通用对话与流式输出：支持 SSE 流式生成、停止生成和重新生成。
- 知识库问答：文档入库后基于 PostgreSQL + pgvector 检索，并在回答中附带引用来源。
- 多 Agent 能力组合：可为不同 Agent 按需绑定知识库、Tool 和 Skill。
- Tool Registry：统一注册内置或自定义工具，记录每次执行的输入、输出、状态与耗时。
- Skill Registry：支持内置 Skill、本地业务 Skill 以及从 skills.sh 市场安装的 Skill。
- 本地登录与数据隔离：账号拥有独立 Workspace；会话、文档、知识库、Tool 执行和 Agent-Skill 绑定均按 Workspace 隔离。
- 可持续演进的运行时：已具备持久化 Run、断点续传与 Tool 策略的基础能力；具体实现状态以 [当前架构](docs/architecture.md) 为准。

## 如何运行

### 前置要求

- Node.js 22+
- PostgreSQL 15+
- Docker（可选；用于启动本地 PostgreSQL）
- DeepSeek API Key 和 Embedding Provider 凭据

### 1. 配置并启动数据库

PowerShell：

```powershell
Copy-Item backend/.env.example backend/.env
# 编辑 backend/.env，填写本地凭据；不要提交该文件
docker compose up -d
```

首次创建数据库数据卷时会执行 `backend/database/init.sql`。如需手动初始化或重建本地数据库，请先阅读 [开发指南](docs/development.md)，避免对共享数据库执行初始化。

### 2. 启动后端并创建账号

```powershell
Set-Location backend
npm ci
npm run migrate
npm run users:create -- --username alice
npm run dev
```

创建账号时，密码会在交互式终端中输入，不会作为命令行参数保存。

### 3. 启动前端

在另一个终端执行：

```powershell
Set-Location frontend
npm ci
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)，使用刚创建的账号登录。

### 常用验证

```powershell
Set-Location backend
npm run typecheck

Set-Location frontend
npm run lint
npm run build
```

服务可用性可通过 `GET /healthz` 检查进程，通过 `GET /readyz` 检查数据库、LLM 与 Embedding 基础配置；后者在依赖未就绪时会返回 `503`，且不会泄露凭据。

## 如何继续开发业务

优先在既有扩展点中增加业务能力，不要直接把业务逻辑耦合到 Mastra Runtime：

| 目标 | 入口 |
| --- | --- |
| 新增 Agent | `backend/src/agents/`：复制 `_template`，再在 `backend/src/agents/index.ts` 注册 |
| 新增 Tool | `backend/src/tools/`：复制 `_template`，在 `backend/src/tools/index.ts` 注册，并配置对应 Agent 的 `toolIds` |
| 新增本地业务 Skill | `backend/src/skills/local/<your-skill>/SKILL.md`：重启后端后自动发现，再通过 API 绑定 |
| 安装市场 Skill | 前端 Skills 页面；安装内容存放在 `backend/market-skills/` |
| 新增业务模块 | `backend/src/modules/`：保持与核心运行时分层，按 Workspace 传递并校验归属 |
| 新增 HTTP API | `backend/src/server/routes/`：并在 `backend/src/server/bootstrap.ts` 的 `apiRoutes` 注册 |
| 修改品牌或默认模型 | `backend/src/config.ts` 与环境变量 `APP_NAME`、`APP_SHORT_NAME`、`LLM_PROVIDER`、`LLM_MODEL` |

开发约束与完整示例见 [扩展指南](docs/extending.md)。后端代码改动至少执行 `npm run typecheck`，前端代码改动至少执行 `npm run build`；不要把真实密钥、Token 或共享数据库配置提交到仓库。

## 项目文档

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
