# Daymind 统一 Composer 文件与 URL 录入 — 设计

> 状态：设计稿，等待用户复核后落实施计划。
> 适用范围：仅 Daymind 文本记录链路扩展到 `.txt` / `.md` / `.pdf` / `.docx` / 普通公开 URL。
> 不在本阶段范围：LLM Wiki、Memory、Project 自动分类、Secret Vault、xlsx/pptx、图片 OCR、Excel/Word/PDF 编辑、浏览器自动化、登录抓取、Cookie/反爬绕过、复杂多 Agent、无关重构。

## 0. 前置事实

- 当前 `sources` 表已存在，列：`id, workspace_id, type, title, raw_content, normalized_content, content_hash, metadata, created_at, updated_at`；`type` CHECK 已含 `text/file/url/image/pdf/docx/xlsx/csv/markdown/other`；`UNIQUE(workspace_id, content_hash)` 已建立。
- `documents` 表已带 `source_id UUID REFERENCES sources(id) ON DELETE SET NULL`；`storage_status` / `storage_key` / `sha256` / `total_chunks` 等列齐全。
- `document_chunks.metadata JSONB` 已支持任意字段（`heading / parser / sourceFormat` 已在写）。
- `document_embeddings` 已通过 `embedding_profiles` 持有 active profile，retriever `searchWorkspaceSources` 已能用 `source_id` JOIN 拿到 `source_id/source_title/source_type`。
- `LocalFsStorage`（`infrastructure/storage/local-storage.ts`）已是成熟 PR-4.2 抽象，提供 `putStaging / finalize / abortStaging / getBytes / exists / remove`；bootstrap 已注入 `setDocumentStorage(new LocalFsStorage())`。
- `SensitiveDataScanner`（`modules/sources/sensitive-data-scanner.ts`）已落地 6 类（`api_key / access_token / password / bearer_token / private_key / database_url`），含 `redactedContent`。
- `recordIntent`（`modules/sources/record-intent.ts`）已提供中文短语识别 + 否定否定前缀过滤。
- `Citation` 类型已有 `sourceId/sourceTitle/sourceType/heading/documentId/chunkIndex/score/distance` 字段；缺 `page` 与 `url`。
- Composer（`AssistantChatWorkspace.tsx`）当前只发文本；没有附件 / URL 录入入口。

## 1. 架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Composer (Frontend)                                │
│  - 文本输入 + Record Intent 识别                                         │
│  - 文件附件按钮 (.txt/.md/.pdf/.docx, ≤10MB)                              │
│  - "记录一个 URL" 输入                                                   │
│  - 文件/URL + 无明确意图 → 显示 422 文案（不静默入库）                      │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │ HTTP multipart / JSON
┌────────────────────────────▼─────────────────────────────────────────────┐
│  server/routes/sources.ts                                                │
│  /sources/record    (text, 既有)                                          │
│  /sources/file      (multipart, 新增)                                     │
│  /sources/url       (JSON, 新增)                                          │
│                                                                            │
│  handler 内只做：身份校验 + 工作区校验 + 入参校验                          │
│  业务完全交给 SourceService                                                 │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────────────┐
│  modules/sources/                                                          │
│  - service.ts        recordSourceService(input)                          │
│                       ├── recordText  (既有 recordTextSource)             │
│                       ├── recordFile  (新增)                              │
│                       └── recordUrl   (新增)                              │
│  - parsers/                                                                 │
│       registry.ts           SourceParserRegistry.parse(input)             │
│       types.ts              ParsedSource / SourceParser 接口             │
│       text-parser.ts        TextParser                                    │
│       plain-text-file.ts    PlainTextFileParser (.txt)                    │
│       markdown-parser.ts    MarkdownParser (.md)                          │
│       pdf-parser.ts         PdfParser (.pdf, 本地 pdf-parse)              │
│       docx-parser.ts        DocxParser (.docx, 本地 mammoth)              │
│       url-parser.ts         UrlParser (URL, cheerio)                      │
│       url-fetcher.ts        UrlFetcher (SSRF 守卫 + size/time cap)        │
│                                                                            │
│  - sensitive-data-scanner.ts    (复用)                                     │
│  - retrieval.ts                 (searchDaymindSources 扩展 page/url)      │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────────────┐
│  Source → Document → Chunk → Embedding (全部复用)                        │
│  Source 行：                                                               │
│    type = 'text' | 'file' | 'url'                                         │
│    metadata = {                                                            │
│      originalName?, mimeType?, size?, storageKey?,                         │
│      originalUrl?, finalUrl?, fetchedAt?,                                  │
│      parser, sourceFormat, pageCount?, sections?                          │
│    }                                                                       │
│  Document 行：storage_key 指向 LocalFsStorage 下的 finalKey               │
│  Chunk 行 metadata：parser / sourceFormat / page? / heading? / sourceId   │
│  Embedding 行：与现有 RAG 路径一致                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

**Source 是事实层。** Document / Chunk / Embedding 是 Source 的解析与检索投影。

## 2. 公共类型

```ts
// modules/sources/parsers/types.ts
export interface ParsedSection {
  heading?: string;
  page?: number;
  startChar: number;
  endChar: number;
}

export interface ParsedSource {
  text: string;                 // canonical normalized text
  title: string;
  metadata: {
    parser: string;             // 'text' | 'plain-text' | 'markdown' | 'pdf-local' | 'docx-local' | 'url-html'
    sourceFormat: string;       // 'txt' | 'md' | 'pdf' | 'docx' | 'html'
    pageCount?: number;         // PDF only
    headings?: string[];        // markdown / DOCX best-effort
  };
  sections?: ParsedSection[];
  warnings?: string[];
}

export type SourceInput =
  | { kind: 'text'; content: string; title?: string }
  | { kind: 'file'; filename: string; mimeType?: string; buffer: Buffer }
  | { kind: 'url'; originalUrl: string; fetchedAt: string; body: string; finalUrl: string };

export interface SourceParser {
  supports(input: SourceInput): boolean;
  parse(input: SourceInput): Promise<ParsedSource>;
}

export class UnsupportedSourceFormatError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedSourceFormatError'; }
}
```

## 3. Parser 实现策略

| Parser | 输入 | 实现 | 备注 |
|---|---|---|---|
| `TextParser` | `{kind:'text', content}` | `content.trim().replace(/\r\n/g, '\n')` | 复用现有 normalize 路径 |
| `PlainTextFileParser` | `{kind:'file', ext:'txt'}` | `TextDecoder('utf-8', {fatal:true}).decode(buffer)` + 现有 `normalizeText()` | 已有 |
| `MarkdownParser` | `{kind:'file', ext:'md'}` | 同上 + 抽出所有 `^#{1,6}\s+(.+)$` 行作为 headings | headings 不伪造 |
| `PdfParser` | `{kind:'file', ext:'pdf'}` | `pdf-parse` 1.x — `getPageText()` 返回每页字符串数组；拼成 text 并记 `pageCount = real` | PDF page 字段从真实抽取；如缺页码则不写 |
| `DocxParser` | `{kind:'file', ext:'docx'}` | `mammoth.convertToRawText()`；heading 走 `mammoth.convertToHtml()` 提取 `h1/h2/h3` 文本 | best-effort headings |
| `UrlParser` | `{kind:'url', body}` | cheerio：`remove('script,style,noscript')` + `text()` + 折叠空白 | 不渲染 JS |

**3 个新 npm 依赖**：`pdf-parse`、`mammoth`、`cheerio`。本地运行，原始字节不出本机。

**Parser 选择由 Registry 决定**：按 extension 或 `kind` 选第一个 `supports()` 命中的 parser；都没命中抛 `UnsupportedSourceFormatError`。路由层只调 `registry.parse(input)`，不知道 file/url 细节。

## 4. URL 抓取与 SSRF

`modules/sources/parsers/url-fetcher.ts`：

1. 入参 `originalUrl: string`，必须以 `http://` 或 `https://` 开头；否则 `UnsupportedUrlError`。
2. DNS 解析 hostname → IP；若 IP 在私有/loopback/link-local 集合，抛 `UnsafeUrlError`。
3. `fetch` 带 `User-Agent: Daymind/1.0`，超时 15s（`AbortSignal.timeout(15000)`），`redirect: 'manual'`（自己处理 30x，最多 5 跳，每跳重做 SSRF 校验）。
4. 拒绝 `Set-Cookie`（不写入）；记录 `finalUrl`。
5. Content-Length / 累计 body 字节数 > 2 MB 立即 abort。
6. 响应头 `Content-Type` 必须是 `text/html` / `text/plain` / `application/xhtml+xml` 之一，否则拒绝。
7. 把 body 编码按 charset 解析（默认 UTF-8，固定大小 chunk 增量读）。

**禁止列表**：`localhost / 127.0.0.0/8 / 10.0.0.0/8 / 172.16.0.0/12 / 192.168.0.0/16 / 169.254.0.0/16 / 0.0.0.0`、`::1 / fe80::/10 / fc00::/7`、以及 IPv4-mapped IPv6 形式的上述网段。

## 5. SourceService 流程（三个入口共享）

```
recordSourceService(input: SourceInput)
  │
  ├── 路由：Text → recordTextService
  ├── 路由：File → recordFileService
  └── 路由：Url  → recordUrlService
                              │
                              ▼
                  ┌───────────────────────────┐
                  │ 1. parserRegistry.parse   │  异常 → 上抛
                  │ 2. scanSensitiveData(text)│  命中 → SensitiveSourceRejectedError
                  │ 3. 若是 File：putStaging  │
                  │ 4. contentHash = sha256   │
                  │ 5. 单事务:                 │
                  │    - advisory_xact_lock   │
                  │    - SELECT KB by name    │
                  │    - INSERT KB 若无        │
                  │    - INSERT sources       │
                  │      ON CONFLICT(workspace_id, content_hash)
                  │        DO UPDATE updated_at = now()
                  │        RETURNING *        │
                  │    - dedup documents      │
                  │      (已有 → 直接返回)     │
                  │    - INSERT documents     │
                  │    - splitText → INSERT chunks
                  │    - 若 RAG: embed + INSERT document_embeddings
                  │ 6. 若是 File：finalizeStaging→finalKey → UPDATE documents.storage_status
                  │ 7. 失败回滚 + abortStaging │
                  └───────────────────────────┘
                              │
                              ▼
                RecordedSource { id, type, title, knowledgeBaseId, createdAt, chunkCount }
```

**关键不变量**：
- 步骤 2 在任何 INSERT 之前；secret 命中 → 整流程直接抛错，不写库，不留 staging。
- 步骤 5 在单 PoolClient + 单事务内完成。
- ON CONFLICT(workspace_id, content_hash) 是关键去重闸门：同一内容二次记录不产生新 Document/Chunks/Embeddings。
- 同 Source 已存在但 Document 缺失（理论不应发生，兜底）→ 重建 Document/Chunks/Embeddings。
- File 入参的 `contentHash` 是 sha256(buffer 原始字节)，不依赖解析结果，保证字节级 dedup。
- URL 入参的 `contentHash = sha256(finalUrl + '\n' + bodyText)`；同一正文不同 URL 视为不同 Source。

## 6. Composer 语义

- **文件 + 明确记录意图**（识别"记录下来/帮我保存/..."或显式"记录此文件"按钮）：走完整管线 → 201 + SourceSummary。
- **URL + 明确记录意图**：同上 → 201 + SourceSummary。
- **文件 + 普通问题**（无记录意图）：返回 422 `{error_code:'UNSUPPORTED_ATTACHMENT_QA', message:'临时附件问答尚未实现。'}`；不静默入库。
- **URL + 普通问题**：同上 422。
- **URL 抓取失败 / body 为空**：422 `{error_code:'UNSUPPORTED_URL_CONTENT', message:'...'} `；不创建 Source。
- **secret 命中**：422 `{error_code:'SENSITIVE_SOURCE_REJECTED'}`；不创建 Source / Document / Chunk / Embedding；不留 staging。

前端 Composer：
- 既有文本输入框保留。
- 新增"📎 附件"按钮：触发 file picker，限定 `.txt/.md/.pdf/.docx`；选中后弹一个"是否记录为长期资料？"的小确认；选择"不记录 / 临时提问"则发出普通问题 + 422 提示文案。
- 新增"🌐 记录 URL"按钮：弹 URL 输入；同样的"是否记录"分支。
- 文本框的 Record Intent 检测沿用既有 `isRecordIntent(content)`，但额外允许纯附件/纯 URL 走 record 路径（按钮触发的 record 意图）。

## 7. Storage

- 完全复用 `LocalFsStorage`。File 入参的 `stagingKey` 与 `finalKey` 与现有 KB 上传共用同一命名空间（`staging/<uploadId>` / `final/<workspaceId>/<sha256>-<safeName>.<ext>`），HTTP 路由复用 `uploadBodyLimitMiddleware` (10.5 MB body / 10 MB file)。
- 业务层不写死路径，路径由 `LocalFsStorage` 内部决定。Provider 替换只改 `setDocumentStorage`。
- 解析后文本 **不** 单独落盘：只通过 Source `normalized_content` + Chunk `content` 落库；原文件仅用于审计 / 重解析。

## 8. Citation

```ts
// modules/citations/types.ts 扩展
export interface Citation {
  // 既有字段保留
  chunkId: string;
  title: string;
  chapter: string;
  content: string;
  score: number;
  documentId?: string;
  documentName?: string;
  chunkIndex?: number;
  heading?: string;
  distance?: number;
  category: string;
  type: string;
  source: string;
  sourceId?: string;
  sourceTitle?: string;
  sourceType?: string;
  // 新增
  page?: number;     // PDF only; 从 chunk.metadata.page 取；不存在则不写
  url?: string;      // URL only; source metadata.finalUrl
}
```

Chunk `metadata` JSONB 写：`{ parser, sourceFormat, sourceId, page?, heading? }`。

`searchWorkspaceSources` 与 `searchDaymindSources` 的 lexical 分支都把 `c.metadata.page / c.metadata.heading` 与 `s.metadata->>'finalUrl'` 映射到 Citation 字段。

## 9. 错误码

| code | HTTP | 触发 |
|---|---|---|
| `UNSUPPORTED_SOURCE_FORMAT` | 422 | 扩展名不在白名单 |
| `UNSUPPORTED_ATTACHMENT_QA` | 422 | 文件/URL + 无明确记录意图 |
| `UNSUPPORTED_URL_CONTENT` | 422 | URL 抓取失败 / body 空 / 非 HTML |
| `UNSAFE_URL` | 422 | SSRF 守卫拦截 |
| `SENSITIVE_SOURCE_REJECTED` | 422 | SensitiveDataScanner 命中 |
| `URL_FETCH_TIMEOUT` / `URL_FETCH_TOO_LARGE` | 422 | 超时或超过 2MB |
| `NOT_FOUND` | 404 | workspace / KB 不存在 |

错误响应统一结构：`{error_code, message}`（沿用既有约定）。

## 10. 测试与验证

**单元测试**（离线，与 `daymind-source-safety.ts` 同风格）：

| 文件 | 覆盖 |
|---|---|
| `tests/unit/sources-parser-registry.ts` | 每种 parser 的 supports() 边界；unknown extension 抛错；PDF 空 page 不写 pageCount |
| `tests/unit/sources-url-safety.ts` | SSRF deny list、redirect-to-private-IP、超时、size cap、scheme 校验 |
| `tests/unit/sources-secret-intercept.ts` | secret 文件与 secret URL body 都被拒绝（mock parser，但走真实 service） |
| `tests/unit/sources-markdown-headings.ts` | markdown headings 抽取 + heading 落到 Chunk metadata |

**E2E 脚本**：`backend/src/scripts/verify-daymind-file-and-url.ts`，参考 `verify-daymind-cross-conversation.ts` 模板。在真实 PostgreSQL + 真实 Embedding Provider 上跑：

1. 创建 workspace 与 daymind agent 会话；
2. TXT（含"测试项目代号：Silver River 8921"）→ record → 新会话查询 → 命中 + 输出 sourceId/documentId/chunkId/score；
3. DOCX（真实 .docx）→ record → 新会话查询 → 命中 + Citation 显示文件名 + heading；
4. PDF（真实文本型 PDF）→ record → 查询 → 命中 + Citation 显示页码（若抽取到）；
5. URL（稳定公开网页）→ record → 新会话查询 → 命中 + Citation 保留 URL；
6. secret 文件（password=abc123456）→ record → 抛 SensitiveSourceRejectedError → 没有 sources/documents/chunks/embeddings/staging 残留；
7. 重复记录同一文件 → 不新增 Document/Chunk/Embedding 行（SQL 计数前后差为 0）；
8. 创建无历史会话（knowledgeBaseId=null，agent=daymind）→ 仍能命中上述 Source。

**static check**：`npm run typecheck` + `git diff --check`。前端 `npm run build`。

## 11. SQL / 权限 / 路由 / 前端 变更

- **SQL**：**不修改** `backend/database/init.sql`。所有表与索引已就绪。**不新增** 业务 SQL 文件。
- **业务 SQL 同步**：无。
- **权限 / 菜单 / 字典**：无。
- **后端路由新增**：
  - `POST /sources/file`（multipart，`uploadBodyLimitMiddleware`）
  - `POST /sources/url`（JSON：`{url, intent?: boolean}`）
- **前端变更**：
  - `frontend/src/lib/api.ts` 新增 `recordFileSource(formData)` / `recordUrlSource({url, intent})`。
  - `frontend/src/features/chat/components/AssistantChatWorkspace.tsx` Composer 加附件按钮 + URL 按钮 + 意图确认分支；422 显示既有"未识别到明确的记录意图"风格的中文提示。

## 12. 文件清单

### 新增

- `backend/src/modules/sources/parsers/types.ts`
- `backend/src/modules/sources/parsers/registry.ts`
- `backend/src/modules/sources/parsers/text-parser.ts`
- `backend/src/modules/sources/parsers/plain-text-file.ts`
- `backend/src/modules/sources/parsers/markdown-parser.ts`
- `backend/src/modules/sources/parsers/pdf-parser.ts`
- `backend/src/modules/sources/parsers/docx-parser.ts`
- `backend/src/modules/sources/parsers/url-parser.ts`
- `backend/src/modules/sources/parsers/url-fetcher.ts`
- `backend/src/modules/sources/parsers/__tests__/registry.test.ts`（命名与 `daymind-source-safety.ts` 一致即可）
- `backend/src/scripts/verify-daymind-file-and-url.ts`
- `backend/tests/unit/sources-parser-registry.ts`
- `backend/tests/unit/sources-url-safety.ts`
- `backend/tests/unit/sources-secret-intercept.ts`
- `backend/tests/unit/sources-markdown-headings.ts`

### 修改

- `backend/src/modules/sources/service.ts`：抽出 `recordSourceService(input)`，保留 `recordTextSource` 作为薄包装；新增 `recordFileSource`、`recordUrlSource`。
- `backend/src/modules/sources/retrieval.ts`：lexical 分支把 `metadata.page/heading` 与 `metadata.finalUrl` 映射到 Citation 字段。
- `backend/src/modules/knowledge/rag/retriever.ts::searchWorkspaceSources`：同样把 chunk metadata.page/heading 写到 Citation。
- `backend/src/modules/citations/types.ts`：加 `page?` / `url?`。
- `backend/src/server/routes/sources.ts`：新增 `recordFileSourceRoute` / `recordUrlSourceRoute`。
- `backend/src/server/bootstrap.ts`：注册新路由。
- `backend/package.json`：加 `pdf-parse`、`mammoth`、`cheerio`。
- `frontend/src/lib/api.ts`：新增 `recordFileSource` / `recordUrlSource`。
- `frontend/src/features/chat/components/AssistantChatWorkspace.tsx`：附件 + URL + 意图确认。
- `docs/architecture.md`、`README.md`：在 Daymind 章节标注"现支持 .txt / .md / .pdf / .docx / 普通公开 URL 录入"。

### 复用不改

- `infrastructure/storage/{document-storage,local-storage}.ts`
- `modules/documents/text-splitter.ts`
- `modules/documents/jobs-repository.ts`（异步 ingestion worker 暂不入本阶段 record 路径；同步落库路径沿用现有 `recordTextSource`）
- `modules/sources/sensitive-data-scanner.ts`
- `modules/sources/record-intent.ts`
- `modules/documents/parsers/registry.ts`（KB 异步 ingestion 用，不动）

## 13. 不做事项的明确声明

- 不创建并行 KB 系统；Source 唯一事实层。
- 不改 `init.sql`；不创建新的 SQL 文件。
- 不引入 LLM-based Wiki 总结；不引入 Memory 等级架构。
- 不做 .xlsx/.xls/.pptx；不做图片 OCR；不做 Word/PDF 编辑。
- 不做浏览器自动化；不做登录抓取；不做 Cookie / 反爬绕过。
- 不重写既有 Composer / Conversation / Run 链路。
- 不重构 Daymind 无关代码；不升级依赖（除新增 3 个 parser 库）。

## 14. 已知风险与未完成事项

- **`git fetch upstream` 在本会话内网络失败**（无法访问 github.com:443）。**未做 upstream diff 检查**；按 AGENTS.md 流程，用户需自行复核 upstream 是否有 mastra-agent-starter 新提交需合并。
- **PDF 解析 page 字段依赖 pdf-parse 的真实抽取**；扫描型 / 图像型 PDF 会得到空文本，不会伪造 page。
- **DOCX headings 是 best-effort**；不保证完整保留 Word 样式映射。
- **URL 仅支持静态公开网页**；登录 / JS 渲染 / 反爬站点会被拒绝或返回空正文。
- **Embedding provider 维度**：复用现有 `getOrCreateActiveEmbeddingProfile`；如 Profile 维度与 text-embedding-3-small 默认 1536 不一致，嵌入步骤会抛 `EMBEDDING_DIM_MISMATCH`，由上游 retry 路径处理。
- **未在本轮验证**：多进程并发 record 的跨进程 dedup；E2E 脚本的 CI 接入；浏览器端附件上传 UI 的人工验收（受本机环境限制）。
