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
  - 兼容性检测基于真实文件列表自动扫描脚本依赖并标记 `requires-runtime`
  - 文件系统作为单一事实来源；DB `skills_installed` 仅作为索引
  - `discoverLocalSkills()` 自动发现 `backend/market-skills/<id>/SKILL.md`

- **skills.sh 市场集成**
  - 通过 `@mastra/server/dist/server/handlers/skills-sh-shared` 调用官方 skills.sh API（`https://skills-api-production.up.railway.app`）
  - `searchSkillsSh()` 搜索、`getPopularSkillsSh()` 热门、`previewSkillsSh()` 预览、`fetchSkillFiles()` 文件树
  - 安装路径下落到 `backend/market-skills/<owner>/<repo>/<skillName>/`
  - 使用 `assertSafeSkillName` 与 `assertSafeFilePath` 防止路径穿越与非法 skill 名

- **Agent-Skill 绑定**
  - 数据库表 `agent_skill_bindings` 支持 Agent 与技能的动态绑定
  - API: `POST /skills/:id/bind` / `POST /skills/:id/unbind`
  - 运行时仅根据数据库绑定注入 skills；`requires-runtime` 技能不可绑定

- **工具执行审计**
  - 数据库表 `tool_executions` 记录每次 Tool 调用
  - 字段: `input`, `output`, `status`, `duration_ms`, `error_code`
  - 流式 SSE 事件: `tool-call-start`, `tool-call-complete`, `tool-call-error`（最小安全 payload：`toolCallId`, `toolName`, `status`，错误事件额外含 `errorCode`）
  - `convergeRunningToolExecutions()` 在流结束、异常、停止时把残留的 `running` 记录收敛到 `stopped`/`failed`

- **前端技能管理 UI**
  - 「技能」模块: 技能列表、来源与兼容性标签
  - 市场安装: 通过搜索 skills.sh 选择结果，预览后再安装
  - Agent 技能绑定: 仅 `compatible` 技能可勾选/取消绑定

- **前端工具状态指示器**
  - 聊天消息中实时展示工具调用状态（⏳ 执行中 / ✅ 完成 / ❌ 失败 + 错误代码）

- **API 路由扩展**
  - `GET /tools`: 列出工具定义
  - `GET /skills`, `GET /skills/:id`: 技能列表与详情
  - `GET /skills/market/search?q=...`: 搜索 skills.sh
  - `GET /skills/market/popular`: skills.sh 热门技能
  - `POST /skills/market/preview`, `POST /skills/market/install`: 市场预览与安装
  - `POST /skills/:id/update`, `DELETE /skills/:id`: 更新与卸载（含清理文件与绑定）
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
- `backend/src/mastra/agents/registry.ts`: 扩展 `AgentDefinition` 接口，新增 `toolIds` 与能力矩阵；移除硬编码 `defaultSkillIds`
- `backend/src/mastra/routes/ask.ts`: 在 SSE 流中处理并转发 Tool 调用事件，持久化工具执行记录；SSE payload 仅含最小安全字段；流结束/异常/停止时收敛残留的 running 执行
- `backend/src/mastra/routes/agents.ts`: 返回增强的 Agent 定义，包含 `boundSkillIds`，不再返回 `defaultSkillIds`
- `backend/src/mastra/services/tool-executions.ts`: 表/字段重命名为 `tool_executions` / `tool_id`；新增 `convergeRunningToolExecutions()`
- `backend/src/mastra/skills/registry.ts`: 使用 `fileURLToPath()` 解析 Windows 路径；新增本地 skill 文件系统发现；每次加载都从磁盘重新校验兼容性
- `frontend/src/App.tsx`: 添加「技能」导航模块、工具状态渲染、SkillsWorkspace 组件（市场技能只能从搜索结果选择）
- `frontend/src/lib/api.ts`: 新增 Skill 与市场相关 API 函数
- `frontend/src/lib/conversations.ts`: 调整 SSEEvent 类型以匹配最小安全 payload
- `frontend/src/types/conversation.ts`: 移除 `AgentDefinition.defaultSkillIds`
- `.gitignore`: 排除 `backend/market-skills/`

### Fixed

- 后端 `index.ts`: 移除对已不存在的静态 Agent 实例的引用
- `market.ts`: 不再使用 GitHub raw URL，统一改走官方 skills-sh-shared helpers

## Stage 2: Streaming Agent Execution & Conversation Persistence

### Added

- SSE 流式对话 (`POST /ask`)
- 消息停止生成 (`POST /messages/:id/stop`)
- 消息重新生成 (`POST /messages/:id/regenerate`)
- 会话与消息持久化 (`conversations`, `messages` 表)
- 知识库问答 Agent 与检索引用
- 前端对话列表、Agent 切换、知识库选择
