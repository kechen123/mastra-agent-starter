/**
 * workspace-context 集成测试（PR-1.1 修正第二轮）。
 *
 * 与上一版的差异（V2.3.6 修正 + 复核要求）：
 *   - **不再**在测试里手抄 workspaces / workspace_members schema；
 *     直接调用 `ensureSchema(pool)` 把项目唯一 `init.sql` 应用到隔离 schema。
 *     任何 schema 与应用代码的不一致都会被这一行直接抓住。
 *   - **所有**写数据库的操作（包含伪造 workspaceId 的端到端测试）都通过
 *     `assertTestDatabase()` 强制要求 `TEST_DATABASE_URL` 已设置 + 数据库名
 *     落在测试库允许列表 + 独享 schema。
 *   - 跨"全局池 + 路由 handler"的端到端测试（11、14）通过
 *     `__setTestPool()` 把全局池换成带 `search_path=schema,public` 的
 *     专用池 —— **不会**写 `public` 默认 schema。
 *   - 覆盖以下场景：
 *     1. 首次创建 Personal Workspace；
 *     2. 二次调用返回相同 ID（幂等）；
 *     3. 并发：两个独立连接同时为同一 userId 调用，返回相同 ID；
 *     4. Personal Workspace 的 owner_user_id 非空；
 *     5. Shared Workspace 写非空 owner_user_id 被 CHECK 拒绝；
 *     6. Personal Workspace 写空 owner_user_id 被 CHECK 拒绝；
 *     7. 同一 userId 插入第二个 Personal 被 partial unique 拒绝；
 *     8. 已有 Personal Workspace 但 owner 成员行缺失时自动补齐；
 *     9. 已有 Shared 成员关系时不把 Shared 当作 Personal；
 *     10. 用户不存在抛 UserNotFoundError；
 *     11. 真实 `/auth/me` 路由 handler 返回非空 workspaceId（走
 *         meRoute.handler()，全局池被换成测试池）；
 *     12. 登录时 `ensurePersonalWorkspace` 失败 → 不创建 Session
 *         （DI 注入失败 ensure，spy 验证 createSession 未被调用）；
 *     13. Personal owner 成员行 role 错误时自动修复为 'owner'；
 *     14. 伪造 X-Workspace-Id 头 / query / body 都被忽略（端到端，走
 *         `meRoute.handler()`）。
 *
 * 启用：`RUN_DB_TESTS=1 TEST_DATABASE_URL=postgres://.../<test_db>`；
 * 缺一直接跳过 / 抛错。`<test_db>` 必须在 `db-isolation.ts` 允许列表内
 * （`test_*` / `*_test` / 独立 `test`），由 `assertTestDatabase()` 真实
 * 连接并 `SELECT current_database()` 校验。
 *
 * 注意：本测试是**真实 Handler 级集成测试**，不是完整 HTTP 端到端。
 * 它直接调用 `meRoute.handler(fakeContext)`，绕过了 Mastra 的路由匹配
 * 与 LocalAuthProvider 的鉴权链；这意味着它验证了 `resolveAuthenticatedContext`
 * + `withAuthenticatedWorkspace` 的契约，但不验证 HTTP 框架层面（method
 * 路由 / middleware 顺序 / 鉴权失败的 401 模板）的行为。后者需要启动
 * 真实 HTTP server，受当前"不启动服务"约束限制，本轮未覆盖。
 */
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import {
  assertSearchPathIsolated,
  createIsolatedSchema,
  dropIsolatedSchema,
  withIsolatedSchema,
} from '../../src/test-utils/db-isolation.js';
import { ensureSchema } from '../../src/test-utils/schema-init.js';
import {
  __resetTestPool,
  __setTestPool,
  withGlobalPoolGuard,
} from '../../src/infrastructure/database/pool.js';

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

async function seedAppUser(
  client: PoolClient,
  id: string,
  username: string,
): Promise<void> {
  await client.query(
    `INSERT INTO app_users (id, username, username_normalized, password_hash)
     VALUES ($1, $2, $2, 'placeholder-hash-not-used')`,
    [id, username],
  );
}

/**
 * 把全局池换成 `search_path=schema,public` 的专用测试池。
 *
 * 调用方负责在 finally 里调 `restoreGlobalPool(testPool)` 收回。
 */
function installTestPool(schema: string): Pool {
  const testPool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
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

async function main(): Promise<void> {
  if (process.env.RUN_DB_TESTS !== '1') {
    console.log(
      'SKIPPED: 设置 RUN_DB_TESTS=1 + TEST_DATABASE_URL 后才会真正连库执行。',
    );
    return;
  }

  const {
    ensurePersonalWorkspace,
    UserNotFoundError,
    WorkspaceIntegrityError,
  } = await import('../../src/modules/auth/workspace-context.js');

  // ===========================================================================
  // (1)(2)(4) 首次创建 + 幂等 + owner_user_id 非空
  // ===========================================================================
  await withIsolatedSchema(async ({ client, pool }) => {
    await ensureSchema(pool);
    await seedAppUser(client, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alice');

    const first = await ensurePersonalWorkspace(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      client,
    );
    assert(
      'create: 返回非空 workspaceId',
      typeof first.workspaceId === 'string' && first.workspaceId.length > 0,
    );

    const row = await client.query<{
      owner: string;
      kind: string;
      name: string;
      role: string;
    }>(
      `SELECT w.owner_user_id::text AS owner, w.kind, w.name, m.role
         FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
        WHERE w.id = $1`,
      [first.workspaceId],
    );
    assert('create: workspace + owner 成员行已建', row.rows.length === 1);
    assert(
      'create: owner_user_id 等于 userId',
      row.rows[0]?.owner === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    );
    assert('create: kind = personal', row.rows[0]?.kind === 'personal');
    assert('create: name = "personal"', row.rows[0]?.name === 'personal');
    assert('create: 成员角色 = owner', row.rows[0]?.role === 'owner');

    const second = await ensurePersonalWorkspace(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      client,
    );
    assert(
      'idempotent: 二次调用返回相同 workspaceId',
      second.workspaceId === first.workspaceId,
    );
    const count = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM workspace_members WHERE user_id = $1`,
      ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
    );
    assert(
      'idempotent: workspace_members 只 1 行（幂等不重复）',
      count.rows[0]?.c === '1',
    );
    const wsCount = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM workspaces WHERE owner_user_id = $1 AND kind = 'personal'`,
      ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
    );
    assert(
      'idempotent: workspaces 表该 userId 只有 1 个 personal',
      wsCount.rows[0]?.c === '1',
    );
  });

  // ===========================================================================
  // (3) 并发安全：两个独立连接同时为同一 userId 调用
  //     schema 已建好（独立 schema），但不开事务——并发事务需要彼此看到
  //     已提交的数据；用 `installTestPool` 让全局池 / 两个并发调用都看到
  //     同一个 schema。
  // ===========================================================================
  {
    const { schema, pool: setupPool } = await createIsolatedSchema();
    const setupClient = await setupPool.connect();
    try {
      await ensureSchema(setupPool);
      await seedAppUser(setupClient, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bob');
    } finally {
      setupClient.release();
    }
    await setupPool.end();

    const concurrentPool = installTestPool(schema);
    try {
      const [a, b] = await Promise.all([
        ensurePersonalWorkspace('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
        ensurePersonalWorkspace('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
      ]);
      assert(
        'concurrent: 两次调用返回相同 workspaceId',
        a.workspaceId === b.workspaceId,
        `a=${a.workspaceId} b=${b.workspaceId}`,
      );

      const verifyPool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 1,
        options: `-c search_path=${schema},public`,
      });
      const v = await verifyPool.connect();
      try {
        const wsCount = await v.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM workspaces WHERE owner_user_id = $1 AND kind = 'personal'`,
          ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
        );
        assert(
          'concurrent: workspaces 表该 userId 只有 1 行 personal',
          wsCount.rows[0]?.c === '1',
          `got ${wsCount.rows[0]?.c}`,
        );
        const memberCount = await v.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM workspace_members WHERE user_id = $1`,
          ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
        );
        assert(
          'concurrent: workspace_members 该 userId 只有 1 行 owner',
          memberCount.rows[0]?.c === '1',
          `got ${memberCount.rows[0]?.c}`,
        );
      } finally {
        v.release();
        await verifyPool.end();
      }
    } finally {
      await restoreGlobalPool(concurrentPool);
      await dropIsolatedSchema(
        schema,
        new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }),
      );
    }
  }

  // ===========================================================================
  // (5)(6) CHECK 约束：shared + owner / personal + null
  // ===========================================================================
  await withIsolatedSchema(async ({ client, pool }) => {
    await ensureSchema(pool);
    await seedAppUser(client, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'carol');

    let sharedErr: unknown = null;
    await client.query('SAVEPOINT sp5');
    try {
      await client.query(
        `INSERT INTO workspaces (kind, name, owner_user_id)
         VALUES ('shared', 's', 'cccccccc-cccc-cccc-cccc-cccccccccccc')`,
      );
      await client.query('RELEASE SAVEPOINT sp5');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp5');
      sharedErr = err;
    }
    assert(
      'check: shared + non-null owner_user_id 被 CHECK 拒绝',
      sharedErr instanceof Error && /check/i.test(sharedErr.message),
      sharedErr instanceof Error ? sharedErr.message : 'no error',
    );

    let personalErr: unknown = null;
    await client.query('SAVEPOINT sp6');
    try {
      await client.query(
        `INSERT INTO workspaces (kind, name, owner_user_id)
         VALUES ('personal', 'p', NULL)`,
      );
      await client.query('RELEASE SAVEPOINT sp6');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp6');
      personalErr = err;
    }
    assert(
      'check: personal + null owner_user_id 被 CHECK 拒绝',
      personalErr instanceof Error && /check/i.test(personalErr.message),
      personalErr instanceof Error ? personalErr.message : 'no error',
    );
  });

  // ===========================================================================
  // (7) partial unique: 同一 userId 第二个 personal 被 unique 拒绝
  // ===========================================================================
  await withIsolatedSchema(async ({ client, pool }) => {
    await ensureSchema(pool);
    await seedAppUser(client, 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'dave');
    const { workspaceId } = await ensurePersonalWorkspace(
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
      client,
    );
    let dupErr: unknown = null;
    try {
      await client.query(
        `INSERT INTO workspaces (kind, name, owner_user_id)
         VALUES ('personal', 'dup', 'dddddddd-dddd-dddd-dddd-dddddddddddd')`,
      );
    } catch (err) {
      dupErr = err;
    }
    assert(
      'unique: 同 userId 第二个 personal 被 unique 索引拒绝',
      dupErr instanceof Error && /unique|duplicate/i.test(dupErr.message),
      dupErr instanceof Error ? dupErr.message : 'no error',
    );
    assert(
      'unique: ensure 仍然返回原 workspaceId',
      typeof workspaceId === 'string' && workspaceId.length > 0,
    );
  });

  // ===========================================================================
  // (8) 修复缺失的 owner 成员行
  // ===========================================================================
  await withIsolatedSchema(async ({ client, pool }) => {
    await ensureSchema(pool);
    await seedAppUser(client, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'erin');
    await client.query(
      `INSERT INTO workspaces (kind, name, owner_user_id)
       VALUES ('personal', 'personal', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')`,
    );
    const memberBefore = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM workspace_members WHERE user_id = $1`,
      ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'],
    );
    assert(
      'repair-missing: 起始状态 — owner 成员行缺失',
      memberBefore.rows[0]?.c === '0',
    );
    const ensured = await ensurePersonalWorkspace(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      client,
    );
    assert(
      'repair-missing: ensure 返回有效 workspaceId',
      typeof ensured.workspaceId === 'string' && ensured.workspaceId.length > 0,
    );
    const memberAfter = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM workspace_members WHERE user_id = $1 AND role = 'owner'`,
      ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'],
    );
    assert(
      'repair-missing: owner 成员行已补齐',
      memberAfter.rows[0]?.c === '1',
      `got ${memberAfter.rows[0]?.c}`,
    );
  });

  // ===========================================================================
  // (9) 已有 Shared 成员关系 — ensurePersonalWorkspace 不返回 Shared ID
  // ===========================================================================
  await withIsolatedSchema(async ({ client, pool }) => {
    await ensureSchema(pool);
    await seedAppUser(client, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'frank');
    const shared = await client.query<{ id: string }>(
      `INSERT INTO workspaces (kind, name, owner_user_id)
       VALUES ('shared', 'shared-room', NULL)
       RETURNING id`,
    );
    const sharedId = shared.rows[0]?.id;
    if (!sharedId) throw new Error('test setup: failed to insert shared');
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [sharedId, 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
    );
    const ensured = await ensurePersonalWorkspace(
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      client,
    );
    assert(
      'shared-not-personal: ensure 不会返回 shared workspace 的 ID',
      ensured.workspaceId !== sharedId,
    );
    const personalCount = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM workspaces WHERE owner_user_id = $1 AND kind = 'personal'`,
      ['ffffffff-ffff-ffff-ffff-ffffffffffff'],
    );
    assert(
      'shared-not-personal: 该 userId 现在有 1 个 personal',
      personalCount.rows[0]?.c === '1',
    );
  });

  // ===========================================================================
  // (10) 用户不存在 / 被禁用 → UserNotFoundError
  // ===========================================================================
  await withIsolatedSchema(async ({ client, pool }) => {
    await ensureSchema(pool);
    try {
      await ensurePersonalWorkspace(
        '99999999-9999-9999-9999-999999999999',
        client,
      );
      assert('user-missing: 应当抛错', false);
    } catch (err) {
      assert(
        'user-missing: 抛 UserNotFoundError',
        err instanceof UserNotFoundError,
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  // ===========================================================================
  // (11) `/auth/me` Handler 级集成测试：返回非空 workspaceId
  //      走真实 handler + 真实 `resolveSession` + 真实 `ensurePersonalWorkspace`。
  //      全局池被换成 `search_path=schema,public` 的专用测试池——
  //      **不**触碰默认 public。
  //
  // **Handler级集成测试 ≠ HTTP 端到端测试。** 本测试直接调用
  //   `meRoute.handler(fakeContext)`，**不**经过：
  //     - Mastra 路由匹配层（path → handler 映射、method 校验）；
  //     - LocalAuthProvider 的 `authenticateToken()` / `authorizeUser()`
  //       middleware 链；
  //     - 真实 HTTP server 的 socket / keep-alive / TLS / Cookie 序列化。
  //   它能证明：路由 handler 拿到 cookie → resolveSession → ensurePersonalWorkspace
  //   → 注入非空 workspaceId 上下文 → 返回正确 JSON。但**不能**证明真实
  //   HTTP 请求会得到相同结果——method 路由、CORS、Cookie Secure、middleware
  //   顺序等都会被绕过。
  //   完整 E2E 需启动 `mastra dev` / `mastra start` 并用 supertest / fetch 命中
  //   `http://localhost:<port>/auth/me`，受本轮"不启动服务"约束未覆盖。
  // ===========================================================================
  {
    const { meRoute } = await import('../../src/server/routes/auth.js');
    const { createSession } = await import(
      '../../src/infrastructure/auth/session.js'
    );
    const { hashPassword } = await import(
      '../../src/infrastructure/auth/password.js'
    );
    const { serializeSessionCookie, getResolvedAuthConfig } = await import(
      '../../src/infrastructure/auth/request.js'
    );

    const userId = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1';
    const { schema, pool: setupPool } = await createIsolatedSchema();
    const setupClient = await setupPool.connect();
    let realWorkspaceId = '';
    let token = '';
    try {
      // 回归守卫：先确认 setupClient 确实落在隔离 schema，再做任何写入。
      // 若 createIsolatedSchema 漏挂 search_path，这里会直接抛错，
      // 行不会被悄悄写到 public。
      await assertSearchPathIsolated(setupClient, schema);
      // 先跑 ensureSchema（建 app_users / auth_sessions / workspaces 等表），
      // 再插用户——保证后续 insert 命中本 schema 的同名表，不会落到 public。
      await ensureSchema(setupPool);
      const hashed = await hashPassword('correct horse battery staple');
      await setupClient.query(
        `INSERT INTO app_users (id, username, username_normalized, password_hash)
         VALUES ($1, 'hank-rt', 'hank-rt', $2)`,
        [userId, hashed],
      );
    } finally {
      setupClient.release();
    }

    const testPool = installTestPool(schema);
    try {
      // 跨 fixture 串扰防御：把"installTestPool + 走全局池的工作 +
      // restoreGlobalPool"整段放进 withGlobalPoolGuard，避免与
      // isolation-contract.ts 等使用 __setTestPool 的 fixture 并发跑
      // 时，对方把全局池抢走、本测试的 createSession INSERT 落到对方的
      // schema、auth_sessions_user_id_fkey 拒绝（典型症状：全套一起跑
      // 时偶现 `insert or update on table "auth_sessions" violates
      // foreign key constraint "auth_sessions_user_id_fkey"`，单跑
      // workspace-context.ts 不出现）。
      await withGlobalPoolGuard(async () => {
        const ensured = await ensurePersonalWorkspace(userId);
        realWorkspaceId = ensured.workspaceId;
        const { ttlDays } = getResolvedAuthConfig();
        const created = await createSession({ userId, ttlDays });
        token = created.token;

        const cookie = serializeSessionCookie(token, 60 * 60);

        // (a) 真实路由 /auth/me —— 带 cookie
        const req = new Request('http://localhost/auth/me', {
          method: 'GET',
          headers: { Cookie: cookie },
        });
        const fakeContext = {
          req: {
            raw: req,
            header: (n: string) => req.headers.get(n) ?? undefined,
          },
          json: (data: unknown, status?: number) =>
            new Response(JSON.stringify(data), {
              status: status ?? 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        };
        const res = await meRoute.handler(fakeContext as never);
        assert('me-route: 状态码 200', res.status === 200, `got ${res.status}`);
        const body = (await res.json()) as {
          user?: { id?: string; workspaceId?: string };
        };
        assert(
          'me-route: 返回 user.workspaceId 非空',
          typeof body.user?.workspaceId === 'string' &&
            body.user.workspaceId.length > 0,
          `got ${body.user?.workspaceId}`,
        );
        assert(
          'me-route: workspaceId 等于 ensure 创建的真实 ID',
          body.user?.workspaceId === realWorkspaceId,
          `expected ${realWorkspaceId}, got ${body.user?.workspaceId}`,
        );
        assert('me-route: userId 等于登录用户', body.user?.id === userId);

        // (b) 无 cookie → 401
        const noCookieRequest = new Request('http://localhost/auth/me', {
          method: 'GET',
        });
        const noCookieContext = {
          req: {
            raw: noCookieRequest,
            header: () => undefined,
          },
          json: (data: unknown, status?: number) =>
            new Response(JSON.stringify(data), {
              status: status ?? 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        };
        const resNoCookie = await meRoute.handler(noCookieContext as never);
        assert('me-route: 无 cookie → 401', resNoCookie.status === 401);
      });
    } finally {
      await restoreGlobalPool(testPool);
      await dropIsolatedSchema(
        schema,
        new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }),
      );
    }
  }

  // ===========================================================================
  // (12) 登录时 ensure 失败 → 不创建 Session
  //      通过 DI 注入失败 ensure，spy 验证 createSession 未被调用。
  //      同时验证 auth_sessions 表里没有该 userId 的行。
  // ===========================================================================
  {
    const { login } = await import('../../src/modules/auth/service.js');
    const { hashPassword } = await import(
      '../../src/infrastructure/auth/password.js'
    );

    const userId = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2';
    const username = 'iris-rt';
    const password = 'correct horse battery staple';

    const { schema, pool: setupPool } = await createIsolatedSchema();
    const setupClient = await setupPool.connect();
    try {
      // 回归守卫 + 先跑迁移：与 (11)/(14) 一致。
      await assertSearchPathIsolated(setupClient, schema);
      await ensureSchema(setupPool);
      const hashed = await hashPassword(password);
      await setupClient.query(
        `INSERT INTO app_users (id, username, username_normalized, password_hash)
         VALUES ($1, $2, $2, $3)`,
        [userId, username, hashed],
      );
    } finally {
      setupClient.release();
    }

    const testPool = installTestPool(schema);
    try {
      // 跨 fixture 串扰防御（与 (11) 同因）：见 (11) 处注释。
      await withGlobalPoolGuard(async () => {
        let createSessionCalls = 0;
        const failingEnsure = async (id: string) => {
          if (id === userId) {
            throw new WorkspaceIntegrityError(
              `测试注入：ensure 故意失败 for ${id}`,
            );
          }
          throw new Error('unexpected userId in failingEnsure');
        };
        const spyCreateSession = async (args: {
          userId: string;
          ttlDays: number;
        }) => {
          createSessionCalls += 1;
          return {
            token: 'spy-token',
            expiresAt: new Date(Date.now() + args.ttlDays * 86400_000),
          };
        };

        let loginFailed = false;
        let loginError: unknown = null;
        try {
          await login(
            { rawUsername: username, rawPassword: password },
            { ensurePersonalWorkspace: failingEnsure, createSession: spyCreateSession },
          );
        } catch (err) {
          loginFailed = true;
          loginError = err;
        }
        assert(
          'login: ensure 抛错时 login() 也抛错',
          loginFailed,
        );
        assert(
          'login: 抛出的错误是 WorkspaceIntegrityError',
          loginError instanceof WorkspaceIntegrityError,
          loginError instanceof Error ? loginError.message : String(loginError),
        );
        assert(
          'login: createSession 从未被调用',
          createSessionCalls === 0,
          `spy 被调用 ${createSessionCalls} 次`,
        );

        // 验证 auth_sessions 表里没有该 userId 的行（彻底排除"半提交"可能）
        const verifyPool = new Pool({
          connectionString: process.env.TEST_DATABASE_URL,
          max: 1,
          options: `-c search_path=${schema},public`,
        });
        const v = await verifyPool.connect();
        try {
          const sessionCount = await v.query<{ c: string }>(
            `SELECT count(*)::text AS c FROM auth_sessions WHERE user_id = $1`,
            [userId],
          );
          assert(
            'login: auth_sessions 表该 userId 0 行（无悬空 Session）',
            sessionCount.rows[0]?.c === '0',
            `got ${sessionCount.rows[0]?.c}`,
          );
        } finally {
          v.release();
          await verifyPool.end();
        }
      });
    } finally {
      await restoreGlobalPool(testPool);
      await dropIsolatedSchema(
        schema,
        new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }),
      );
    }
  }

  // ===========================================================================
  // (13) Personal owner 成员行 role 错误时自动修复为 'owner'
  // ===========================================================================
  await withIsolatedSchema(async ({ client, pool }) => {
    await ensureSchema(pool);
    await seedAppUser(client, 'd3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3', 'dora');
    const ws = await client.query<{ id: string }>(
      `INSERT INTO workspaces (kind, name, owner_user_id)
       VALUES ('personal', 'personal', 'd3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3')
       RETURNING id`,
    );
    const wsId = ws.rows[0]?.id;
    if (!wsId) throw new Error('setup failed');
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, 'd3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3', 'member')`,
      [wsId],
    );
    const before = await client.query<{ role: string }>(
      `SELECT role FROM workspace_members
        WHERE user_id = 'd3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3'`,
    );
    assert('role-repair: 起始 role = member', before.rows[0]?.role === 'member');
    const ensured = await ensurePersonalWorkspace(
      'd3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3',
      client,
    );
    assert('role-repair: ensure 返回相同 workspaceId', ensured.workspaceId === wsId);
    const after = await client.query<{ role: string }>(
      `SELECT role FROM workspace_members
        WHERE user_id = 'd3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3'`,
    );
    assert(
      'role-repair: 错误 role 被自动修复为 owner',
      after.rows[0]?.role === 'owner',
      `got ${after.rows[0]?.role}`,
    );
  });

  // ===========================================================================
  // (14) 伪造 X-Workspace-Id 头 / query / body 都被忽略（Handler 级 /auth/me）
  //
  // 走真实路由 meRoute.handler()。全局池换成测试池——不写 public。
  //
  // **重要：这是 Handler 级集成测试，不是完整 HTTP 端到端。**
  //   - 本测试直接调用 `meRoute.handler(fakeContext)`，绕过了 Mastra 的
  //     路由匹配（path → handler 映射 + method 校验）与 LocalAuthProvider 的
  //     鉴权链；只验证 `resolveAuthenticatedContext` + `withAuthenticatedWorkspace`
  //     + `meRoute` 内部逻辑的契约。
  //   - **不能**等同于"启动 HTTP server 后用 curl / supertest 调 /auth/me"。
  //     后者还会覆盖：路由 method 匹配、404 / 405 模板、未鉴权 401 模板、
  //     Cookie SameSite / Secure 行为、CORS preflight 等。
  //
  // 子用例 (c) 的 POST-to-GET 限制：
  //   `/auth/me` 只注册了 `method: 'GET'`。本测试用 `method: 'POST'` 直接调用
  //   `meRoute.handler()`，这只能证明：
  //     - `resolveAuthenticatedContext()` 不读取 body（POST 体的 `workspaceId`
  //       不会污染 session 解析出的真实 workspaceId）；
  //     - `withAuthenticatedWorkspace` 包装器拿到 cookie 后能正确返回。
  //   它**不能**证明"真实路由会接受 POST"——Mastra 的 method 路由在
  //   registerApiRoute 阶段就拒收 POST， handler 根本不会被调用。
  //   真实 method 校验需要启动 HTTP server，受"不启动服务"约束限制。
  // ===========================================================================
  {
    const { meRoute } = await import('../../src/server/routes/auth.js');
    const { createSession } = await import(
      '../../src/infrastructure/auth/session.js'
    );
    const { hashPassword } = await import(
      '../../src/infrastructure/auth/password.js'
    );
    const { serializeSessionCookie, getResolvedAuthConfig } = await import(
      '../../src/infrastructure/auth/request.js'
    );

    const userId = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3';
    const { schema, pool: setupPool } = await createIsolatedSchema();
    const setupClient = await setupPool.connect();
    let realWorkspaceId = '';
    let token = '';
    try {
      // 回归守卫：先确认 setupClient 确实落在隔离 schema，再做任何写入。
      // 若 createIsolatedSchema 漏挂 search_path，这里会直接抛错，
      // 行不会被悄悄写到 public。
      await assertSearchPathIsolated(setupClient, schema);
      // 先跑 ensureSchema（建 app_users / auth_sessions / workspaces 等表），
      // 再插用户——保证后续 insert 命中本 schema 的同名表，不会落到 public。
      await ensureSchema(setupPool);
      const hashed = await hashPassword('correct horse battery staple');
      await setupClient.query(
        `INSERT INTO app_users (id, username, username_normalized, password_hash)
         VALUES ($1, 'john-rt', 'john-rt', $2)`,
        [userId, hashed],
      );
    } finally {
      setupClient.release();
    }

    const testPool = installTestPool(schema);
    try {
      // 跨 fixture 串扰防御（与 (11) 同因）：见 (11) 处注释。
      await withGlobalPoolGuard(async () => {
        const ensured = await ensurePersonalWorkspace(userId);
        realWorkspaceId = ensured.workspaceId;
        const { ttlDays } = getResolvedAuthConfig();
        const created = await createSession({ userId, ttlDays });
        token = created.token;

        const cookie = serializeSessionCookie(token, 60 * 60);
        const forgedId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

        const fakeJson = (data: unknown, status?: number) =>
          new Response(JSON.stringify(data), {
            status: status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          });

        // (a) X-Workspace-Id header 伪造
        const req = new Request('http://localhost/auth/me', {
          method: 'GET',
          headers: { Cookie: cookie, 'X-Workspace-Id': forgedId },
        });
        const ctx = {
          req: { raw: req, header: (n: string) => req.headers.get(n) ?? undefined },
          json: fakeJson,
        };
        const res = await meRoute.handler(ctx as never);
        const body = (await res.json()) as { user?: { workspaceId?: string } };
        assert('forged-header: 状态码 200', res.status === 200);
        assert(
          'forged-header: 伪造 X-Workspace-Id 不覆盖真实 workspaceId',
          body.user?.workspaceId === realWorkspaceId,
          `expected ${realWorkspaceId}, got ${body.user?.workspaceId}`,
        );

        // (b) query string 伪造
        const req2 = new Request(
          `http://localhost/auth/me?workspaceId=${forgedId}`,
          { method: 'GET', headers: { Cookie: cookie } },
        );
        const ctx2 = {
          req: {
            raw: req2,
            header: (n: string) => req2.headers.get(n) ?? undefined,
          },
          json: fakeJson,
        };
        const res2 = await meRoute.handler(ctx2 as never);
        const body2 = (await res2.json()) as { user?: { workspaceId?: string } };
        assert(
          'forged-query: query 里的 workspaceId 不被采纳',
          body2.user?.workspaceId === realWorkspaceId,
          `expected ${realWorkspaceId}, got ${body2.user?.workspaceId}`,
        );

        // (c) body 中伪造（POST 也走同一路径）
        const req3 = new Request('http://localhost/auth/me', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: forgedId }),
        });
        const ctx3 = {
          req: {
            raw: req3,
            header: (n: string) => req3.headers.get(n) ?? undefined,
          },
          json: fakeJson,
        };
        const res3 = await meRoute.handler(ctx3 as never);
        const body3 = (await res3.json()) as { user?: { workspaceId?: string } };
        assert(
          'forged-body: POST body 里的 workspaceId 不被采纳',
          body3.user?.workspaceId === realWorkspaceId,
          `expected ${realWorkspaceId}, got ${body3.user?.workspaceId}`,
        );

        // (d) 无 session → 401
        const req4 = new Request('http://localhost/auth/me', { method: 'GET' });
        const ctx4 = {
          req: { raw: req4, header: () => undefined },
          json: fakeJson,
        };
        const res4 = await meRoute.handler(ctx4 as never);
        assert('no-cookie: 无 session → 401', res4.status === 401);
      });
    } finally {
      await restoreGlobalPool(testPool);
      await dropIsolatedSchema(
        schema,
        new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }),
      );
    }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    throw new Error(`workspace-context 失败 ${failed} 项断言`);
  }
}

// Top-level await —— 不调用 process.exit，让 npm run test:integration 继续
// import 后续 fixture；任一 fixture 失败向上 throw，被 runner 接住 → 进程 exit 1。
await main();