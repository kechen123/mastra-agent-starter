# 玄枢（xuanshu-agent）

面向个人知识库的 AI 工作台。V1 只聚焦知识库、文档管理、RAG 检索、知识问答与可追溯引用；不包含小说、创作、人物或世界观功能。

## 目录

```text
backend/   Mastra、RAG、PostgreSQL/pgvector 初始化与种子数据
frontend/  React + Vite 知识问答工作台（Dark / Light 双主题）
storage/   本地上传文件运行目录（后续接入，Git 忽略）
```

## 当前状态

- `backend/` 已保留现有 Mastra 道教典籍检索和独立引用数组能力。
- `frontend/` 完成 Phase 1 的对话工作台 Mock：双主题、两级侧栏、回答、引用标签和按需展开的来源 Drawer。
- 前端当前使用 Mock 数据；尚未接入真实上传、知识库 CRUD 或 Agent API。

## 本地开发

后端依赖和命令位于 `backend/`：

```bash
cd backend
npm run typecheck
npm run dev
```

前端命令位于 `frontend/`：

```bash
cd frontend
npm run build
npm run dev
```

不要在未获批准时对共享数据库执行初始化、导入或启动服务。
