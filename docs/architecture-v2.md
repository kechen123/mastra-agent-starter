# Agent Starter 生产化总体架构设计 V2

> **本版本已被本次裁决覆盖**：迁移链 / Legacy Workspace / `LEGACY_WORKSPACE_OWNER_USER_ID` ——以 `docs/superpowers/specs/2026-08-28-workspace-id-isolation-design.md` §5 为准。**注意**：PR-1.4 `skills_installed → skill_packages` 重命名**不**在本裁决覆盖范围内，仍按原计划后续 PR 实施。

> 本文档取代前一版 V1。V1 的所有目标（Workspace、AgentRun、Tool Policy Gateway、限流、可观测性）保留并增强，关键变更集中在「RAG 模块边界」「Agent 命名空间粒度」「会话创建时序」「SSE 事件日志形态」「Tool Gateway 拦截策略」五处架构裁决上。
>
> 适用边界：本文是面向 **Core / Full / Production** 三档部署的统一设计语言。三档之间通过 `DEPLOYMENT_PROFILE` 与模块迁移而非运行时开关区分。

## 修订记录

| 版本 | 日期 | 主要修订 |
|---|---|---|
| V2.0 | 2026-08-27 | 初版：5 项架构裁决、阶段 0–5、附录 |
| V2.1 | 2026-08-27 | 8 处 P0/P1 修订：Embedding Profile、Legacy Shared Workspace、Run Lease、Approval 物理链路、DocumentStorage、Draft 接口统一、npm 全栈统一；同步修订 security_events / status 映射 / AbortSignal / Provider 熔断 / evaluation_cases 标注 / `/api/v1` 兼容窗口 / RAG 迁移 checksum / is_active 下沉 |
| V2.2 | 2026-08-27 | 5 处一致性修订：Shared Workspace owner 表达、POST messages 协议重做、Embedding hash 语义、Run Lease 与 Approval 超时分离、跨 KB 去重 + staging/finalize；同时清扫了 activate / lastEventSeq / created_by 等首批旧协议残留 |
| V2.3 | 2026-08-27 | 12 处二次清扫：Shared CHECK 收紧（personal NOT NULL / shared 必须 NULL）；Worker 抢占补 `lease_expires_at IS NULL` 兜底；消息/Run 创建事务顺序修正（先 message 后 run，最后回填 current_run_id；queued→run-queued，running→run-started）；eventsUrl 返回已渲染真实路径；幂等键冲突统一 `409 IDEMPOTENCY_KEY_REUSED`；§0 差异表消除"前端统一 pnpm"误导；阶段验收 `/ask` → `/conversations/:id/messages`、Lease 状态模型替代 2 分钟兜底；waiting_approval 超时统一 `stopped + APPROVAL_EXPIRED`；§8.4 Embedding UPSERT 复用 Decision 1（`<>` 而非 `=`）；§8.3 上传 + Outbox 去重统一到 §8.1 staging/finalize；Appendix E 重写为 V2.2/2.3 事务模型；V2.2 修订日志的"全文清扫"声明收回 |
| V2.3.1 | 2026-08-27 | 5 处实施级冲突修正：npm ci 锁文件策略（保留 `frontend/package-lock.json`，禁止删除后跑 `npm ci`）；Run 终态名 `succeeded → completed`（与 CHECK 一致）；§8.1 staging/finalize 重写（DB 预存 finalKey + `storage_status` 状态机，避免 finalize 后 DB 指针失效）；documents 三元组部分唯一索引（强制并发去重，替代普通索引）；`agent_runs.created_by` 字段统一（事务 SQL 写 `created_by`，与 schema 对齐） |
| V2.3.2 | 2026-08-27 | 4 处存储链路闭环：新增 `storage_finalize_jobs` 持久化 `staging_key`（进程崩溃后重试可定位）；`document_ingestion_jobs.status` 写 `queued`（与 CHECK 一致，不再写 `pending`）；ingestion worker 抢占 SQL JOIN documents 过滤 `storage_status='ready' AND deleted_at IS NULL`；`finalKey` 改为 `documents/<workspaceId>/<kbId>/<documentId>.<ext>`（含 `kbId`+`documentId`，避免跨 KB 同 hash 共享对象被 Outbox 误删）；并发上传唯一索引冲突时 `abortStaging` 并返回已有 document |
| V2.3.3 | 2026-08-27 | 4 个故障恢复窗口闭合：DocumentStorage 新增 `listStagingOlderThan(cutoff)` 让 TTL GC 发现事务前孤儿（putStaging 成功但 DB 事务提交前的崩溃）；任何 DB 失败 best-effort `abortStaging`（不仅唯一冲突）；finalize 抢占只设 Lease 不消耗 attempts（worker 抢占后崩溃不再留下永久卡死记录）；finalize 落库 SQL 补齐成功 / 失败 / 耗尽三条，受 `lease_owner + status='pending'` 保护；删除改为单事务串联软删除 + Outbox 入队 + 终止未完成 finalize job + 终止未完成 ingestion job；`storage_finalize_jobs.status` CHECK 新增 `'cancelled'` |
| V2.3.4 | 2026-08-27 | 4 处 SQL 级冲突修正（纯 SQL 定向）：`storage_finalize_jobs` 补 `processed_at TIMESTAMPTZ` 列（成功 / 失败 / 取消 终态时刻）；失败与耗尽合并为受 Lease 保护的单一事务（`CASE WHEN attempts+1 >= max_attempts THEN 'failed' ELSE 'pending' END`），消除旧 Step C 清 Lease 后 Step D 因 `lease_owner=NULL` 影响 0 行的死锁；`abortStaging` 仅在已确认 ROLLBACK（唯一索引冲突 / 显式 ROLLBACK / 可重试死锁）时调用，连接断开 / 超时 / 不确定提交改由 TTL GC 兜底（避免误删已成功落库的 staging 对象）；`storage_deletion_outbox.document_id` 由 `ON DELETE CASCADE` 改为 `ON DELETE SET NULL`（硬删 document 前必须先确认 outbox 已清零），同步新增 finalize-竞态补偿删除：旧 worker 在删除事务把 job 置 `cancelled` 之前已完成 finalize 时，Step B 影响 0 行后 best-effort `deleteObject(finalKey)` 兜底 |
| V2.3.5 | 2026-08-27 | 3 处 SQL 可执行性修正（纯 SQL 二次确认）：Step C/D 删除"概念 SQL + 应用层推荐实现"双轨描述，改为单条多 CTE SQL（`updated` + `failed_document` + `security_event` + 外层 SELECT），确保 CTE 同语句可见且 `attempts` 只递增一次；`security_events.event_type` CHECK 补 `'storage_finalize_exhausted'`，避免耗尽事务因 CHECK 违例整语句回滚；Step B 补偿删除：失败时必须 `INSERT INTO storage_deletion_outbox` 持久重试（TTL GC 只能枚举 staging，无法兜底 finalKey 对象） |

### V2.2 与 V2.1 的差异速览

| 维度 | V2.1 | V2.2 |
|---|---|---|
| Shared Workspace owner | `workspaces.kind='shared'` 时 `owner_user_id=NULL`（CHECK 约束）+ Legacy 迁移 `INSERT ... owner_user_id=:legacyOwnerId`（自相矛盾） | `owner_user_id` **仅**用于 Personal Workspace 唯一性；Shared Workspace owner 通过 `workspace_members.role='owner'` 表达；Legacy 创建 Shared 时 `owner_user_id=NULL`，环境变量指定用户写入 `workspace_members(role='owner')` |
| POST messages 协议 | `POST /conversations/:id/messages` 返回 SSE 流 | POST 返回 `202 {userMessageId, assistantMessageId, runId, eventsUrl}`；SSE 改由 `GET /runs/:runId/events` 建立；幂等键缓存 POST 的 202 JSON，不缓存 SSE |
| SSE 重连参数 | `?lastEventSeq=` | 标准 `Last-Event-ID` header（V2.1 已统一） |
| Embedding 写入 | `ON CONFLICT (chunk_id, profile_id) DO UPDATE WHERE content_hash = EXCLUDED.content_hash`（反向：内容变化保留旧向量） | 同 hash：`DO NOTHING`；异 hash：`UPDATE SET embedding=..., content_hash=..., updated_at=...`（同事务）；Profile 切换：旧 Profile 失活 + 新 Profile 激活 + 校验向量覆盖率 三步单事务 |
| Run Lease 范围 | `status IN ('queued','running','waiting_approval')` 均受 Lease 过期失败扫描 | 执行 Lease 只覆盖 `queued`/`running`；`waiting_approval` **释放执行 Lease**（`lease_owner=NULL, lease_expires_at=NULL`）；超时由 `tool_approval_requests.expires_at` 驱动，过期后 Run **统一**转 `stopped` + `error_code='APPROVAL_EXPIRED'`（V2.3 裁决：审批超时是用户主动放弃语义，不归类 failed）；`lease_expires_at IS NULL` 的 queued 也可被抢占 |
| 文档去重粒度 | `(workspace_id, sha256)` | `(workspace_id, knowledge_base_id, sha256)`；新增 `DocumentStorage.staging` + finalize 机制防对象存储孤儿 |
| POST messages 接口重复 | Decision 3 仍保留 `POST /conversations/:id/activate`；API 附录并列两个端点 | Decision 3 删除 activate；附录只保留 messages 端点 |
| 阶段 0 验收 | "保留 `frontend/package-lock.json`，删除 `pnpm-lock.yaml`" | 表述与 §4.1 完全一致：保留两个 `package-lock.json`，删除未跟踪的 `pnpm-lock.yaml`，CI 全部 `npm ci` |
| 阶段 1 验收 | "回填 `workspace_id`（按 created_by → user.personal_workspace_id）" | 删除：V2.2 改为按 Legacy Workspace 整体回填，不按 created_by 推断 |
| 阶段 1 跨 Workspace 测试对象 | 包含 `agent_skill_bindings` / `skill_packages` | 隔离测试只覆盖 `agent_skill_bindings`；`skill_packages` 是全局表，不在隔离测试范围 |
| Provider 健康检查 | "每 30s 主动 ping" | 删除主动 ping；改被动熔断（V2.1 §9.2 已修，章节中残留文字清理） |

### V2.3 与 V2.2 的差异速览

| 维度 | V2.2 | V2.3 |
|---|---|---|
| workspaces CHECK | personal NOT NULL / shared 允许 NULL **或** 非 NULL（V2.2 留了"显示性写入"反模式） | personal NOT NULL / shared **必须** NULL；Shared owner 完全交给 `workspace_members.role='owner'` |
| Worker 抢占 SQL | `(lease_owner IS NULL OR lease_expires_at < now())` | 补 `lease_expires_at IS NULL` 兜底，防止 lease_owner 非空但 expires_at 为空时 Run 不可回收 |
| 事务顺序（POST /messages） | step 3 写 assistant message 时直接 `current_run_id=...`、step 4 才建 Run（FK 风险） | 先建 assistant message（`current_run_id=NULL`）→ 建 Run（`assistant_message_id` 反向指向 message）→ 回填 `messages.current_run_id` |
| 事件与状态对齐 | Run INSERT 时写 `run-started`，但 status='queued | Run INSERT 时写 `run-queued`（与状态一致）；`run-started` 留到 worker 抢占、status 转 `'running'` 时再发 |
| eventsUrl 示例 | 写 `"GET /api/v1/runs/:runId/events"` 模板 | 返回已渲染真实路径，形如 `"/api/v1/runs/<actual-runId>/events"` |
| 幂等键冲突码 | 正文 422 / 附录 D 409（分裂） | 正文与附录 D 一律 `409 IDEMPOTENCY_KEY_REUSED` |
| §0 差异表"前端统一 pnpm" | V2.0 行写"统一 pnpm"，易被误解为当前规范 | 改为"前后端统一 npm ci"；V2.0 的 pnpm 决议被显式覆盖 |
| 阶段验收 /ask | 仍出现 `/ask`、`pending/streaming Run 2 分钟后 failed` 旧表述 | 验收全部替换为 `/conversations/:id/messages`；超时模型改写为 Lease 过期失败扫描 + 审批超时另算 |
| waiting_approval 超时终态 | "stopped 或 failed（待业务决定）" | 架构裁决：统一 `stopped` + `error_code='APPROVAL_EXPIRED'`，不再分裂 |
| §8.4 Embedding UPSERT | 保留第二份 `content_hash = EXCLUDED.content_hash` 反向 SQL | 删除重复；UPSERT 复用 Decision 1（`content_hash IS DISTINCT FROM`），单一权威 |
| §8.3 上传 + §8.1 staging | §8.3 仍按 `(workspace_id, sha256)` + `DocumentStorage.put` 直写，绕过 staging/finalize；§8.1 的 Outbox 删除段重复一次 | §8.3 改用 `(workspace_id, knowledge_base_id, sha256)` + `putStaging`/`finalize`，与 §8.1 单一来源；Outbox 重复段删除 |
| Appendix E 状态机 | 仍写"返回 SSE 流（同 /ask）"、事务内预写模型首段 | 重写为 POST 202 JSON + 独立 GET SSE；事务内不预写模型首段；事件表与 §6.2 对齐 |

### V2.3.1 与 V2.3 的差异速览

| 维度 | V2.3 | V2.3.1 |
|---|---|---|
| §4.1 npm ci 锁文件 | 要求"删除 `frontend/package-lock.json`"，再让 CI 跑 `npm ci`（自相矛盾，CI 会立刻失败） | 保留并提交 `frontend/package-lock.json`；若不存在由维护者 `npm install --package-lock-only` 生成；禁止删锁后跑 `npm ci` |
| Run 终态名 | `agent_runs.status` CHECK 写 `completed`，§6.2 状态对齐表 + Appendix E 写 `succeeded` | 全部统一为 `completed`；状态对齐表与 Appendix E 删除 `succeeded` |
| §8.1 staging/finalize | DB 存 `storage_key=stagingKey`；finalize 后对象移到 `finalKey`，DB 未更新 → finalize 成功后 DB 指向已不存在的 staging 对象 | DB 直接落 `finalKey`，新增 `documents.storage_status`（`storage_pending` / `ready` / `storage_failed`）；finalize 成功置 `ready`，失败保留 `pending` 由 worker 重试，job worker 只拾取 `ready` |
| documents 唯一性 | 普通索引 `documents_sha256_idx(workspace_id, sha256)`；正文声称"DB 唯一约束保证去重"实际不存在 | 替换为部分唯一索引 `documents_dedup_unique_idx(workspace_id, knowledge_base_id, sha256) WHERE deleted_at IS NULL`；新增 `deleted_at` 列支持软删除与唯一约束共存 |
| `agent_runs` 发起人字段 | §6.2 事务 SQL 写 `user_id`，但 schema 定义的是 `created_by` | 事务 SQL 与 schema 一律使用 `created_by`；`idempotency_keys.user_id` 保持不变（不同表语义不同） |
| §8.1 旧"命中后写 Storage"描述 | 文中同时存在"命中则跳过 Storage"与"命中仍写新对象由 GC 收敛"两种说法，互相矛盾 | 删除旧"命中仍写新对象"描述，仅保留"命中则跳过 Storage 与 DB 写入"，与 §8.3 一致 |

### V2.3.2 与 V2.3.1 的差异速览

| 维度 | V2.3.1 | V2.3.2 |
|---|---|---|
| staging_key 持久化 | `stagingKey` 只在内存；进程在 `putStaging` 后崩溃，重试 worker 无法定位 staging 对象 | 新增 `storage_finalize_jobs` 表持久化 `(document_id, staging_key, final_key, status, attempts, max_attempts, next_attempt_at, lease_owner, lease_expires_at, last_error)`；finalize 重试 worker 从此表 SELECT 抢占 |
| ingestion job status | §8.1/§8.3 写 `INSERT INTO document_ingestion_jobs (status='pending', ...)`，但 schema CHECK 仅允许 `queued/parsing/cleaning/chunking/embedding/completed/failed/cancelled` | 统一写 `status='queued'`；与 schema CHECK 对齐 |
| ingestion worker 实际过滤 | 抢占 SQL 只查 `document_ingestion_jobs`，不变式声称"worker 只处理 `ready` 文档"无法兑现 | 抢占 SQL 改为 `JOIN documents ON document_id` + `WHERE d.storage_status='ready' AND d.deleted_at IS NULL`；同样修正 `lease_expires_at IS NULL` 兜底分支 |
| `finalKey` 唯一性 | `finalKey = documents/<workspaceId>/<sha256>.<ext>`，不含 kb/document 维度 | `finalKey = documents/<workspaceId>/<kbId>/<documentId>.<ext>`；删除走 Outbox 时按 finalKey 单文档清理，不会误删同 hash 其他 KB 仍在用的对象 |
| 并发上传冲突处理 | 第二个请求在 putStaging 后命中唯一索引会遗留 staging 对象 | INSERT 唯一索引冲突 → `storage.abortStaging(stagingKey)` → 查 `documents` 拿已有 document → 返回 200；不遗留 staging |

### V2.3.3 与 V2.3.2 的差异速览

| 维度 | V2.3.2 | V2.3.3 |
|---|---|---|
| 事务前 staging 孤儿 | GC 仅从 `storage_finalize_jobs` 枚举 staging_key；putStaging 成功但三表 INSERT 提交前崩溃 → 无任何 DB 记录，GC 无法发现 | `DocumentStorage` 新增 `listStagingOlderThan(cutoff)`；GC 从 Storage 列举超过 TTL 的 staging 对象，减去 `storage_finalize_jobs.status='pending'` 的活跃 set，剩下的执行 `abortStaging` |
| DB 失败处理 | 仅唯一索引冲突分支做 `abortStaging`；其他 DB 错误（连接断开 / 死锁 / 超时）会遗留 staging 对象 | 任何 DB 失败（包括唯一冲突、连接断开、死锁、超时）都必须 best-effort `await storage.abortStaging(stagingKey)`；TTL GC 兜底 |
| finalize 抢占语义 | 抢占 SQL 同步 `attempts = attempts + 1`；worker 抢占后崩溃会留下 `attempts=max_attempts AND status='pending'` 永久卡死 | 抢占**只设 Lease**（`attempts` 不变）；worker 崩溃后 Lease 过期，下一轮 worker 重新抢占；`attempts` 仅在 finalize **实际失败**后递增 |
| finalize 落库协议 | 仅定义抢占 SQL；无成功 / 失败 / 耗尽的受 Lease 保护落库协议 | 补齐 4 步：抢占 / 成功（job=done + document=ready 同事务）/ 失败（last_error + attempts++ + 指数退避 + 清 Lease）/ 耗尽（job=failed + document=storage_failed + security_events）；全部带 `id=:jobId AND lease_owner=:workerId AND status='pending'` |
| 删除流程 | 描述"删除 documents 行时同时 INSERT Outbox"；与 `deleted_at` 软删除语义冲突 | 单事务串联 4 步：`UPDATE deleted_at=now()` + `INSERT storage_deletion_outbox(final_key)` + 终止未完成 finalize job（status=cancelled）+ 终止未完成 ingestion job；Outbox worker 按 finalKey 单文档清理 storage 对象 |
| `storage_finalize_jobs.status` CHECK | `'pending' / 'done' / 'failed'` 三态 | 新增 `'cancelled'`（删除事务置位） |

### V2.3.4 与 V2.3.3 的差异速览（纯 SQL 定向）

| 维度 | V2.3.3 | V2.3.4 |
|---|---|---|
| `storage_finalize_jobs.processed_at` | 引用了但 schema 未定义（Step B/D 与删除事务都会写 `processed_at`，导致 SQL 报错 `column does not exist`） | schema 补齐 `processed_at TIMESTAMPTZ`；成功 / 失败 / 取消三个终态统一写；pending 留空由下一轮处理 |
| finalize 失败→耗尽转换 | Step C 清 `lease_owner` 后 Step D 要求 `lease_owner=:workerId`，**影响 0 行**，耗尽任务停留在 `pending` | Step C/D 合并为单一 UPDATE：`attempts=attempts+1` 与 `status=CASE WHEN attempts+1>=max_attempts THEN 'failed' ELSE 'pending' END` 在同一语句完成；RETURNING 决定是否同事务落 `documents.storage_failed` 与 `security_events` |
| `abortStaging` 触发条件 | "任何 DB 错都 abort"（包括连接断开 / 超时） | 仅在已确认 ROLLBACK（唯一索引冲突 / 显式 ROLLBACK / `deadlock_detected` / `serialization_failure`）时调用；连接断开 / 超时 / COMMIT 期间网络中断**绝不**立即 abort，由 TTL GC 兜底（避免误删已成功落库引用的 staging 对象） |
| finalize 竞态 | 旧 worker 完成 finalize 后落库受影响 0 行，但 `finalKey` 已存在 → 孤儿对象 | Step B 影响 0 行时（旧 worker 撞上删除事务的 cancel）→ best-effort `await storage.deleteObject(finalKey)`（`finalKey` 单文档独占，补偿删除安全） |
| `storage_deletion_outbox.document_id` | `REFERENCES documents(id) ON DELETE CASCADE`（硬删 document 会把未处理 outbox 一起带走，对应 Storage 对象永远得不到清理） | `REFERENCES documents(id) ON DELETE SET NULL`；outbox 生命周期与 documents 解耦，按 `storage_key` 独立完成；硬删前需校验对应 outbox 已清零 |

### V2.3.5 与 V2.3.4 的差异速览（SQL 可执行性定向）

| 维度 | V2.3.4 | V2.3.5 |
|---|---|---|
| Step C/D SQL 结构 | "概念 SQL"含两个独立 UPDATE（`WITH updated ... UPDATE documents` 然后单独的 `INSERT security_events FROM (UPDATE ... RETURNING) u`）；`updated` CTE 无法跨语句可见，第二段 `FROM (UPDATE ... RETURNING ...) u` 不是合法 PG 语法，且会重复 `attempts++` 后因 Lease 已清影响 0 行 | 单条多 CTE SQL：`updated`（递增 attempts + 决定 status + 清 Lease + RETURNING）+ `failed_document`（仅 status='failed' 时改 documents）+ `security_event`（仅 status='failed' 时写安全事件）+ 外层 `SELECT u.status, u.attempts, u.document_id FROM updated u` 触发整语句执行；`attempts` 只递增一次，CTE 在同一语句内可见 |
| `security_events.event_type` CHECK | `'storage_finalize_exhausted'` 不在枚举内，耗尽事务会因 CHECK 违例整语句回滚 | CHECK 补 `'storage_finalize_exhausted'`；阶段 4 写入路径同步注释 |
| Step B 影响 0 行的处置 | 无条件 best-effort `deleteObject(finalKey)`；失败后"由 TTL GC 兜底"（但 TTL GC 仅枚举 staging 命名空间，**不会**发现 finalKey） | 先查权威状态（`job.status` / 当前 `lease_owner` / `documents.deleted_at`）再分类：仅 `cancelled` 或已软删除才 `INSERT INTO storage_deletion_outbox` 交给 Outbox worker 持久重试；`pending` 且 Lease 已被新 worker 抢占 / `done` / `failed` 一律**不删**（否则会删掉新 worker 正要标记 ready 的对象） |

### V2.3.6 与 V2.3.5 的差异速览（代码基线对齐定向）

对照仓库实际基线（`backend/database/init.sql` + `0001-local-auth.sql`）勘察后，修正 5 处规范缺口。**本次不做全文清扫**，只改下列 5 项。

| 维度 | V2.3.5 | V2.3.6 |
|---|---|---|
| Core / RAG Schema 边界（§8.4.1 新增） | §8.7 要求"Core 模式启动不需要 pgvector"，但基线把向量内联在 `document_chunks.embedding vector(2048)`，`vector` 扩展是**启动硬依赖**——验收项无法成立 | 显式分层：Core Schema 不创建 `vector` 扩展、不创建 `document_chunks.embedding`；RAG 启用时才创建扩展 + `embedding_profiles` + `document_embeddings`。Core 路径 SQL 禁止引用 `vector` 类型 / `<=>` / `document_embeddings` |
| 存量内联向量迁移（§8.4.2 新增） | §8.4 只规定新表**怎么写入**，完全未定义存量 `document_chunks.embedding` **怎么迁**；阶段 4 无法确定迁移顺序与回滚边界 | 六步迁移：建 Legacy Profile（非激活）→ 判定搬迁/重算 → 回填 → 四项校验 → 切读（唯一切换点）→ 过 7 天回滚窗口才 DROP 列。附读写切换总序与每步回滚动作；**禁止**跳过校验直接切读、**禁止**切读后立即 DROP |
| 旧向量的模型归属 | 未规定 | `provider`/`model`/`dimensions` 三者必须全部显式确认且维度与列 typmod 一致才允许原样搬迁；任一无法确认 → **必须重新 embedding**。禁止用当前配置伪造归属（向量与模型不匹配会让检索静默劣化，相似度仍有数值但语义空间不同，数据上无法发现） |
| §8.7 Worker 回收判据 | 写作"基于 `locked_at` + timeout" | 两张 job 表都没有 `locked_at` 列。统一为 `lease_owner` / `lease_expires_at` 租约过期，与 §8.1 Step A、§8.2 抢占 SQL 一致 |
| `skills_installed → skill_packages` 阶段归属 | §5.1 只说"后续重命名"，未定阶段；§5.4 验收却已直接使用 `skill_packages` 名称 | 明确在**阶段 1** 完成，与 `agent_skill_bindings` 拆三表同阶段，避免两套表名在阶段 2～4 并存 |
| §5.4 隔离合约测试清单 | 覆盖 conversations / knowledge_bases / documents / tool_executions / agent_skill_bindings，遗漏 `document_chunks` | 补入 `document_chunks`——§5.1 已给它加 `workspace_id`，加了归属列却不验证隔离会留下盲区 |

| 维度 | V2.0 | V2.1 |
|---|---|---|
| Embedding 激活态 | `document_embeddings.is_active` 每行 | 新增 `embedding_profiles`；`is_active` 在 Profile 上；同 Profile 内 `(chunk_id, profile_id)` 唯一 |
| Embedding 维度 | `embedding vector(dimensions)` 同行 typmod | `embedding vector`（无 typmod）；按维度建立带 cast 的部分 HNSW：`USING hnsw ((embedding::vector(N)) vector_cosine_ops) WHERE dimensions = N` |
| Embedding 写入冲突 | `ON CONFLICT (chunk_id, provider, model) DO UPDATE WHERE existing.content_hash = EXCLUDED.content_hash`（反向） | `ON CONFLICT (chunk_id, profile_id) DO UPDATE SET embedding=EXCLUDED.embedding, dimensions=EXCLUDED.dimensions WHERE document_embeddings.content_hash = EXCLUDED.content_hash`（同步 hash 时才覆盖） |
| Embedding 写入时间 | 缺 `updated_at` | `document_embeddings` 加 `updated_at` |
| 历史数据回填 | 按 `created_by` 推断（无该列） | 新建 `Legacy Shared Workspace`，显式指定 owner；现有账号作为 member；新用户才创建 Personal Workspace |
| Personal Workspace 唯一性 | 仅应用层 `ensurePersonalWorkspace()` | DB 级：`workspaces(owner_user_id) UNIQUE WHERE kind='personal'` |
| `agent_runs.approval_request_id` | 引用阶段 3 表 | **删除**；审批只走 `tool_approval_requests.run_id → agent_runs.id` 单向 |
| 事件 ID | UUID `agent_run_events.id` + `seq` + 查询参数 `lastEventSeq` | `BIGINT IDENTITY` 全局递增；SSE 使用标准 `Last-Event-ID`；服务端按 `id > lastEventId AND run_id = ?` 回放 |
| 多实例 SSE | 仅描述"继续订阅"无方案 | 每后端实例一条 PG `LISTEN/NOTIFY` 共享连接，本地扇出；DB 是数据源，NOTIFY 仅做唤醒 |
| Run 失败判定 | `started_at < now() - interval '2 minutes'` | 长任务友好：加 `lease_owner` / `lease_expires_at` / `heartbeat_at`；worker 每 15s 心跳；过期未续约才算失败 |
| Tool Approval 物理链路 | wrap → Mastra Approval → 原 execute | 风险策略传入 `agent.stream(requireToolApproval = riskPolicy)`；Mastra 挂起前；持久化 `approval-requested`；resolve API **必须调用 Mastra approve/resume**；包装后 execute 恢复时二次校验 |
| 错误码 `424` | 列在错误码表 | **移除**；审批等待走 SSE `approval-requested` 事件，424 仅适用于同步依赖失败 |
| DocumentStorage | 未设计 | 新增接口：Core/Full 用受控本地数据目录，Production 用 S3-compatible；DB 只存 `storage_key` / `sha256` / `size` / `mime_type`；删除走 Outbox |
| `document_ingestion_jobs` | 缺外键、缺 lease | 加 `document_id` 外键（带 cascade）、`lease_expires_at`、`next_attempt_at`、`attempts`、`(document_id) UNIQUE WHERE status IN (active)` |
| Draft 启动 | `POST /conversations/:id/activate` + `POST /conversations/:id/messages` 双入口 | 统一为 `POST /api/v1/conversations/:id/messages`；阶段 2 引入 `Idempotency-Key`（不能拖到阶段 5）；`POST /conversations` 也支持幂等 |
| 包管理器 | "统一 npm" 但前端用 pnpm | **前后端统一 npm**；删除未跟踪的 `frontend/pnpm-lock.yaml`；CI 全部 `npm ci` |
| `security_events` | 阶段 1 引用但无 schema | 阶段 1 增加 schema 与写入路径 |
| `messages.status` ↔ run.status | 未映射 | `queued→pending`、`running/waiting_approval→streaming`、其余镜像 |
| `AbortSignal.timeout()` | 未提组合 | 必须 `AbortSignal.any([userSignal, timeoutSignal])`，不能覆盖用户停止 |
| Provider 切换 | 每次 pre-flight | 改**被动熔断**：连续失败 → unhealthy；只在首 token 前且确定无输出时 fallback |
| `evaluation_cases` | `expected_citations?`、`tags[]` 伪 schema | 标注"伪 schema，未在 V2 中落地"，阶段 7 实现时再敲定 |
| `/api/v1` 上线 | 直接替换 | 设兼容窗口：`/api/v1/v2alpha` + `/api/v1` 并行；前端先迁 `/api/v1/v2alpha`；稳定后删 `/api/v1/v2alpha` |
| RAG 模块迁移 | 跳过编号 | 模块迁移清单 + 每文件 sha256 checksum；module migrations 目录与编号独立 |
| `is_active` 归属 | 每条向量 | 在 Workspace 的 Embedding Profile 上 |

## 0. 与 V1 的差异速览

| 维度 | V1 提议 | V2 裁决 |
|---|---|---|
| RAG 与 Core 边界 | "Core 不强制依赖 pgvector"，但 `init.sql` 写死 `vector(2048)` | RAG 整体划入 **Full 可选模块**；Core Schema 不创建 `vector` 扩展；Embedding 迁到独立 `document_embeddings` 表，支持多模型多维度并存 |
| Agent 命名空间 | 未明确 | Agent/Tool 定义**全局**；绑定、知识库、Tool 授权按 Workspace 隔离；Skill 拆为 `skill_packages` / `workspace_skills` / `agent_skill_bindings` 三表 |
| 用户进入 Workspace | 未明确 | 首次本地登录自动创建 Personal Workspace（owner=self），邀请/SSO 预留接口；公开注册暂不开放 |
| 会话创建时机 | "第一条消息后 replace URL" | 进入 `/chat/new` 即服务端建 draft，replace 到 `/chat/:id`；draft 不入历史；24h 清理 |
| 最近路由持久化 | "按用户保存最近访问路由" | 暂不入库；用用户级 localStorage `mastra:last-route:<userId>`；显式退出时清除 |
| SSE 事件日志 | "后续再实现" | **PG 事件表 + 文本检查点合并**（250-500ms / ~512 字符）；不引入 Redis |
| Tool Gateway 拦截点 | 未指定 | **Mastra 原生 Approval + 自有 Policy 包装**（包 `ToolDefinition.tool.execute`）；不重写 Tool Dispatcher |
| 授权粒度 | 三档（once/session/persistent） | P0 仅 `once`；session/persistent 等权限和撤销机制成熟后再开放 |
| Tool Definition 字段 | 仅 capability 元数据 | 新增 `requiredScopes` / `policyHints` / `timeoutMs` / `maxRetries` |
| 数据库迁移策略 | 4 步回填 | 6 步回填（新增 Personal Workspace 创建 + 孤儿校验两步） |
| 测试现状 | "零自动化测试" | 后端已有 contract / unit / integration / fixture；CI 需补齐执行 |
| 前端包管理器 | 文档未明确 | 前后端统一 **npm**；删除未跟踪的 `frontend/pnpm-lock.yaml`；CI 全部 `npm ci`（V2.3 重写：原文"V2.0 统一 pnpm"误述，现统一 npm ci） |
| SSE 与 DB 连接 | 假设长连接占一个 PG 连接 | DB 查询按次从连接池获取，SSE 生命周期不持连接 |

---

## 1. 项目定位

最终提供三种可组合档位，通过 `DEPLOYMENT_PROFILE` 与模块迁移（而非运行时开关）区分：

### Core

最小 Agent 运行模板：

- Agent Registry（全局）
- Tool Registry（全局）
- Skill Registry（文件系统 + DB 索引）
- LLM Provider（DeepSeek 唯一正式启用，预留第二 Provider 扩展点）
- 流式执行 + 会话持久化
- 本地账号密码登录

**Core 不引入**：pgvector 扩展、Embedding 服务、MinerU、Workspace 多租户。

### Full

完整知识工作台 = Core + 独立 RAG 模块：

- RAG Pipeline（知识库 / 文档 / 解析 / Embedding / 混合检索 / Rerank / 引用）
- 文档异步 Worker（PG `FOR UPDATE SKIP LOCKED` 队列）
- 用户反馈
- Tool 执行审计

### Production

在 Full 基础上增加多实例生产安全：

- Workspace 数据隔离与 RBAC
- Tool Policy Gateway + Approval
- 限流与配额
- 持久化 Run 与事件日志
- OpenAI-compatible 第二 Provider
- 可观测性（结构化日志、Trace、成本归因）
- 用户反馈回归与 AI 评测
- 多实例部署

只有全部生产自检通过，`DEPLOYMENT_PROFILE=production` 才允许启动。

---

## 2. 目标架构

```text
HTTP / SSE
    ↓
Authentication
    ↓
Workspace Context + RBAC
    ↓
Rate Limit + Quota
    ↓
Conversation Ownership
    ↓
Agent Run Controller
    ├── Context Manager
    ├── RAG Pipeline（Full 档可选）
    ├── Model Router
    ├── Tool Policy Gateway
    │     ├── Workspace / 权限校验
    │     ├── 动态输入风险判断
    │     ├── 资源白名单（path / url / amount）
    │     ├── 超时与取消
    │     └── 输出脱敏
    ├── Skill Resolver（Workspace 作用域）
    └── Run Event Recorder → agent_run_events
    ↓
Mastra requireToolApproval（高风险 Tool 挂起）
    ↓
Tool.execute（实际执行）
    ↓
SSE / 持久化消息
    ↓
Trace / Usage / Audit / Feedback / Evaluation
```

**核心原则**：

- 请求必须先建立用户与 Workspace 上下文。
- 所有业务资源必须带 `workspace_id`；查询一律 `WHERE id = ? AND workspace_id = ?`。
- 每次生成对应一个持久化 `AgentRun`；并发通过 PG Partial Unique Index 约束。
- Tool 调用必须经过 Policy Gateway；高风险 Tool 必须经 Mastra `requireToolApproval`。
- 浏览器不保存消息正文、引用、Tool 输出；仅按用户保存最近路由（localStorage）。
- RAG、文档解析、市场 Skill 都是可选模块；Core 模式不应被任何 RAG 资源阻塞。
- 模型调用、检索、Tool、错误与成本都必须可追踪。

---

## 3. 关键架构决策（ADR 摘要）

### 决策 1：RAG = 可选 Full 模块，Embedding 独立表

**背景**：V1 把 RAG 描述为 Core 可选，但 `init.sql` 硬编码 `vector(2048)` 与 `CREATE EXTENSION vector`，Core 模式实际上跑不起来。`EMBEDDING_DIM=2048` 在 `config.ts` 也硬约束，切换 Embedding 模型需重写 schema + 全量重新嵌入。

**决议**：

1. Core Schema 不创建 `vector` 扩展、不引用 pgvector。
2. `document_chunks` 仅保存文本与元数据（`id` / `workspace_id` / `document_id` / `content` / `chunk_index` / `metadata` / `created_at`）。
3. 引入 **Embedding Profile** 概念：

```sql
CREATE TABLE embedding_profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,        -- 'doubao' / 'openai' / 'cohere' / ...
  model         TEXT NOT NULL,        -- 'doubao-embedding-vision-251215' / ...
  dimensions    INTEGER NOT NULL CHECK (dimensions > 0),
  status        TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'retired')),
  is_active     BOOLEAN NOT NULL DEFAULT false,  -- 同一 Workspace 同一时刻仅一个 active
  activated_at  TIMESTAMPTZ,
  retired_at    TIMESTAMPTZ,
  created_by    UUID NOT NULL REFERENCES app_users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, model)
);

-- 同一 Workspace 仅一个 active profile（DB 级强制）
CREATE UNIQUE INDEX one_active_embedding_profile_per_workspace
  ON embedding_profiles(workspace_id)
  WHERE is_active = true;
```

4. 向量表 `document_embeddings` 使用无 typmod 的 `vector`（避免 `vector(dimensions)` 这种不可执行声明）：

```sql
CREATE TABLE document_embeddings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id      UUID NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  profile_id    UUID NOT NULL REFERENCES embedding_profiles(id) ON DELETE CASCADE,
  dimensions    INTEGER NOT NULL CHECK (dimensions > 0),  -- 冗余但可索引
  embedding     vector NOT NULL,                          -- 无 typmod
  content_hash  TEXT NOT NULL,                            -- sha256(chunks.content)，用于幂等
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chunk_id, profile_id)
);
```

5. **激活态在 Profile 上**：`document_embeddings` 不再带 `is_active`。查询时按 `JOIN embedding_profiles ON status='active'` 过滤。切换模型只需 `UPDATE embedding_profiles SET is_active=true WHERE id=:newProfile, false WHERE id=:oldProfile`，旧向量保留。

6. **按维度建立带 cast 的部分 HNSW**（pgvector 不能跨维度共享一个索引）：

```sql
-- 示例：维度 1536
CREATE INDEX document_embeddings_hnsw_1536
  ON document_embeddings
  USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
  WHERE dimensions = 1536;

-- 维度 2048
CREATE INDEX document_embeddings_hnsw_2048
  ON document_embeddings
  USING hnsw ((embedding::vector(2048)) vector_cosine_ops)
  WHERE dimensions = 2048;
```

迁移 `migrations/rag/0001-vector-extension.sql` 在注册新 Profile 时执行对应维度的索引创建（脚本按 Profile.dimensions 动态生成 DDL）。

7. **幂等写入**（V2.2 修复反向语义）：

```sql
-- 语义：
--   - 相同 hash → DO NOTHING（向量已正确，无需重写）
--   - 不同 hash → 重新生成向量并同步更新 content_hash + updated_at
INSERT INTO document_embeddings (
  workspace_id, document_id, chunk_id, profile_id,
  dimensions, embedding, content_hash, updated_at
)
SELECT :workspaceId, :documentId, chunk.id, :profileId,
       :dimensions, :embeddingVec, :contentHash, now()
FROM document_chunks chunk
WHERE chunk.document_id = :documentId
ON CONFLICT (chunk_id, profile_id) DO UPDATE
  SET embedding    = EXCLUDED.embedding,
      dimensions   = EXCLUDED.dimensions,
      content_hash = EXCLUDED.content_hash,
      updated_at   = now()
  WHERE document_embeddings.content_hash <> EXCLUDED.content_hash;
  -- 仅 hash 不一致时才覆盖；相同 hash 不做任何操作
  -- 错误语义禁止："内容已变化但保留旧向量"——一旦 chunk.content 重写，hash 必然变，
  -- 本语句会立即同步更新 embedding。
```

**Profile 切换原子性**（V2.2 强化）：

切换 Embedding Profile 必须在一个事务内完成三步：

```sql
BEGIN;

-- 1) 旧 Profile 失活
UPDATE embedding_profiles
SET is_active = false, status = 'retired', retired_at = now()
WHERE workspace_id = :workspaceId AND is_active = true;

-- 2) 新 Profile 激活
UPDATE embedding_profiles
SET is_active = true, status = 'active', activated_at = now()
WHERE id = :newProfileId AND workspace_id = :workspaceId;

-- 3) 校验向量覆盖率：所有 chunks 必须有 (provider, model) 对应的 embedding 行
--    不通过则 ROLLBACK
DO $$
DECLARE
  expected_count INTEGER;
  actual_count   INTEGER;
BEGIN
  SELECT count(*) INTO expected_count
  FROM document_chunks c
  JOIN documents d ON d.id = c.document_id
  JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
  WHERE kb.workspace_id = :workspaceId;

  SELECT count(*) INTO actual_count
  FROM document_embeddings e
  JOIN embedding_profiles p ON p.id = e.profile_id
  WHERE p.id = :newProfileId AND p.workspace_id = :workspaceId;

  IF actual_count < expected_count THEN
    RAISE EXCEPTION 'EMBEDDING_COVERAGE_INCOMPLETE: expected=%, actual=%',
      expected_count, actual_count;
  END IF;
END $$;

COMMIT;
-- 任一步骤失败 → 整事务回滚，查询仍走旧 Profile，无脏读窗口
```

阶段 4 worker 在后台生成新 Profile 的向量时，旧 Profile 的 `is_active=true` 维持查询路径；新 Profile 设 `status='provisioning'`；向量全部入库后通过上面的事务切换。

8. `config.ts` 删除 `DATABASE_EMBEDDING_DIM` 常量；`EMBEDDING_DIM` 仅作为运行时校验提示；切换 Embedding 模型不再需要修改 schema。

**迁移路径**：

- 已有数据库：迁移脚本 `migrations/rag/0001-vector-extension.sql`（创建 `vector` 扩展 + `embedding_profiles` + `document_embeddings`）；`document_chunks.embedding` 列标记 deprecated，写入路径迁到新表后停用。
- 新安装：拆分 `0000-core-schema.sql` 与 `migrations/rag/0001-vector-extension.sql`，DEPLOYMENT_PROFILE=core 只跑 `0000`。
- 模块迁移清单（独立 checksum）：每个 `migrations/rag/*.sql` 在文件头包含 `-- checksum: <sha256>` 与 `-- module: rag`；`npm run migrate -- --module=rag` 校验全部 checksum 后才执行。

### 决策 2：Agent 全局，能力绑定按 Workspace 隔离

**背景**：V1 未明确 Agent 定义是 Workspace 级还是全局，会导致阶段 1 落地时 namespace 选择反复。

**决议**：

| 实体 | 命名空间 | 说明 |
|---|---|---|
| `AgentDefinition` | 全局 | 代码级注册；Agent 是产品能力，不应每个 workspace 复制 |
| `ToolDefinition` | 全局 | 代码级注册 |
| `Skill Package`（文件系统 + 校验和） | 全局 | `backend/src/skills/builtin` / `local` / `market-skills` |
| Skill 启用 | Workspace | `workspace_skills` 控制哪些 Skill 在该 Workspace 可见 |
| Agent-Skill 绑定 | Workspace | `agent_skill_bindings(workspace_id, agent_id, skill_id, enabled)`，主键改为三元组 |
| Knowledge Base | Workspace | `workspace_id NOT NULL` |
| Document / Chunk / Embedding | Workspace | 继承所属 Knowledge Base |
| Tool 授权范围（policyHints 中引用的资源） | Workspace | 同一 Tool 在不同 Workspace 可有不同白名单 |
| Conversation / Message / Run / Run Event | Workspace | 继承所属 Conversation |

**Skill 表三拆分**（V2.1：`skill_packages` 是全局表）：

```sql
-- 全局安装包与校验和（无 workspace_id；所有 Workspace 共享）
CREATE TABLE skill_packages (
  id              TEXT PRIMARY KEY,           -- 'builtin/structured-summary' / 'local/<id>' / 'marketplace/<owner>/<repo>/<skill>'
  name            TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('builtin', 'marketplace', 'local')),
  location        TEXT NOT NULL,              -- 文件系统绝对路径
  checksum_sha256 TEXT,
  compatibility   TEXT NOT NULL,
  has_scripts     BOOLEAN NOT NULL DEFAULT false,
  allowed_tools   TEXT[],
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  installed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- V2.1 明确：skill_packages 不属于"跨 Workspace 数据隔离测试"对象——它是全局共享资源，
-- 任何 Workspace 看到的是同一份代码 + 同一份校验和；隔离只作用于"该 Workspace 是否启用/绑定"。

-- Workspace 是否启用该 Skill
CREATE TABLE workspace_skills (
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_id      TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, skill_id)
);

-- Workspace 内 Agent 与 Skill 的绑定
CREATE TABLE agent_skill_bindings (
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  skill_id      TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_id, skill_id)
);
```

**用户进入 Workspace 的方式**：

- **首次本地登录**：自动创建 Personal Workspace（owner=self）。该 Workspace 不可删除、不可转让。
- **邀请**：预留 `workspace_invitations` 表与 `POST /workspaces/:id/invitations` 接口，阶段 1 不实现。
- **SSO**：预留 Identity Provider 接口，阶段 1 不实现。
- **公开注册**：暂不开放。

**Personal Workspace DB 级唯一性**：

Phase 0 的 `ensurePersonalWorkspace()` 只在应用层 `SELECT + INSERT`，并发登录可能产生两个 Personal Workspace。V2.3 引入 DB 级唯一约束 + Shared 必须 NULL 的硬性约束：

```sql
ALTER TABLE workspaces
  ADD COLUMN owner_user_id UUID REFERENCES app_users(id) ON DELETE CASCADE,
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'shared' CHECK (kind IN ('personal', 'shared'));

-- V2.3 收紧（覆盖 V2.2 的"shared 可填入用于显示"反模式）：
--   personal  → owner_user_id NOT NULL
--   shared    → owner_user_id 必须 NULL，owner 身份完全交给 workspace_members
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_kind_owner_check CHECK (
    (kind = 'personal' AND owner_user_id IS NOT NULL) OR
    (kind = 'shared'   AND owner_user_id IS NULL)
  );

-- DB 级保证每个用户最多一个 Personal Workspace（partial unique 依赖上面 CHECK）
CREATE UNIQUE INDEX one_personal_workspace_per_user
  ON workspaces(owner_user_id)
  WHERE kind = 'personal';
```

**owner_user_id 的语义边界**（V2.3 收紧）：

- `owner_user_id` 只用于 `kind = 'personal'` 的唯一性约束与 Personal Workspace 的"归属用户"显示。
- `kind = 'shared'` 的 Workspace owner 身份**完全**通过 `workspace_members.role = 'owner'` 表达；`owner_user_id` 在 Shared 上**必须为 NULL**（DB 强制，不允许显示性写入）。
- V2.2 注释中"DB 不强制 Shared 不能填 owner_user_id 用于显示"的反模式已废除——任何试图在 Shared Workspace 写 owner_user_id 的语句都会被 CHECK 直接拒绝。

应用层 `ensurePersonalWorkspace()` 在事务内：

```sql
INSERT INTO workspaces (kind, name, owner_user_id)
VALUES ('personal', :displayName, :userId)
ON CONFLICT (owner_user_id) WHERE kind = 'personal' DO NOTHING
RETURNING id;

-- 兜底 SELECT
SELECT id INTO :workspaceId FROM workspaces
WHERE owner_user_id = :userId AND kind = 'personal';
```

**Legacy Shared Workspace（历史数据归属，V2.2 修正）**：

Phase 0 的业务表没有 `created_by`，且所有账号共享数据。无法把历史 conversations / KB / documents 推断到某个具体用户。V2.2 修正为：

```sql
-- 1) 创建 Legacy Shared Workspace（owner_user_id = NULL）
INSERT INTO workspaces (kind, name, owner_user_id)
VALUES ('shared', 'Legacy Shared Workspace', NULL)
RETURNING id;
-- legacyWorkspaceId 写入 :legacyWorkspaceId

-- 2) 环境变量 LEGACY_WORKSPACE_OWNER_USER_ID 指定的"显示 owner"通过 workspace_members 表达
--    缺失环境变量时拒绝迁移；该用户写入 role='owner'
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES (:legacyWorkspaceId, :legacyOwnerId, 'owner');

-- 3) 现有所有其他用户都成为该 Workspace 的 member
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT :legacyWorkspaceId, id, 'member'
FROM app_users WHERE id != :legacyOwnerId
ON CONFLICT DO NOTHING;

-- 4) 回填：把 Phase 0 全部业务数据归入 Legacy Workspace
UPDATE conversations      SET workspace_id = :legacyWorkspaceId WHERE workspace_id IS NULL;
UPDATE knowledge_bases    SET workspace_id = :legacyWorkspaceId WHERE workspace_id IS NULL;
UPDATE documents          SET workspace_id = :legacyWorkspaceId WHERE workspace_id IS NULL;
UPDATE document_chunks    SET workspace_id = :legacyWorkspaceId WHERE workspace_id IS NULL;
UPDATE tool_executions    SET workspace_id = :legacyWorkspaceId WHERE workspace_id IS NULL;
UPDATE agent_skill_bindings SET workspace_id = :legacyWorkspaceId WHERE workspace_id IS NULL;

-- 5) 设置 NOT NULL
ALTER TABLE conversations      ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE knowledge_bases    ALTER COLUMN workspace_id SET NOT NULL;
-- 其他表同上

-- 6) 后续新建用户才走 Personal Workspace 自动创建（业务层触发，DB 唯一约束保证幂等）
```

**禁止**：

- 在迁移脚本里写"按现有最后登录用户推断 owner"。
- 在迁移脚本里写"按 created_by → user.personal_workspace_id"——Phase 0 没有 `created_by`。
- 在 Shared Workspace 上写 `owner_user_id`——owner 只能通过 `workspace_members.role='owner'` 表达。
- 用应用层 Map / 单例去重 Personal Workspace——必须 DB 级唯一约束。

**Workspace 数据回填（独立脚本，不内联 SQL）**：

```text
LEGACY_WORKSPACE_OWNER_USER_ID=<uuid> npm run migrate:workspaces
```

迁移顺序（V2.1 修正）：

1. 读取 `LEGACY_WORKSPACE_OWNER_USER_ID` 环境变量；缺失时拒绝迁移。
2. 新增 `workspaces` / `workspace_members` / `owner_user_id` UNIQUE 约束 / 业务表 `workspace_id` 列（nullable）。
3. 创建 Legacy Shared Workspace（owner=env 指定 user），现有账号写入 `workspace_members(role='member')`。
4. 回填全部业务表的 `workspace_id = :legacyWorkspaceId`（**不是**按 created_by 推断，Phase 0 没有该列）。
5. 校验孤儿：所有业务表 `workspace_id IS NULL` 计数必须为 0。
6. 设置 `workspace_id NOT NULL`。
7. 创建组合索引 `(workspace_id, ...)`，加入跨 Workspace 隔离合约测试（用户 A 的 token 不能读到用户 B 的资源）。
8. 对每个已存在 `app_users` 行，立即调用 `ensurePersonalWorkspace()` 创建该用户的 Personal Workspace（DB 唯一约束保证幂等）。

**禁止**：

- 在迁移脚本里写"按现有最后登录用户推断 owner"。
- 在迁移脚本里写"按 created_by → user.personal_workspace_id"——Phase 0 没有 `created_by`。
- 用应用层 Map / 单例去重 Personal Workspace——必须 DB 级唯一约束。

### 决策 3：服务端 Draft Conversation

**背景**：V1 提议"第一条消息创建会话后 replace URL"在用户刷新场景下脆弱——`POST /conversations` 与 `POST /ask` 之间任何中断都会丢失草稿。

**决议**：采用**服务端 Draft Conversation**：

- 进入 `/chat/new` 时客户端立即调用 `POST /conversations`（`status='draft'`），成功响应后 `replace` 到 `/chat/:id`。
- Draft 不出现在历史会话列表（`GET /conversations` 默认过滤 `status='active'`）。
- 用户发送第一条消息后由后端将该 Conversation 从 `draft` 转为 `active`，标题也从默认占位改为基于首条消息的标题。
- 超过 24 小时仍无消息的 Draft 由清理任务删除（`DELETE /conversations WHERE status='draft' AND updated_at < now() - interval '24 hours'`）。
- 第一条消息的 `POST /conversations/:id/messages` 必须接受 `conversation.status='draft' OR 'active'`，并在事务内把 draft 转 active（沿用 §6.2 V2.3 事务顺序）。
- 页面初始化期间（`POST /conversations` 未返回）禁用发送按钮，避免会话 ID 尚未存在就提交。
- 刷新时直接根据 URL 恢复 Draft 或历史会话。

**最近路由持久化（不新增 DB 表）**：

- 第一阶段使用用户级 localStorage 键 `mastra:last-route:<userId>`（`<userId>` 为登录后从 `/auth/me` 获取）。
- 显式退出登录时清除该键。
- 未来需要跨设备同步时再升级为 `user_preferences.recent_routes JSONB`。

**Draft 与激活（统一 `POST .../messages`）**：

```text
POST /api/v1/conversations
Body: { agentId, knowledgeBaseId? }
201 → { id, status: 'draft', agentId, knowledgeBaseId, createdAt }

POST /api/v1/conversations/:id/messages
Idempotency-Key: <client-generated>
Body: { content }
Effect:
  - draft 上首条消息：status draft→active；title 触发 maybeUpdateTitleFromFirstMessage
  - active 上消息：仅追加 user + assistant pending
  - 创建 agent_run（status=queued → running），由 lease worker 抢占执行
  - 写 assistant_message.status='streaming'
Response (always): 202 Accepted
  { userMessageId, assistantMessageId, runId, eventsUrl: "/api/v1/runs/<actual-runId>/events" }
  （eventsUrl 由服务端在 POST 事务内拼好后随 202 返回；客户端不需再做任何模板替换）
```

**SSE 订阅**（不与命令耦合，命令成功即可立即开始订阅）：

```text
GET /api/v1/runs/:runId/events
Headers: Last-Event-ID: <last seq from previous subscription>
Response: text/event-stream
  event: <type>
  id: <event_seq>
  data: <payload>
```

幂等性边界：命令（POST + Idempotency-Key）保证只创建一份 user/assistant/run；订阅（GET SSE + Last-Event-ID）保证重连不丢不重。`Idempotency-Key` 不缓存 SSE 流，仅用于 POST 的副作用去重。

### 决策 4：Run 与 SSE 事件 = PostgreSQL

**背景**：V1 将 SSE 重连留到"后续阶段"且未指定服务端事件日志形态。

**决议**：单一基础设施原则，**不引入 Redis**：

```sql
CREATE TABLE agent_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id      UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  assistant_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id             TEXT NOT NULL,
  provider             TEXT NOT NULL,
  model                TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
                         'queued', 'running', 'waiting_approval',
                         'completed', 'stopped', 'failed'
                       )),
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd   NUMERIC(10,6) NOT NULL DEFAULT 0,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  error_code           TEXT,
  parent_run_id        UUID REFERENCES agent_runs(id) ON DELETE SET NULL,  -- regenerate 链
  request_id           TEXT NOT NULL,
  -- V2.1 新增 Lease 字段（多实例 Worker 协作）
  lease_owner          TEXT,           -- worker instance id（如 'host-pid-12345'）
  lease_expires_at     TIMESTAMPTZ,    -- Lease TTL，默认 60s
  heartbeat_at         TIMESTAMPTZ,    -- worker 每 15s 更新；过期未续约视为孤儿
  created_by           UUID NOT NULL REFERENCES app_users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同会话同一时刻只有一个活跃 Run
CREATE UNIQUE INDEX one_active_run_per_conversation
  ON agent_runs(conversation_id)
  WHERE status IN ('queued', 'running', 'waiting_approval');

CREATE INDEX agent_runs_workspace_idx ON agent_runs(workspace_id, created_at DESC);
CREATE INDEX agent_runs_message_idx ON agent_runs(assistant_message_id);
CREATE INDEX agent_runs_status_idx ON agent_runs(status)
  WHERE status IN ('queued', 'running', 'waiting_approval');
-- Lease 索引：V2.2 规定 waiting_approval 释放执行 Lease（lease_expires_at NULL），
-- 扫描时直接 WHERE lease_expires_at < now() 即可命中 queued/running 的过期行。
CREATE INDEX agent_runs_lease_expiry_idx ON agent_runs(lease_expires_at)
  WHERE status IN ('queued', 'running');

-- V2.1 事件 ID 改 BIGINT IDENTITY：全局递增，便于 Last-Event-ID 重连与多实例排序
CREATE TABLE agent_run_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  type         TEXT NOT NULL CHECK (type IN (
                 'run-queued',          -- V2.3 新增：POST 事务内 INSERT 时即发
                 'run-started',
                 'content-checkpoint',
                 'tool-call-started',
                 'tool-call-completed',
                 'approval-requested',
                 'approval-resolved',
                 'run-completed',
                 'run-stopped',
                 'run-failed'
               )),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 单 run 内按 id 排序；查询用 id > lastEventId AND run_id = ?
CREATE INDEX agent_run_events_run_idx ON agent_run_events(run_id, id);
CREATE INDEX agent_run_events_workspace_idx ON agent_run_events(workspace_id, id);
```

**`approval_request_id` 删除**（V2.1）：原 `agent_runs.approval_request_id` 引用阶段 3 才创建的 `tool_approval_requests`，导致阶段 2 迁移无法独立执行；且一个 Run 可能产生多次审批（多个 Tool 调用各自审批），单值外键在语义上不成立。审批关系改为 `tool_approval_requests.run_id → agent_runs.id` 单向外键，阶段 3 才创建该表。

**Lease / Heartbeat 协议**（V2.2 修订：执行 Lease 仅覆盖 `queued`/`running`）：

执行 Lease 作用域：

| Run status | 是否持有执行 Lease | 超时驱动 |
|---|---|---|
| `queued` | 是（worker 抢占后） | `lease_expires_at < now()` → `failed` `LEASE_EXPIRED` |
| `running` | 是 | `lease_expires_at < now()` → `failed` `LEASE_EXPIRED` |
| `waiting_approval` | **否**（`lease_owner=NULL, lease_expires_at=NULL`） | `tool_approval_requests.expires_at < now()` → `stopped` + `error_code='APPROVAL_EXPIRED'`（V2.3 统一：审批超时归 `stopped`，不归 `failed`） |

- Worker 抢占 Run（V2.3 修正 NULL 分支）：`UPDATE agent_runs SET lease_owner=:workerId, lease_expires_at=now()+interval '60 seconds', heartbeat_at=now() WHERE id=:runId AND status IN ('queued','running') AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now()) RETURNING *`。`lease_expires_at IS NULL` 是兜底分支，处理"曾持有 lease 但 expires_at 被清空（如旧版本 bug / 手工修库）"的 Run，避免它被永远卡住。
- Worker 处理中每 15s：`UPDATE agent_runs SET heartbeat_at=now(), lease_expires_at=greatest(lease_expires_at, now()+interval '60 seconds') WHERE id=:runId AND lease_owner=:workerId AND status='running'`。
- Run 进入 `waiting_approval`（阶段 3）时立即释放执行 Lease：`UPDATE agent_runs SET lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL WHERE id=:runId AND status='waiting_approval'`。Approval 流转完全由 `tool_approval_requests.expires_at` 驱动。
- Approval 通过后 Run 转回 `running`，worker 重新抢占 Lease（同上 UPDATE 路径）。
- 执行 Lease Orphan 回收（每 30s 一次，仅扫描 `queued`/`running`）：

  ```sql
  UPDATE agent_runs
  SET status = 'failed',
      error_code = 'LEASE_EXPIRED',
      completed_at = now()
  WHERE status IN ('queued', 'running')
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at < now()
  RETURNING id;
  ```

  对每个返回 id 写 `agent_run_events(type='run-failed', payload={"error_code":"LEASE_EXPIRED"})`，同步更新 `messages.status='failed'`。
- `lease_expires_at IS NULL` 的 queued 任务（新建后未被任何 worker 抢占）也必须可被抢占：`lease_owner IS NULL OR lease_expires_at < now()` 条件已覆盖 NULL 比较（NULL `<` now() → NULL → WHERE 不命中）。修正为 `lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now()`。
- `waiting_approval` 的 Run **不**由 Lease 过期回收——它在 `tool_approval_requests` 表上有独立的 `expires_at`。

**Approval 超时处理**（阶段 3 实施）：

```sql
-- 每 60s 一次
UPDATE tool_approval_requests
SET status = 'expired', resolved_at = now()
WHERE status = 'pending' AND expires_at < now()
RETURNING run_id, id;

-- 对每个返回的 run_id（V2.3 裁决：审批超时统一归 stopped，详见 §0 差异表）：
UPDATE agent_runs
SET status = 'stopped',
    error_code = 'APPROVAL_EXPIRED',
    completed_at = now()
WHERE id = :runId AND status = 'waiting_approval';

INSERT INTO agent_run_events (run_id, workspace_id, type, payload)
VALUES (:runId, :workspaceId, 'run-stopped', '{"error_code":"APPROVAL_EXPIRED"}');

UPDATE messages SET status = 'stopped' WHERE current_run_id = :runId;
```

调用 `Mastra SDK decline(suspensionToken, reason='APPROVAL_EXPIRED')` 让 Run 真正终止。

**多实例 SSE 扇出**（V2.1）：

- DB 是事件**数据源**；`LISTEN/NOTIFY` 只做**唤醒**。
- 每个后端实例启动时建立**一条**共享 PG `LISTEN agent_run_events_channel` 连接。
- Run 写入事件后 `NOTIFY agent_run_events_channel, '<run_id>:<event_id>'`。
- 本地实例收到 NOTIFY 后查 `SELECT * FROM agent_run_events WHERE id > lastNotifiedEventId AND run_id IN (:myActiveRuns)`，再向本实例的 SSE 连接分发。
- SSE 重连协议：

  ```text
  GET /api/v1/runs/:runId/events
  Headers:
    Last-Event-ID: <event_id>     -- 标准 SSE 重连头
  Response: text/event-stream
    id: <event_id>
    event: <type>
    data: <json>
  
  服务端回放：SELECT * FROM agent_run_events WHERE run_id = :runId AND id > :lastEventId ORDER BY id
  然后继续跟踪新事件。
  ```

**消息侧**：

- `messages` 表新增 `current_run_id UUID`。
- `messages.status` **不**独立设置；它只是 `agent_runs.status` 的查询投影，**映射规则**：

  | `agent_runs.status` | `messages.status` |
  |---|---|
  | `queued` | `pending` |
  | `running` | `streaming` |
  | `waiting_approval` | `streaming` |
  | `completed` | `completed` |
  | `stopped` | `stopped` |
  | `failed` | `failed` |

  `agent_runs.status` 变更与 `messages.status` 更新必须在同一事务内完成。
- 重新生成 → 创建新 Run，旧 Run 保留用于审计（`parent_run_id`）。

**文本增量合并**：

- 模型每个 Token **不**单独写入 `agent_run_events`。
- `content-checkpoint` 触发条件：**距上次 checkpoint 满 250-500ms** 或 **累积满 ~512 字符**。
- checkpoint payload：`{ text, accumulatedLength }`；前端用 `accumulatedLength` 重建当前文本。

**断线恢复协议**：

1. SSE 客户端携带标准 `Last-Event-ID: <event_id>` 头。
2. 服务端回放 `SELECT * FROM agent_run_events WHERE run_id = :runId AND id > :lastEventId ORDER BY id`。
3. 切换到 LISTEN/NOTIFY 实时跟踪新事件。
4. 前端按 `id` 单调递增、`accumulatedLength` 重建 message 流。

**Orphan Run 回收**（V2.2 修正）：

- 不再按 `started_at < now() - interval '2 minutes'` 简单判定（会误杀长任务）。
- Worker Lease：抢占时设 `lease_expires_at = now() + 60s`、`heartbeat_at = now()`；每 15s 心跳续约。
- V2.3 明确 `waiting_approval` 释放执行 Lease（`lease_owner=NULL, lease_expires_at=NULL`），由阶段 3 的 `tool_approval_requests.expires_at` 驱动超时；过期后 Run **统一**转 `status='stopped'` + `error_code='APPROVAL_EXPIRED'`（审批超时归 `stopped`，不归 `failed`，与 Lease 过期失败的语义分开）。
- 后台每 30s 扫描 `lease_expires_at < now()`（部分索引仅含 `queued`/`running`，waiting_approval 不命中）：
  - 更新 `status='failed'`、`error_code='LEASE_EXPIRED'`、`completed_at=now()`；
  - 写 `agent_run_events(type='run-failed', payload={"error_code":"LEASE_EXPIRED"})`；
  - 同步更新 `messages.status='failed'`。

### 决策 5：Mastra 原生 Approval + Policy 包装

**背景**：本地 Mastra 版本已提供 `requireToolApproval` 与 Tool suspend/resume；自实现完整 Tool Dispatcher 成本高、风险大。但 Approval 不是单纯的数据库写入，必须调用 Mastra SDK 才能恢复 Run。

**决议**：采用**原生 Approval + 自有 Policy 包装**混合方案。Mastra Approval 在 Tool.execute 被调用**之前**挂起，恢复时才进入包装后的 execute 二次校验。

**正确执行链路**（V2.1 修正）：

```text
Policy-aware Tool Resolver（按 workspace 解析 Tool 授权范围）
  ↓
生成包装后的 Tool（wrapToolExecute(def, gateway)）
  ↓
构造 riskPolicy = classifyRisk(def, inputs) → 'low' | 'medium' | 'high'
  ↓
agent.stream(prompt, {
  requireToolApproval: riskPolicy,      // 风险等级 >= high 才挂起
  abortSignal: combinedSignal,          // AbortSignal.any([userSignal, timeoutSignal])
})
  ↓
Mastra 内部：在 Tool.execute 触发前根据 requireToolApproval 决定
  - LOW/MEDIUM：直接调用 Tool.execute（即包装后的 execute）
  - HIGH：挂起 Run，写入 Mastra 内部 suspension token，返回 tool-call-suspended
  ↓
包装后的 execute（即使 LOW/MEDIUM 也会进入）：
  ├── 校验 Workspace / 权限 / requiredScopes
  ├── 动态输入风险判断（policyHints）
  ├── 路径 / URL / 金额白名单
  ├── AbortSignal.timeout(timeoutMs)
  ├── 审计 tool_executions(status='running')
  ├── 原 Tool.execute（实际执行）
  ├── 输出脱敏（sensitiveOutputFields）
  └── 审计 tool_executions(status='completed'|'failed')

HIGH 挂起后：
  ↓
服务端把 suspension 映射为持久化 tool_approval_requests + agent_run_events(type='approval-requested')
  + agent_runs.status='waiting_approval'
  ↓
SSE 推送 'approval-requested' 事件给前端

用户批准：
  ↓
POST /api/v1/approvals/:id/resolve { decision: 'approve' | 'decline' }
  ↓
服务端事务：
  1. UPDATE tool_approval_requests SET status=...
  2. INSERT INTO agent_run_events(type='approval-resolved')
  3. UPDATE agent_runs SET status='running'
  4. 调用 Mastra SDK approve(suspensionToken, decision)  ← 关键：必须真正调用
  5. Mastra 恢复 Run，重新进入包装后的 execute（inputs hash 必须再次校验）

用户拒绝 / 过期：
  ↓
调用 Mastra SDK decline(suspensionToken, reason)
  ↓
包装后的 execute 不再调用；audit 写 'failed'，events 写 'run-completed' status='declined'
```

**关键约束**：

- Approval resolve API **不能只更新 DB**——必须调用 Mastra 的 `approve/decline` 才能让 Run 继续；否则 Run 永远挂起。
- 包装后的 execute 在恢复路径会被**二次调用**（Mastra 从 suspension 恢复后会重新执行）；第二次必须再次校验 inputs hash、权限、Workspace，避免"批准后再修改 inputs 绕过审核"。
- `requireToolApproval` 参数传入 `agent.stream`，不是包在 Tool 注册里——风险是 dynamic 的（依赖 inputs）。
- 用户停止信号：`AbortSignal.any([userSignal, timeoutSignal])`（V2.1 修正）；不能 `AbortSignal.timeout()` 直接覆盖原信号。

**三层分工**：

| 层 | 职责 |
|---|---|
| Policy Gateway | 业务授权、输入风险、Workspace 隔离、输出脱敏、inputs hash 二次校验 |
| Mastra Approval | 挂起/恢复、用户确认 UI；调用 SDK 完成 Run 续接 |
| 原 Tool.execute | 实际执行（被包装层包了一层） |

**风险等级（与 V1 一致）**：

- `LOW`：只读、无外网，自动执行。
- `MEDIUM`：外网读取、产生费用，需策略授权。
- `HIGH`：写入、删除、发送、支付，必须 Mastra Approval。
- `FORBIDDEN`：访问密钥、越权资源、执行任意脚本，直接拒绝（不进 Mastra）。

**授权粒度（仅 once）**：

- `once`：仅本 Run、本 Tool、本 inputs（hash 校验）。`tool_approval_requests` 记录 user/workspace/run/tool/inputs_hash/expires_at。

`session` / `persistent` 待权限与撤销机制成熟后再开放。`persistent` 对高风险 Tool 风险过高，必须配套审计与撤销流程。

**`ToolDefinition` 新增字段**：

```typescript
interface ToolDefinition {
  id: string;
  displayName: string;
  description: string;
  tool: ReturnType<typeof createTool>;
  metadata: {
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
    openWorld: boolean;
    requiresRuntime?: boolean;
    requiredScopes?: string[];        // 权限 scope，例如 'kb:read', 'kb:write'
    policyHints?: {
      pathAllowlist?: string[];       // glob 模式
      urlAllowlist?: string[];
      maxAmount?: { currency: string; value: number };
      allowedMethods?: string[];      // HTTP method 白名单
      sensitiveOutputFields?: string[];
    };
    timeoutMs?: number;                // 默认 30000
    maxRetries?: number;               // 默认 0；只对 idempotent=true 启用
  };
}
```

**Approval 表**（V2.1 单向外键，不被 agent_runs 反向引用）：

```sql
CREATE TABLE tool_approval_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id         UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_id        TEXT NOT NULL,
  suspension_id  TEXT NOT NULL,         -- Mastra SDK 返回的 suspension token
  inputs_hash    TEXT NOT NULL,         -- sha256(canonical_json(inputs))
  inputs_summary JSONB NOT NULL,        -- 脱敏后的输入摘要，用于 UI 展示
  status         TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'expired')),
  requester_id   UUID NOT NULL REFERENCES app_users(id),
  resolver_id    UUID REFERENCES app_users(id),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ
);

CREATE INDEX tool_approval_requests_workspace_pending_idx
  ON tool_approval_requests(workspace_id, status)
  WHERE status = 'pending';

CREATE INDEX tool_approval_requests_run_idx ON tool_approval_requests(run_id);
```

---

## 4. 阶段 0：设计与工程基线

### 4.1 文档与基线

- 本文档取代 V1；`docs/architecture.md` 保留为 Phase 0 当前架构描述，与 V2 并存便于对比。
- 统一包管理器为 **npm**（前后端都用；V2.3.1 明确锁文件策略）：
  - 保留并提交 `backend/package-lock.json` 与 `frontend/package-lock.json`（CI `npm ci` 强依赖锁文件存在；删除锁文件再 `npm ci` 会立刻失败）；
  - **删除**未跟踪的 `frontend/pnpm-lock.yaml`（git clean 候选；不自动执行，阶段 0 由用户确认）；
  - 若 `frontend/package-lock.json` 不存在（仅含 `pnpm-lock.yaml` 的旧仓库），由维护者手动 `npm install --package-lock-only` 生成并提交，**禁止**在 CI 前删锁后跑 `npm ci`；
  - 重新生成 `frontend/package.json` 的 scripts，确保无 pnpm 独有语法（`pnpm.onlyBuiltDependencies` 等）。
- CI 升级（`.github/workflows/verify.yml`）：
  - backend：`npm ci` + `npm run lint` + `npm run typecheck` + `npm run test`（执行全部 contract / unit / integration / fixture）+ `npm audit --audit-level=high`
  - frontend：`npm ci` + `npm run lint` + `npm run build` + `npm audit --audit-level=high`
  - 全局：secret scan（gitleaks / trufflehog）。
- 修正 README 安全边界表述："已登录但业务资源未按用户或 Workspace 隔离"。
- 清理候选清单（**仅记录，不自动执行**）：
  - `.playwright-mcp/` 是否加入 `.gitignore`。
  - 根目录空 `src/` 是否保留。
  - `frontend/README.md` 是否替换为项目专用。
  - 历史变量 `XUANSHU_CHAT_MODEL` 警告保留（不删除向后兼容路径）。

### 4.2 阶段 0 验收

- [ ] `docs/architecture-v2.md` 已写入且被 README 引用。
- [ ] `frontend/pnpm-lock.yaml` 已删除（用户确认后），前后端均使用 `npm ci`。
- [ ] `frontend/package-lock.json` 与 `backend/package-lock.json` 存在且已提交（V2.3.1：CI 强依赖锁文件）。
- [ ] CI 全绿；`npm audit` 无 high。
- [ ] README 安全边界措辞统一。

---

## 5. 阶段 1：Workspace 与资源隔离

### 5.1 数据库 Schema

§5.1 描述的 Schema **全部**定义在 `backend/database/init.sql` 单文件中；项目不维护迁移链（见 §5.3）。

```sql
CREATE TABLE workspaces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);
```

6 张业务表 `workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`：

- `conversations`
- `knowledge_bases`
- `documents`
- `document_chunks`
- `tool_executions`
- `agent_skill_bindings`（PK 三元组 `(workspace_id, agent_id, skill_id)`）

权限所需资源加 `created_by UUID REFERENCES app_users(id)`：

- `conversations`、`knowledge_bases`、`documents`、`agent_runs`（阶段 2）。

### 5.2 应用层变更

- `app_users` 首次登录后由 `ensurePersonalWorkspace(userId)` 自动创建 Personal Workspace 并写入 `workspace_members`。
- 中间件链：auth → load workspace context（请求头 `X-Workspace-Id` 或默认取用户 Personal Workspace）→ RBAC。
- 所有业务查询改为：

  ```sql
  SELECT * FROM resources
  WHERE id = :resourceId
    AND workspace_id = :currentWorkspaceId
  ```

- 跨 Workspace 访问统一返回 404（避免泄露存在性）；写入 `security_events` 表。

**`security_events` 表**（V2.1 显式化）：

```sql
CREATE TABLE security_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID REFERENCES workspaces(id) ON DELETE SET NULL,  -- 跨 workspace 攻击时为 NULL
  actor_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  source_ip     INET,
  user_agent    TEXT,
  event_type    TEXT NOT NULL CHECK (event_type IN (
                  'cross_workspace_access_attempt',
                  'auth_failed',
                  'login_lockout',
                  'rate_limit_exceeded',
                  'forbidden_tool_invocation',
                  'approval_expired',
                  'storage_finalize_exhausted'   -- V2.3.5：finalize 耗尽事务同事务写
                )),
  resource_type TEXT,        -- 'conversation' / 'knowledge_base' / ...
  resource_id   UUID,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX security_events_workspace_idx ON security_events(workspace_id, created_at DESC);
CREATE INDEX security_events_actor_idx ON security_events(actor_user_id, created_at DESC);
CREATE INDEX security_events_type_idx ON security_events(event_type, created_at DESC);
```

阶段 1 写入路径：cross_workspace_access_attempt（跨 Workspace 访问）、auth_failed（密码错误）；阶段 2 补 login_lockout / rate_limit_exceeded；阶段 3 补 forbidden_tool_invocation / approval_expired；阶段 4 补 storage_finalize_exhausted（finalize 耗尽事务同事务写，V2.3.5 同步扩展 CHECK 枚举）。

### 5.3 迁移脚本

`backend/database/init.sql` 是 **Schema 唯一来源**。项目不维护迁移链。

部署或本地初始化：

```bash
# 1. 备份数据（生产环境）
# 2. 删库 / 删 schema
# 3. 执行
npm run migrate
```

`npm run migrate` 内部流程（`src/scripts/migrate.ts`）：

1. 计算 `backend/database/init.sql` 的 SHA-256 checksum；
2. 与 `_init_meta` 表中已登记 checksum 对比：
   - **未登记** → 应用整个 `init.sql`，写入 `_init_meta(checksum, applied_at)`；返回 `action='applied'`；
   - **一致** → 跳过；返回 `action='skipped'`，退出码 0；
   - **不一致** → 拒绝继续；返回 `action='drift'`，退出码 2。
3. 任何阶段 DB 失败 → ROLLBACK + 抛出原错误。

校验脚本不重复生产 SQL——`init.sql` 是 single source of truth；如需调整 Schema，**直接修改** `init.sql`，然后删库重建。

> **不接受**的部分：迁移编号链、`LEGACY_WORKSPACE_OWNER_USER_ID`、Legacy Shared Workspace 回填段。

### 5.4 阶段 1 验收

跨 workspace 隔离合约测试（17 项）——对应 `tests/integration/isolation-contract.ts`：

**读路径返回空 / null**
1. `listConversations(otherWs)` → `[]`
2. `getConversationWithMessages(otherWs, id)` → `null`
3. `getMessageSnapshot(otherWs, id)` → `null`
4. `getDocument(otherWs, id)` → `null`
5. `getAgentSkillBindings(otherWs, ...)` → `[]`
6. `getToolExecutionsByMessage(otherWs, id)` → `[]`

**写路径抛 `ResourceNotFoundError` 或被 FK 拒绝**
7. `updateConversation(otherWs, id, ...)` → throw
8. `deleteConversation(otherWs, id)` → throw
9. `finalizeAssistant(otherWs, id, ...)` → throw
10. `updateDocumentStatus(otherWs, id, ...)` → throw
11. `deleteDocument(otherWs, id)` → throw
12. `createToolExecution(otherWs, ...)` → throw
13. `finalizeToolExecution(otherWs, id, ...)` → throw
14. `ingestDocument(otherWs, id, [])` → throw

**`agent_skill_bindings` 跨 workspace 隔离**
15. `bindSkillToAgent` 在 workspace A 和 B 用相同 `(agentId, skillId)` → 两行共存（PK 三元组）
16. `getAgentSkillBindings` 从 A 看 A 的绑定；从 B 看 B 的；互不可见
17. `removeInstalledSkill` 后跨 workspace 该绑定行为仍可见

**强不变量**（附加静态合约）：
- 跨 workspace HTTP 访问**统一返回 404**（详见 `tests/integration/handler-http-404.ts` —— Task 17）；
- 客户端 `X-Workspace-Id` / `?workspaceId=` / `body.workspaceId` 不覆盖服务端上下文（详见 `tests/integration/workspace-context.ts` §14）；
- `deleteWorkspace` → `ON DELETE CASCADE` 清理其下 conversations / documents / tool_executions / agent_skill_bindings / workspace_members；不影响其他 workspace。

---

## 6. 阶段 2：路由、会话恢复与持久化 Run

### 6.1 前端路由

- 引入 `react-router-dom` v6（数据路由）。
- 路由表：

  ```text
  /login
  /chat/new                                  → 服务端建 draft，replace 到 /chat/:id
  /chat/:conversationId                      → 加载历史 / 恢复 draft / 续传
  /knowledge
  /knowledge/:knowledgeBaseId
  /capabilities
  /workspaces/:workspaceId/settings          （阶段 1 末预留，阶段 5 实现）
  /approvals                                  （Tool Approval 收件箱）
  /feedback                                   （用户反馈）
  ```

- 未匹配路由 → 重定向到 `/chat/new`。
- 受保护路由：未认证时统一跳 `/login`。

### 6.2 Conversation 接口（V2.2 重做 POST/SSE 协议）

V2.1 让 POST 返回 SSE 流，导致 Idempotency-Key 无法可靠缓存持续流。V2.2 拆分为**POST 是命令；SSE 是订阅**：

```text
POST /api/v1/conversations
  Headers: Idempotency-Key: <uuid>     ← 必须
  Body: { agentId, knowledgeBaseId? }
  201 → { id, status: 'draft', agentId, knowledgeBaseId, createdAt }

POST /api/v1/conversations/:id/messages
  Headers: Idempotency-Key: <uuid>     ← 必须
  Body: { content }
  202 Accepted →
    {
      userMessageId:      string,
      assistantMessageId: string,
      runId:              string,
      eventsUrl:          string     ← 已渲染路径，形如 "/api/v1/runs/8d2c.../events"，客户端可直接订阅
    }

GET /api/v1/runs/:runId/events
  Headers: Last-Event-ID: <event_id>     ← 可选；重连恢复时必带
  Response: text/event-stream
    id: <event_id>                        ← BIGINT IDENTITY
    event: <type>                          ← run-started / content-checkpoint / ...
    data: <json>
```

**重复 POST 的幂等行为**：

- 命中 `(workspace_id, user_id, key)` 且 `request_fingerprint` 匹配 → 直接返回**同一** 202 JSON（含同一 `runId`）；客户端随后通过 `eventsUrl` 订阅。
- `request_fingerprint` 不一致 → 409 `IDEMPOTENCY_KEY_REUSED`（V2.3 统一：正文与附录 D 均为 409，错误响应体 `{ error_code, message }`）。
- Key 缺失或格式非法 → 422 `INPUT_VALIDATION_FAILED`。

**事务边界**（V2.3 修正外键顺序）：

POST 单事务内必须严格按下列顺序，避免 assistant message 反向引用尚未插入的 Run：

1. `UPDATE conversations SET status='active', title=... WHERE id=:id AND status='draft'`（仅 draft→active）
2. `INSERT INTO messages (role='user', status='done', workspace_id, conversation_id, content)` — 取 `:userMessageId`
3. `INSERT INTO messages (role='assistant', status='pending', current_run_id=NULL, workspace_id, conversation_id)` — 取 `:assistantMessageId`；`current_run_id` 此时必须为 NULL，FK 不可指向尚未存在的 Run。
4. `INSERT INTO agent_runs (status='queued', workspace_id, conversation_id, created_by=:userId, assistant_message_id=:assistantMessageId, ...)` — Run 通过 `assistant_message_id` 反向指向 message（agent_runs.assistant_message_id → messages.id）；发起人字段统一为 `created_by`（V2.3.1：与 §6.1 schema 一致；`idempotency_keys.user_id` 保持原字段名不变，仅 `agent_runs` 是 `created_by`）。
5. `INSERT INTO agent_run_events (type='run-queued', run_id=:runId, payload={assistant_message_id})` + `NOTIFY agent_run_events_channel` — **V2.3 修正**：Run 刚创建时 status='queued'，事件名必须为 `run-queued`，与状态一致；`run-started` 留到 worker 抢占成功、status 转 `'running'` 时再发。
6. `UPDATE messages SET current_run_id=:runId WHERE id=:assistantMessageId` — Run 已存在，FK 安全，再回填。
7. `INSERT INTO idempotency_keys (..., response_status=202, response_body={...})`

任一失败 → 整事务回滚；POST 失败时无 Run 残留，客户端可安全用同 Idempotency-Key 重试。

**事件与状态对齐**（V2.3）：

| Run 状态 | 触发事件 |
|---|---|
| `'queued'`（POST 事务内 INSERT） | `run-queued` |
| `'queued'` → `'running'`（worker 抢占） | `run-started` |
| `'running'` → `'completed'` | `run-completed` |
| `'running'` → `'failed'` | `run-failed` |
| `'running'` → `'waiting_approval'`（阶段 3） | `approval-requested` |
| `'waiting_approval'` → `'running'`（审批通过） | `approval-resolved` |
| `'waiting_approval'` → `'stopped'`（超时） | `run-stopped`（`error_code=APPROVAL_EXPIRED`） |

**Idempotency-Key 缓存的是 POST 的 202 JSON，不是 SSE**：

```sql
CREATE TABLE idempotency_keys (
  key                  TEXT NOT NULL,
  workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  request_fingerprint  TEXT NOT NULL,        -- sha256(canonical_json(method + path + body))
  response_status      INTEGER NOT NULL,     -- 通常 201 / 202
  response_body        JSONB NOT NULL,       -- 缓存的稳定 JSON（userMessageId / runId / eventsUrl）
  expires_at           TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, key)
);

CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys(expires_at);
```

- POST 命中缓存 → 直接返回 `response_status` + `response_body`，**不**触发 DB 写入、**不**再次开启 Run。
- SSE 不走幂等键缓存——SSE 重连通过 `Last-Event-ID` 回放 `agent_run_events`。

**会话刷新 = 重连 SSE**（V2.2 协议统一）：

刷新页面时，前端根据 URL `/chat/:id` 走下列流程：

1. `GET /api/v1/conversations/:id` → 拿到 `messages` 列表与每条的 `currentRunId`。
2. 若消息 `status='streaming'` → `GET /api/v1/runs/:currentRunId/events` with `Last-Event-ID: <最近事件 id>`。
3. 若消息 `status IN ('completed','stopped','failed')` → 直接展示终态。
4. 若消息 `status='pending'` 且 `currentRunId=NULL` → 显示"准备中"占位，1s 轮询。
5. **重连只走 GET，不重发 POST**；会话上下文已经从 `GET /conversations/:id` 取回。

**POST 重试边界**：

- 网络中断但 POST 已落库 → 客户端不重发 POST；用 `GET /conversations/:id` 取回 `currentRunId` → 订阅 SSE。
- POST 返回前客户端崩溃 → 重启后用同 `Idempotency-Key` 重发；命中缓存或触发新 Run。
- 已收到 202 但 eventsUrl 订阅失败 → 不重发 POST，订阅 GET SSE 时带 `Last-Event-ID=0`。

后台清理任务：每小时一次 `DELETE FROM conversations WHERE status='draft' AND updated_at < now() - interval '24 hours'`。

### 6.3 `agent_runs` + `agent_run_events`

落地见决策 4 schema。`messages` 新增 `current_run_id`。

- 每次 `POST /conversations/:id/messages` 或 `POST /messages/:id/regenerate` 创建一条 `agent_runs`。
- 同会话并发由 Partial Unique Index 保证；并发 INSERT 失败 → 业务层捕获 → 返回 409。
- 每次状态变化在**同一事务**内更新 `agent_runs.status` 与 `messages.status`。
- 每次 `agent_runs.status` 进入终态（completed/stopped/failed）写对应事件。
- 文本增量按决策 4 合并策略写 `content-checkpoint` 事件。

### 6.4 SSE 断点续传

```text
GET /api/v1/runs/:runId/events
Headers:
  Last-Event-ID: <last event_id from previous subscription>   # 可选；首次订阅不发送
  Accept: text/event-stream
Response:
  id:    <event_id>           # 服务端 agent_run_events.id（全局 BIGINT）
  event: <type>                ← run-queued / run-started / content-checkpoint / tool-call-* / approval-* / run-completed / run-stopped / run-failed
  data:  <json>
  \n
```

事件流先回放 `agent_run_events.id > Last-Event-ID AND run_id = :runId` 的历史，再继续跟踪新事件。客户端重连时若没有 Last-Event-ID，从 `runId` 创建时的首个事件开始；如未结束，回放可能较长，因此**前端必须**在关闭 SSE 前持久化最后收到的 `id` 到 sessionStorage（key: `mastra:lastEventId:<runId>`）。

### 6.5 Request ID + 结构化日志

- 引入 pino，删除全部 `console.error`（runtime / ask / execute 等）。
- 每个请求生成 `requestId`，写入日志字段、响应头 `X-Request-ID`、`agent_runs.request_id`。
- 日志字段：`requestId` / `workspaceId` / `userId` / `conversationId` / `runId` / `provider` / `model` / `durationMs` / `tokens` / `errorCode`。
- 禁止字段：cookie / token / password / Authorization header / 完整 Tool 敏感 I/O / 文档正文。

### 6.6 阶段 2 验收

- [ ] `/chat/:conversationId` 直接打开可恢复历史会话（用户与 Workspace 隔离）。
- [ ] `/chat/new` 进入立即创建 draft，刷新不丢。
- [ ] 第一条消息发送后 draft 转 active，URL 不变。
- [ ] 删除当前会话跳 `/chat/new`。
- [ ] 同会话并发 `POST /conversations/:id/messages` 一条成功一条 409。
- [ ] 进程重启后无 Lease 持有的 `queued`/`running` Run 由后台 Orphan 回收扫描转 `failed` + `LEASE_EXPIRED`；`waiting_approval` 由 `tool_approval_requests.expires_at` 驱动超时，转 `stopped` + `APPROVAL_EXPIRED`。
- [ ] SSE 重连按 `Last-Event-ID` header 回放，前端文本与持续生成一致；sessionStorage 持久化最后事件 id 在刷新后能继续订阅。
- [ ] 日志含 requestId 但不含敏感字段；用合约测试验证。

---

## 7. 阶段 3：Tool Policy 与审批

### 7.1 Policy-aware Tool Resolver

新增 `core/policy/tool-gateway.ts`，对外暴露 `wrapToolExecute(def, ctx)`：

```typescript
async function wrapToolExecute(
  def: ToolDefinition,
  ctx: { workspaceId; userId; runId; signal },
): Promise<WrappedTool>;
```

包装层职责：

1. 校验 `ctx.userId` 对 `workspaceId` 的成员身份。
2. 校验 `def.metadata.requiredScopes` 与用户权限的包含关系。
3. 解析 `policyHints` 中动态风险（path / url / amount）。
4. 设置 `AbortSignal.timeout(def.metadata.timeoutMs ?? 30000)`。
5. 执行前审计 `tool_executions(status='running')`。
6. 执行后 `sensitiveOutputFields` 脱敏。
7. 执行后审计 `tool_executions(status='completed'|'failed')`。

### 7.2 风险分类与审批联动

```text
risk(def, inputs) →
  FORBIDDEN     → 立即拒绝，写 audit
  HIGH          → 写 tool_approval_requests(status='pending')，
                  Tool 挂起等待用户 confirm，
                  Mastra requireToolApproval 接管 UI 流程
  MEDIUM        → 校验 policyHints 通过后直接执行
  LOW           → 直接执行
```

### 7.3 Approval API

```text
GET    /api/v1/approvals?status=pending          （当前 Workspace 待审批列表）
POST   /api/v1/approvals/:id/resolve            { decision: 'approve' | 'decline', reason? }
```

resolve 必须在同一事务内更新 `tool_approval_requests.status` 并写 `agent_run_events(type='approval-resolved')`。

### 7.4 阶段 3 验收

- [ ] 同一 Tool 在不同 Workspace 可有不同的 `policyHints`（合约测试）。
- [ ] HIGH 风险 Tool 未审批执行直接返回拒绝状态。
- [ ] `sensitiveOutputFields` 在 SSE payload 与 `tool_executions.output` 中均脱敏。
- [ ] Approval 列表按 Workspace 隔离。
- [ ] 超时 Tool 在 `timeoutMs` 后被中止，审计写 `failed`。

---

## 8. 阶段 4：异步文档与 RAG

### 8.1 Worker 形态与 DocumentStorage

**Worker 形态**：

- 独立 Node 进程，**共享 image**（同一 backend 镜像 + 不同 entrypoint）。
- 队列：**PG `FOR UPDATE SKIP LOCKED`**；不引入 Redis。
- Worker 心跳写入 `document_ingestion_jobs.lease_owner` / `lease_expires_at`（V2.1）。

**DocumentStorage 抽象**（V2.1 新增）：

HTTP 接收上传后必须**先持久化原文件字节**再返回 202；Worker 不能从请求内存里读。

```typescript
interface DocumentStorage {
  /** 上传：把 bytes 写到 storage_key 对应的位置，返回 storage_key */
  put(key: string, body: Buffer, meta: { mimeType: string; size: number }): Promise<{ storageKey: string; sha256: string }>;
  /** 下载：Worker 拉取原文件用于解析 */
  get(storageKey: string): Promise<Readable>;
  /** 删除：Outbox 任务保证最终一致 */
  remove(storageKey: string): Promise<void>;
}
```

**实现**：

- **Core/Full**：本地数据目录（`backend/data/documents/<yyyy>/<mm>/<dd>/<sha256>.<ext>`），受控目录大小，定期 GC。
- **Production**：S3-compatible（AWS S3 / MinIO / R2），凭据从 env 读取；`DocumentStorage` 通过适配器切换实现。

**`documents` 表**（V2.3.1 扩展）：

```sql
CREATE TABLE documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL CHECK (size_bytes >= 0),
  storage_key       TEXT NOT NULL,        -- DocumentStorage 终态 key（local path / S3 key）；DB 直接落 finalKey
  sha256            TEXT NOT NULL,        -- 原文件 sha256，用于幂等去重
  storage_status    TEXT NOT NULL DEFAULT 'storage_pending' CHECK (storage_status IN (
                      'storage_pending',  -- staging 已写，DB 已提交，finalize 还未成功，文档不可被 ingestion job 拾取
                      'ready',            -- finalize 成功，对象已在 finalKey，ingestion job 可拾取
                      'storage_failed'    -- 多次 finalize 仍失败，需人工介入
                    )),
  status            TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN (
                      'uploaded', 'parsing', 'cleaning', 'chunking', 'embedding',
                      'completed', 'failed', 'cancelled'
                    )),
  error_message     TEXT,
  deleted_at        TIMESTAMPTZ,          -- 软删除，保留行以维持唯一约束历史
  created_by        UUID NOT NULL REFERENCES app_users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX documents_workspace_idx ON documents(workspace_id);
CREATE INDEX documents_kb_idx ON documents(knowledge_base_id);

-- V2.3.1 强制唯一：同一 Workspace + 同一 KB + 同一 sha256 在未删除时只允许一行。
-- partial unique 让软删除行不阻塞未来同名文件重新上传。
CREATE UNIQUE INDEX documents_dedup_unique_idx
  ON documents(workspace_id, knowledge_base_id, sha256)
  WHERE deleted_at IS NULL;
```

**幂等去重**（V2.3.1 收紧）：

- 去重粒度：`(workspace_id, knowledge_base_id, sha256)`，DB 通过 `documents_dedup_unique_idx`（partial unique `WHERE deleted_at IS NULL`）强制唯一——并发上传相同三元组第二个 INSERT 直接失败，由应用层捕获后返回 200 + 现有 document。
- HTTP 上传时计算 `sha256`；命中 partial unique → 返回 200 + 现有 document，**不**调 `putStaging`、**不**创建新 ingestion job、**不**写 Storage 对象。
- 软删除（`deleted_at IS NOT NULL`）后的三元组不参与唯一约束，允许同名文件重新上传；后台 GC 负责清理 `deleted_at < now() - interval '30 days'` 的行。
- 简单方案与完整方案（file_objects 多对多）合并为上述统一模型；不再保留"同 KB 仍写多份对象"的旧描述。

**Staging / Finalize 机制**（V2.2 解决对象存储孤儿；V2.3.3 补齐崩溃恢复窗口）：

HTTP 写 Storage 后再写 DB 的两步操作存在失败窗口：DB 事务失败但对象已写入 → 孤儿对象。V2.2 引入 staging；V2.3.3 补 `listStagingOlderThan` 让 GC 能找到"事务前孤儿"（putStaging 成功但三表 INSERT 提交前崩溃留下的对象）。

```typescript
interface DocumentStorage {
  /** staging：写到 staging 命名空间，未 finalize 前不可见 */
  putStaging(uploadId: string, body: Buffer, meta): Promise<{ stagingKey: string; sha256: string }>;
  /** finalize：原子地把 staging 对象移到正式 key（local: rename；S3: COPY + DELETE） */
  finalize(stagingKey: string, finalKey: string): Promise<void>;
  /**
   * abort：清理未 finalize 的 staging 对象
   * V2.3.4 触发条件：仅在已确认 ROLLBACK / 唯一索引冲突 / 显式事务回滚时调用；
   * 不确定提交（连接断开 / 超时 / COMMIT 期间网络中断）必须交给 TTL GC 兜底，
   * 不可即时调用本接口。
   */
  abortStaging(stagingKey: string): Promise<void>;
  /** V2.3.3 列举超过 cutoff 的 staging 对象；用于 TTL GC 发现事务前孤儿 + 不确定提交孤儿 */
  listStagingOlderThan(cutoff: Date): AsyncIterable<string>;
}
```

**写入流程**（V2.3.4 重写：DB 预存 finalKey + 仅在明确回滚时 abortStaging + 事务前孤儿由 TTL GC 兜底）：

1. HTTP 接收上传 → 校验 mime / 大小 → 计算 `sha256`。
2. 校验 `(workspace_id, knowledge_base_id, sha256)` 部分唯一索引 `documents_dedup_unique_idx` 且 `deleted_at IS NULL`：
   - **命中**（`storage_status IN ('storage_pending','ready')`）→ 返回 200 + 现有 document，**不**调 `putStaging`、**不**创建 ingestion job、**不**写 Storage 对象。
   - **并发竞争**：第二个请求在 `putStaging` 后才命中唯一索引 → 立刻 `abortStaging(stagingKey)`，查 `documents` 拿已有 document，返回 200；**不**遗留 staging 对象。
3. 未命中：服务端预生成 `documentId = gen_random_uuid()`，按文档唯一规则计算 `finalKey = documents/<workspaceId>/<kbId>/<documentId>.<ext>`（V2.3.2：必须含 `kbId`+`documentId`，避免跨 KB 同 hash 共享对象导致 Outbox 误删）；`storage.putStaging(uploadId, body, meta)` 拿到 `stagingKey`（独立 staging 命名空间）。
4. **三表 DB 事务**（V2.3.4 失败处理收紧——区分"明确回滚"与"不确定提交"）：
   - `INSERT INTO documents (id=:documentId, storage_key=finalKey, sha256, storage_status='storage_pending', ...)`；
   - `INSERT INTO document_ingestion_jobs (document_id=:documentId, status='queued', ...)`；
   - `INSERT INTO storage_finalize_jobs (document_id=:documentId, staging_key=stagingKey, final_key=finalKey, status='pending', ...)`。
   - **DB 直接落 finalKey，不存 stagingKey 到 documents**。
   - **V2.3.4 abortStaging 触发条件**（按 commit 状态分类，绝不"任何 DB 错都 abort"）：
     | 失败来源 | COMMIT 状态 | 是否立即 `abortStaging` | 兜底机制 |
     |---------|-----------|----------------------|---------|
     | 唯一索引冲突（`documents_dedup_unique_idx`） | 已 ROLLBACK | **是** | — |
     | 显式 ROLLBACK / `BEGIN` 之后未 COMMIT 即抛错 | 已 ROLLBACK | **是** | — |
     | `deadlock_detected` / `serialization_failure` 等可重试错 | 已 ROLLBACK | **是** | 重试前重新 putStaging，避免新 staging 对象与已删 staging 串号 |
     | **连接断开 / 超时 / 网络中断**（COMMIT 可能实际已成功） | **不确定** | **否** | TTL GC 兜底；活跃 job 仍引用 stagingKey，不会被 GC |
     | 任何 COMMIT 已 ack 后再出现的"错"（应用层包装错误） | 已 COMMIT | **否** | 记录 `security_events` 后继续走 finalize worker |
   - **为什么不能"任何 DB 错都 abort"**：连接在 COMMIT 往返之间断开时，PostgreSQL 可能已成功持久化三表行；直接 `abortStaging` 会删除已经被成功落库引用的 staging 对象，导致 `storage_finalize_jobs` 指向不存在的对象、TTL GC 也无能为力。**TTL GC 是这种"不确定"场景唯一安全的清理者**。
   - 即使 abortStaging 自身失败也不抛——TTL GC 会兜底清理。
5. 事务成功 → 调 `storage.finalize(stagingKey, finalKey)`（local: rename；S3: COPY + DELETE 原 staging 对象）。
6. finalize 成功 → `UPDATE documents SET storage_status='ready', updated_at=now() WHERE id=:documentId` + `UPDATE storage_finalize_jobs SET status='done', processed_at=now() WHERE document_id=:documentId`；ingestion job worker 此时开始拾取。
7. finalize 失败 → 保留 `documents.storage_status='storage_pending'` + `storage_finalize_jobs.status='pending'`；后台 finalize 重试 worker 从 `storage_finalize_jobs` SELECT 抢占（详见下方 §8.1 finalize worker），重调 `storage.finalize(stagingKey, finalKey)`（idempotent — staging 对象在 putStaging 后没被任何路径删除，重试安全）。
8. 重试超过 `max_finalize_attempts=5`（详见 §8.1 finalize worker 落库 SQL）→ `documents.storage_status='storage_failed'` + `storage_finalize_jobs.status='failed'` + `security_events`，需要人工介入。
9. **stagingKey 的 TTL GC**（V2.3.3 列举式，可发现事务前孤儿；V2.3.4 同样承担"不确定提交"的兜底职责）：
   ```typescript
   const cutoff = new Date(Date.now() - 60 * 60 * 1000);   // 1h TTL
   const activeStagingKeys = new Set(
     await sql`SELECT staging_key FROM storage_finalize_jobs WHERE status='pending'`
   );
   for await (const stagingKey of storage.listStagingOlderThan(cutoff)) {
     if (!activeStagingKeys.has(stagingKey)) {
       // 没有活跃 finalize job 引用 → 孤儿（事务前崩溃 / 不确定提交 / finalize 成功后 finalize_jobs 漏更新等场景）
       await storage.abortStaging(stagingKey).catch(() => {/* best-effort */});
     }
   }
   ```
   **关键**：GC 不依赖 `storage_finalize_jobs.staging_key` 列表枚举——它从 Storage 反向列举所有超过 TTL 的 staging 对象，减去活跃 job 集合，剩下的就是真正的孤儿。V2.3.4 起，"不确定提交"产生的孤儿也走这条 GC 路径，不会被即时 abortStaging 误伤。

**关键不变式**（V2.3.2）：

- `documents.storage_key` 始终是 finalKey；任何代码都不应读到 stagingKey。
- `staging_key` **只**存于 `storage_finalize_jobs`，进程崩溃后重试 worker 仍可定位 staging 对象。
- ingestion job worker 只处理 `storage_status='ready' AND deleted_at IS NULL` 的 document（实际 SQL JOIN 过滤，见 §8.2），避免读到 finalize 失败的空对象。
- finalize 是幂等的（rename / COPY+DELETE 可重入）；多次失败重试不会破坏对象。
- `finalKey` 含 `kbId` + `documentId`，每个文档独占对象；删除走 Outbox 按 finalKey 单文档清理，不会误删同 hash 其他 KB 的对象。

**`storage_finalize_jobs` 表**（V2.3.2 新增）：

```sql
CREATE TABLE storage_finalize_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  staging_key     TEXT NOT NULL,                -- 进程崩溃后重试定位 staging 对象用
  final_key       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending',                  -- 待 finalize（事务已提交，HTTP finalize 未完成）
                    'done',                     -- finalize 成功
                    'failed',                   -- 多次重试仍失败
                    'cancelled'                 -- V2.3.3：文档软删除时由删除事务置位
                  )),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner     TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error      TEXT,
  processed_at    TIMESTAMPTZ,        -- V2.3.4：成功 / 失败 / 取消 终态时刻；用于审计与监控
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一 document 同一时刻只有一个活跃 finalize job
CREATE UNIQUE INDEX one_active_finalize_per_document
  ON storage_finalize_jobs(document_id)
  WHERE status IN ('pending');

-- finalize 重试 worker 抢占索引
CREATE INDEX storage_finalize_jobs_retry_idx
  ON storage_finalize_jobs(next_attempt_at)
  WHERE status = 'pending' AND attempts < max_attempts;

-- finalize worker 实际过滤（V2.3.2 §8.2 同样要 JOIN documents）
CREATE INDEX storage_finalize_jobs_lease_idx
  ON storage_finalize_jobs(lease_expires_at)
  WHERE status = 'pending';
```

**finalize 重试 worker**（每 30s 一次；V2.3.3 重写为"只占 Lease / 失败才递增 attempts / 三条落库 SQL"）：

**Step A — 抢占（只占 Lease，不消耗 attempts）**：

```sql
UPDATE storage_finalize_jobs f
SET lease_owner = :workerId,
    lease_expires_at = now() + interval '60 seconds'
WHERE f.id = (
  SELECT f.id
  FROM storage_finalize_jobs f
  JOIN documents d ON d.id = f.document_id
  WHERE f.status = 'pending'
    AND f.attempts < f.max_attempts
    AND f.next_attempt_at <= now()
    AND (f.lease_owner IS NULL OR f.lease_expires_at IS NULL OR f.lease_expires_at < now())
    AND d.deleted_at IS NULL
  ORDER BY f.next_attempt_at
  FOR UPDATE OF f SKIP LOCKED
  LIMIT 1
)
RETURNING f.id, f.workspace_id, f.document_id, f.staging_key, f.final_key, f.attempts, f.max_attempts;
```

**Step B — finalize 成功（受 Lease 保护；同一事务同时落 document 与 job）**：

```sql
BEGIN;
UPDATE storage_finalize_jobs
SET status = 'done',
    processed_at = now(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error = NULL
WHERE id = :jobId
  AND lease_owner = :workerId
  AND status = 'pending';

UPDATE documents
SET storage_status = 'ready',
    updated_at = now()
WHERE id = :documentId
  AND storage_status = 'storage_pending';
COMMIT;
-- 任意 UPDATE 影响行数 = 0（被并发 worker / 软删除抢先）→ 整事务回滚，本轮视为无效
```

**Step C/D — finalize 失败（含耗尽分支；V2.3.5 改为单条多 CTE SQL）**：

```sql
-- 单条多 CTE SQL，受当前 worker 的 Lease 保护；同事务内：
--  1) 递增 attempts，根据是否跨过 max_attempts 决定终态（pending 或 failed）
--  2) 清 Lease（无论 pending 还是 failed 都清掉，避免 stale lease 阻塞抢占）
--  3) 若本次失败耗尽（status='failed'），同事务落 document=storage_failed 与 security_events
--     （注意：两个 CTE 都从 updated 派生，单语句内合法；CTE 在 PG 中确实只在紧随的单语句中可见，
--      因此把 document UPDATE 与 security_events INSERT 写成独立的 CTE，包裹在同一个 WITH 之后
--      通过最终的 SELECT 触发执行——所有 CTE 在同一条 SELECT 之前都已物化）
WITH updated AS (
  UPDATE storage_finalize_jobs
  SET last_error = :errMessage,
      attempts = attempts + 1,
      status = CASE
        WHEN attempts + 1 >= max_attempts THEN 'failed'
        ELSE 'pending'
      END,
      next_attempt_at = CASE
        WHEN attempts + 1 >= max_attempts THEN next_attempt_at          -- 已耗尽，下一次抢占不必要
        ELSE now() + (interval '30 seconds' * power(2, attempts + 1))   -- 指数退避 30s/60s/120s/240s/...
      END,
      processed_at = CASE
        WHEN attempts + 1 >= max_attempts THEN now()                     -- 终态时刻
        ELSE NULL                                                        -- pending 留空，由下一轮处理
      END,
      lease_owner = NULL,
      lease_expires_at = NULL
  WHERE id = :jobId
    AND lease_owner = :workerId
    AND status = 'pending'
  RETURNING id, status, attempts, document_id, workspace_id, final_key
),
failed_document AS (
  UPDATE documents d
  SET storage_status = 'storage_failed',
      updated_at = now()
  FROM updated u
  WHERE d.id = u.document_id
    AND u.status = 'failed'
  RETURNING d.id
),
security_event AS (
  INSERT INTO security_events (workspace_id, actor_user_id, event_type, resource_type, resource_id, detail)
  SELECT u.workspace_id, NULL, 'storage_finalize_exhausted', 'document', u.document_id,
         jsonb_build_object('job_id', u.id, 'attempts', u.attempts, 'last_error', :errMessage)
  FROM updated u
  WHERE u.status = 'failed'
  RETURNING id
)
SELECT u.status, u.attempts, u.document_id
FROM updated u;
```

> **V2.3.5 实现说明**：本节 SQL 是**唯一权威实现**——V2.3.4 的"概念 SQL + 应用层推荐实现"双轨描述已删除。CTE 在 PostgreSQL 中**只在紧随的单语句中可见**；因此 `failed_document` 与 `security_event` 必须写成 WITH 子句内的独立 CTE，让同一条查询语句一次性执行完所有副作用。`attempts` 只递增一次（`updated` CTE 内）；外层 SELECT 不触发任何写。整条语句在应用层作为**单条查询**提交，PG 自动在单条语句内保证原子性，无需额外 `BEGIN/COMMIT`。任何 CTE 抛错（如 `security_events.event_type` CHECK 违例）→ 整语句回滚，不会留下"job=failed 但 document 仍 pending"的不一致状态。

**Step B 影响 0 行的分类处置（V2.3.5 修订：先查权威状态，再决定是否清理 finalKey）**：

Step B 的 `WHERE id=:jobId AND lease_owner=:workerId AND status='pending'` 影响 0 行**不等于**"文档已删除"。至少有两类成因：

- job 已被删除事务置为 `cancelled`（或 document 已软删除）——finalKey 确实是孤儿；
- 旧 worker 的 Lease 已过期并被新 worker 重新抢占，job 仍是 `pending`——finalKey 归新 worker 的恢复流程所有。

不加区分直接删除会产生如下竞争：① 旧 worker finalize 成功；② Lease 已转给新 worker，Step B 影响 0 行；③ 旧 worker 删除 finalKey；④ 新 worker 把 job 置 `done`、document 置 `ready`，但对象已被删掉。

因此**补偿前必须读取权威状态**：

```sql
SELECT f.status      AS job_status,
       f.lease_owner AS current_lease_owner,
       d.deleted_at  AS document_deleted_at
FROM storage_finalize_jobs f
JOIN documents d ON d.id = f.document_id
WHERE f.id = :jobId;
```

按结果分类处置：

| 权威状态 | 处置 |
| --- | --- |
| `job_status='cancelled'` 或 `document_deleted_at IS NOT NULL` | 文档确已删除 → `INSERT INTO storage_deletion_outbox (storage_key, document_id) VALUES (:finalKey, :documentId)`，由 Outbox worker 持久重试清理 finalKey |
| `job_status='pending'` 且 `current_lease_owner` 不等于 `:workerId`（含 NULL / 已过期待抢占） | Lease 已转移 → **不得删除**；finalKey 交由当前（或下一个）Lease owner 继续完成恢复，本轮只记日志 |
| `job_status='done'` | 另一 worker 已完成落库、document 已 `ready` → **不得删除** |
| `job_status='failed'` | 保留对象供人工恢复 → **不得删除**，由人工 / 运维流程处置 |

**为什么走 Outbox 而不是就地 `deleteObject`**：finalKey 单文档独占，删除动作本身安全，但删除可能失败；TTL GC **无法**兜底（它只枚举 staging 命名空间，不会发现 finalKey 对象）。只有 `storage_deletion_outbox` 的持久重试能保证 finalKey 最终被清理——Outbox worker 每 30s 拾取 pending 行，重复 `storage.deleteObject(storage_key)` 直到成功或耗尽（耗尽写 `security_events` 兜底）。

**为什么删除事务已入队过 finalKey，这里仍要再入队一次**：删除事务的 Outbox 行可能在旧 worker 的 finalize 完成**之前**就被 Outbox worker 处理掉（彼时 finalKey 尚不存在，`deleteObject` 空删成功并置 `processed_at`）；随后 finalize 才写出对象，成为无人清理的孤儿。重复入队是安全的——`deleteObject` 幂等，重复删除不报错。

**关键不变式**（V2.3.4 finalize worker）：

- 抢占**不消耗 attempts**——worker 抢占后崩溃只会让 Lease 自然过期，下一轮 worker 重新抢占；不会留下"attempts=max_attempts 且 status='pending'"的永久卡死记录。
- 落库 SQL 全部带 `id=:jobId AND lease_owner=:workerId AND status='pending'`——过期 worker 无法覆盖新 worker 的结果。
- 失败 / 耗尽合并为单事务：`attempts++` 与 `status` 终态判断同一次 UPDATE 完成；不会出现"清 Lease 后第二次 UPDATE 因 lease 丢失影响 0 行"的死锁场景。
- Step B 影响 0 行**不直接触发删除**：必须先查权威状态（`job.status` / 当前 `lease_owner` / `documents.deleted_at`），仅在确认 `cancelled` 或软删除后写 `storage_deletion_outbox` 清理 finalKey；其余情况（Lease 已被新 worker 重新抢占 / `done` / `failed`）一律保留对象。
- TTL GC 不清理 `status='failed'` 的 finalize job 对应的 staging 对象（保留供人工排查）；TTL GC 不清理 `status='done'` 的 staging 对象（已不存在）；TTL GC 只清理"超过 TTL 且 storage_finalize_jobs 没有活跃引用"的 staging 对象。

**删除走 Outbox**（V2.3.3 改为软删除 + 单事务终止未完成 finalize）：

`documents` 已采用 `deleted_at` 软删除，删除流程必须保持行存在以维持部分唯一约束历史。完整删除链路：

```sql
CREATE TABLE storage_deletion_outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key   TEXT NOT NULL,
  -- V2.3.4：document_id 改为 SET NULL。
  -- 旧 ON DELETE CASCADE 会在维护脚本硬删 `deleted_at < now() - 30 days` 的 document 行时，
  -- 把尚未处理的 outbox 行一并删除；storage_key 对应的 Storage 对象永远得不到清理。
  -- 改为 SET NULL 后：
  --   1) outbox 行必须独立完成（按 storage_key 删除 storage 对象），与 documents 行生命周期解耦；
  --   2) document_id 字段保留供审计 / 关联，但不参与外键级联。
  document_id   UUID REFERENCES documents(id) ON DELETE SET NULL,
  enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);

CREATE INDEX storage_deletion_outbox_pending_idx
  ON storage_deletion_outbox(enqueued_at)
  WHERE processed_at IS NULL;
```

**V2.3.4 硬删前置校验**：维护脚本硬删软删除 document 前，必须确认对应 outbox 已清零：

```sql
-- 硬删前：找出还有未处理 outbox 的软删除 document，禁止直接 DELETE
SELECT d.id, d.deleted_at,
       (SELECT count(*) FROM storage_deletion_outbox o
        WHERE o.document_id = d.id AND o.processed_at IS NULL) AS pending_outbox
FROM documents d
WHERE d.deleted_at < now() - interval '30 days'
  AND (SELECT COUNT(*) FROM storage_deletion_outbox o
        WHERE o.document_id = d.id AND o.processed_at IS NULL) > 0;
-- 预期：返回 0 行；否则禁止继续硬删，先让 outbox worker 处理完。
```

**删除事务**（V2.3.3 单事务串联 4 个动作）：

```sql
BEGIN;
-- 1) 软删除 document；ingestion worker 立即停止拾取（§8.2 抢占 SQL WHERE deleted_at IS NULL）
UPDATE documents
SET deleted_at = now(), updated_at = now()
WHERE id = :documentId AND deleted_at IS NULL;

-- 2) Outbox 入队；Worker 按 finalKey 单文档清理 Storage 对象
INSERT INTO storage_deletion_outbox (storage_key, document_id)
VALUES (:finalKey, :documentId);

-- 3) 终止未完成的 finalize job；不让 pending finalize 永远卡住（被软删除文档的 staging 也不再被 finalize worker 抢占）
UPDATE storage_finalize_jobs
SET status = 'cancelled',
    processed_at = now(),
    lease_owner = NULL,
    lease_expires_at = NULL
WHERE document_id = :documentId AND status = 'pending';

-- 4) 终止未完成的 ingestion job；cancelled 状态在 document_ingestion_jobs CHECK 内
UPDATE document_ingestion_jobs
SET status = 'cancelled',
    updated_at = now(),
    lease_owner = NULL,
    lease_expires_at = NULL
WHERE document_id = :documentId
  AND status IN ('queued', 'parsing', 'cleaning', 'chunking', 'embedding');

COMMIT;
```

**后续清理链路**（V2.3.4）：

- Outbox worker 每 30s 处理 pending 项：`storage.deleteObject(storage_key)` → `UPDATE storage_deletion_outbox SET processed_at=now()`；重试超过 `max_attempts=5` 写 `security_events`。`document_id` 为 NULL 时（document 已硬删）也按 `storage_key` 独立处理；outbox 行的生命周期不再绑定 documents。
- `storage_finalize_jobs.status='cancelled'` 的 staging 对象由 §8.1 TTL GC 清理：其 staging_key 不在 active set 内 → `abortStaging`。
- 后台软删除清理：30 天前软删除的 document（`deleted_at < now() - interval '30 days'`）可由维护者手动 `DELETE FROM documents WHERE deleted_at < now() - interval '30 days'`，移除唯一约束历史，释放行空间。**V2.3.4 前置校验**：硬删前必须先确认对应 outbox 已 `processed_at IS NOT NULL`（详见上文 "V2.3.4 硬删前置校验"）。
- ingestion worker 由于 §8.2 抢占 SQL 的 `AND d.deleted_at IS NULL`，自动不再拾取被软删除文档的 ingestion job；cancel 步骤主要是为了清除已 in-flight 的 Lease。
- **V2.3.5 finalize 竞态兜底**（与 §8.1 Step B 联动）：删除事务把 finalize job 标记为 `cancelled` 之前，旧 worker 已取得 Lease 并完成 `storage.finalize(stagingKey, finalKey)`；旧 worker 的 Step B 因 `WHERE status='pending'` 影响 0 行，但 `finalKey` 已存在。旧 worker 检测到 0 行影响后**不得直接删除** `finalKey`——影响 0 行也可能是 Lease 已被新 worker 重新抢占。必须先按 §8.1 "Step B 影响 0 行的分类处置"读取 `job.status` / 当前 `lease_owner` / `documents.deleted_at`；**仅当**确认 `cancelled` 或 document 已软删除时，才 `INSERT INTO storage_deletion_outbox (storage_key, document_id) VALUES (:finalKey, :documentId)`，由 Outbox worker 持久重试清理。TTL GC **不能**兜底 finalKey（它只枚举 staging 命名空间）。

**关键不变式**（V2.3.3 删除）：

- `documents.deleted_at` 是唯一真理；任何代码不得通过 `DELETE FROM documents` 物理删除（除非 30 天后清理脚本）。
- 删除单事务必须包含 4 个动作；任一失败整事务回滚，文档保持 active 状态。

### 8.2 文档状态机与 Ingestion Job Lease

```text
uploaded → parsing → cleaning → chunking → embedding → completed
                                                    ↘ failed (可重试)
                                                    ↘ cancelled
```

`document_ingestion_jobs`（V2.1 加外键 + Lease）：

```sql
CREATE TABLE document_ingestion_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id         UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  status              TEXT NOT NULL CHECK (status IN (
                        'queued', 'parsing', 'cleaning', 'chunking', 'embedding',
                        'completed', 'failed', 'cancelled'
                      )),
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 3,
  lease_owner         TEXT,                       -- worker instance id
  lease_expires_at    TIMESTAMPTZ,                -- 默认 120s（文档解析比 LLM Run 长）
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 失败重试的 backoff 时间点
  error_code          TEXT,
  error_detail        TEXT,
  embedding_profile_id UUID REFERENCES embedding_profiles(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX document_ingestion_jobs_doc_idx ON document_ingestion_jobs(document_id);
CREATE INDEX document_ingestion_jobs_queue_idx
  ON document_ingestion_jobs(next_attempt_at)
  WHERE status IN ('queued', 'failed') AND attempts < max_attempts;

-- 同一 document 同一时刻只有一个活跃 job
CREATE UNIQUE INDEX one_active_ingestion_per_document
  ON document_ingestion_jobs(document_id)
  WHERE status IN ('queued', 'parsing', 'cleaning', 'chunking', 'embedding');

CREATE INDEX document_ingestion_jobs_lease_idx
  ON document_ingestion_jobs(lease_expires_at)
  WHERE status IN ('queued', 'parsing', 'cleaning', 'chunking', 'embedding');
```

Worker 抢占（V2.3.2 必须 JOIN documents，过滤 `storage_status='ready' AND deleted_at IS NULL`）：

```sql
UPDATE document_ingestion_jobs j
SET lease_owner = :workerId,
    lease_expires_at = now() + interval '120 seconds',
    status = CASE WHEN j.status = 'queued' THEN 'parsing' ELSE j.status END
WHERE j.id = (
  SELECT j.id
  FROM document_ingestion_jobs j
  JOIN documents d ON d.id = j.document_id
  WHERE j.status IN ('queued', 'failed')
    AND j.attempts < j.max_attempts
    AND j.next_attempt_at <= now()
    AND (j.lease_owner IS NULL OR j.lease_expires_at IS NULL OR j.lease_expires_at < now())
    AND d.storage_status = 'ready'        -- V2.3.2：finalize 完成后才拾取
    AND d.deleted_at IS NULL              -- V2.3.2：软删除文档不拾取
  ORDER BY j.next_attempt_at
  FOR UPDATE OF j SKIP LOCKED
  LIMIT 1
)
RETURNING j.*;
```

### 8.3 文档上传接口（HTTP）

```text
POST /api/v1/knowledge-bases/:kbId/documents
Headers:
  Content-Type: multipart/form-data
  Idempotency-Key: <uuid>          ← 推荐
Body: file binary
Response: 202 Accepted { documentId, jobId, status: 'queued' }
```

HTTP 流程（V2.3.2 与 §8.1 完全对齐：DB 预存 finalKey + `storage_status` 状态机 + `storage_finalize_jobs` 持久化 staging_key + 并发竞争清理）：

1. 校验文件大小（`MAX_UPLOAD_BYTES`）、mime type 白名单。
2. 计算 `sha256`；按 `(workspace_id, knowledge_base_id, sha256)` 命中部分唯一索引 `documents_dedup_unique_idx` 且 `deleted_at IS NULL` → 返回 200 + 现有 document；**不**调 `putStaging`、**不**创建 ingestion job、**不**写 Storage 对象。
3. **并发竞争分支**：若 putStaging 后 INSERT 命中唯一索引冲突 → 立刻 `storage.abortStaging(stagingKey)`；查 `documents` 拿已有 document；返回 200 给客户端；**不**遗留 staging 对象。
4. 未命中：服务端预生成 `documentId = gen_random_uuid()`；按文档唯一规则计算 `finalKey = documents/<workspaceId>/<kbId>/<documentId>.<ext>`（V2.3.2：含 `kbId`+`documentId`）；`storage.putStaging(uploadId, body, meta)` 拿到 `stagingKey`；失败 5xx。
5. 事务：`INSERT INTO documents (id=:documentId, storage_key=finalKey, sha256, storage_status='storage_pending', ...)` + `INSERT INTO document_ingestion_jobs (document_id=:documentId, status='queued', ...)`（V2.3.2：与 §8.2 schema CHECK 一致）+ `INSERT INTO storage_finalize_jobs (document_id, staging_key, final_key, status='pending', ...)`（V2.3.2 新增）。**DB 直接落 finalKey**，与 §8.1 写入流程一致。
6. 事务成功 → 调 `storage.finalize(stagingKey, finalKey)`；成功后 `UPDATE documents SET storage_status='ready' WHERE id=:documentId` + `UPDATE storage_finalize_jobs SET status='done' WHERE document_id=:documentId`，ingestion worker 此时才拾取。
7. finalize 失败 → `documents.storage_status` 与 `storage_finalize_jobs.status` 都保持 pending，由 §8.1 后台 finalize 重试 worker 接管；HTTP 端已返回 202。
7. 返回 202 + `Location: /api/v1/documents/:documentId`。

### 8.4 Embedding 独立表

见决策 1。Worker 在 `embedding` 阶段写入 `document_embeddings`：

```sql
-- V2.3 复用 Decision 1 唯一规范；本节不再维护第二份方向相反的 SQL：
--   同 hash   → DO NOTHING（内容未变，无需重写向量）
--   异 hash   → UPDATE（content 已变，必须重算 embedding）
INSERT INTO document_embeddings (
  workspace_id, document_id, chunk_id, profile_id,
  dimensions, embedding, content_hash, updated_at
)
SELECT :workspaceId, :documentId, chunk.id, :profileId,
       :dimensions, :embeddingVec, :contentHash, now()
FROM document_chunks chunk
WHERE chunk.document_id = :documentId
ON CONFLICT (chunk_id, profile_id) DO UPDATE
  SET embedding    = EXCLUDED.embedding,
      dimensions   = EXCLUDED.dimensions,
      content_hash = EXCLUDED.content_hash,
      updated_at   = now()
  WHERE document_embeddings.content_hash IS DISTINCT FROM EXCLUDED.content_hash;
```

激活态由 `embedding_profiles.is_active` 决定，**不**在向量行上。查询路径：

```sql
SELECT e.*
FROM document_embeddings e
JOIN embedding_profiles p ON p.id = e.profile_id
WHERE p.workspace_id = :workspaceId
  AND p.status = 'active'
  AND p.is_active = true
ORDER BY e.embedding <=> :queryVec
LIMIT :topK;
```

### 8.4.1 Core / RAG Schema 边界（V2.3.6 新增）

Phase 0 基线把向量**内联**在 `document_chunks.embedding vector(2048)`，导致 `vector` 扩展成为**启动硬依赖**——这与 §8.7「Core 模式启动不需要 pgvector」直接冲突。V2.3.6 把 Schema 拆成两层：

| 层 | 包含 | 何时创建 |
|---|---|---|
| **Core Schema** | `documents`、`document_chunks`（**不含** `embedding` 列）、`conversations`、`messages`、… | always |
| **RAG Schema** | `vector` 扩展、`embedding_profiles`、`document_embeddings`、HNSW 索引 | **仅当 RAG 模块启用** |

**新安装**（全新数据库）：

- Core Schema **不创建** `vector` 扩展，**不创建** `document_chunks.embedding` 列。
- 只有 RAG 模块启用时才执行 RAG Schema 迁移：`CREATE EXTENSION IF NOT EXISTS vector` → `embedding_profiles` → `document_embeddings` → 部分 HNSW 索引。
- Core 模式下 `document_chunks` 依然可用（切片、全文检索、Citation 元数据都不依赖向量）。

**关键不变式**：任何 Core 路径的 SQL **不得**引用 `vector` 类型、`<=>` 算子或 `document_embeddings`。检索模块必须在 RAG 未启用时走「无向量」降级分支，而不是启动即失败。

### 8.4.2 存量内联向量迁移（V2.3.6 新增）

已有数据库（`document_chunks.embedding` 有数据）**不能**直接 `DROP COLUMN` 再重建——那会丢失全部已计算向量且无法回滚。迁移必须分 6 步，每步可独立回滚：

**Step 1 — 建 RAG Schema 与 Legacy Profile（不动旧列）**

```sql
CREATE EXTENSION IF NOT EXISTS vector;
-- embedding_profiles / document_embeddings 见决策 1

-- Legacy Profile 先建为非激活，回填期间检索仍走旧列
INSERT INTO embedding_profiles (workspace_id, provider, model, dimensions, status, is_active)
VALUES (:workspaceId, :legacyProvider, :legacyModel, :legacyDimensions, 'migrating', false)
RETURNING id;
```

**Step 2 — 判定搬迁 or 重算（V2.3.6 强制裁决点）**

Phase 0 的 `document_chunks` **没有记录** `provider` / `model`——只有 `dimensions` 能从列 typmod（`vector(2048)`）反推。因此：

| 条件 | 路径 |
|---|---|
| 运维显式提供 `LEGACY_EMBEDDING_PROVIDER` + `LEGACY_EMBEDDING_MODEL` + `LEGACY_EMBEDDING_DIMENSIONS`，且 `LEGACY_EMBEDDING_DIMENSIONS` 与列 typmod **一致** | **原样搬迁**（SQL 直接 INSERT ... SELECT） |
| 三个变量任一缺失，或维度与 typmod 不符 | **必须重新 embedding**——逐 chunk 重算后写入 |

> **禁止伪造模型归属**：不得用「当前配置的 provider/model」去标注来历不明的旧向量。向量与模型不匹配会让检索静默劣化——相似度仍能算出数值，但语义空间不同，结果不可信且无法从数据上发现。宁可重算。

**Step 3 — 回填**

```sql
-- 仅在 Step 2 判定为"原样搬迁"时使用
INSERT INTO document_embeddings (
  workspace_id, document_id, chunk_id, profile_id,
  dimensions, embedding, content_hash, updated_at
)
SELECT c.workspace_id, c.document_id, c.id, :legacyProfileId,
       :legacyDimensions, c.embedding, c.content_hash, now()
FROM document_chunks c
WHERE c.embedding IS NOT NULL
ON CONFLICT (chunk_id, profile_id) DO NOTHING;   -- 可重入
```

重算路径按 §8.4 的 `ON CONFLICT ... DO UPDATE` 规范逐批写入，受 `document_ingestion_jobs` 的 Lease 保护。

**Step 4 — 校验（四项全过才允许继续）**

```sql
SELECT
  (SELECT count(*) FROM document_chunks WHERE embedding IS NOT NULL)      AS legacy_vectors,
  (SELECT count(*) FROM document_embeddings WHERE profile_id = :pid)      AS migrated_vectors,
  (SELECT count(*) FROM document_chunks c                                  -- chunk 覆盖率
     WHERE c.embedding IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM document_embeddings e
                       WHERE e.chunk_id = c.id AND e.profile_id = :pid))  AS uncovered_chunks,
  (SELECT count(*) FROM document_embeddings
     WHERE profile_id = :pid AND dimensions <> :legacyDimensions)         AS dimension_mismatch,
  (SELECT count(*) FROM document_embeddings e                             -- content_hash 一致性
     JOIN document_chunks c ON c.id = e.chunk_id
     WHERE e.profile_id = :pid
       AND e.content_hash IS DISTINCT FROM c.content_hash)                AS hash_mismatch;
```

门禁：`migrated_vectors = legacy_vectors`（搬迁路径）、`uncovered_chunks = 0`、`dimension_mismatch = 0`、`hash_mismatch = 0`。任一不满足 → **停止迁移**，`embedding_profiles.status` 保持 `'migrating'`，检索继续走旧列。

**Step 5 — 切读（唯一切换点，可秒级回滚）**

```sql
UPDATE embedding_profiles SET status = 'active', is_active = true WHERE id = :pid;
```

检索路径按 §8.4 的查询 SQL 改走 `document_embeddings`。**回滚**：`UPDATE embedding_profiles SET status='migrating', is_active=false` —— 旧列仍在，检索立即退回旧路径，无数据损失。

**Step 6 — 回滚窗口届满后才删列**

- 回滚窗口 **7 天**（与 §8.7「旧向量保留 7 天可回滚」一致），窗口内 `document_chunks.embedding` **只读保留**，不再被任何写路径更新。
- 窗口内每日复跑 Step 4 校验；任一次失败即回滚到 Step 5 前状态。
- 窗口届满且校验持续通过后，才允许：

  ```sql
  ALTER TABLE document_chunks DROP COLUMN embedding;
  ```

- **禁止**在 Step 5 之后立即 DROP；**禁止**跳过 Step 4 直接切读。

**读写切换总序**（任何时刻只有一个读源）：

```text
Step 1-3   读=旧列   写=新表（回填中）      回滚：DELETE FROM document_embeddings WHERE profile_id=:pid
Step 4     读=旧列   写=停                  回滚：同上
Step 5     读=新表   写=新表                回滚：is_active=false → 读回旧列
Step 6     读=新表   写=新表   旧列已删     回滚：不再可能（故必须过完窗口）
```

### 8.5 RAG Pipeline

```text
Query Normalize
  ↓
可选 Query Rewrite
  ↓
向量检索（document_embeddings WHERE provider=? AND model=? AND is_active=true）
  + 关键词检索（pg_trgm / tsvector，待阶段 4 选型）
  ↓
相关度阈值
  ↓
去重（同一 document 的相邻 chunk 合并）
  ↓
Rerank（Provider 接口预留，模型选型延后）
  ↓
上下文预算裁剪（maxContextTokens）
  ↓
Citation Builder（保留 title / chapter / documentName / chunkIndex / source）
```

**配置项（Workspace 级）**：`topK` / `minSimilarity` / `chunkSize` / `chunkOverlap` / `maxContextTokens` / `hybridEnabled` / `rerankEnabled`。

### 8.6 Context Manager

替换 `runtime.ts:buildPrompt`：

- 结构化消息（system / user / assistant / tool）。
- Token 估算（tiktoken 离线 + 启发式兜底）。
- 完整回合裁剪（保留 tool result 与对应 assistant 决策）。
- 历史摘要（默认关闭；接口预留）。
- Prompt Injection 边界（引文与用户问题之间加固定分隔符）。

### 8.7 阶段 4 验收

- [ ] 文档上传立即返回 202，Worker 异步完成。
- [ ] Worker 重启后未完成任务自动重新抢占（基于 `lease_owner` / `lease_expires_at` 租约过期；V2.3.6 修正——`document_ingestion_jobs` 与 `storage_finalize_jobs` 均无 `locked_at` 列，回收判据统一为"`lease_owner IS NULL` 或 `lease_expires_at < now()`"，见 §8.1 Step A 与 §8.2 抢占 SQL）。
- [ ] 同一文件二次上传 hash 命中，不重新 embed。
- [ ] Core 模式启动不需要 pgvector：新安装的 Core Schema **不创建** `vector` 扩展、**不创建** `document_chunks.embedding` 列；RAG 模块启用后才创建 `vector` 扩展、`embedding_profiles` 与 `document_embeddings`（V2.3.6 §8.4.1）。
- [ ] 存量库的内联向量按 §8.4.2 六步迁移：Legacy Profile → 判定搬迁/重算 → 回填 → 四项校验 → 切读 → 过 7 天回滚窗口后才 DROP 旧列；四项校验任一失败即停止并保持读旧列。
- [ ] 来历不明的旧向量（`provider`/`model`/`dimensions` 无法全部确认）走**重算**路径，不得以当前配置伪造模型归属（V2.3.6 §8.4.2 Step 2）。
- [ ] 切换 Embedding 模型：并行入库 → 校验覆盖 → 切 `is_active` → 旧向量保留 7 天可回滚。
- [ ] 检索调试信息只对 Workspace admin 可见（合约测试）。

---

## 9. 阶段 5：模型、评测与生产开放

### 9.1 第二 Provider

- 实现 OpenAI-compatible Adapter（`backend/src/infrastructure/llm/providers/openai-compatible.ts`）。
- `resolveDefaultChatModel()` 优先用配置；失败回退到第二 Provider；输出 `deprecated` 警告。
- 健康检查统一走 §9.2 被动熔断，**不**做 pre-flight ping（避免无谓开销）。

### 9.2 退避、熔断、Fallback（V2.1 改被动熔断）

V2.0 提议"每次请求前执行 pre-flight ping 探测 primary Provider"——这会增加延迟、消耗 token、引入额外费用。V2.1 改为**被动熔断**：

- Provider 健康状态由**实际请求结果**驱动：
  - `success` → healthy 计数 +1；
  - `connection refused / 5xx / timeout` → unhealthy 计数 +1；
  - `4xx`（业务错误）→ 不计入健康度。
- 滚动窗口（最近 1min 错误率 > 50% 且失败次数 ≥ 5）→ unhealthy 持续 5min。
- unhealthy 期间不发起新请求；下一个 Run 直接路由到 fallback Provider。
- **Fallback 仅在首 token 前**：流式输出已开始（已有 token 产出）后 Provider 报错 → abort + 返回错误，**不**静默切换（避免用户读到一半内容风格/语义突变）。
- 退避：exponential backoff with jitter；max retries 3（仅对 `idempotent=true` 的请求启用）。
- 健康检查是被动的；**不**主动 ping Provider（避免无谓开销）。
- 熔断状态写入内存（per-instance）+ 周期性持久化到 `provider_health` 表（用于多实例共享视图，但**不**作为强一致来源）。

### 9.3 用户反馈

```text
POST /api/v1/messages/:messageId/feedback
Body: { rating: 'up' | 'down', reason?: string, customFields?: Record<string, string> }
```

`message_feedback` 表关联 `messageId` / `runId` / `model` / `promptVersion` / `retrievalVersion`。

### 9.4 AI 评测

**重要**：下表的 `expected_citations?`、`expected_tool_calls?`、`tags[]` 是**伪 schema 草案**，未在 V2 中落地。阶段 5 实际编写评测 runner 时再敲定字段类型（数组用 JSONB、稀疏字段去掉 `?`、新增的字段要补兼容逻辑）。

```sql
-- 伪 schema（待阶段 5 实际设计时落实）
CREATE TABLE evaluation_datasets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 注：以下字段仅为示意，阶段 5 实施前需细化
CREATE TABLE evaluation_cases (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id             UUID NOT NULL REFERENCES evaluation_datasets(id) ON DELETE CASCADE,
  input                  TEXT NOT NULL,
  expected_output        TEXT,                  -- 伪 schema：阶段 5 需明确是否 NOT NULL
  expected_citations     JSONB,                 -- 伪 schema：阶段 5 需明确引用结构
  expected_tool_calls    JSONB,                 -- 伪 schema：同上
  tags                   JSONB                  -- 伪 schema：用 JSONB 数组而非 TEXT[]
);

CREATE TABLE evaluation_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id          UUID NOT NULL REFERENCES evaluation_datasets(id) ON DELETE CASCADE,
  model               TEXT NOT NULL,
  prompt_version      TEXT NOT NULL,            -- git-sha 形式
  retrieval_version   TEXT NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);

CREATE TABLE evaluation_results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  case_id         UUID NOT NULL REFERENCES evaluation_cases(id) ON DELETE CASCADE,
  actual_output   TEXT NOT NULL,
  scores          JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms      INTEGER NOT NULL,
  token_count     INTEGER NOT NULL
);
```

评测 runner 跑在独立进程（与生产流量隔离）。

### 9.5 OpenAPI

- 用 `@hono/zod-openapi` 一份 zod schema 同时生成运行时校验 + OpenAPI 文档。
- 统一错误结构：

  ```json
  {
    "code": "CONVERSATION_NOT_FOUND",
    "message": "会话不存在。",
    "requestId": "..."
  }
  ```

- 统一错误码表见附录 D。
- 分页：`?cursor=&limit=`。
- 幂等键：`Idempotency-Key` header；服务端用 `idempotency_keys` 表 + TTL 24h（阶段 2 已落地，详见 §6.2）。

### 9.5.1 `/api/v1` 上线兼容窗口（V2.1）

Phase 0 当前所有路由挂在根路径（`/ask`、`/auth/login`、`/conversations` 等）。阶段 2 引入 `/api/v1` 前缀时不能直接替换——前端、SDK、可能存在的外部调用都会同时失效。

**策略**：

1. 阶段 2 部署时同时挂两个前缀：
   - `/api/v1/v2alpha`（新前端主用入口，本地环境默认）；
   - `/api/v1`（正式入口，对外文档）；
   - **保留**旧的 `/ask` / `/auth/*` / `/conversations` 等 Phase 0 路由，加 deprecation header `Deprecation: true; Sunset="2027-02-01"`。
2. 前端先切到 `/api/v1/v2alpha`：验证 URL 恢复、idempotency、SSE 续传等新行为。
3. 稳定后（至少 1 个 minor 周期）前端切到 `/api/v1`。
4. 删除 `/api/v1/v2alpha` 与 Phase 0 旧路由（按 Sunset 日期）。
5. 反向代理（nginx / cloud LB）层做 rewrite：外部传入 `/api/v1/*` 时去掉前缀；本地开发也支持 `/api/v1/*` 直连。

**兼容矩阵**：

| 阶段 | 阶段 0 旧路由 | `/api/v1/v2alpha` | `/api/v1` |
|---|---|---|---|
| 2 启动期 | ✓ + deprecation 头 | ✓ | ✓（空实现或 404） |
| 2 验证期 | ✓ | ✓（前端主用） | ✓ |
| 3 之后 | ✗ | ✓ | ✓（前端主用） |
| 5 之后 | ✗ | ✗ | ✓ |

### 9.6 Production Readiness 报告

`npm run readiness`：

```json
{
  "production_ready": false,
  "missing": [
    "workspace_migration_complete",
    "tool_policy_gateway_active",
    "rate_limit_active",
    "structured_logging_active",
    "openapi_documented"
  ]
}
```

`DEPLOYMENT_PROFILE=production` 启动时跑该检查，任一缺失即抛错并打印缺失项。

### 9.7 优雅停机

- SIGTERM → 停止接受新请求 → 等所有 SSE 在 30s 内自然结束 → 退出。
- 配合 SSE 续传：客户端重连后从 `Last-Event-ID` 回放；Worker 心跳超时由 lease 回收接管。

### 9.8 阶段 5 验收

- [ ] DeepSeek 暂时挂掉时第二 Provider 在熔断窗口后自动接管（被动熔断，非 pre-flight）。
- [ ] 流式输出中 DeepSeek 报错 → 错误透出，不静默切换。
- [ ] 每次 Prompt / RAG / Tool 改动可运行回归评测集。
- [ ] OpenAPI 文档与实现一致（用 `schemathesis` / `dredd` 校验）。
- [ ] `DEPLOYMENT_PROFILE=production` 启动时 readiness 报告全绿。
- [ ] `/api/v1/v2alpha` 兼容入口已删除；旧 Phase 0 路由已按 Sunset 日期下线。

---

## 10. 总体验收标准

1. 多用户之间看不到彼此数据；Workspace 隔离 + 跨访问 404 + 合约测试覆盖。
2. 刷新后恢复当前会话；URL 可直接定位会话。
3. 多实例部署下并发与停止行为符合预期。
4. 高风险 Tool 未审批不能执行；审批记录可追溯。
5. 文档处理失败可恢复和重试；Worker 重启不丢任务。
6. RAG 有阈值、引用、质量评测。
7. 长会话不会无限扩大上下文（Context Manager 强制 token 预算）。
8. 每次 Run 可定位模型、Token、费用与错误（通过 `requestId`）。
9. AI 改动可运行固定回归评测。
10. Core 模式无需 pgvector 即可启动。
11. Production 档位只能在 readiness 全绿后开放。
12. 日志、API 响应、Tool I/O 不含敏感字段（合约测试保证）。

---

## 附录 A：路径约定

```text
backend/src/
  core/
    agent/
    execution/
    context/             （新增，Context Manager）
    policy/              （新增，Tool Gateway）
    observability/       （新增，结构化日志 + Request ID）
    provider/
    skill/
    tool/
  modules/
    auth/
    workspaces/          （新增，Workspace + RBAC + 成员管理）
    conversations/
    runs/                （新增，agent_runs + agent_run_events 业务封装）
    knowledge/           （RAG 模块可选；Core 不加载）
    documents/           （RAG 模块可选）
    feedback/            （新增）
    evaluations/         （新增）
  infrastructure/
    database/
    jobs/                （新增，Worker）
    llm/
    rate-limit/          （新增）
  server/
    middleware/
    routes/
    bootstrap.ts

frontend/src/
  app/
    router.tsx           （新增，react-router 配置）
    providers/
  features/
    auth/
    chat/
    conversations/
    knowledge/
    capabilities/
    approvals/           （新增）
    feedback/            （新增）
  lib/
    api/                 （按领域拆分）
    routing/
```

## 附录 B：环境变量清单

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEPLOYMENT_PROFILE` | `core` | `core` / `full` / `production`；`production` 启动前跑 readiness |
| `APP_NAME` | `Mastra Agent Starter` | 品牌名 |
| `APP_SHORT_NAME` | `Mastra` | 简称 |
| `LLM_PROVIDER` | `deepseek` | 默认 Provider |
| `LLM_MODEL` | `deepseek-v4-flash` | 默认模型（不含前缀） |
| `DEEPSEEK_API_KEY` | 无 | DeepSeek 凭据 |
| `OPENAI_COMPATIBLE_BASE_URL` | 无 | 第二 Provider base URL |
| `OPENAI_COMPATIBLE_API_KEY` | 无 | 第二 Provider 凭据 |
| `EMBEDDING_PROVIDER` | 无 | RAG 模块：`doubao` / `openai` / ... |
| `EMBEDDING_MODEL` | `doubao-embedding-vision-251215` | RAG 模块：Embedding 模型 |
| `EMBEDDING_DIMENSIONS` | 无 | RAG 模块：向量维度（首次写入时确定） |
| `AUTH_SESSION_TTL_DAYS` | `7` | 会话有效期 |
| `AUTH_COOKIE_SECURE` | `false` | 生产环境必须 `true` |
| `AUTH_ALLOWED_ORIGINS` | `http://localhost:5173` | Origin 白名单，逗号分隔 |
| `RATE_LIMIT_RPM_PER_USER` | `60` | 每用户每分钟请求上限 |
| `RATE_LIMIT_RPM_PER_WORKSPACE` | `600` | 每 Workspace 每分钟请求上限 |
| `MAX_REQUEST_BODY_BYTES` | `8192` | `/ask`、`/conversations` body 上限 |
| `MAX_UPLOAD_BYTES` | `52428800` | 50 MB，单文件 |
| `SSE_RESUME_TTL_HOURS` | `24` | Run 事件保留时长 |
| `DRAFT_TTL_HOURS` | `24` | Draft Conversation 清理阈值 |
| `LOG_LEVEL` | `info` | 结构化日志级别 |
| `LOG_FORMAT` | `json` | `json` / `pretty` |

## 附录 C：API 路由表

```text
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
GET    /api/v1/auth/me

GET    /api/v1/workspaces
POST   /api/v1/workspaces              （阶段 1 末，共享 Workspace；当前仅 Personal）
GET    /api/v1/workspaces/:id
GET    /api/v1/workspaces/:id/members

POST   /api/v1/conversations
GET    /api/v1/conversations?status=active
GET    /api/v1/conversations/:id
PATCH  /api/v1/conversations/:id
DELETE /api/v1/conversations/:id
POST   /api/v1/conversations/:id/messages   （draft 上首条触发 status→active；同 §6.2 V2.3 事务顺序）
POST   /api/v1/messages/:id/stop
POST   /api/v1/messages/:id/regenerate
POST   /api/v1/messages/:id/feedback
GET    /api/v1/runs/:runId/events           （SSE；重连通过 Last-Event-ID header）

GET    /api/v1/agents
GET    /api/v1/tools
GET    /api/v1/capabilities

GET    /api/v1/skills
GET    /api/v1/skills/:id
DELETE /api/v1/skills/:id
GET    /api/v1/skills/market/search
GET    /api/v1/skills/market/popular
POST   /api/v1/skills/market/preview
POST   /api/v1/skills/market/install
POST   /api/v1/skills/:id/update
POST   /api/v1/skills/:id/bind
POST   /api/v1/skills/:id/unbind

GET    /api/v1/knowledge-bases
POST   /api/v1/knowledge-bases
GET    /api/v1/knowledge-bases/:id
PATCH  /api/v1/knowledge-bases/:id
DELETE /api/v1/knowledge-bases/:id
POST   /api/v1/knowledge-bases/:id/documents
GET    /api/v1/knowledge-bases/:id/documents
GET    /api/v1/documents/:id
DELETE /api/v1/documents/:id

GET    /api/v1/approvals?status=pending
POST   /api/v1/approvals/:id/resolve

GET    /api/v1/feedback

GET    /api/v1/evaluations/datasets
POST   /api/v1/evaluations/datasets
GET    /api/v1/evaluations/runs
POST   /api/v1/evaluations/runs

GET    /api/v1/healthz
GET    /api/v1/readyz
GET    /api/v1/livez
```

## 附录 D：错误码约定

```text
AUTH_INVALID_CREDENTIALS         401
AUTH_SESSION_EXPIRED             401
AUTH_INSUFFICIENT_SCOPE          403
WORKSPACE_NOT_FOUND              404
CONVERSATION_NOT_FOUND           404
KNOWLEDGE_BASE_NOT_FOUND         404
DOCUMENT_NOT_FOUND               404
RUN_NOT_FOUND                    404
APPROVAL_NOT_FOUND               404

CONVERSATION_CONFLICT_ACTIVE_RUN 409
IDEMPOTENCY_KEY_REUSED           409   -- 同一 key 不同 fingerprint
APPROVAL_EXPIRED                 410
RATE_LIMIT_EXCEEDED              429

INPUT_VALIDATION_FAILED          400
INPUT_TOO_LARGE                  413
TOOL_FORBIDDEN                   422
EMBEDDING_NOT_CONFIGURED         422

INTERNAL_ERROR                   500
PROVIDER_UNAVAILABLE             502
PROVIDER_TIMEOUT                 504
```

**V2.1 调整**：删除 `424 Failed Dependency / TOOL_APPROVAL_REQUIRED`。审批等待是**异步**语义，必须通过 SSE `approval-requested` 事件推送给前端；`POST /conversations/:id/messages` 等同步端点不会因为审批挂起返回错误码。`424` 仍保留为 RFC 4918 标准定义，仅用于"同步调用依赖失败"的极少数场景（如同步网关调用内部 RPC 失败），本 Starter 不使用。

新增 `IDEMPOTENCY_KEY_REUSED`：同一 `Idempotency-Key` 在 TTL 内重复使用但请求 fingerprint 不一致时返回。

## 附录 E：会话恢复与 SSE 重放状态机（V2.1 修正）

```text
客户端：window.location = '/chat/new'
  ↓ POST /api/v1/conversations    Headers: Idempotency-Key: <uuid>
服务端：status='draft' → 201 { id }
客户端：replace('/chat/:id')
  ↓ GET /api/v1/conversations/:id   （含 message 列表）
  ↓ 找到 status='streaming' 的消息 → 进入恢复流程

恢复流程：
  1. GET /api/v1/runs/:currentRunId/events   Headers: Last-Event-ID: <event_id>
  2. 服务端回放 id > lastEventId 的事件
  3. 切换到 LISTEN/NOTIFY 实时跟踪
  4. 客户端按 id 单调递增 + accumulatedLength 重建 message 流

激活流程（draft → active，统一 messages 端点；V2.3 修正）：
  POST /api/v1/conversations/:id/messages
    Headers:
      Idempotency-Key: <uuid>
    Body: { content: firstMessage }
  服务端单事务（严格外键顺序，先 message 后 run，最后回填 current_run_id）：
    UPDATE conversations SET status='active', title=... WHERE id=:id AND status='draft'
    INSERT INTO messages (role='user', status='done', current_run_id=NULL, ...)
    INSERT INTO messages (role='assistant', status='pending', current_run_id=NULL, ...)  ← 取 :assistantMessageId
    INSERT INTO agent_runs (status='queued', assistant_message_id=:assistantMessageId, ...)  ← 取 :runId
    INSERT INTO agent_run_events (type='run-queued', run_id=:runId, ...)  ← queued 状态对应 run-queued；不预写模型首段
    UPDATE messages SET current_run_id=:runId WHERE id=:assistantMessageId  ← Run 已存在，FK 安全
    NOTIFY agent_run_events_channel
    INSERT INTO idempotency_keys (key, workspace_id, user_id, request_fingerprint, response_status=202, response_body={userMessageId, assistantMessageId, runId, eventsUrl})
  返回 202 JSON（含已渲染的 eventsUrl，形如 "/api/v1/runs/<actual-runId>/events"）
  客户端随后通过 GET eventsUrl 订阅 SSE（SSE 与命令解耦；事务内不再返回 SSE 流）
  失败回滚：Draft 状态保留；客户端可用同 Idempotency-Key 重试
  状态语义（V2.3 明确）：
    queued    → run-queued
    running   → run-started（worker 抢占时再发）
    running→completed → run-completed
    running→failed    → run-failed
    running→waiting_approval（阶段 3） → approval-requested
    waiting_approval→running（审批通过） → approval-resolved
    waiting_approval→stopped（APPROVAL_EXPIRED） → run-stopped（error_code=APPROVAL_EXPIRED）
```

## 附录 F：从 V1 到 V2 的拒绝记录

为避免后续 PR 重新引入已拒绝的方案：

- ❌ 不在客户端 localStorage 保存消息正文、引用、Tool 输出。
- ❌ 不在输入框聚焦时创建空会话。
- ❌ 不把 `EMBEDDING_DIM` 硬编码到 schema。
- ❌ 不让 Tool 直接由 Mastra runtime 执行而不经 Policy 包装。
- ❌ 不实现 `session` / `persistent` 授权粒度（P0 阶段）。
- ❌ 不在 SSE 生命周期内独占 DB 连接。
- ❌ 不让 `console.error` 进入生产（替换为 pino）。
- ❌ 不在迁移脚本里塞复杂业务循环（用 `npm run migrate:*` 独立脚本）。
- ❌ 不为单租户 Starter 实现邀请注册（仅 Personal + 预留接口）。
- ❌ 不重写 Mastra Tool Dispatcher（用原生 Approval + 包装 execute）。
