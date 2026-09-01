/**
 * Agent ↔ Skill 绑定离线契约测试（整合层）。
 *
 * 范围：
 *  - 真实注册 `agents/index.ts` + `tools/index.ts`，让 `general-chat`、
 *    `knowledge-base`、`calculator`、`get-current-time` 进入内存注册表；
 *  - 通过 `setSkillLookup` 把兼容 / 脚本 / 工具未注册 / 工具未授权四类
 *    Skill 直接挂进 binding 路径——不依赖文件系统、不依赖 DB；
 *  - 通过 `_setBindingsPoolForTesting` 把 `agent_skill_bindings` 的 CRUD
 *    路由到内存假实现，覆盖 4 个真实绑定场景。
 *
 * 不连接真实 PostgreSQL，不调用真实模型，不启动 HTTP 服务。
 *
 * Run with: npx tsx tests/integration/skill-binding-contract.ts
 */
import {
  bindSkillToAgent,
  ensureSkillRegistryLoaded,
  getAgentSkillBindings,
  resolveSkillsForAgent,
  unbindSkillFromAgent,
  _setBindingsPoolForTesting,
  _setSkillRegistryLoaderForTesting,
} from '../../src/core/skill/registry.js';
import type { Pool } from 'pg';
import type { SkillDefinition } from '../../src/core/skill/discovery.js';

// 让 agents/index.ts + tools/index.ts 的 registerAgent / registerTool 真正执行。
// 这样 binding 路径里调用的 `getAgentDefinition` / `listToolDefinitions`
// 拿到的就是真实的 registry，不是空 Map。
await import('../../src/agents/index.js');
await import('../../src/tools/index.js');

// 在真实 Tool Registry 里再注册一个 search-web 工具，用于场景 4：
// "已注册但不在 general-chat.toolIds 内"。这一注册仅在本测试进程生效，
// 不会影响生产代码或持久化注册表。
const { registerTool } = await import('../../src/core/tool/registry.js');
const { createTool } = await import('@mastra/core/tools');
const { z } = await import('zod');
const searchWebTool = createTool({
  id: 'search-web',
  description: 'integration-test-only: 模拟已注册但 Agent 未授权的工具',
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ result: z.string() }),
  execute: async () => ({ result: 'noop' }),
});
registerTool({
  id: 'search-web',
  displayName: 'Search Web (test-only)',
  description: 'integration-test-only fixture',
  tool: searchWebTool,
  metadata: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
});

// 用空 loader 跑一次 ensure：DB-free 环境里不触发 hydrateInstalledFromDb，
// 仅把 builtin / local / marketplace 索引刷一遍，并 mark 成 completed。
// 这一步也验证了"loader 已经被替换 + 后面的 ensure 直接走 O(1) 短路"语义。
_setSkillRegistryLoaderForTesting(async () => {
  // builtin / local / installed 三张索引都通过 registry.ts 的内置装载函数
  // 在模块初始化时已经触达；此处只把 hydrationPromise 标记为已完成，
  // 避免后续 binding 测试再去碰 DB。
});
await ensureSkillRegistryLoaded();

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

// ─────────────────────────────────────────────────────────────────────────
// 内存假 Skill 集合 + 内存假 DB pool
// ─────────────────────────────────────────────────────────────────────────

const COMPATIBLE_SKILL_ID = 'integration-clean-skill';
const SCRIPT_SKILL_ID = 'integration-script-skill';
const UNREGISTERED_TOOL_SKILL_ID = 'integration-unregistered-tool-skill';
const UNAUTHORIZED_TOOL_SKILL_ID = 'integration-unauthorized-tool-skill';
const SECOND_AGENT = 'knowledge-base';

const compatibleSkill: SkillDefinition = {
  id: COMPATIBLE_SKILL_ID,
  name: '测试用兼容 Skill',
  description: '无脚本，allowed-tools 全部注册且在 Agent.toolIds 内',
  source: 'local',
  location: '/tmp/integration/clean',
  compatibility: 'compatible',
  hasScripts: false,
  allowedTools: ['calculator', 'get-current-time'],
  files: ['SKILL.md'],
  metadata: { source: 'local' },
  skill: null,
};

const scriptSkill: SkillDefinition = {
  id: SCRIPT_SKILL_ID,
  name: '脚本 Skill',
  description: '带 scripts/ 目录，compatibility 必然为 requires-runtime',
  source: 'local',
  location: '/tmp/integration/script',
  compatibility: 'requires-runtime',
  hasScripts: true,
  allowedTools: [],
  files: ['SKILL.md', 'scripts/run.sh'],
  metadata: { source: 'local' },
  skill: null,
};

// allowed-tools 引用了 Tool Registry 里不存在的 id：把 compatibility 显式标
// 为 compatible，让 binding 路径继续走到 allowed-tools 二次校验，从而触发
// "工具未注册"的拒绝分支——这模拟"Skill 描述里写了未注册工具"的真实场景。
const unregisteredToolSkill: SkillDefinition = {
  id: UNREGISTERED_TOOL_SKILL_ID,
  name: '引用未注册工具的 Skill',
  description: 'allowed-tools 包含不存在的 tool id',
  source: 'local',
  location: '/tmp/integration/unregistered-tool',
  compatibility: 'compatible',
  hasScripts: false,
  allowedTools: ['does-not-exist-tool'],
  files: ['SKILL.md'],
  metadata: { source: 'local' },
  skill: null,
};

// allowed-tools 引用的工具全部已注册，但其中一部分不在 Agent.toolIds 内：
// 必须被 binding 路径拒绝。要走到"工具已注册但 Agent 未授权"分支，需要在
// Tool Registry 中先注册一个 search-web 工具，再让 Skill 引用它。
const unauthorizedToolSkill: SkillDefinition = {
  id: UNAUTHORIZED_TOOL_SKILL_ID,
  name: '引用 Agent 未授权工具的 Skill',
  description: 'allowed-tools 中部分工具不在 Agent.toolIds',
  source: 'local',
  location: '/tmp/integration/unauthorized-tool',
  compatibility: 'compatible',
  hasScripts: false,
  allowedTools: ['calculator', 'search-web'],
  files: ['SKILL.md'],
  metadata: { source: 'local' },
  skill: null,
};

const skillMap = new Map<string, SkillDefinition>([
  [compatibleSkill.id, compatibleSkill],
  [scriptSkill.id, scriptSkill],
  [unregisteredToolSkill.id, unregisteredToolSkill],
  [unauthorizedToolSkill.id, unauthorizedToolSkill],
]);

// 把内存 Skill 集合挂进 binding 路径。setSkillLookup 是 closure 注入入口，
// 对生产路径无副作用。
import { setSkillLookup } from '../../src/core/skill/bindings.js';
setSkillLookup((id) => skillMap.get(id));

/** 极简内存假 DB pool——仅支持本测试的 INSERT / SELECT / DELETE。 */
function makeInMemoryDbPool(): { pool: Pool; bindings: Map<string, Set<string>>; calls: { insert: number; select: number; delete: number } } {
  // PR-1.2/1.3/1.5 整改：e406f74 把 bindSkillToAgent / unbindSkillFromAgent /
  // getAgentSkillBindings 签名改成 (workspaceId, agentId, skillId) 三元组。
  // 本内存假池的 key 也跟着用 `(workspaceId, agentId)` 二元组，保证假池
  // 与生产 SQL 的"按 workspace + agent 维度隔离"语义一致。
  const bindings = new Map<string, Set<string>>();
  const calls = { insert: 0, select: 0, delete: 0 };
  const pool = {
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      const trimmed = sql.trim();
      if (/INSERT INTO workspace_skills/i.test(trimmed)) {
        return { rows: [] };
      }
      if (/INSERT INTO agent_skill_bindings/i.test(trimmed)) {
        const [workspaceId, agentId, skillId] = params as [string, string, string];
        const key = `${workspaceId}::${agentId}`;
        let set = bindings.get(key);
        if (!set) {
          set = new Set();
          bindings.set(key, set);
        }
        set.add(skillId);
        calls.insert++;
        return { rows: [] };
      }
      if (/FROM agent_skill_bindings binding/i.test(trimmed)) {
        const [workspaceId, agentId] = params as [string, string];
        calls.select++;
        const key = `${workspaceId}::${agentId}`;
        const set = bindings.get(key) ?? new Set<string>();
        return { rows: Array.from(set).map((id) => ({ skill_id: id })) as unknown as T[] };
      }
      if (/DELETE FROM agent_skill_bindings/i.test(trimmed)) {
        const [workspaceId, agentId, skillId] = params as [string, string, string];
        const key = `${workspaceId}::${agentId}`;
        calls.delete++;
        bindings.get(key)?.delete(skillId);
        return { rows: [] };
      }
      throw new Error(`未预期的 SQL：${trimmed.slice(0, 80)}`);
    },
  };
  return { pool: pool as unknown as Pool, bindings, calls };
}

const { pool, calls } = makeInMemoryDbPool();
_setBindingsPoolForTesting(pool);

// 本测试不依赖真实 workspace——所有 binding 调用都走同一个常量 workspace。
const TEST_WS = 'test-workspace';

// ─────────────────────────────────────────────────────────────────────────
// 场景 1：兼容 Skill 绑定成功，DB 写入一次
// ─────────────────────────────────────────────────────────────────────────

console.log('[scenario 1] 兼容 Skill + 真实 Agent → 绑定成功且 DB 写入一次');

const insertBefore = calls.insert;
await bindSkillToAgent(TEST_WS, 'general-chat', COMPATIBLE_SKILL_ID);

assert(
  '首次绑定后 getAgentSkillBindings 返回该 Skill',
  (await getAgentSkillBindings(TEST_WS, 'general-chat')).includes(COMPATIBLE_SKILL_ID),
);
assert(
  '首次绑定恰好触发一次 INSERT',
  calls.insert === insertBefore + 1,
  `expected ${insertBefore + 1}, got ${calls.insert}`,
);

// 重复绑定同一 (agent, skill) 应走 ON CONFLICT，仍然算一次 SQL 调用，
// 不抛错。这是对"幂等"的最小保证。
const insertBeforeDup = calls.insert;
await bindSkillToAgent(TEST_WS, 'general-chat', COMPATIBLE_SKILL_ID);
assert(
  '重复绑定同一 Skill 不会抛错',
  true,
);
assert(
  '重复绑定仍只触发一次 INSERT（ON CONFLICT 走更新路径）',
  calls.insert === insertBeforeDup + 1,
);

// ─────────────────────────────────────────────────────────────────────────
// 场景 2：脚本 Skill 必须被 binding 路径拒绝，且不应触发任何 DB 写入
// ─────────────────────────────────────────────────────────────────────────

console.log('\n[scenario 2] 脚本 Skill → 拒绝且零 DB 写入');

const insertBeforeScript = calls.insert;
const selectBeforeScript = calls.select;
let scriptErr = '';
try {
  await bindSkillToAgent(TEST_WS, 'general-chat', SCRIPT_SKILL_ID);
} catch (err) {
  scriptErr = err instanceof Error ? err.message : String(err);
}
assert(
  '绑定 requires-runtime Skill 必须抛错',
  scriptErr.length > 0,
);
assert(
  '错误信息必须包含"不兼容"原因',
  /不兼容/.test(scriptErr),
  `actual: ${JSON.stringify(scriptErr)}`,
);
assert(
  '拒绝路径不触发任何 INSERT',
  calls.insert === insertBeforeScript,
  `inserts went from ${insertBeforeScript} → ${calls.insert}`,
);
assert(
  '拒绝路径不触发任何 SELECT',
  calls.select === selectBeforeScript,
  `selects went from ${selectBeforeScript} → ${calls.select}`,
);
assert(
  '绑定失败后 getAgentSkillBindings 仍只返回成功绑定过的 Skill',
  !(await getAgentSkillBindings(TEST_WS, 'general-chat')).includes(SCRIPT_SKILL_ID),
);

// ─────────────────────────────────────────────────────────────────────────
// 场景 3：allowed-tools 未在 Tool Registry 注册 → 拒绝，零 DB 写入
// ─────────────────────────────────────────────────────────────────────────

console.log('\n[scenario 3] allowed-tools 引用未注册工具 → 拒绝且零 DB 写入');

const insertBeforeUnreg = calls.insert;
let unregErr = '';
try {
  await bindSkillToAgent(TEST_WS, 'general-chat', UNREGISTERED_TOOL_SKILL_ID);
} catch (err) {
  unregErr = err instanceof Error ? err.message : String(err);
}
assert(
  '未注册工具必须抛错',
  unregErr.length > 0,
);
assert(
  '错误信息必须点出"未注册"工具',
  /未注册/.test(unregErr),
  `actual: ${JSON.stringify(unregErr)}`,
);
assert(
  '未注册工具路径不触发任何 INSERT',
  calls.insert === insertBeforeUnreg,
  `inserts went from ${insertBeforeUnreg} → ${calls.insert}`,
);

// ─────────────────────────────────────────────────────────────────────────
// 场景 4：allowed-tools 已注册但不在 Agent.toolIds → 拒绝，零 DB 写入
// ─────────────────────────────────────────────────────────────────────────

console.log('\n[scenario 4] allowed-tools 引用 Agent 未授权工具 → 拒绝且零 DB 写入');

const insertBeforeUnauth = calls.insert;
let unauthErr = '';
try {
  await bindSkillToAgent(TEST_WS, 'general-chat', UNAUTHORIZED_TOOL_SKILL_ID);
} catch (err) {
  unauthErr = err instanceof Error ? err.message : String(err);
}
assert(
  'Agent 未授权工具必须抛错',
  unauthErr.length > 0,
);
assert(
  '错误信息必须包含 Agent id + "未授权"',
  /未授权/.test(unauthErr) && unauthErr.includes('general-chat'),
  `actual: ${JSON.stringify(unauthErr)}`,
);
assert(
  '未授权工具路径不触发任何 INSERT',
  calls.insert === insertBeforeUnauth,
  `inserts went from ${insertBeforeUnauth} → ${calls.insert}`,
);
assert(
  '未授权工具路径下 getAgentSkillBindings 不包含该 Skill',
  !(await getAgentSkillBindings(TEST_WS, 'general-chat')).includes(UNAUTHORIZED_TOOL_SKILL_ID),
);

// ─────────────────────────────────────────────────────────────────────────
// 场景 5：解绑 + 查询一致性
// ─────────────────────────────────────────────────────────────────────────

console.log('\n[scenario 5] unbindSkillFromAgent → DB 行移除，查询一致');

const deleteBefore = calls.delete;
const beforeUnbind = await getAgentSkillBindings(TEST_WS, 'general-chat');
assert(
  '解绑前 getAgentSkillBindings 包含已绑定 Skill',
  beforeUnbind.includes(COMPATIBLE_SKILL_ID),
);

await unbindSkillFromAgent(TEST_WS, 'general-chat', COMPATIBLE_SKILL_ID);
assert(
  '解绑操作触发一次 DELETE',
  calls.delete === deleteBefore + 1,
);
assert(
  '解绑后 getAgentSkillBindings 不再返回该 Skill',
  !(await getAgentSkillBindings(TEST_WS, 'general-chat')).includes(COMPATIBLE_SKILL_ID),
);

// 解绑一个本就不存在的 binding：DELETE 仍然算一次，但不应抛错，不应产生
// 新的 bindings 行。
const bindingsSizeBefore = Array.from(skillMap.keys()).length;
await unbindSkillFromAgent(TEST_WS, 'general-chat', 'integration-never-bound-skill');
assert(
  '解绑不存在的 binding 不抛错',
  true,
);

// 解绑也会清理 knowledge-base 域内的 binding（独立于 general-chat），
// 因此 knowledge-base 的 getAgentSkillBindings 应为空数组。
assert(
  '未绑定任何 Skill 的 Agent 返回空数组',
  (await getAgentSkillBindings(TEST_WS, SECOND_AGENT)).length === 0,
);

// ─────────────────────────────────────────────────────────────────────────
// 场景 6：resolveSkillsForAgent 与 binding 路径的一致性
// ─────────────────────────────────────────────────────────────────────────

console.log('\n[scenario 6] resolveSkillsForAgent 必须与 binding 路径使用相同规则');

// 把 compatible Skill 重新绑一次，让 knowledge-base 域里也能命中。
await bindSkillToAgent(TEST_WS, SECOND_AGENT, COMPATIBLE_SKILL_ID);
const resolvedKb = resolveSkillsForAgent(SECOND_AGENT, [
  COMPATIBLE_SKILL_ID,
  SCRIPT_SKILL_ID,
  UNREGISTERED_TOOL_SKILL_ID,
  UNAUTHORIZED_TOOL_SKILL_ID,
]);
assert(
  'resolveSkillsForAgent 只保留兼容 Skill',
  resolvedKb.length === 1 && resolvedKb[0]?.id === COMPATIBLE_SKILL_ID,
  `resolved=${JSON.stringify(resolvedKb.map((s) => s.id))}`,
);

// 未知 agent：resolve 静默返回空，不抛错（与 binding 显式 throw 的语义
// 形成对比——resolve 是只读投影，bind 是写操作）。
const resolvedUnknown = resolveSkillsForAgent('not-a-real-agent', [COMPATIBLE_SKILL_ID]);
assert(
  '未知 agent 上 resolve 返回 []（不抛错）',
  resolvedUnknown.length === 0,
);

// 清理：把兼容 Skill 从 knowledge-base 解绑，避免污染其它场景的统计。
await unbindSkillFromAgent(TEST_WS, SECOND_AGENT, COMPATIBLE_SKILL_ID);

// ─────────────────────────────────────────────────────────────────────────
// 收尾：恢复生产 loader 与 production pool，避免污染其它测试 / 模块
// ─────────────────────────────────────────────────────────────────────────
_setSkillRegistryLoaderForTesting(null);
_setBindingsPoolForTesting(null);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  // 不调 process.exit —— 让 npm run test:integration 继续 import 后续 fixture；
  // 失败向上 throw，由 runner 接住 → 进程 exit 1。
  throw new Error(`skill-binding-contract 失败 ${failed} 项断言`);
}
