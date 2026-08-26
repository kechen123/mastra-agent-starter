# 玄枢 Agent Starter 架构文档

## 概述

玄枢 Agent Starter 是一个基于 Mastra 框架的智能对话平台，支持通用对话和知识库问答两种 Agent 模式。系统采用前后端分离架构，使用 PostgreSQL 持久化数据，并通过 SSE 流式传输实现实时对话体验。

## 技术栈

- **后端**: Mastra (~1.61.0), TypeScript, PostgreSQL
- **前端**: React 19, Vite, Tailwind CSS 4, TypeScript
- **数据存储**: PostgreSQL（会话、消息、知识库、技能执行审计）

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                         前端 (React)                          │
│  ┌─────────┐  ┌─────────────┐  ┌─────────┐  ┌──────────┐  │
│  │ 对话模块 │  │  知识库模块  │  │ 技能模块 │  │  设置   │  │
│  └─────────┘  └─────────────┘  └─────────┘  └──────────┘  │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP / SSE
┌────────────────────▼────────────────────────────────────────┐
│                      后端 (Mastra Server)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │   API Routes  │  │   Agent Runtime│  │  Service Layer │  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Tool Registry│  │  Skill Registry│  │ Knowledge Base│  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                     │
              ┌──────┴──────┐
              │  PostgreSQL │
              └─────────────┘
```

## 核心模块

### 1. Agent 运行时 (Agent Runtime)

位于 `backend/src/mastra/agents/runtime.ts`。负责协调 Agent 的流式执行：
- 根据 `agentId` 解析对应的 AgentDefinition
- 动态解析并注入 Tools 和 Skills
- 通过 AsyncGenerator 产生标准化的 `StreamEvent`（delta、done、stopped、error、tool-call-start、tool-call-complete、tool-call-error）
- 统一处理 AbortSignal 和异常边界

### 2. Tool Registry

位于 `backend/src/mastra/tools/registry.ts`。
- 提供注册中心模式，所有工具通过 `registerTool()` 注册
- `resolveTools()` 根据 Agent 的 `toolIds` 配置解析可用工具
- `resolveToolIds()` 支持 allowed-tools 交集过滤

内置工具 (`backend/src/mastra/tools/builtins.ts`):
- `calculator`: 安全的数学表达式计算器，使用白名单正则 `/^[\d+\-*/().]+$/` 和 `Function` 构造器
- `get-current-time`: 返回本地化的当前日期时间

### 3. Skill Registry

位于 `backend/src/mastra/skills/registry.ts`。
- 管理内置技能（如 `structured-summary`）、已安装的市场技能以及本地 SKILL.md
- `discoverLocalSkills()` 扫描 `market-skills/<id>/SKILL.md`
- 从 `skills_installed` 数据库表加载技能，但每次加载都会重新扫描磁盘文件并据此重新计算 `compatibility`
- `resolveSkills()` 仅返回 `compatibility === 'compatible'` 的技能；`requires-runtime` 永远不会被注入
- 兼容性检测基于真实文件列表（`scripts/` 目录、`.sh|.py|.js|.ts` 等可执行扩展名、`allowed-tools` 缺失）

### 4. Agent 定义与能力绑定

位于 `backend/src/mastra/agents/registry.ts`。
- `AgentDefinition` 描述每个 Agent 的能力矩阵：`knowledgeBase`, `citations`, `tools`, `skills`
- 仅硬编码 `toolIds`；**不包含 `defaultSkillIds`**，运行时仅根据数据库绑定注入技能
- 运行时通过 `getAgentSkillBindings()` 读取 `agent_skill_bindings` 表

### 5. 会话与消息服务

位于 `backend/src/mastra/services/conversations.ts`。
- 管理 `conversations` 和 `messages` 表
- 支持持久化的多轮对话
- 消息状态机：`pending → streaming → completed | stopped | failed`

### 6. 知识库检索

位于 `backend/src/mastra/rag/knowledge-base-retriever.ts`。
- 在提问时将用户问题向量化
- 从绑定的知识库中检索相关片段（Citation）
- 返回带元数据的引文列表

### 7. 工具执行审计

位于 `backend/src/mastra/services/tool-executions.ts`。
- 记录每次工具调用到 `tool_executions` 表
- 状态跟踪：`running → completed | failed | stopped`
- 记录输入、输出、耗时、错误码
- `convergeRunningToolExecutions()` 在流结束/异常/停止时把残留 `running` 记录收敛为 `stopped` / `failed`

## 数据流

### 问答请求流

1. 用户发送 `POST /ask`，携带 `conversationId` 和 `message`
2. 保存用户消息到数据库
3. 创建 `assistant` 消息，状态为 `pending`
4. 注册执行上下文（AbortController）
5. 启动 Agent 流式生成
6. Agent 运行时动态解析 Tools 和 Skills
7. 流式返回 SSE 事件：
   - `message-start`: 助手消息开始生成
   - `content-delta`: 文本片段
   - `tool-call-start`: 工具调用开始（载荷 `{ toolCallId, toolName, status: 'running' }`）
   - `tool-call-complete`: 工具调用成功（载荷 `{ toolCallId, toolName, status: 'completed' }`）
   - `tool-call-error`: 工具调用失败（载荷 `{ toolCallId, toolName, status: 'failed', errorCode }`）
   - `message-complete`: 生成完成
   - `message-error`: 生成失败
8. 最终持久化助手消息的最终内容、状态和引文
9. 流退出前调用 `convergeRunningToolExecutions()` 收敛残留执行记录

### 技能市场安装流

1. 前端调用 `GET /skills/market/search?q=...` 或 `GET /skills/market/popular`
2. 用户从结果中选择 `owner/repo/skillName`，前端调用 `POST /skills/market/preview` 预览
3. 预览通过 `fetchSkillFiles()` 拉取真实文件列表，计算 `compatibility`
4. 前端调用 `POST /skills/market/install`
5. 服务端下载所有文件到 `backend/market-skills/<owner>/<repo>/<skillName>/`，注册到 `skills_installed` 表
6. 调用 `loadInstalledSkills()` 刷新内存缓存
7. `compatible` 技能可通过 `POST /skills/:id/bind` 绑定到 Agent

## 路由表

| 路由 | 方法 | 说明 |
|------|------|------|
| `/agents` | GET | 列出可用 Agent 定义 |
| `/tools` | GET | 列出可用工具定义 |
| `/skills` | GET | 列出所有技能 |
| `/skills/:id` | GET | 获取单个技能详情 |
| `/skills/market/search` | GET | 搜索 skills.sh（`?q=...&limit=...`） |
| `/skills/market/popular` | GET | skills.sh 热门技能 |
| `/skills/market/preview` | POST | 预览市场技能（`{ owner, repo, skillName }`） |
| `/skills/market/install` | POST | 安装市场技能（`{ owner, repo, skillName }`） |
| `/skills/:id/update` | POST | 更新已安装技能 |
| `/skills/:id` | DELETE | 卸载技能（含清理文件、绑定、注册表刷新） |
| `/skills/:id/bind` | POST | 绑定技能到 Agent（拒绝 `requires-runtime`） |
| `/skills/:id/unbind` | POST | 解绑技能从 Agent |
| `/ask` | POST | 流式问答（SSE） |
| `/messages/:id/stop` | POST | 停止生成 |
| `/messages/:id/regenerate` | POST | 重新生成 |
| `/conversations` | GET/POST | 会话列表/创建 |
| `/conversations/:id` | GET/PATCH/DELETE | 会话详情/更新/删除 |
| `/knowledge-bases` | GET/POST | 知识库列表/创建 |
| `/knowledge-bases/:id` | GET/PATCH/DELETE | 知识库详情/更新/删除 |
| `/knowledge-bases/:id/documents` | POST | 上传文档 |
| `/documents/:id` | GET/DELETE | 文档详情/删除 |
| `/capabilities` | GET | 获取系统能力配置 |

## 安全设计

- **Tool 沙箱**: Calculator 使用正则白名单过滤表达式，只允许数字和 `+-*/().`，拒绝任何代码注入
- **SQL 注入防护**: 所有数据库操作使用参数化查询
- **输入校验**: 严格校验 UUID 格式、字符串长度上限（2000 字符）
- **无凭证暴露**: 不保存密钥、Token、Header 到日志或数据库
- **Skill 兼容性检测**: 自动扫描技能目录中的脚本文件，标记 `requires-runtime` 以防止不安全的自动执行
