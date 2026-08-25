# 开发文档

## 环境要求

- Node.js 22+
- PostgreSQL 15+
- pnpm / npm / yarn

## 项目结构

```
xuanshu-agent/
├── backend/
│   ├── database/
│   │   └── init.sql              # 数据库 Schema（唯一来源）
│   ├── src/
│   │   ├── mastra/
│   │   │   ├── agents/           # Agent 定义、运行时、注册表
│   │   │   ├── routes/           # API 路由（ask, agents, tools, skills, conversations, knowledge-bases, documents）
│   │   │   ├── services/         # 业务服务（conversations, tool-executions）
│   │   │   ├── skills/           # Skill Registry、市场集成、内置技能
│   │   │   ├── tools/            # Tool Registry、内置工具
│   │   │   ├── rag/              # 知识库检索
│   │   │   └── index.ts          # Mastra 实例入口
│   │   ├── database/pool.ts        # PostgreSQL 连接池
│   │   └── scripts/ask.ts          # CLI 调试脚本
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx               # 主应用组件
│   │   ├── App.css               # 样式
│   │   ├── lib/api.ts            # 知识库/文档 API
│   │   ├── lib/conversations.ts  # 会话/消息 API + SSE 处理
│   │   └── types/conversation.ts # 类型定义
│   └── package.json
├── docs/
│   ├── architecture.md
│   ├── agents.md
│   ├── tools.md
│   └── skills.md
├── docker-compose.yml            # 开发环境 PostgreSQL
└── .gitignore
```

## 本地启动

### 1. 数据库

```bash
docker-compose up -d   # 启动 PostgreSQL
cd backend
cat database/init.sql | psql $DATABASE_URL  # 初始化 Schema
```

### 2. 环境变量

在 `backend/.env` 中配置：

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/xuanshu
XUANSHU_CHAT_MODEL=deepseek/deepseek-v4-flash
OPENAI_API_KEY=sk-...
```

### 3. 后端

```bash
cd backend
npm install
npm run dev    # 启动 Mastra 开发服务器（默认 4111）
```

### 4. 前端

```bash
cd frontend
npm install
npm run dev    # 启动 Vite 开发服务器（默认 5173）
```

前端通过 Vite proxy 将 `/api/*` 转发到后端。

## 开发规范

### 代码风格

- TypeScript 严格模式启用
- 使用参数化查询防止 SQL 注入
- 所有导出函数使用 JSDoc 风格的注释
- 禁止在前端暴露密钥、Token、环境变量

### 数据库变更

**所有 schema 变更只维护 `backend/database/init.sql`**。禁止创建额外的 SQL 文件。

本地开发时，如需修改 schema：
1. 编辑 `init.sql`
2. 重新初始化数据库（开发环境允许丢弃数据）
3. 生产环境通过迁移脚本执行（不在本仓库中管理）

### 添加新 Agent

参见 `docs/agents.md` → 添加新 Agent。

### 添加新 Tool

参见 `docs/tools.md` → 添加新工具。

### 添加新 Skill

参见 `docs/skills.md` → 添加自定义 Skill。

## 测试

后端类型检查：
```bash
cd backend
npx tsc --noEmit
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
npx tsx src/scripts/ask.ts
```

### SSE 流调试

在浏览器开发者工具的 Network → EventStream 中查看 `/ask` 的 SSE 事件流。

### 日志

后端使用 Mastra 内置的 Pino 日志。设置 `LOG_LEVEL=debug` 查看详细日志。
