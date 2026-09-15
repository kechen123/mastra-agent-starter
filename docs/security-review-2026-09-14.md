# 项目安全与可靠性审查报告（2026-09-14）

## 执行摘要

本次审查覆盖后端 TypeScript/Mastra/Hono 路由、React 前端、PostgreSQL 数据隔离、认证会话、文档上传与本地存储、市场 Skill、Tool 审批、RAG 外部请求、CI 和依赖树。审查采用静态代码追踪与 `npm audit`，未启动服务、未连接 PostgreSQL、未调用 DeepSeek、Embedding、MinerU，也未做浏览器动态渗透测试。

未发现已经证实的 Critical 漏洞。初始审查确认 2 项 High、6 项 Medium、1 项 Low 问题。

> **2026-09-15 修复状态**：按当前范围已完成 SEC-02、SEC-03、SEC-06、SEC-07、REL-01、SEC-08，以及 SEC-05 中非 Skill 的 Run SSE 错误脱敏；SEC-01 和 SEC-05 的 Skill 路由子项按用户要求暂不处理，SEC-04 限流/配额也不在本轮范围。修复后的依赖 audit、隔离 PostgreSQL CI 和真实部署/浏览器验收仍须分别执行，不能把本报告的静态结论等同于渗透或生产验收。

已经存在的有效安全控制包括：业务路由统一认证包装、服务端派生 Workspace、主要 SQL 参数化、跨 Workspace 资源统一返回 404、会话 token 仅存哈希、HttpOnly/SameSite Cookie、写请求 Origin 精确校验、Tool 审批 fail-closed、Embedding 错误脱敏以及上传文件名路径净化。

## High

### SEC-01：任意已登录 Workspace 可以覆盖或删除全局 Skill 包

- 规则 ID：AUTHZ-TENANT-001
- 严重级别：High
- 位置：`backend/src/server/routes/skills.ts:167-199`；`backend/src/infrastructure/external-skills/market.ts:279-322`；`backend/src/core/skill/registry.ts:288-323`
- 证据：更新接口把 `workspaceId` 传给 `updateMarketSkill`，但最终仍对全局 `skill_packages(id)` 执行 UPSERT 并重写共享磁盘目录；卸载接口丢弃认证上下文，调用 `uninstallMarketSkill(id)`，随后执行 `DELETE FROM skill_packages WHERE id = $1`。该外键删除会级联清理所有 Workspace 的启用与绑定记录。
- 影响：任意合法用户都可以更新或卸载其他 Workspace 正在使用的市场 Skill；更新还可能让共享 Skill 指令在其他 Workspace 下发生未经授权的变化。这是跨租户完整性问题。
- 修复：明确全局包治理模型。最小安全方案是把全局安装、更新、卸载限制为平台管理员；普通 Workspace 用户只能增删自己的 `workspace_skills` 启用关系。若产品要求各 Workspace 独立版本，则把包实体和磁盘目录纳入 Workspace/版本维度，避免全局原地覆盖。
- 缓解：修复前关闭市场 Skill 的 update/delete 路由，或仅在单用户部署中开放。
- 误报说明：只有在部署永远只有一个可信用户、且不允许创建第二个账号时风险才明显降低；当前数据库与认证代码支持多个用户，因此不能按单用户假设处理。

### SEC-02：后端生产依赖包含已公开的高危漏洞版本

**状态：已修复，待完整回归。** `backend/package.json` / lockfile 已锁定 `fast-uri@3.1.6`、`hono@4.13.5`、`js-yaml@3.15.2`，未升级 Mastra 主版本；本轮本机 `npm audit --omit=dev` 已复查为 0 vulnerabilities。

- 规则 ID：SUPPLY-CHAIN-001
- 严重级别：High
- 位置：`backend/package-lock.json`；依赖链由 `@mastra/core@1.65.0`、`@mastra/server@1.65.0`、`mastra@1.28.0` 引入。
- 证据：使用官方 npm registry 执行 `npm audit --omit=dev --json`，报告 `fast-uri@3.1.5` 的多项 host confusion/SSRF 公告、`js-yaml@3.15.1` 的 CPU DoS 公告，以及 `hono@4.13.3` 的 3 项中危公告；共 2 High、1 Moderate。前端生产依赖报告 0 项。
- 影响：如果易受影响的 URL/YAML/Hono 解析路径接收攻击者可控输入，可能导致 SSRF/主机校验绕过、CPU 或内存耗尽、路径写出或代理/缓存解释差异。具体可利用性还取决于 Mastra 对这些依赖的调用路径。
- 修复：先尝试不改变 Mastra 主版本的锁文件级安全更新；确认 `fast-uri >=3.1.6`、`hono >=4.13.5`。`js-yaml` 由 `gray-matter@4.0.3` 引入，需要确认 Mastra 可兼容的上游修复版本或受控 override，并运行完整 contract/unit/fixture/PG integration 与真实 Skill 解析回归。
- 缓解：在更新前限制公开的市场 Skill/YAML 输入规模和来源，并避免用相关 URL 解析结果做网络访问授权判断。
- 误报说明：`npm audit` 证明版本受影响，不等于本项目每个公告都可直接利用；需要针对 Mastra 实际调用链做动态验证。

## Medium

### SEC-03：上传大小限制发生在 multipart 已被解析之后

**状态：已修复。** 上传路由在 `formData()` 前接入 Hono `bodyLimit`，请求体上限 10.5 MB，单个文件仍限制 10 MB；Mastra 全局 `bodySizeLimit` 同步为 10.5 MB，避免默认 4.5 MB 提前拒绝合法文件。反向代理限额与存储/频率配额尚未配置。

- 规则 ID：UPLOAD-DOS-001
- 严重级别：Medium
- 位置：`backend/src/server/routes/documents.ts:29-45`、`backend/src/server/routes/documents.ts:160-169`
- 证据：路由先执行 `context.req.formData()`，之后才通过 `File.size > 10 MB` 拒绝；随后还会执行 `arrayBuffer()`，应用层没有请求体级上限、Workspace 存储配额或上传频率限制。
- 影响：已认证用户可发送远大于 10 MB 的 multipart 请求，让运行时在拒绝前解析并占用内存/临时资源；重复上传还可能造成内存、磁盘、解析任务和模型费用压力。
- 修复：在反向代理和 Hono/Mastra 请求入口设置硬 body limit；能读取可信 `Content-Length` 时提前拒绝，但不能只依赖该头。再补每 Workspace 存储/并发任务配额，并对允许扩展名、MIME 与内容特征做一致校验。
- 缓解：网关先配置请求体上限和每用户上传速率限制。
- 误报说明：边缘代理可能已经限制请求体，但仓库中不可见，需检查部署配置和真实响应。

### SEC-04：登录和高成本业务入口没有限流或失败锁定

- 规则 ID：AUTH-ABUSE-001
- 严重级别：Medium
- 位置：`backend/src/server/routes/auth.ts:61-105`；`backend/src/server/routes/v2alpha/shared-handlers.ts:112-299`；`backend/src/server/routes/documents.ts:20-118`
- 证据：登录实现具备统一错误与等时密码校验，但没有 IP/用户名失败次数限制；聊天 Run、市场 Skill 网络请求和文档上传也没有每用户/Workspace 并发与速率配额。`docs/architecture-v2.md:2371-2374` 声明了 rate/body/upload 配置，但当前代码和 `.env.example` 没有对应实现。
- 影响：可能遭受密码猜测、会话/Run 洪泛、第三方 API 费用消耗以及 worker 队列堆积。
- 修复：优先在可信网关做 IP 限流，并在应用层实现登录账号维度的渐进退避；聊天/上传/市场请求按 user + workspace 做额度和并发控制。返回标准 429 和 `Retry-After`。
- 缓解：在尚未实现应用限流时，不要把服务直接暴露公网；使用反向代理/WAF 限流。
- 误报说明：如果部署层已经有可靠限流，需要用部署配置和运行时响应确认，并修正文档说明控制位于何处。

### SEC-05：部分内部异常文本会直接进入客户端响应或持久化 SSE

**状态：部分修复。** `run-executor` 的 `run-failed` payload 已改为 errorCode 到稳定安全文案的映射，原始异常不再持久化到 SSE；Skill 路由的原始错误回传按本轮范围暂不处理。

- 规则 ID：ERROR-DISCLOSURE-001
- 严重级别：Medium
- 位置：`backend/src/server/routes/skills.ts:103-105,139-141,160-162,180-182,197-199`；`backend/src/core/execution/run-executor.ts:1185-1191,1635-1678`；`frontend/src/app/App.tsx:706-710`
- 证据：Skill 路由直接把 `err.message` 返回给客户端；`failRun` 把传入的 `err.message` 写入可回放 `run-failed` 事件，前端直接显示该字段。Run 在读取历史或数据库失败时可能传入数据库/内部异常原文。
- 影响：认证用户可能看到内部路径、上游 URL、数据库约束或实现细节；持久化事件会延长信息暴露时间。
- 修复：建立稳定错误码到安全用户文案的映射；原始异常只进入受控服务端日志，并确保日志不含凭据。Skill 市场错误按 network/not_found/invalid_package/upstream_error 分类。
- 缓解：生产日志和错误响应做集中脱敏，避免返回第三方库原始错误。
- 误报说明：某些当前错误文本本身是安全中文，但代码允许任意下游异常原文穿透，因此边界并不稳定。

### SEC-06：模型生成的 Markdown 链接缺少协议白名单

**状态：已修复。** `sanitizeLinkTarget` 只允许 HTTPS、本机 HTTP 和明确相对路径；其余目标退化为文本，并有协议大小写、控制字符和协议相对 URL 单元测试。

- 规则 ID：REACT-URL-001
- 严重级别：Medium
- 位置：`frontend/src/features/chat/components/Markdown.tsx:49-61`
- 证据：Markdown 中的任意 `[text](url)` 都直接赋给 `<a href={linkMatch[2]}>`；虽然使用了 `rel="noopener noreferrer"`，但没有只允许 `http:`、`https:` 和受控相对链接。
- 影响：模型输出、被检索文档或提示注入可以构造欺骗性/危险协议链接，诱导用户点击。React 当前版本可能拦截部分 `javascript:` URL，但产品安全不应依赖未在本项目中显式测试的框架细节。
- 修复：增加纯函数 `sanitizeLinkTarget`，只允许 `https:`、受控开发期 `http:` 和明确需要的相对路径；其余渲染为普通文本。为大小写、空白/控制字符、编码和协议相对 URL 增加测试。
- 缓解：部署 CSP，并保持 `noopener noreferrer`。
- 误报说明：没有发现 raw HTML 注入或 `dangerouslySetInnerHTML`；风险限于链接目标与社会工程，不是已证实的 DOM XSS。

### SEC-07：仓库内未见生产安全响应头基线

**状态：部分修复。** API 已下发 nosniff、DENY、no-referrer、Permissions-Policy；前端入口有 CSP/referrer meta。生产反向代理仍必须实际配置 `frame-ancestors` 等 HTTP CSP 并做真实响应验证。

- 规则 ID：REACT-CSP-001
- 严重级别：Medium
- 位置：`frontend/index.html:1-13`；`backend/src/server/bootstrap.ts:136-165`
- 证据：未找到 `Content-Security-Policy`、`frame-ancestors`/`X-Frame-Options`、`X-Content-Type-Options` 或 `Referrer-Policy` 配置。前端会显示模型和文档派生内容，CSP 是重要的纵深防御。
- 影响：一旦未来引入 XSS sink 或第三方脚本问题，缺少浏览器侧约束会扩大影响；同时缺少显式点击劫持和 MIME sniffing 防护。
- 修复：优先在生产反向代理/边缘层设置响应头；为当前 Vite 产物制定不含 `unsafe-eval` 的 CSP，并根据真实资源逐步收紧。点击劫持策略需先确认是否允许嵌入。
- 缓解：可先用 CSP Report-Only 收集兼容性问题。
- 误报说明：这些头可能由部署平台设置，仓库静态审查无法确认；上线前必须用真实 HTTP 响应验证。

### REL-01：CI 与版本文档存在可验证的漂移

**状态：已修复。** 新增隔离 pgvector service 的 integration workflow；文档已将 1.61 真实验收标为历史证据，并明确当前 1.65.0 尚未做真实模型/浏览器 E2E。

- 规则 ID：VERIFICATION-DRIFT-001
- 严重级别：Medium
- 位置：`.github/workflows/verify.yml:7-11`；`docs/architecture.md:16,305-307`；`docs/implementation-plan.md:627,771,844`；`docs/runbooks/staging-tool-approval-e2e.md:3-7`
- 证据：`verify.yml` 注释称 PostgreSQL integration 由独立 `integration.yml` 执行，但 `.github/workflows/` 实际只有 `verify.yml`。多处当前架构/运行说明仍以 Mastra 1.61 为已验证基线，而 `backend/package.json` 已固定 `@mastra/core@1.65.0`。
- 影响：维护者可能误以为 PG 集成测试已由 CI 持续执行，或把 1.61 的真实验收证据错误外推到 1.65.0；并发、审批恢复、Schema/RAG 问题可能在普通检查全绿时进入主分支。
- 修复：新增真正使用隔离 PostgreSQL service/container 的 integration workflow，或把注释改成“尚未建立”；把历史 1.61 记录明确标为历史证据，并单列 1.65.0 尚未完成的真实模型/审批恢复验收。
- 缓解：合并前人工运行隔离 PG 集成测试，并在 PR 中明确记录 skipped 数量。
- 误报说明：本地曾经跑通的 1.61/PG 记录仍有历史价值，问题是其当前适用范围描述不清。

## Low

### SEC-08：Calculator 使用 `new Function` 动态求值

**状态：已修复。** Calculator 改用受限的四则运算递归下降解析器，长度、字符集、嵌套和非有限结果均受限制，无动态代码执行。

- 规则 ID：JS-XSS-003 / CODE-EXEC-001
- 严重级别：Low
- 位置：`backend/src/tools/calculator/tool.ts:19-35`
- 证据：表达式经过 `^[\\d+\\-*/().]+$` 白名单和 200 字符长度限制后传给 `new Function`。
- 影响：当前字符白名单使直接代码注入很难成立，因此不是已证实的 RCE；但动态编译扩大审计面，也会与严格 `unsafe-eval` 策略冲突，未来白名单修改容易引入高风险回归。
- 修复：改为小型算术 tokenizer/parser，或使用项目已批准且不执行任意代码的表达式求值能力；保留深度、token 数和除零/非有限值限制。
- 缓解：在测试中固定危险字符、Unicode、指数/超长括号和语法异常用例，并禁止扩大字符白名单。
- 误报说明：该代码运行在 Node 后端，不是浏览器 DOM XSS；当前严格白名单显著降低可利用性。

## 建议修复顺序

1. SEC-01：明确全局 Skill 的平台管理员边界，并补跨 Workspace 集成测试。
2. SEC-04：在可信网关和应用层补登录/上传/Run 的限流与配额。
3. 对已完成项执行隔离 PostgreSQL CI、真实 Provider 和浏览器/部署网关验收。

## 本次实际检查

- `git status --short --branch`、路由/SQL/文件系统/网络/前端危险 sink 的静态检索。
- 初始 `npm audit --omit=dev --json --registry=https://registry.npmjs.org`（backend）：2 High、1 Moderate、0 Critical；2026-09-15 锁定补丁后本机复查为 0 vulnerabilities。
- 同命令（frontend）：0 个生产依赖漏洞。
- `npm explain fast-uri`、`npm explain hono`、`npm explain js-yaml`：确认均由 Mastra/相关传递依赖带入。

## 未验证边界

- 未连接真实 PostgreSQL，因此未做 SQL 权限、RLS、并发与锁的动态验证。
- 未调用 DeepSeek、Embedding、MinerU 或 skills.sh，因此未验证真实上游错误内容、超时与重试行为。
- 未启动浏览器，因此未验证生产响应头、Cookie Secure、CORS/Origin、Markdown URL 点击行为。
- 未做依赖漏洞 PoC；SEC-02 的项目级可利用性仍需按实际 Mastra 调用路径确认。
