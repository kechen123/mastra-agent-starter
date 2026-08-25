# Changelog

## [Unreleased] — Stage 3: Tool + Skill Capability Core

### Added

- **Tool Registry**
  - 统一工具注册中心 (`backend/src/mastra/tools/registry.ts`)
  - 内置工具: `calculator`（安全表达式计算，白名单正则过滤）、`get-current-time`（本地化日期时间）
  - `resolveTools()` 与 `resolveToolIds()` 支持动态工具解析与权限过滤

- **Skill Registry**
  - 技能注册中心 (`backend/src/mastra/skills/registry.ts`)
  - 内置技能: `structured-summary`（结构化摘要指令）
  - 兼容性检测 `analyzeSkillCompatibility()`，自动扫描脚本依赖并标记 `requires-runtime`
  - 支持从 `skills_installed` 数据库表加载已安装技能

- **skills.sh 市场集成**
  - `previewMarketSkill()`: 从 GitHub raw 预览远程 SKILL.md
  - `installMarketSkill()`: 下载安装到 `backend/market-skills/`
  - `updateMarketSkill()`: 更新已安装技能
  - `uninstallMarketSkill()`: 卸载并清理数据库记录

- **Agent-Skill 绑定**
  - 数据库表 `agent_skill_bindings` 支持 Agent 与技能的动态绑定
  - API: `POST /skills/:id/bind` / `POST /skills/:id/unbind`
  - 运行时合并 `defaultSkillIds`（硬编码）与 `boundSkillIds`（数据库绑定）

- **工具执行审计**
  - 数据库表 `skill_executions` 记录每次 Tool 调用
  - 字段: `input`, `output`, `status`, `duration_ms`, `error_code`
  - 流式 SSE 事件: `tool-call-start`, `tool-call-complete`, `tool-call-error`

- **前端技能管理 UI**
  - 「技能」模块: 技能列表、来源与兼容性标签
  - 市场安装: 输入 GitHub owner/repo 预览并安装
  - Agent 技能绑定: 复选框式绑定/解绑界面

- **前端工具状态指示器**
  - 聊天消息中实时展示工具调用状态（⏳ 执行中 / ✅ 完成 / ❌ 失败）

- **API 路由扩展**
  - `GET /tools`: 列出工具定义
  - `GET /skills`, `GET /skills/:id`: 技能列表与详情
  - `POST /skills/preview`, `POST /skills/install`: 市场预览与安装
  - `POST /skills/:id/update`, `DELETE /skills/:id`: 更新与卸载
  - `POST /skills/:id/bind`, `POST /skills/:id/unbind`: Agent 绑定

- **文档**
  - `docs/architecture.md`: 系统架构总览
  - `docs/agents.md`: Agent 系统文档
  - `docs/tools.md`: Tool 系统文档
  - `docs/skills.md`: Skill 系统文档
  - `docs/development.md`: 开发指南
  - `README.md`: 项目总览与快速开始

### Changed

- `backend/src/mastra/agents/general-agent.ts` 与 `knowledge-base-agent.ts`: 从静态实例改为工厂函数 `createGeneralAgent(tools, skills)` / `createKnowledgeBaseAgent(tools, skills)`
- `backend/src/mastra/agents/runtime.ts`: 支持动态解析 Tools 和 Skills 后创建临时 Agent 实例
- `backend/src/mastra/agents/registry.ts`: 扩展 `AgentDefinition` 接口，新增 `toolIds`、`defaultSkillIds` 和能力矩阵
- `backend/src/mastra/routes/ask.ts`: 在 SSE 流中处理并转发 Tool 调用事件，持久化工具执行记录
- `backend/src/mastra/routes/agents.ts`: 返回增强的 Agent 定义，包含 `boundSkillIds`
- `frontend/src/App.tsx`: 添加「技能」导航模块、工具状态渲染、SkillsWorkspace 组件
- `frontend/src/lib/api.ts`: 新增 Skill 相关 API 函数
- `frontend/src/lib/conversations.ts`: 扩展 SSEEvent 类型以支持 Tool 调用事件
- `.gitignore`: 排除 `backend/market-skills/`

### Fixed

- 后端 `index.ts`: 移除对已不存在的静态 Agent 实例的引用

## Stage 2: Streaming Agent Execution & Conversation Persistence

### Added

- SSE 流式对话 (`POST /ask`)
- 消息停止生成 (`POST /messages/:id/stop`)
- 消息重新生成 (`POST /messages/:id/regenerate`)
- 会话与消息持久化 (`conversations`, `messages` 表)
- 知识库问答 Agent 与检索引用
- 前端对话列表、Agent 切换、知识库选择
