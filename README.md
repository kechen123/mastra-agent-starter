# 玄枢（xuanshu-agent）

基于 Mastra 的道教知识 Agent。V0.1 优先完成可追溯来源的典籍 RAG；小说创作 Agent 不在当前范围内。

## 当前能力

- 使用 Mastra Agent 与 `searchScripture` Tool；
- 使用 PostgreSQL + pgvector 检索，向量元数据保留书名、章节、版本、类别、资料类型、注家与来源；
- 内置《道德经》王弼本测试摘录，覆盖“无为”最小验证问题；
- 回答结果把模型文本与系统返回的引文数组分开，避免把模型归纳伪装成原典。

## 本地启动

1. 复制 `.env.example` 为 `.env`，填写已有 PostgreSQL 连接、`DEEPSEEK_API_KEY` 和豆包 `EMBEDDING_API_KEY`；
2. 在目标数据库执行 `database/init.sql`；如没有现成 PostgreSQL，再使用 `docker compose up -d postgres` 建立本地开发库；
3. 安装依赖：`npm install`；
4. 导入测试典籍：`npm run ingest:daodejing`；
5. 启动 Mastra Studio：`npm run dev`，访问 `http://localhost:4111`；
6. 命令行验证：`npm run ask -- "《道德经》中的无为是什么意思？"`。

DeepSeek 用于 Agent 的问答和工具调用，默认采用 `deepseek/deepseek-v4-flash`。RAG 向量化使用豆包 `doubao-embedding-vision-251215` 的多模态 Embedding 接口，输出 2048 维向量。由于 pgvector 的 HNSW 索引最多支持 2000 维，V0.1 对该索引使用精确检索；数据量增长后再评估降维或半精度索引方案。

## V0.1 架构

```text
Markdown / 后续文件导入
  -> 章节表（原文、版本、来源）
  -> Mastra MDocument 切分
  -> 模型 Embedding
  -> Mastra PgVector
  -> searchScripture Tool
  -> 道教知识 Agent
  -> 回答 + 独立 Citation 数组
```

`works`、`chapters` 是权威书目与章节数据；pgvector 索引仅保存检索块及其引用元数据。后续增加注疏、多版本、章节查看时应先扩展前两张结构化表，而不是把所有文本混进一个普通 Chunk 表。

## 下一阶段（未实现）

- 通用的 TXT / Markdown / PDF 导入流程与人工校对；
- `getChapter`、`searchCommentary`、`compareTexts`；
- 章节引用跳转 API 与前端；
- 小说创作相关 Agent。
