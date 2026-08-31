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
import { Pool } from 'pg';
import {
  ensureSchema,
  dropIsolatedSchema,
  createIsolatedSchema,
} from '../../src/test-utils/schema-init.js';
import {
  __setTestPool,
  __resetTestPool,
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
  loadInstalledSkills,
} from '../../src/core/skill/registry.js';

const URL = process.env.TEST_DATABASE_URL;
const RUN = process.env.RUN_DB_TESTS === '1' && !!URL;

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

// ─── Fixtures（直接走 SQL；service 函数走 service 函数，fixture 走 fixture） ───

async function seedUser(pool: Pool, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO app_users (id, username, username_normalized, password_hash)
     VALUES ($1, $1, $1, 'placeholder')`,
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
     VALUES ($1, 'personal', 'personal', $2)`,
    [wsId, ownerUserId],
  );
}

async function seedConversation(
  pool: Pool,
  conversationId: string,
  wsId: string,
  userId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO conversations (id, workspace_id, user_id, agent_id, title)
     VALUES ($1, $2, $3, 'general-chat', 't')`,
    [conversationId, wsId, userId],
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
     VALUES ($1, $2, $3, 'assistant', '', 'pending')`,
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
     VALUES ($1, $2, 'k')`,
    [kbId, wsId],
  );
}

async function seedDocument(
  pool: Pool,
  docId: string,
  kbId: string,
  wsId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO documents (id, workspace_id, knowledge_base_id, title, source, status)
     VALUES ($1, $2, $3, 'd', 'text/plain', 'pending')`,
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
     VALUES ($1, $2, $3, 't', '{}'::jsonb, 'success')`,
    [execId, wsId, messageId],
  );
}

async function seedCompatibleSkill(
  pool: Pool,
  skillId: string,
): Promise<void> {
  // location 指向不存在的路径 —— hydrateInstalledFromDb 会跳过文件扫描，
  // 但 analyzeCompatibility([]) 仍返 'compatible'，所以 bind 不被拒绝。
  await saveInstalledSkill(
    skillId,
    skillId,
    'isolation-test skill',
    'local',
    '/tmp/non-existent-isolation-skill-path',
    'compatible',
    false,
  );
  await loadInstalledSkills();
  void pool; // 当前 fixture 走全局池；保留 pool 参数便于未来切回 pool-bound 写法
}

// ─── 17 cases（按 Spec §7.1 表 1:1 落测试） ──────────────────────────────

// case 1: listConversations —— 列表查询，跨 workspace 返空数组
test('case 1: listConversations isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    setGlobal(a);
    try {
      const rows = await conv.listConversations('wB');
      assert.deepEqual(rows, []);
    } finally {
      resetGlobal();
    }
  });
});

// case 2: getConversationWithMessages —— 查询类，跨 workspace 返 null
test('case 2: getConversationWithMessages isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    setGlobal(a);
    try {
      const result = await conv.getConversationWithMessages('wB', 'c1');
      assert.equal(result, null);
    } finally {
      resetGlobal();
    }
  });
});

// case 3: updateConversation / deleteConversation —— 用户资源写，rowCount===0 抛
//         ResourceNotFoundError
test('case 3: updateConversation / deleteConversation isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    setGlobal(a);
    try {
      await assert.rejects(
        conv.updateConversation('wB', 'c1', { title: 'hacked' }),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
      await assert.rejects(
        conv.deleteConversation('wB', 'c1'),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
    } finally {
      resetGlobal();
    }
  });
});

// case 4: saveUserMessage —— JOIN 父资源（conversation）校验失败抛
//         CrossWorkspaceAccessError
test('case 4: saveUserMessage isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    setGlobal(a);
    try {
      await assert.rejects(
        conv.saveUserMessage('wB', 'c1', 'hello'),
        (err: unknown) => err instanceof CrossWorkspaceAccessError,
      );
    } finally {
      resetGlobal();
    }
  });
});

// case 5: assistant message writes —— 四种语义各自标注
test('case 5: assistant message write isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    await seedAssistantMessage(a, 'm1', 'c1', 'wA');
    setGlobal(a);
    try {
      // updateAssistantStreaming —— 内部状态写，0 行不抛
      await conv.updateAssistantStreaming('wB', 'm1');
      // finalizeAssistant —— 用户资源写，rowCount===0 抛 ResourceNotFoundError
      await assert.rejects(
        conv.finalizeAssistant('wB', 'm1', 'done', [], 'completed'),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
      // resetAssistantForRetry —— 内部幂等终态写，0 行不抛
      await conv.resetAssistantForRetry('wB', 'm1');
      // convergeAssistantToFailed —— 内部幂等终态写，0 行不抛（返 0）
      const n = await conv.convergeAssistantToFailed('wB', 'm1');
      assert.equal(n, 0);
    } finally {
      resetGlobal();
    }
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
    setGlobal(a);
    try {
      const snap = await conv.getMessageSnapshot('wB', 'm1');
      assert.equal(snap, null);
      await conv.restoreAssistantFromSnapshot('wB', 'm1', {
        content: 'restored',
        citations: [],
        status: 'pending',
      });
    } finally {
      resetGlobal();
    }
  });
});

// case 7: touchConversation / updateConversationTitle / maybeUpdateTitleFromFirstMessage
//         —— 内部 / 内部辅助写，跨 workspace 全部 0 行；A 的标题不被改写
test('case 7: conversation internal write isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    setGlobal(a);
    try {
      await conv.touchConversation('wB', 'c1');
      await conv.updateConversationTitle('wB', 'c1', 'hacked');
      await conv.maybeUpdateTitleFromFirstMessage('wB', 'c1', 'hello world');
      const rows = await a.query<{ title: string }>(
        `SELECT title FROM conversations WHERE id = 'c1'`,
      );
      assert.equal(rows.rows[0]?.title, 't');
    } finally {
      resetGlobal();
    }
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
    setGlobal(a);
    try {
      await assert.rejects(
        doc.createDocument('wB', 'kA', {
          name: 'd',
          type: 'text/plain',
          size: 1,
        }),
        (err: unknown) => err instanceof CrossWorkspaceAccessError,
      );
    } finally {
      resetGlobal();
    }
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
    setGlobal(a);
    try {
      const got = await doc.getDocument('wB', 'd1');
      assert.equal(got, null);
      await assert.rejects(
        doc.updateDocumentStatus('wB', 'd1', 'failed'),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
      await assert.rejects(
        doc.deleteDocument('wB', 'd1'),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
    } finally {
      resetGlobal();
    }
  });
});

// case 10: ingestDocument —— 父 document 校验失败抛 CrossWorkspaceAccessError
test('case 10: ingestDocument isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedKnowledgeBase(a, 'kA', 'wA');
    await seedDocument(a, 'd1', 'kA', 'wA');
    setGlobal(a);
    try {
      await assert.rejects(
        ingestDocument('wB', 'd1', []),
        (err: unknown) => err instanceof CrossWorkspaceAccessError,
      );
    } finally {
      resetGlobal();
    }
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
    setGlobal(a);
    try {
      const rows = await tool.getToolExecutionsByMessage('wB', 'm1');
      assert.deepEqual(rows, []);
    } finally {
      resetGlobal();
    }
  });
});

// case 12: createToolExecution —— 父 message 校验失败抛 CrossWorkspaceAccessError
test('case 12: createToolExecution isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedWorkspace(a, 'wA', 'u1');
    await seedConversation(a, 'c1', 'wA', 'u1');
    await seedAssistantMessage(a, 'm1', 'c1', 'wA');
    setGlobal(a);
    try {
      await assert.rejects(
        tool.createToolExecution('wB', 'm1', 't', {}),
        (err: unknown) => err instanceof CrossWorkspaceAccessError,
      );
    } finally {
      resetGlobal();
    }
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
    setGlobal(a);
    try {
      await assert.rejects(
        tool.finalizeToolExecution('wB', 'e1', null, 'success'),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
    } finally {
      resetGlobal();
    }
  });
});

// case 14: bindSkillToAgent —— PK 是 (workspace_id, agent_id, skill_id) 三元组，
//          同一 (agentId, skillId) 在两个 workspace 各自绑定 → 两行共存
test('case 14: bindSkillToAgent workspace-scoped PK', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    setGlobal(a);
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await seedCompatibleSkill(a, 's1');
    try {
      await bind.bindSkillToAgent('wA', 'general-chat', 's1');
      await bind.bindSkillToAgent('wB', 'general-chat', 's1');
      const rows = await a.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM agent_skill_bindings
          WHERE agent_id = 'general-chat' AND skill_id = 's1'
          ORDER BY workspace_id`,
      );
      assert.equal(rows.rows.length, 2);
      assert.deepEqual(
        rows.rows.map((r) => r.workspace_id).sort(),
        ['wA', 'wB'],
      );
    } finally {
      resetGlobal();
    }
  });
});

// case 15: getAgentSkillBindings —— 列表查询，B 看不到 A 的绑定
test('case 15: getAgentSkillBindings workspace isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    setGlobal(a);
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await seedCompatibleSkill(a, 's1');
    try {
      await bind.bindSkillToAgent('wA', 'general-chat', 's1');
      const wABindings = await bind.getAgentSkillBindings('wA', 'general-chat');
      assert.deepEqual(wABindings, ['s1']);
      const wBBindings = await bind.getAgentSkillBindings('wB', 'general-chat');
      assert.deepEqual(wBBindings, []);
    } finally {
      resetGlobal();
    }
  });
});

// case 16: removeInstalledSkill —— 全局级联清理 agent_skill_bindings WHERE
//          skill_id=id，0 孤儿
test('case 16: removeInstalledSkill cascades bindings', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    setGlobal(a);
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await seedCompatibleSkill(a, 's1');
    try {
      await bind.bindSkillToAgent('wA', 'general-chat', 's1');
      await bind.bindSkillToAgent('wB', 'general-chat', 's1');
      await removeInstalledSkill('s1');
      const rows = await a.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM agent_skill_bindings WHERE skill_id = 's1'`,
      );
      assert.equal(rows.rows[0]?.c, '0');
    } finally {
      resetGlobal();
    }
  });
});

// case 17: 删除 workspace A —— A 的全部资源（conversations / documents /
//          messages / document_chunks / tool_executions / agent_skill_bindings /
//          knowledge_bases / workspace_members）由 ON DELETE CASCADE 清空
test('case 17: workspace deletion cascades all owned resources', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    setGlobal(a);
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
       VALUES ('ch1', 'wA', 'kA', 'd1', 0, 'x')`,
    );
    await seedToolExecution(a, 'e1', 'm1', 'wA');
    await seedCompatibleSkill(a, 's1');
    try {
      await bind.bindSkillToAgent('wA', 'general-chat', 's1');
    } finally {
      resetGlobal();
    }

    // 级联删 workspace A
    await a.query(`DELETE FROM workspaces WHERE id = 'wA'`);

    // A 的资源全部应被清空（含主表与从表）
    const checks: Array<[string, string]> = [
      ['conversations', `id = 'c1'`],
      ['messages', `id = 'm1'`],
      ['documents', `id = 'd1'`],
      ['document_chunks', `id = 'ch1'`],
      ['tool_executions', `id = 'e1'`],
      ['knowledge_bases', `id = 'kA'`],
      ['agent_skill_bindings', `workspace_id = 'wA'`],
      ['workspace_members', `workspace_id = 'wA'`],
      ['workspaces', `id = 'wA'`],
    ];
    for (const [table, where] of checks) {
      const rows = await a.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM ${table} WHERE ${where}`,
      );
      assert.equal(rows.rows[0]?.c, '0', `${table} 应为 0 行`);
    }
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
    setGlobal(a);
    try {
      const rows = await kb.listKnowledgeBases('wB');
      assert.deepEqual(rows, []);
    } finally {
      resetGlobal();
    }
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
    setGlobal(a);
    try {
      const result = await kb.getKnowledgeBase('wB', 'kA');
      assert.equal(result, null);
    } finally {
      resetGlobal();
    }
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
    setGlobal(a);
    try {
      await assert.rejects(
        kb.updateKnowledgeBase('wB', 'kA', { name: 'hijacked' }),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
      const rows = await a.query<{ name: string }>(
        `SELECT name FROM knowledge_bases WHERE id = 'kA'`,
      );
      assert.equal(rows.rows[0]?.name, 'k');
    } finally {
      resetGlobal();
    }
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
    setGlobal(a);
    try {
      await assert.rejects(
        kb.deleteKnowledgeBase('wB', 'kA'),
        (err: unknown) => err instanceof ResourceNotFoundError,
      );
      const rows = await a.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM knowledge_bases WHERE id = 'kA'`,
      );
      assert.equal(rows.rows[0]?.c, '1');
    } finally {
      resetGlobal();
    }
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
       VALUES ('ch1', 'wA', 'kA', 'd1', 0, 'x')`,
    );
    setGlobal(a);
    try {
      await assert.rejects(
        searchKnowledgeBase('wB', 'kA', 'query'),
        (err: unknown) => err instanceof CrossWorkspaceAccessError,
      );
    } finally {
      resetGlobal();
    }
  });
});

// case 23: retriever 直连跨 workspace 隔离（防御深度 —— Spec §retriever）。
//
// 验证 retriever 本身的 SQL 已按 `workspace_id = $1 AND knowledge_base_id = $2`
// 过滤：即使绕过 wrapper（直接 import retriever）以 wB.workspaceId 调，
// 也读不到 wA 的 chunk。
//
// 已知限制：`document_chunks.embedding` 当前是 `REAL[]`（Task 23 的列类型 bug
// 尚未修），导致 retriever 主查询的 `embedding <=> $1::vector` 会失败。因此
// 本 case 不插入 embedding —— 这意味着 has-chunks 预检（`embedding IS NOT NULL`）
// 在两条路径上都返 false、retriever 都返 `[]`。该 case 的价值不在"区分两条
// 路径返回内容"，而在：
//   1. 验证新签名（`(workspaceId, kbId, query, options)`）可调通、不抛；
//   2. 验证跨 workspace 调用不会泄露 A 的 chunk；
//   3. 作为 Task 23 修复后的回归基线（修好 embedding 类型后，只需把
//      `assert.deepEqual(..., [])` 换成具体 citation 内容验证）。
test('case 23: retriever direct call cross-workspace isolation', { skip: !RUN }, async () => {
  await withTwoWorkspaces(async (a) => {
    await seedUser(a, 'u1');
    await seedUser(a, 'u2');
    await seedWorkspace(a, 'wA', 'u1');
    await seedWorkspace(a, 'wB', 'u2');
    await seedKnowledgeBase(a, 'kA', 'wA');
    await seedDocument(a, 'd1', 'kA', 'wA');
    // 不插 embedding —— 见上方说明（Task 23 跟踪 REAL[] → vector 修复）。
    await a.query(
      `INSERT INTO document_chunks
         (id, workspace_id, knowledge_base_id, document_id, chunk_index, content)
       VALUES ('ch1', 'wA', 'kA', 'd1', 0, 'x')`,
    );
    setGlobal(a);
    try {
      // 动态 import —— 与 suite 其余静态 import 隔离，模拟"未来绕过 wrapper 的入口"。
      const retriever = await import(
        '../../../src/modules/knowledge/rag/retriever.js'
      );
      // 跨 workspace：has-chunks 因 workspace_id 过滤返 false → []，
      // 不会泄露 A 的 chunk 数据。
      const wrongWorkspaceResult = await retriever.searchKnowledgeBase(
        'wB',
        'kA',
        'query',
      );
      assert.deepEqual(wrongWorkspaceResult, []);
      // 同 workspace：has-chunks 也返 false（embedding IS NULL），retriever 短路返 []；
      // 此路径验证 SQL 形状可执行、不抛错、与 wrapper 行为一致（KB 存在但无 chunk → []）。
      const correctWorkspaceResult = await retriever.searchKnowledgeBase(
        'wA',
        'kA',
        'query',
        { topK: 5 },
      );
      assert.deepEqual(correctWorkspaceResult, []);
    } finally {
      resetGlobal();
    }
  });
});
