# 开发文档

## 环境要求

- Node.js 22+
- PostgreSQL 15+
- pnpm / npm / yarn

## 项目结构

```
mastra-agent-starter/
├── backend/
│   ├── database/
│   │   ├── init.sql                     # 首次安装的 Schema 基线（0000）
│   │   └── migrations/                  # 后续只增不改的增量迁移
│   ├── market-skills/                   # 通过 skills.sh 安装的本地化技能
│   ├── src/
│   │   ├── mastra/
│   │   │   └── index.ts                 # 薄适配器：导出 Mastra 实例
│   │   ├── server/
│   │   │   ├── bootstrap.ts             # 装配所有 Agent/Tool/Skill/路由
│   │   │   └── routes/                  # 所有 HTTP 路由（ask, agents, tools, skills, …）
│   │   ├── core/
│   │   │   ├── agent/                   # Agent Registry + 通用运行时
│   │   │   ├── tool/                    # Tool Registry
│   │   │   ├── skill/                   # Skill Registry（filesystem-driven）
│   │   │   └── execution/               # 流式执行上下文、AbortController
│   │   ├── agents/                      # 具体 Agent（_template + general-chat + knowledge-base）
│   │   ├── tools/                       # 具体 Tool（_template + calculator + get-current-time）
│   │   ├── skills/
│   │   │   ├── builtin/structured-summary/  # 内置 SKILL.md
│   │   │   └── _template/               # Skill 模板（占位，不注册）
│   │   ├── modules/
│   │   │   ├── conversations/           # 会话/消息/工具执行审计
│   │   │   ├── knowledge/               # 知识库服务 + RAG 检索
│   │   │   ├── documents/               # 文档解析与入库
│   │   │   └── citations/               # 引用类型
│   │   ├── infrastructure/
│   │   │   ├── database/pool.ts         # PostgreSQL 连接池
│   │   │   ├── external-skills/market.ts # skills.sh 适配器
│   │   │   └── llm/                     # LLM Provider 边界（DeepSeek-first）
│   │   │       ├── types.ts             # LlmProviderAdapter 契约
│   │   │       ├── registry.ts          # Provider 解析 + resolveDefaultChatModel
│   │   │       └── providers/deepseek.ts# 唯一已实现的 Provider Adapter
│   │   └── scripts/                     # CLI 调试脚本
│   └── package.json
├── frontend/
│   ├── src/                             # React 19 + Vite + Tailwind 4
│   └── package.json
├── docs/
│   ├── architecture.md                  # 架构总览
│   ├── agents.md                        # Agent 系统
│   ├── tools.md                         # Tool 系统
│   ├── skills.md                        # Skill 系统
│   ├── development.md                   # 本文件
│   └── extending.md                     # 新增 Agent / Tool / Skill / Route 的步骤
├── docker-compose.yml                   # 开发环境 PostgreSQL
└── .gitignore
```

### 目录职责

| 目录 | 唯一职责 | 依赖 |
|------|---------|------|
| `core/` | 框架无关的注册中心与运行时协议，**不引用任何具体 Agent / Tool / Skill / Provider** | Mastra 类型 |
| `agents/` | 唯一注册具体 `AgentDefinition` 的地方 | `core/agent`、`infrastructure/llm` |
| `tools/` | 唯一注册具体 `ToolDefinition` 的地方 | `core/tool` |
| `skills/` | 静态 SKILL.md 文件（filesystem-driven） | — |
| `modules/` | 业务能力模块（对话、知识库、文档、引用类型） | `core/`、`infrastructure/` |
| `infrastructure/` | 横切外部依赖（DB 连接池、skills.sh 适配器、**LLM Provider 边界**） | — |
| `server/routes/` | 纯 HTTP 处理器，零业务状态 | `core/`、`modules/`、`agents/`、`tools/`、`infrastructure/` |
| `mastra/index.ts` | 仅做「装配 → `new Mastra({ apiRoutes })`」 | `server/bootstrap` |

## 本地启动

### 1. 数据库

PowerShell：

```powershell
Copy-Item backend/.env.example backend/.env
docker compose up -d
Set-Location backend
npm ci
npm run migrate
```

Git Bash：

```bash
cp backend/.env.example backend/.env
docker compose up -d
cd backend
npm ci
npm run migrate
```

根目录的 Compose 会把 `backend/database/init.sql` 挂载为新数据卷的初始化 Schema。`npm run migrate` 负责记录该基线，并执行 `database/migrations/` 中尚未执行的增量迁移。

### 2. 环境变量

在 `backend/.env` 中配置。当前 Starter **仅启用 DeepSeek**，配置入口是：

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/mastra_agent_starter
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=sk-...
DEPLOYMENT_PROFILE=demo
```

历史变量 `AGENT_CHAT_MODEL` 仍可解析为 `deepseek/<model>` 形式，但会输出弃用警告；`XUANSHU_CHAT_MODEL` 仅作为警告，不参与解析。`OPENAI_API_KEY` 等其他凭据当前不被任何模块读取。

### 3. 后端

```bash
cd backend
npm install
npm run dev
```

### 4. 前端

```bash
cd frontend
npm install
npm run dev
```

前端通过 Vite proxy 将 `/api/*` 转发到后端。

## 开发规范

### 代码风格

- TypeScript 严格模式启用
- 使用参数化查询防止 SQL 注入
- 所有导出函数使用 JSDoc 风格的注释
- 禁止在前端暴露密钥、Token、环境变量

### 数据库变更

`backend/database/init.sql` 是 `0000-initial-schema` 基线。某个环境已经执行并记录该基线后，**不得再修改它**；后续 Schema 变更必须新增 `backend/database/migrations/<序号>-<名称>.sql`。

`npm run migrate` 会把已执行文件的 SHA-256 写入 `schema_migrations`。若修改已执行迁移，命令会失败，防止环境之间静默漂移。

### 新增 Agent / Tool / Skill / Route

参见 `docs/extending.md`。

## 测试

后端类型检查：
```bash
cd backend
npm run typecheck
```

前端构建：
```bash
cd frontend
npm run build
```

前端 Lint：
```bash
cd frontend
npm run lint
```

## 调试

### CLI 问答

```bash
cd backend
npm run ask
```

### SSE 流调试

在浏览器开发者工具的 Network → EventStream 中查看 `/ask` 的 SSE 事件流。

### 日志

后端使用 Mastra 内置的 Pino 日志。设置 `LOG_LEVEL=debug` 查看详细日志。

### 健康检查

- `GET /healthz`：进程存活。
- `GET /readyz`：数据库、LLM 凭据、Embedding 基础配置均可用才返回 `200`；否则返回 `503` 和非敏感检查项名称。

### 部署档位

当前仅支持 `DEPLOYMENT_PROFILE=demo`，对应本地或受信任网络中的匿名演示。设置 `production` 会拒绝启动，避免在认证、租户隔离和限流尚未实现前发生误部署。
