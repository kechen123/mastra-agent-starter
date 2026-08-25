# 玄枢（xuanshu-agent）

Xuanshu Agent Starter：通用 Agent 应用基础模板。内置 Agent Registry、状态化对话持久化、知识库 RAG 检索与可追溯引用；采用无状态 Runtime 模式，支持多 Agent 切换与扩展。

## 目录

```text
backend/   Mastra、Agent Registry、Runtime、状态化对话 CRUD、RAG、PostgreSQL/pgvector
frontend/  React + Vite Agent 工作台（Dark / Light 双主题）
storage/   本地上传文件运行目录（Git 忽略）
```

## 当前状态

- `backend/` 已完成 Agent Registry（general-chat / knowledge-base）、Runtime 执行层、状态化对话 CRUD、知识库管理、文档上传与 RAG 检索。
- `frontend/` 已完成多 Agent 切换、会话历史侧边栏、草稿/持久化状态管理、知识库管理、文档上传与问答接入真实 API。

## 本地开发（默认）

默认启动依赖仅包含 PostgreSQL、backend、frontend。

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

默认上传仅支持 TXT、Markdown。

## 可选：文档解析（PDF / DOCX）

如需支持 PDF 和 DOCX，需要额外启动 MinerU 解析服务，并启用后端开关：

1. 启动 MinerU API（本机需 Python 环境）：
   ```bash
   mineru-api --host 127.0.0.1 --port 8000
   ```
2. 在 `backend/.env` 中设置：
   ```ini
   ENABLE_MINERU=true
   MINERU_API_BASE_URL=http://127.0.0.1:8000
   ```
3. 重启 backend，前端会自动识别新格式并更新上传提示。
