# 玄枢 Agent Starter

玄枢 Agent Starter 是一个基于 [Mastra](https://mastra.ai/) 框架的智能对话平台，支持通用对话与知识库问答两种模式，具备可扩展的 Tool Registry、Skill Registry 和 Agent 能力绑定系统。

## 功能特性

- **通用对话 Agent**: 日常问答、百科、技术支持
- **知识库问答 Agent**: 基于 PostgreSQL + pgvector 的语义检索，回答附带引用来源
- **Tool Registry**: 统一注册与安全管理内置及自定义工具（计算器、时间获取等）
- **Skill Registry**: 模块化指令技能系统，支持内置技能与 skills.sh 市场安装
- **Agent-Skill 绑定**: 为不同 Agent 动态绑定/解绑技能组合
- **流式对话**: Server-Sent Events (SSE) 实时推送生成内容
- **工具执行审计**: 所有 Tool 调用持久化到数据库，前端实时展示执行状态
- **会话管理**: 完整的对话历史持久化、停止生成、重新生成

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Mastra (~1.61.0), TypeScript, PostgreSQL |
| 前端 | React 19, Vite, Tailwind CSS 4, TypeScript |
| AI | 支持任意兼容 OpenAI SDK 的模型（默认 deepseek/deepseek-v4-flash） |

## 快速开始

### 前置要求

- Node.js 22+
- PostgreSQL 15+
- Docker（可选，用于一键启动数据库）

### 安装与启动

```bash
# 1. 启动数据库
docker-compose up -d

# 2. 初始化数据库 Schema
cat backend/database/init.sql | psql $DATABASE_URL

# 3. 配置环境变量
# 创建 backend/.env，填写 DATABASE_URL 和模型 API Key

# 4. 启动后端
cd backend
npm install
npm run dev

# 5. 启动前端（新终端）
cd frontend
npm install
npm run dev
```

访问 http://localhost:5173 打开工作台。

## 项目文档

- [架构总览](docs/architecture.md)
- [Agent 系统](docs/agents.md)
- [Tool 系统](docs/tools.md)
- [Skill 系统](docs/skills.md)
- [开发指南](docs/development.md)

## 核心概念

### Capability Resolver

玄枢采用 Capability Resolver 模式处理 Agent 能力：

```
Conversation → AgentDefinition → Tool Registry + DB Bindings → Skill Registry → Mastra Runtime
```

每个 Agent 定义包含能力矩阵（knowledgeBase / citations / tools / skills），运行时根据当前会话状态动态解析所需的 Tools 和 Skills，而非静态绑定。

### Tool 与 Skill 的区别

| 维度 | Tool | Skill |
|------|------|-------|
| 作用方式 | 执行代码函数 | 注入 system prompt 指令 |
| 生命周期 | 运行中即时调用 | 随 Agent 初始化加载 |
| 审计 | 完整记录（输入/输出/耗时） | 无独立审计 |
| 安全边界 | 白名单校验、正则过滤 | 兼容性检测、脚本扫描 |

## 安全提示

- Calculator 工具使用正则白名单 `/^[\d+\-*/().]+$/` 拒绝代码注入
- Skill 安装时自动扫描脚本文件，标记 `requires-runtime` 以阻止自动执行
- 所有数据库操作使用参数化查询
- 禁止保存密钥、Token、Header 到日志或数据库

## 许可证

MIT
