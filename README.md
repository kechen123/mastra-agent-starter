# 玄枢（xuanshu-agent）

面向个人知识库的 AI 工作台。V1 只聚焦知识库、文档管理、RAG 检索、知识问答与可追溯引用；不包含小说、创作、人物或世界观功能。

## 目录

```text
backend/   Mastra、RAG、PostgreSQL/pgvector 初始化与种子数据
frontend/  React + Vite 知识问答工作台（Dark / Light 双主题）
storage/   本地上传文件运行目录（后续接入，Git 忽略）
```

## 当前状态

- `backend/` 已完成 Mastra 通用对话、知识库 CRUD、文档上传与限定知识库向量检索。
- `frontend/` 已完成对话工作台、知识库管理、文档上传与问答接入真实 API。

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
