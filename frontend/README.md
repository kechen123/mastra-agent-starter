# Frontend — Mastra Agent Starter

> **本版本已被本次裁决覆盖**：迁移链 / 增量迁移 ——以 `docs/superpowers/specs/2026-08-28-workspace-id-isolation-design.md` §5 为准。PR-1.2 / PR-1.3 / PR-1.5 已合并落地；前端无 Schema 直接依赖，但鉴权 cookie 契约不变。

React 19 + Vite + Tailwind CSS 4 前端。本 README 仅说明前端特有的开发命令；项目总体说明、根目录安装与服务端启动详见 [`../README.md`](../README.md)。

## 开发命令

```bash
npm ci           # 安装依赖（锁文件是 frontend/package-lock.json）
npm run dev      # 启动 Vite dev server（http://localhost:5173）
npm run lint     # oxlint
npm run build    # tsc -b && vite build
npm run preview  # 预览生产构建
```

## 技术栈

- React 19 + TypeScript
- Vite 8
- Tailwind CSS 4（`@tailwindcss/vite`）
- Oxlint
- [`@assistant-ui/react`](https://github.com/assistant-ui/assistant-ui) — Chat Workspace UI 框架（`AssistantChatWorkspace` + 适配器）

## 目录约定

```text
src/
├── app/                       # 应用入口与跨模块编排
├── components/layout/          # 侧栏等全局布局
├── features/                  # 按业务领域拆分的 feature workspace
│   ├── chat/                  #   对话工作区（AssistantChatWorkspace）
│   ├── knowledge/             #   知识库管理
│   ├── capabilities/          #   Skill 与模型能力面板
│   └── tool-approvals/        #   Tool 审批 UI（V2 阶段 3 接入）
├── lib/                       # 后端 API 客户端、SSE 封装
└── types/                     # 跨模块共享类型
```

## 与后端的契约

- 全部请求携带 HttpOnly Cookie `mastra_session`；前端 JS 不可读、不可写。
- 流式生成走 `POST /ask`（当前实现）；V2 阶段 2 会切到 `POST /api/v1/conversations/:id/messages` + `GET /api/v1/runs/:runId/events`。
- 鉴权失败统一跳到 `/login`。
- LLM Provider / API Key **不**出现在前端代码或环境变量中，由 `GET /capabilities` 返回展示信息。

## 包管理器

仅使用 **npm**。若发现 `frontend/pnpm-lock.yaml` 已被提交，请删除并重新执行 `npm ci`。前后端统一 `npm ci`，CI 强依赖锁文件存在。

## 相关文档

- [根目录 README](../README.md)
- [架构总览（当前实现）](../docs/architecture.md)
- [前端 Workspace 与适配器说明（TODO：阶段 2 接入时补）](../docs/implementation-plan.md)
