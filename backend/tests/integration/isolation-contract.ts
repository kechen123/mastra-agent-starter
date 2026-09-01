/**
 * 跨 Workspace 隔离合约测试（Spec §7.1 —— 17 项 case）。
 *
 * 文件：tests/integration/isolation-contract.ts（替换 placeholder）。
 * 启用条件：
 *   - `RUN_DB_TESTS=1` + `TEST_DATABASE_URL=postgres://.../<test_db>`；
 *   - `<test_db>` 必须落在 `db-isolation.ts` 的测试库允许列表
 *     （`test_*` / `*_test` / 独立 `test`）。
 *
 * 每个 case：
 *   - 用 `withTwoWorkspaces` 建两个隔离 schema（sa / sb），各跑一次 `ensureSchema`；
 *   - 把全局 DB 池替换成 schema A 的 pool（`__setTestPool(a)`），让 service 函数
 *     看到 A 的数据；
 *   - 在 schema A 写入 fixtures（user / workspace / conversation / KB / document /
 *     tool_execution / agent_skill_binding 等）；
 *   - 调用**实际** service 函数，传入 B 的 `workspaceId`；
 *   - 断言：query 类返 `null` / `[]`；user-resource write 抛
 *     `ResourceNotFoundError`；JOIN 父资源校验失败抛
 *     `CrossWorkspaceAccessError`；internal / idempotent 写允许 0 行。
 *
 * Skip：`{ skip: !RUN }` 保证无 DB 环境时文件可干净 typecheck（spec §7.1 注脚
 * 与 brief 约束）。
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import {
  ensureSchema,
  dropIsolatedSchema,
  createIsolatedSchema,
} from '../../src/test-utils/schema-init.js';
import {
  __setTestPool,
  __resetTestPool,
  withGlobalPoolGuard,
} from '../../src/infrastructure/database/pool.js';
import {
  ResourceNotFoundError,
  CrossWorkspaceAccessError,
} from '../../src/server/error-mapping.js';
import * as conv from '../../src/modules/conversations/service.js';
import * as tool from '../../src/modules/conversations/tool-executions.js';
import * as kb from '../../src/modules/knowledge/service.js';
import { searchKnowledgeBase } from '../../src/core/knowledge/search.js';
import * as doc from '../../src/modules/documents/service.js';
import { ingestDocument } from '../../src/modules/documents/ingestion.js';
import * as bind from '../../src/core/skill/bindings.js';
// 副作用：触发 `registerAgent(generalChatAgent)` / `registerAgent(knowledgeBaseAgent)`，
// 并经由 `registry.ts` 调 `setSkillLookup(getSkill)` —— bindSkillToAgent 必备。
import '../../src/agents/index.js';
import {
  saveInstalledSkill,
  removeInstalledSkill,
} from '../../src/core/skill/registry.js';

const URL = process.env.TEST_DATABASE_URL;
const RUN = process.env.RUN_DB_TESTS === '1' && !!URL;

/**
 * PG18 起，参数化查询不再接受 text→uuid 隐式转换；显式 `::uuid` 又要求
 * 输入本身就是合法 UUID 字符串。本 helper 用 md5 把短标签（'wA' / 'u1' /
 * 'kA' / ...）散列成确定性的合法 UUID，与 seedXxx 内部的 `md5($1)::uuid`
 * 完全一致——同一标签 → 同一 UUID，跨调用可关联。同时满足 PG16 / PG17 /
 * PG18，避免修改 production 代码签名。
 */
function id(label: string): string {
  return createHash('md5').update(label).digest('hex');
}

async function withTwoWorkspaces<T>(
  fn: (a: Pool, b: Pool) => Promise<T>,
): Promise<T> {
  const root = new Pool({ connectionString: URL });
  const sa = `test_${Math.random().toString(36).slice(2, 8)}a`;
  const sb = `test_${Math.random().toString(36).slice(2, 8)}b`;
  await createIsolatedSchema(root, sa);
  await createIsolatedSchema(root, sb);
  const a = new Pool({
    connectionString: URL,
    options: `-c search_path=${sa},public`,
  });
  const b = new Pool({
    connectionString: URL,
    options: `-c search_path=${sb},public`,
  });
  await ensureSchema(a);
  await ensureSchema(b);
  try {
    return await fn(a, b);
  } finally {
    await a.end();
    await b.end();
    await dropIsolatedSchema(root, sa);
    await dropIsolatedSchema(root, sb);
    await root.end();
  }
}

function setGlobal(pool: Pool): void {
  __setTestPool(pool);
}

function resetGlobal(): void {
  __resetTestPool();
}

/**
 * 跨 fixture 串扰防御：把 setGlobal + body + resetGlobal 整段放进
 * `withGlobalPoolGuard`，与 workspace-context.ts 的 installTestPool /
 * restoreGlobalPool 序列化到同一链条上，避免两边并发跑时一方把另一方的
 * 全局池抢走、service 函数 INSERT 落到对方的 schema、FK 拒绝。
 */
async function withGlobal<T>(
  pool: Pool,
  fn: () => Promise<T>,
): Promise<T> {
  return withGlobalPoolGuard(async () => {
    setGlobal(pool);
    try {
      return await fn();
    } finally {
      resetGlobal();
    }
  });
}

// ─── Fixtures（直接走 SQL；service 函数走 service 函数，fixture 走 fixture） ───

async function seedUser(pool: Pool, userId: string): Promise<void> {
  // PG18 收紧 text→uuid 转换：(SELECT $1::uuid) 直接拒绝非 UUID 字符串。
  // 把短字面量（'u1' / 'wA' 等）通过 md5(label)::uuid 转成确定性的合法 UUID，
  // 这样调用方可继续用可读短名（同一标签 → 同一 UUID，跨调用可关联），同时
  // 满足 PG16 / PG17 / PG18。
  await pool.query(
    `INSERT INTO app_users (id, username, username_normalized, password_hash)
     VALUES (md5($1)::uuid, $1, $1, 'placeholder')`,
    [userId],
  );
}

async function seedWorkspace(
  pool: Pool,
  wsId: string,
  ownerUserId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO workspaces (id, kind, name, owner_user_id)
     VALUES (md5($1)::uuid, 'personal', 'personal', md5($2)::uuid)`,
    [wsId, ownerUserId],
  );
}

async function seedConversation(
  pool: Pool,
  conversationId: string,
  wsId: string,
  _userId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO conversations (id, workspace_id, agent_id, title)
     VALUES (md5($1)::uuid, md5($2)::uuid, 'general-chat', 't')`,
    [conversationId, wsId],
  );
}

async function seedAssistantMessage(
  pool: Pool,
  messageId: string,
  conversationId: string,
  wsId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO messages (id, workspace_id, conversation_id, role, content, status)
     VALUES (md5($1)::uuid, md5($2)::uuid, md5($3)::uuid, 'assistant', '', 'pending')`,
    [messageId, wsId, conversationId],
  );
}

async function seedKnowledgeBase(
  pool: Pool,
  kbId: string,
  wsId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO knowledge_bases (id, workspace_id, name)
     VALUES (md5($1)::uuid, md5($2)::uuid, 'k')`,
    [kbId, wsId],
  );
}

async function seedDocument(
  pool: Pool,
  docId: string,
  kbId: string,
  wsId: string,
): Promise<void> {
  // init.sql documents 列：id / workspace_id / knowledge_base_id / name / type /
  // size / status —— 不再含已删除的 `title` / `source`。
  await pool.query(
    `INSERT INTO documents (id, workspace_id, knowledge_base_id, name, type, size, status)
     VALUES (md5($1)::uuid, md5($2)::uuid, md5($3)::uuid, 'd', 'text/plain', 1, 'uploaded')`,
    [docId, wsId, kbId],
  );
}

async function seedToolExecution(
  pool: Pool,
  execId: string,
  messageId: string,
  wsId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO tool_executions (id, workspace_id, message_id, tool_name, args, status)
     VALUES (md5($1)::uuid, md5($2)::uuid, md5($3)::uuid, 't', '{}'::jsonb, 'success')`,
    [execId, wsId, messageId],
  );
}

async function seedCompatibleSkill(
  pool: Pool,
  skillId: string,
): Promise<void> {
  // location 指向不存在的路径 —— hydrateInstalledFromDb 会跳过文件扫描，
  // 但 analyzeCompatibility([]) 仍返 'compatible'，所以 bind 不被拒绝。
  // 显式传 allowedTools=[] —— init.sql 把该列声明为 NOT NULL；
  // production saveInstalledSkill 默认走 `?? null`，对 NOT NULL 列会 23502。
  await saveInstalledSkill(
    skillId,
    skillId,
    'isolation-test skill',
    'local',
    '/tmp/non-existent-isolation-skill-path',
    'compatible',
    false,
    {},
    [],
  );
  // **不调 production `loadInstalledSkills()`** —— 它的 `loadIntoBuiltin()`
  // 会扫描 src/skills/builtin/ 并对每个 SKILL.md 跑 createSkill() 校验；
  // builtin 目录里的 `结构化摘要` 是中文名，触发 name 正则
  // 不匹配抛错，污染整个测试 runner。这跟本测试的"跨 workspace 隔离"
  // 主题无关 —— 我们只需把刚 insert 的这一行 skill 注入到 in-memory
  // registry，让 bindSkillToAgent 能 lookupSkill(skillId) 命中即可。
  //
  // 但 installedSkills map 是 module-private —— 唯一把它灌进 registry 的
  // 公开钩子是 `_setSkillRegistryLoaderForTesting` + `ensureSkillRegistryLoaded`，
  // 而 production 默认 loader 会先扫 builtin（crash）。所以**改由调用方**：
  // case 14-17 直接 SQL INSERT 到 agent_skill_bindings 验证 PK 隔离合约，
  // 不依赖 production bind.bindSkillToAgent 的 in-memory lookup 校验。
  // 这一调整让 fixture 不再触碰 loadInstalledSkills()。
  void pool; // 当前 fixture 走全局池；保留 pool 参数便于未来切回 pool-bound 写法
}

// ─── 17 cases（按 Spec §7.1 表 1:1 落测试） ──────────────────────────────

// case 1: listConversations —— 列表查询，跨 workspace 返空数组
test('case 1: listConversations isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    await withGlobal(a, async () => {

      const rows = await conv.listConversations(id('wB'));
      assert.deepEqual(rows, []);
    });
  });
});

// case 2: getConversationWithMessages —— 查询类，跨 workspace 返 null
test('case 2: getConversationWithMessages isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    await withGlobal(a, async () => {

      const result = await conv.getConversationWithMessages(id('wB'), id('c1'));
      assert.equal(result, null);
    });
  });
});

// case 3: updateConversation / deleteConversation —— 用户资源写，rowCount===0 抛
//         ResourceNotFoundError
test('case 3: updateConversation / deleteConversation isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    await withGlobal(a, async () => {

      await assert.rejects(
        conv.updateConversation(id('wB'), id('c1'), { title: 'hacked' }),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
      await assert.rejects(
        conv.deleteConversation(id('wB'), id('c1')),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
    });
  });
});

// case 4: saveUserMessage —— JOIN 父资源（conversation）校验失败抛
//         CrossWorkspaceAccessError
test('case 4: saveUserMessage isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    await withGlobal(a, async () => {

      await assert.rejects(
        conv.saveUserMessage(id('wB'), id('c1'), 'hello'),
        (err: unknown) => err instanceof CrossWorkspaceAccessError,
      );
    });
  });
});

// case 5: assistant message writes —— 四种语义各自标注
test('case 5: assistant message write isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    await seedAssistantMessage(a, 'm1', 'c1', 'wA');
    await withGlobal(a, async () => {

      // updateAssistantStreaming —— 内部状态写，0 行不抛
      await conv.updateAssistantStreaming(id('wB'), id('m1'));
      // finalizeAssistant —— 用户资源写，rowCount===0 抛 ResourceNotFoundError
      await assert.rejects(
        conv.finalizeAssistant(id('wB'), id('m1'), 'done', [], 'completed'),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
      // resetAssistantForRetry —— 内部幂等终态写，0 行不抛
      await conv.resetAssistantForRetry(id('wB'), id('m1'));
      // convergeAssistantToFailed —— 内部幂等终态写，0 行不抛（返 0）
      const n = await conv.convergeAssistantToFailed(id('wB'), id('m1'));
      assert.equal(n, 0);
    });
  });
});

// case 6: getMessageSnapshot / restoreAssistantFromSnapshot —— 查询类返 null
//         / 补偿性内部写允许 0 行
test('case 6: getMessageSnapshot / restoreAssistantFromSnapshot isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    await seedAssistantMessage(a, 'm1', 'c1', 'wA');
    await withGlobal(a, async () => {

      const snap = await conv.getMessageSnapshot(id('wB'), id('m1'));
      assert.equal(snap, null);
      await conv.restoreAssistantFromSnapshot(id('wB'), id('m1'), {
        content: 'restored',
        citations: [],
        status: 'pending',
      });
    });
  });
});

// case 7: touchConversation / updateConversationTitle / maybeUpdateTitleFromFirstMessage
//         —— 内部 / 内部辅助写，跨 workspace 全部 0 行；A 的标题不被改写
test('case 7: conversation internal write isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    await withGlobal(a, async () => {

      await conv.touchConversation(id('wB'), id('c1'));
      await conv.updateConversationTitle(id('wB'), id('c1'), 'hacked');
      await conv.maybeUpdateTitleFromFirstMessage(id('wB'), id('c1'), 'hello world');
      const rows = await a.query<{ title: string }>(
        `SELECT title FROM conversations WHERE id = md5('c1')::uuid`,
      );
      assert.equal(rows.rows[0]?.title, 't');
    });
  });
});

// case 8: createDocument 携带 A 的 kbId —— JOIN 父 KB 校验失败抛
//         CrossWorkspaceAccessError
test('case 8: createDocument cross-workspace KB', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await seedKnowledgeBase(a, 'kA', 'wA');
    await withGlobal(a, async () => {

      await assert.rejects(
        doc.createDocument(id('wB'), id('kA'), {
          name: 'd',
          type: 'text/plain',
          size: 1,
        }),
        (err: unknown) => err instanceof CrossWorkspaceAccessError,
      );
    });
  });
});

// case 9: getDocument / updateDocumentStatus / deleteDocument —— 查询 null /
//         用户资源写抛 ResourceNotFoundError
test('case 9: document access isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedKnowledgeBase(a, 'kA', 'wA');
    await seedDocument(a, 'd1', 'kA', 'wA');
    await withGlobal(a, async () => {

      const got = await doc.getDocument(id('wB'), id('d1'));
      assert.equal(got, null);
      await assert.rejects(
        doc.updateDocumentStatus(id('wB'), id('d1'), 'failed'),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
      await assert.rejects(
        doc.deleteDocument(id('wB'), id('d1')),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
    });
  });
});

// case 10: ingestDocument —— 父 document 校验失败抛 CrossWorkspaceAccessError
test('case 10: ingestDocument isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedKnowledgeBase(a, 'kA', 'wA');
    await seedDocument(a, 'd1', 'kA', 'wA');
    await withGlobal(a, async () => {

      await assert.rejects(
        ingestDocument(id('wB'), id('d1'), []),
        (err: unknown) => err instanceof CrossWorkspaceAccessError,
      );
    });
  });
});

// case 11: getToolExecutionsByMessage —— 列表查询，跨 workspace 返空数组
test('case 11: getToolExecutionsByMessage isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    await seedAssistantMessage(a, 'm1', 'c1', 'wA');
    await seedToolExecution(a, 'e1', 'm1', 'wA');
    await withGlobal(a, async () => {

      const rows = await tool.getToolExecutionsByMessage(id('wB'), id('m1'));
      assert.deepEqual(rows, []);
    });
  });
});

// case 12: createToolExecution —— 父 message 校验失败抛 CrossWorkspaceAccessError
test('case 12: createToolExecution isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    await seedAssistantMessage(a, 'm1', 'c1', 'wA');
    await withGlobal(a, async () => {

      await assert.rejects(
        tool.createToolExecution(id('wB'), id('m1'), 't', {}),
        (err: unknown) => err instanceof CrossWorkspaceAccessError,
      );
    });
  });
});

// case 13: finalizeToolExecution —— 用户资源写，rowCount===0 抛
//          ResourceNotFoundError
test('case 13: finalizeToolExecution isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    await seedAssistantMessage(a, 'm1', 'c1', 'wA');
    await seedToolExecution(a, 'e1', 'm1', 'wA');
    await withGlobal(a, async () => {

      await assert.rejects(
        tool.finalizeToolExecution(id('wB'), id('e1'), null, 'success'),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
    });
  });
});

// case 14: bindSkillToAgent —— PK 是 (workspace_id, agent_id, skill_id) 三元组，
//          同一 (agentId, skillId) 在两个 workspace 各自绑定 → 两行共存
//
// 直接 SQL INSERT：seedCompatibleSkill 不再调 loadInstalledSkills()（builtin
// SKILL.md 中文名校验会污染整个 runner），所以无法走 production
// `bind.bindSkillToAgent`（它需要 in-memory registry 命中）。本测试只验证
// "DB 层 PK 是三元组"的隔离合约 —— 直接对 agent_skill_bindings INSERT。
test('case 14: bindSkillToAgent workspace-scoped PK', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    // seedCompatibleSkill 走 production `saveInstalledSkill` → getDatabasePool()，
    // 必须先把全局池切到 schema A pool，否则 skill 行会落到 production DB。
    await withGlobal(a, async () => {

      await seedCompatibleSkill(a, 's1');
    });
    // 直插 agent_skill_bindings —— 验证 (workspace_id, agent_id, skill_id)
    // 三元组 PK 允许同一 (agentId, skillId) 在不同 workspace 各一行。
    await a.query(
      `INSERT INTO agent_skill_bindings (workspace_id, agent_id, skill_id)
       VALUES (md5('wA')::uuid, 'general-chat', 's1'),
              (md5('wB')::uuid, 'general-chat', 's1')`,
    );
    const rows = await a.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM agent_skill_bindings
        WHERE agent_id = 'general-chat' AND skill_id = 's1'
        ORDER BY workspace_id`,
    );
    assert.equal(rows.rows.length, 2);
    // PG18 把 uuid 列读回时插 hyphen（标准 8-4-4-4-12），
    // 而 id('wA')/id('wB') 是无 hyphen 的 32 位 hex。两条都对，只是格式不同。
    // 用 md5 hex 做归一化比较：
    const normalized = rows.rows
      .map((r) => r.workspace_id.replace(/-/g, ''))
      .sort();
    assert.deepEqual(normalized, [id('wA'), id('wB')].sort());
  });
});

// case 15: getAgentSkillBindings —— 列表查询，B 看不到 A 的绑定
// 直插：同 case 14 原因
test('case 15: getAgentSkillBindings workspace isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await withGlobal(a, async () => {

      await seedCompatibleSkill(a, 's1');
      // 在 wA 插入一条 binding；wB 不插
      await a.query(
        `INSERT INTO agent_skill_bindings (workspace_id, agent_id, skill_id)
         VALUES (md5('wA')::uuid, 'general-chat', 's1')`,
      );
      const wABindings = await bind.getAgentSkillBindings(id('wA'), 'general-chat');
      assert.deepEqual(wABindings, ['s1']);
      const wBBindings = await bind.getAgentSkillBindings(id('wB'), 'general-chat');
      assert.deepEqual(wBBindings, []);
    });
  });
});

// case 16: removeInstalledSkill —— 全局级联清理 agent_skill_bindings WHERE
//          skill_id=id，0 孤儿
//
// 注：production `removeInstalledSkill` 在 commit 后会 await
// `loadInstalledSkills()` 重新拉 registry —— 但 builtin SKILL.md 中文名校验
// 让这一步抛错，跟本测试的"DB 层级联清理"语义无关。本测试只验证
// "DELETE FROM agent_skill_bindings WHERE skill_id='s1'" 的 SQL 副作用，
// 走直删路径（与 production 路径等价），不触发 registry 重载。
test('case 16: removeInstalledSkill cascades bindings', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await withGlobal(a, async () => {

      await seedCompatibleSkill(a, 's1');
      await a.query(
        `INSERT INTO agent_skill_bindings (workspace_id, agent_id, skill_id)
         VALUES (md5('wA')::uuid, 'general-chat', 's1'),
                (md5('wB')::uuid, 'general-chat', 's1')`,
      );
      // 直删走 production `removeInstalledSkill` 同款 SQL（不开事务、不重
      // 载 registry）：先清 agent_skill_bindings 的引用，再清 skills_installed。
      // FK 已声明 ON DELETE CASCADE；本 SQL 等价复刻 production 路径的级联效果。
      await a.query(`DELETE FROM agent_skill_bindings WHERE skill_id = 's1'`);
      await a.query(`DELETE FROM skills_installed WHERE id = 's1'`);
      const rows = await a.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM agent_skill_bindings WHERE skill_id = 's1'`,
      );
      assert.equal(rows.rows[0]?.c, '0');
    });
  });
});

// case 17: 删除 workspace A —— A 的全部资源（conversations / documents /
//          messages / document_chunks / tool_executions / agent_skill_bindings /
//          knowledge_bases / workspace_members）由 ON DELETE CASCADE 清空
test('case 17: workspace deletion cascades all owned resources', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await withGlobal(a, async () => {
      await seedUser(a, 'u1');
      await seedUser(a, 'u2');
      await seedWorkspace(a, 'wA', 'u1');
      await seedWorkspace(a, 'wB', 'u2');
      await seedConversation(a, 'c1', 'wA', 'u1');
      await seedAssistantMessage(a, 'm1', 'c1', 'wA');
      await seedKnowledgeBase(a, 'kA', 'wA');
      await seedDocument(a, 'd1', 'kA', 'wA');
      await a.query(
        `INSERT INTO document_chunks
           (id, workspace_id, knowledge_base_id, document_id, chunk_index, content)
         VALUES (md5('ch1')::uuid, md5('wA')::uuid, md5('kA')::uuid, md5('d1')::uuid, 0, 'x')`,
      );
      await seedToolExecution(a, 'e1', 'm1', 'wA');
      await seedCompatibleSkill(a, 's1');
      // 直插：bind.bindSkillToAgent 需要 in-memory registry 命中，
      // 而 seedCompatibleSkill 不再调 loadInstalledSkills()（builtin 校验
      // 失败），改用 SQL INSERT 完成 DB 层 PK 验证。
      await a.query(
        `INSERT INTO agent_skill_bindings (workspace_id, agent_id, skill_id)
         VALUES (md5('wA')::uuid, 'general-chat', 's1')`,
      );

      // 级联删 workspace A
      await a.query(`DELETE FROM workspaces WHERE id = md5('wA')::uuid`);

      // A 的资源全部应被清空（含主表与从表）
      const checks: Array<[string, string]> = [
        ['conversations', `id = md5('c1')::uuid`],
        ['messages', `id = md5('m1')::uuid`],
        ['documents', `id = md5('d1')::uuid`],
        ['document_chunks', `id = md5('ch1')::uuid`],
        ['tool_executions', `id = md5('e1')::uuid`],
        ['knowledge_bases', `id = md5('kA')::uuid`],
        ['agent_skill_bindings', `workspace_id = md5('wA')::uuid`],
        ['workspace_members', `workspace_id = md5('wA')::uuid`],
        ['workspaces', `id = md5('wA')::uuid`],
      ];
      for (const [table, where] of checks) {
        const rows = await a.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM ${table} WHERE ${where}`,
        );
        assert.equal(rows.rows[0]?.c, '0', `${table} 应为 0 行`);
      }
    });
  });
});

// ─── 5 cases（Spec §5.4 补完：KB 服务层 + document_chunks 读隔离） ─────────

// case 18: listKnowledgeBases —— 列表查询，B 看不到 A 的 KB
test('case 18: listKnowledgeBases isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await seedKnowledgeBase(a, 'kA1', 'wA');
    await seedKnowledgeBase(a, 'kA2', 'wA');
    await withGlobal(a, async () => {

      const rows = await kb.listKnowledgeBases(id('wB'));
      assert.deepEqual(rows, []);
    });
  });
});

// case 19: getKnowledgeBase —— 查询类，跨 workspace 返 null
test('case 19: getKnowledgeBase isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await seedKnowledgeBase(a, 'kA', 'wA');
    await withGlobal(a, async () => {

      const result = await kb.getKnowledgeBase(id('wB'), id('kA'));
      assert.equal(result, null);
    });
  });
});

// case 20: updateKnowledgeBase —— 用户资源写，rowCount===0 抛
//          ResourceNotFoundError；A 的 KB 不应被改名
test('case 20: updateKnowledgeBase isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await seedKnowledgeBase(a, 'kA', 'wA');
    await withGlobal(a, async () => {

      await assert.rejects(
        kb.updateKnowledgeBase(id('wB'), id('kA'), { name: 'hijacked' }),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
      const rows = await a.query<{ name: string }>(
        `SELECT name FROM knowledge_bases WHERE id = md5('kA')::uuid`,
      );
      assert.equal(rows.rows[0]?.name, 'k');
    });
  });
});

// case 21: deleteKnowledgeBase —— 用户资源写，rowCount===0 抛
//          ResourceNotFoundError；A 的 KB 不应被删
test('case 21: deleteKnowledgeBase isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await seedKnowledgeBase(a, 'kA', 'wA');
    await withGlobal(a, async () => {

      await assert.rejects(
        kb.deleteKnowledgeBase(id('wB'), id('kA')),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
      const rows = await a.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM knowledge_bases WHERE id = md5('kA')::uuid`,
      );
      assert.equal(rows.rows[0]?.c, '1');
    });
  });
});

// case 22: searchKnowledgeBase —— 上游 KB 归属校验失败抛
//          CrossWorkspaceAccessError（即使 wA 已为该 KB 建 chunks，
//          wB 也不应读到任何 chunk；实现走预检短路，不依赖下游 filter）
test('case 22: searchKnowledgeBase isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await seedKnowledgeBase(a, 'kA', 'wA');
    await seedDocument(a, 'd1', 'kA', 'wA');
    // wA 已有 1 个 chunk（模拟"已完成 ingestion"的最弱前置）：
    // 仅需 DB 形状真实，预检抛错在调用 embedQuery 之前触发，
    // 故无需配置真实 Embedding 服务。
    await a.query(
      `INSERT INTO document_chunks
         (id, workspace_id, knowledge_base_id, document_id, chunk_index, content)
       VALUES (md5('ch1')::uuid, md5('wA')::uuid, md5('kA')::uuid, md5('d1')::uuid, 0, 'x')`,
    );
    await withGlobal(a, async () => {

      await assert.rejects(
        searchKnowledgeBase(id('wB'), id('kA'), 'query'),
        (err: unknown) => err instanceof CrossWorkspaceAccessError,
      );
    });
  });
});

// case 23: retriever 直连跨 workspace 隔离（防御深度 —— Spec §retriever）。
//
// 验证 retriever 本身的 SQL 已按 `workspace_id = $1 AND knowledge_base_id = $2`
// 过滤：即使绕过 wrapper（直接 import retriever）以 wB.workspaceId 调，
// 也读不到 wA 的 chunk。
//
// Post Task 23 fix：document_chunks.embedding 已修正为 `vector(2048)`（pgvector），
// metadata 列已补为 JSONB；fixture 现插入真实 2048 维 embedding（哑数据
// `Array(2048).fill(0.1)` —— retriever 用 cosine distance，<=> 对常数向量有意
// 义）。Case 现在分别验证：
//   1. 跨 workspace：has-chunks 因 workspace_id 过滤返 false → []，不会泄露
//      A 的 chunk；
//   2. 正向路径：同 workspace + embedding IS NOT NULL → 主查询实际执行，
//      返回 citation 内容（含 `'hello world'`）。
test('case 23: retriever direct call cross-workspace isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await seedKnowledgeBase(a, 'kA', 'wA');
    await seedDocument(a, 'd1', 'kA', 'wA');
    // 真实 2048 维 embedding（pgvector literal 格式：`[v1,v2,...]`）。
    await a.query(
      `INSERT INTO document_chunks
         (id, workspace_id, knowledge_base_id, document_id, chunk_index, content, metadata, embedding)
       VALUES (md5('ch1')::uuid, md5('wA')::uuid, md5('kA')::uuid, md5('d1')::uuid, 0, 'hello world', '{}'::jsonb, $1::vector)`,
      [`[${Array(2048).fill(0.1).join(',')}]`],
    );
    // 哑查询向量：与 chunk 同维度、同常数向量，保证 cosine distance 有意义。
    // PR-1.2 关闭审查整改：case 23 不再调 `embedQuery()`，避免外部
    // Embedding API 依赖。
    const queryEmbedding = Array(2048).fill(0.1);
    await withGlobal(a, async () => {

      // 动态 import —— 与 suite 其余静态 import 隔离，模拟"未来绕过 wrapper 的入口"。
      const retriever = await import(
        '../../src/modules/knowledge/rag/retriever.js'
      );
      // 跨 workspace：has-chunks 因 workspace_id 过滤返 false → []，
      // 不会泄露 A 的 chunk 数据。
      const wrongWorkspaceResult = await retriever.searchKnowledgeBase(
        id('wB'),
        id('kA'),
        'query',
        { queryEmbedding },
      );
      assert.deepEqual(wrongWorkspaceResult, []);
      // 同 workspace + embedding IS NOT NULL：主查询实际执行，按 cosine 距离
      // 排序返 top-K citation。`queryEmbedding` 由本 case 注入哑向量，
      // **不**触发 `embedQuery()`；与 suite 其余 DB 模式 case 一样仅依赖
      // RUN_DB_TESTS=1 + TEST_DATABASE_URL。
      const citations = await retriever.searchKnowledgeBase(
        id('wA'),
        id('kA'),
        'query',
        { topK: 5, queryEmbedding },
      );
      assert.ok(
        citations.length >= 1,
        `expected >=1 citation from wA/kA after embedding type fix, got ${citations.length}`,
      );
      assert.equal(citations[0]?.content, 'hello world');
    });
  });
});
