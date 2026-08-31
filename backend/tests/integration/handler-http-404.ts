/**
 * 跨 Workspace HTTP 404 集成测试（PR-1.5 —— 边界合约）。
 *
 * 与 `isolation-contract.ts` 的差异：本任务在 **HTTP handler 边界** 而非
 * service 层做镜像验证——验证每个 `requiresAuth: true` 业务路由对跨
 * workspace 访问**统一返回 404**（与"资源不存在"字节级一致），同时确认：
 *   - `withAuthenticatedWorkspace(handler)` 包装器正确注入 `authCtx.workspaceId`；
 *   - 路由内部"先 SELECT 验证 workspace_id"（如 `regenerate.ts` / `stop.ts`）
 *     的预校验真的命中；
 *   - 跨 workspace 的破坏性操作（DELETE / UPDATE）不留任何副作用（资源行
 *     状态、cascade 触发数等仍为初始值）。
 *
 * 文件：tests/integration/handler-http-404.ts
 *
 * 启用条件（与 isolation-contract.ts / workspace-context.ts 一致）：
 *   - `RUN_DB_TESTS=1` + `TEST_DATABASE_URL=postgres://.../<test_db>`；
 *   - `<test_db>` 必须落在 `db-isolation.ts` 的测试库允许列表内
 *     （`test_*` / `*_test` / 独立 `test`）。
 *
 * **Handler 级集成测试 ≠ HTTP 端到端测试。** 本测试直接调用
 *   `route.handler(fakeContext)`，**不**经过：
 *     - Mastra 路由匹配层（path → handler 映射、method 校验）；
 *     - LocalAuthProvider 的 `authenticateToken()` / `authorizeUser()`
 *       middleware 链；
 *     - 真实 HTTP server 的 socket / keep-alive / TLS / Cookie 序列化。
 *   它能证明：路由 handler 拿到 cookie → resolveSession →
 *   ensurePersonalWorkspace → 注入非空 workspaceId 上下文 → 业务逻辑
 *   读到的也是同一个 workspaceId。**不能**证明真实 HTTP 请求会得到
 *   相同结果——method 路由、CORS、Cookie Secure、middleware 顺序等都会被
 *   绕过。完整 E2E 需启动 `mastra dev` / `mastra start` 并用 supertest /
 *   fetch 命中真实端口。
 *
 * 8 个 case（Step 1 表）：
 *   1. getConversationRoute    (GET   /conversations/:id)
 *   2. updateConversationRoute (PATCH /conversations/:id)
 *   3. deleteConversationRoute (DELETE /conversations/:id)
 *   4. getKnowledgeBaseRoute   (GET   /knowledge-bases/:id)
 *   5. getDocumentRoute        (GET   /documents/:id)
 *   6. deleteDocumentRoute     (DELETE /documents/:id)
 *   7. stopMessageRoute        (POST  /messages/:id/stop)
 *   8. regenerateMessageRoute  (POST  /messages/:assistantMessageId/regenerate)
 *
 * 每个 case：
 *   - uB session 请求 wA 的资源 ID；
 *   - 断言 res.status === 404；
 *   - 断言响应体包含 `资源不存在`（或 error_code === 'NOT_FOUND'）；
 *   - 断言 wA 的资源行**未被改动**（title / status / 存在性保持初始）。
 *
 * 跨 workspace 访问统一返回 404，**禁止** 403、禁止 401（401 仅用于
 * "无有效 Session"）。客户端不能区分"资源不存在" vs "归属其他 workspace"——
 * status 必须都是 404，body 必须都是同一 `error_code: 'NOT_FOUND'`。
 *
 * Skip：未设置 `RUN_DB_TESTS=1` 直接 SKIPPED 退出（不抛错）。
 */
import { Pool } from 'pg';
import {
  assertSearchPathIsolated,
  createIsolatedSchema,
  dropIsolatedSchema,
} from '../../src/test-utils/db-isolation.js';
import { runProjectMigrations } from '../../src/test-utils/migrations.js';
import {
  __resetTestPool,
  __setTestPool,
} from '../../src/infrastructure/database/pool.js';
import { createSession } from '../../src/infrastructure/auth/session.js';
import { hashPassword } from '../../src/infrastructure/auth/password.js';
import {
  getResolvedAuthConfig,
  serializeSessionCookie,
} from '../../src/infrastructure/auth/request.js';
import { ensurePersonalWorkspace } from '../../src/modules/auth/workspace-context.js';
import { getConversationRoute, updateConversationRoute, deleteConversationRoute } from '../../src/server/routes/conversations.js';
import { getKnowledgeBaseRoute } from '../../src/server/routes/knowledge-bases.js';
import { getDocumentRoute, deleteDocumentRoute } from '../../src/server/routes/documents.js';
import { stopMessageRoute } from '../../src/server/routes/messages/stop.js';
import { regenerateMessageRoute } from '../../src/server/routes/messages/regenerate.js';

const URL = process.env.TEST_DATABASE_URL;
const RUN = process.env.RUN_DB_TESTS === '1' && !!URL;

// ─── 资源 ID 常量（一个 schema 内 8 个 case 共享同一组 fixture） ───
const W_A = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const W_B = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const U_A = 'a3a3a3a3-3333-4333-8333-a3a3a3a3a3a3';
const U_B = 'b4b4b4b4-4444-4444-8444-b4b4b4b4b4b4';
const C_A = 'c5c5c5c5-5555-4555-8555-c5c5c5c5c5c5';
const KB_A = 'd6d6d6d6-6666-4666-8666-d6d6d6d6d6d6';
const DOC_A = 'e7e7e7e7-7777-4777-8777-e7e7e7e7e7e7';
const M_USER_A = 'f8f8f8f8-8888-4888-8888-f8f8f8f8f8f8';
const M_ASST_A = 'a9a9a9a9-9999-4999-8999-a9a9a9a9a9a9';

// init.sql 是当前阶段唯一的迁移文件。`through` 字典序比较用 `'init.sql'`
// 即可截到这条；后续 PR 增加 migrations/*.sql 时本测试需要升级到对应文件名。
const THROUGH_INIT = 'init.sql';

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * 把全局池换成 `search_path=schema,public` 的专用测试池。调用方负责在
 * finally 里调 `restoreGlobalPool(testPool)` 收回。
 *
 * 与 `tests/integration/workspace-context.ts` 中的同名辅助函数一致——本文件
 * 不复用它是因为 `workspace-context.ts` 是模块顶层 `let` / `function`，
 * 不能跨文件 import。
 */
function installTestPool(schema: string): Pool {
  if (!URL) {
    throw new Error('installTestPool: TEST_DATABASE_URL 未设置。');
  }
  const testPool = new Pool({
    connectionString: URL,
    max: 4,
    options: `-c search_path=${schema},public`,
  });
  __setTestPool(testPool);
  return testPool;
}

async function restoreGlobalPool(testPool: Pool): Promise<void> {
  await testPool.end();
  __resetTestPool();
}

/**
 * 构造 fakeContext：模拟 Mastra 的路由上下文，让路由 handler 直接调用
 * 时拿到我们想要的 cookie / path / body / params。
 *
 * 字段集与 `AuthenticatedRouteContextLike`（workspace-context.ts）一致：
 *   - req.raw：传给 extractSessionTokenFromRequest 解析 session
 *   - req.header：上游鉴权 provider 在 fallback 路径会用；本测试不需要
 *   - req.param：路由 handler 读 `:id` / `:assistantMessageId`
 *   - req.json / req.formData / req.query：updateConversation 等路由需要
 *   - json / body：构造 Response
 */
function makeCtx(opts: {
  method: string;
  path: string;
  cookie: string;
  params?: Record<string, string>;
  body?: unknown;
}): {
  req: {
    raw: Request;
    header: (n: string) => string | undefined;
    param: (name: string) => string;
    query: (name: string) => string | undefined;
    json: <T = unknown>() => Promise<T>;
    formData: () => Promise<FormData>;
  };
  json: (data: unknown, status?: number) => Response;
  body: (data: unknown, status?: number) => Response;
} {
  const headers: Record<string, string> = { Cookie: opts.cookie };
  const init: RequestInit = { method: opts.method, headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const req = new Request(`http://localhost${opts.path}`, init);
  const params = opts.params ?? {};
  return {
    req: {
      raw: req,
      header: (n: string) => req.headers.get(n) ?? undefined,
      param: (name: string) => params[name] ?? '',
      query: (_name: string) => undefined,
      json: <T = unknown>() => req.json() as Promise<T>,
      formData: async () => new FormData(),
    },
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    body: (data: unknown, status?: number) =>
      new Response(data as BodyInit | null, { status: status ?? 200 }),
  };
}

/** 断言响应是 404 + 包含 `资源不存在` 的统一错误体（与 error-mapping 契约一致）。 */
function assertNotFound(
  label: string,
  res: Response,
  body: unknown,
): void {
  assert(`${label}: status === 404`, res.status === 404, `got ${res.status}`);
  const bodyRecord =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  assert(
    `${label}: body.error_code === 'NOT_FOUND'`,
    bodyRecord?.error_code === 'NOT_FOUND',
    `got ${JSON.stringify(bodyRecord?.error_code)}`,
  );
  const message = typeof bodyRecord?.message === 'string' ? bodyRecord.message : '';
  assert(
    `${label}: body.message 包含「资源不存在」`,
    message.includes('资源不存在'),
    `got "${message}"`,
  );
}

async function main(): Promise<void> {
  if (!RUN) {
    console.log(
      'SKIPPED: 设置 RUN_DB_TESTS=1 + TEST_DATABASE_URL 后才会跑（typecheck 已通过）。',
    );
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Setup：1 个 schema + 2 个 user + 2 个 personal workspace + wA 的全套
  // 业务资源（conversation / knowledge_base / document / user message /
  // assistant message）。wB 只建 user + workspace + member 行——wB 不持有
  // 任何业务资源，作为"另一 workspace 的请求者"。
  // -------------------------------------------------------------------------
  const { schema, pool: setupPool } = await createIsolatedSchema();
  const setupClient = await setupPool.connect();
  let uBToken = '';
  try {
    // 回归守卫：确保 setupClient 真实落在隔离 schema，再做任何写入。
    await assertSearchPathIsolated(setupClient, schema);
    await runProjectMigrations(setupClient, { through: THROUGH_INIT });

    const hashed = await hashPassword('correct horse battery staple');
    await setupClient.query(
      `INSERT INTO app_users (id, username, username_normalized, password_hash)
       VALUES ($1, 'alice-404', 'alice-404', $2),
              ($3, 'bob-404',   'bob-404',   $2)`,
      [U_A, hashed, U_B],
    );
    // workspaces（personal，owner 各一）
    await setupClient.query(
      `INSERT INTO workspaces (id, kind, name, owner_user_id)
       VALUES ($1, 'personal', 'personal', $2),
              ($3, 'personal', 'personal', $4)`,
      [W_A, U_A, W_B, U_B],
    );
    // workspace_members（owner）
    await setupClient.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner'),
              ($3, $4, 'owner')`,
      [W_A, U_A, W_B, U_B],
    );
    // wA 的会话
    await setupClient.query(
      `INSERT INTO conversations (id, workspace_id, user_id, agent_id, title)
       VALUES ($1, $2, $3, 'general-chat', 'original-title')`,
      [C_A, W_A, U_A],
    );
    // wA 的知识库
    await setupClient.query(
      `INSERT INTO knowledge_bases (id, workspace_id, name)
       VALUES ($1, $2, 'kb-original')`,
      [KB_A, W_A],
    );
    // wA 的文档（必须挂在 wA 的 KB 下，status = 'ready' 标识未变更）
    await setupClient.query(
      `INSERT INTO documents (id, workspace_id, knowledge_base_id, title, source, status)
       VALUES ($1, $2, $3, 'doc-original', 'text/plain', 'ready')`,
      [DOC_A, W_A, KB_A],
    );
    // wA 的 user / assistant 消息（与 conversations.workspace_id 一致）
    await setupClient.query(
      `INSERT INTO messages (id, workspace_id, conversation_id, role, content, status)
       VALUES ($1, $2, $3, 'user',      'hi',           'complete'),
              ($4, $2, $3, 'assistant', 'hello there',  'pending')`,
      [M_USER_A, W_A, C_A, M_ASST_A],
    );
  } finally {
    setupClient.release();
  }
  await setupPool.end();

  // 全局池换成带 search_path 的测试池；让 service 函数与 route handler 都
  // 看到同一个 schema。
  const testPool = installTestPool(schema);
  try {
    // uB 的 session：通过 createSession 把 token hash 写入隔离 schema 的
    // auth_sessions 表；后续 wB cookie 解析会命中这一行。
    const { ttlDays } = getResolvedAuthConfig();
    const ensured = await ensurePersonalWorkspace(U_B);
    assert(
      'setup: ensurePersonalWorkspace(U_B) 返回非空 workspaceId',
      typeof ensured.workspaceId === 'string' && ensured.workspaceId.length > 0,
      `got ${ensured.workspaceId}`,
    );
    // 关键不变量：uB 的真实 workspaceId 是服务端兜底新建的（与 W_B 常量
    // **不**相等）——这是为了在本测试中显式区分"客户端伪造 / cookie 解析"
    // 与"fixture 字面 ID"。W_B 仅用于 workspace / member 表里建立归属
    // 关系，路由上下文拿到的 workspaceId 来自 ensurePersonalWorkspace。
    const wBRealWorkspaceId = ensured.workspaceId;
    const created = await createSession({ userId: U_B, ttlDays });
    uBToken = created.token;
    const cookie = serializeSessionCookie(uBToken, 60 * 60);

    // 辅助查询池（不走全局池；直接连隔离 schema 用于"资源未被改动"断言）
    const verifyPool = new Pool({
      connectionString: URL!,
      max: 1,
      options: `-c search_path=${schema},public`,
    });

    // ────────────────────────────────────────────────────────────────────
    // Case 1: getConversationRoute (GET /conversations/:id)
    //   uB cookie + cA → 期望 404 + cA 行未变（title = 'original-title'）
    // ────────────────────────────────────────────────────────────────────
    {
      const ctx = makeCtx({
        method: 'GET',
        path: `/conversations/${C_A}`,
        cookie,
        params: { id: C_A },
      });
      const res = await (getConversationRoute as unknown as {
        handler: (c: unknown) => Promise<Response>;
      }).handler(ctx);
      const body = (await res.json()) as unknown;
      assertNotFound('case 1 getConversation cross-workspace', res, body);

      const r = await verifyPool.query<{ title: string }>(
        `SELECT title FROM conversations WHERE id = $1`,
        [C_A],
      );
      assert(
        'case 1 getConversation: wA 会话行未被删除/修改',
        r.rows.length === 1 && r.rows[0]!.title === 'original-title',
        `rowCount=${r.rows.length}, title=${r.rows[0]?.title}`,
      );
    }

    // ────────────────────────────────────────────────────────────────────
    // Case 2: updateConversationRoute (PATCH /conversations/:id)
    //   uB cookie + cA + body {title: 'hijack'} → 期望 404 + 标题未变
    // ────────────────────────────────────────────────────────────────────
    {
      const ctx = makeCtx({
        method: 'PATCH',
        path: `/conversations/${C_A}`,
        cookie,
        params: { id: C_A },
        body: { title: 'hijack' },
      });
      const res = await (updateConversationRoute as unknown as {
        handler: (c: unknown) => Promise<Response>;
      }).handler(ctx);
      const body = (await res.json()) as unknown;
      assertNotFound('case 2 updateConversation cross-workspace', res, body);

      const r = await verifyPool.query<{ title: string }>(
        `SELECT title FROM conversations WHERE id = $1`,
        [C_A],
      );
      assert(
        'case 2 updateConversation: wA 会话标题未被改写',
        r.rows.length === 1 && r.rows[0]!.title === 'original-title',
        `title=${r.rows[0]?.title}`,
      );
    }

    // ────────────────────────────────────────────────────────────────────
    // Case 3: deleteConversationRoute (DELETE /conversations/:id)
    //   uB cookie + cA → 期望 404 + 会话行仍存在
    // ────────────────────────────────────────────────────────────────────
    {
      const ctx = makeCtx({
        method: 'DELETE',
        path: `/conversations/${C_A}`,
        cookie,
        params: { id: C_A },
      });
      const res = await (deleteConversationRoute as unknown as {
        handler: (c: unknown) => Promise<Response>;
      }).handler(ctx);
      const body = (await res.json()) as unknown;
      assertNotFound('case 3 deleteConversation cross-workspace', res, body);

      const r = await verifyPool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM conversations WHERE id = $1`,
        [C_A],
      );
      assert(
        'case 3 deleteConversation: wA 会话行未被删除',
        r.rows[0]?.c === '1',
        `count=${r.rows[0]?.c}`,
      );
      // 同步校验 cascade 不被踩到（messages 仍 2 行）
      const m = await verifyPool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM messages WHERE conversation_id = $1`,
        [C_A],
      );
      assert(
        'case 3 deleteConversation: cascade 未触发（messages 仍 2 行）',
        m.rows[0]?.c === '2',
        `count=${m.rows[0]?.c}`,
      );
    }

    // ────────────────────────────────────────────────────────────────────
    // Case 4: getKnowledgeBaseRoute (GET /knowledge-bases/:id)
    //   uB cookie + kbA → 期望 404 + kbA 行未变
    // ────────────────────────────────────────────────────────────────────
    {
      const ctx = makeCtx({
        method: 'GET',
        path: `/knowledge-bases/${KB_A}`,
        cookie,
        params: { id: KB_A },
      });
      const res = await (getKnowledgeBaseRoute as unknown as {
        handler: (c: unknown) => Promise<Response>;
      }).handler(ctx);
      const body = (await res.json()) as unknown;
      assertNotFound('case 4 getKnowledgeBase cross-workspace', res, body);

      const r = await verifyPool.query<{ name: string }>(
        `SELECT name FROM knowledge_bases WHERE id = $1`,
        [KB_A],
      );
      assert(
        'case 4 getKnowledgeBase: wA KB 行未被修改',
        r.rows.length === 1 && r.rows[0]!.name === 'kb-original',
        `name=${r.rows[0]?.name}`,
      );
    }

    // ────────────────────────────────────────────────────────────────────
    // Case 5: getDocumentRoute (GET /documents/:id)
    //   uB cookie + docA → 期望 404 + docA 行未变
    // ────────────────────────────────────────────────────────────────────
    {
      const ctx = makeCtx({
        method: 'GET',
        path: `/documents/${DOC_A}`,
        cookie,
        params: { id: DOC_A },
      });
      const res = await (getDocumentRoute as unknown as {
        handler: (c: unknown) => Promise<Response>;
      }).handler(ctx);
      const body = (await res.json()) as unknown;
      assertNotFound('case 5 getDocument cross-workspace', res, body);

      const r = await verifyPool.query<{ title: string; status: string }>(
        `SELECT title, status FROM documents WHERE id = $1`,
        [DOC_A],
      );
      assert(
        'case 5 getDocument: wA 文档行未被修改',
        r.rows.length === 1 &&
          r.rows[0]!.title === 'doc-original' &&
          r.rows[0]!.status === 'ready',
        `title=${r.rows[0]?.title}, status=${r.rows[0]?.status}`,
      );
    }

    // ────────────────────────────────────────────────────────────────────
    // Case 6: deleteDocumentRoute (DELETE /documents/:id)
    //   uB cookie + docA → 期望 404 + docA 行仍存在
    // ────────────────────────────────────────────────────────────────────
    {
      const ctx = makeCtx({
        method: 'DELETE',
        path: `/documents/${DOC_A}`,
        cookie,
        params: { id: DOC_A },
      });
      const res = await (deleteDocumentRoute as unknown as {
        handler: (c: unknown) => Promise<Response>;
      }).handler(ctx);
      const body = (await res.json()) as unknown;
      assertNotFound('case 6 deleteDocument cross-workspace', res, body);

      const r = await verifyPool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM documents WHERE id = $1`,
        [DOC_A],
      );
      assert(
        'case 6 deleteDocument: wA 文档行未被删除',
        r.rows[0]?.c === '1',
        `count=${r.rows[0]?.c}`,
      );
    }

    // ────────────────────────────────────────────────────────────────────
    // Case 7: stopMessageRoute (POST /messages/:id/stop)
    //   uB cookie + mAsstA → 期望 404 + 消息行未变（status 仍 'pending'）
    //   stop 路由在 workspace 校验失败时**不会**调用 abortExecution，所以
    //   内存里 mAsstA 的执行记录状态也不会被打扰。
    // ────────────────────────────────────────────────────────────────────
    {
      const ctx = makeCtx({
        method: 'POST',
        path: `/messages/${M_ASST_A}/stop`,
        cookie,
        params: { id: M_ASST_A },
      });
      const res = await (stopMessageRoute as unknown as {
        handler: (c: unknown) => Promise<Response>;
      }).handler(ctx);
      const body = (await res.json()) as unknown;
      assertNotFound('case 7 stopMessage cross-workspace', res, body);

      const r = await verifyPool.query<{ status: string; content: string }>(
        `SELECT status, content FROM messages WHERE id = $1`,
        [M_ASST_A],
      );
      assert(
        'case 7 stopMessage: wA 助手消息 status 未被 finalize 为 stopped',
        r.rows.length === 1 && r.rows[0]!.status === 'pending',
        `status=${r.rows[0]?.status}`,
      );
      assert(
        'case 7 stopMessage: wA 助手消息 content 未被覆写',
        r.rows.length === 1 && r.rows[0]!.content === 'hello there',
        `content=${r.rows[0]?.content}`,
      );
    }

    // ────────────────────────────────────────────────────────────────────
    // Case 8: regenerateMessageRoute (POST /messages/:assistantMessageId/regenerate)
    //   uB cookie + mAsstA → 期望 404 + 消息行未变（status 仍 'pending'）
    //   路由在 workspace 校验失败时**不会**触发 reserve-before-read，
    //   所以内存里 mAsstA 对应的 conversation 也不应该被预占。
    // ────────────────────────────────────────────────────────────────────
    {
      const ctx = makeCtx({
        method: 'POST',
        path: `/messages/${M_ASST_A}/regenerate`,
        cookie,
        params: { assistantMessageId: M_ASST_A },
      });
      const res = await (regenerateMessageRoute as unknown as {
        handler: (c: unknown) => Promise<Response>;
      }).handler(ctx);
      const body = (await res.json()) as unknown;
      assertNotFound('case 8 regenerateMessage cross-workspace', res, body);

      const r = await verifyPool.query<{ status: string; content: string }>(
        `SELECT status, content FROM messages WHERE id = $1`,
        [M_ASST_A],
      );
      assert(
        'case 8 regenerateMessage: wA 助手消息 status 未被 reset 为 pending',
        r.rows.length === 1 && r.rows[0]!.status === 'pending',
        `status=${r.rows[0]?.status}`,
      );
      assert(
        'case 8 regenerateMessage: wA 助手消息 content 未被清空',
        r.rows.length === 1 && r.rows[0]!.content === 'hello there',
        `content=${r.rows[0]?.content}`,
      );
    }

    // 防回归：uB 拿到的真实 workspaceId 与 wA 字面常量 W_A 不同，避免有人
    // 在未来误用 W_B 作为路由 ctx 注入的 workspaceId。
    assert(
      'sanity: uB 真实 workspaceId !== fixture 字面 W_A',
      wBRealWorkspaceId !== W_A,
      `wB=${wBRealWorkspaceId}`,
    );
    // 防回归：uB 真实 workspaceId 与 W_B 也不同——ensurePersonalWorkspace
    // 返回的是新建行（fixture 字面 W_B 仅用于建表归属关系）。这是为了
    // 显式证明"客户端无法伪造 workspaceId"，只走 cookie 解析出的服务端
    // 上下文。
    assert(
      'sanity: uB 真实 workspaceId !== fixture 字面 W_B',
      wBRealWorkspaceId !== W_B,
      `wB=${wBRealWorkspaceId}`,
    );

    await verifyPool.end().catch(() => {});
  } finally {
    await restoreGlobalPool(testPool);
    await dropIsolatedSchema(
      schema,
      new Pool({ connectionString: URL!, max: 1 }),
    );
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();