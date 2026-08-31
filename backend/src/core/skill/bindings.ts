/**
 * Agent ↔ Skill 绑定 API 与已绑定 Skill 的解析投影。
 *
 * 双重校验：
 *  - Skill 的 `allowedTools` 必须在 Tool Registry 中注册；
 *  - 目标 Agent 的 `toolIds` 必须包含 Skill 的 `allowedTools`。
 *
 * 任何一项不满足都拒绝绑定——Skill 永远不能扩展 Agent 的 toolIds。
 */
import type { Pool } from 'pg';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { getAgentDefinition } from '../agent/registry.js';
import { listToolDefinitions } from '../tool/registry.js';
import type { SkillDefinition } from './discovery.js';

export function resolveSkillsForAgent(agentId: string, ids: string[]): SkillDefinition[] {
  const def = getAgentDefinition(agentId);
  if (!def) return [];
  const agentToolIds = new Set(def.toolIds ?? []);
  const registeredToolIds = new Set(listToolDefinitions().map((t) => t.id));
  return ids
    .map((id) => lookupSkill(id))
    .filter((s): s is SkillDefinition => {
      if (!s) return false;
      if (s.compatibility !== 'compatible') return false;
      if (s.allowedTools && s.allowedTools.length > 0) {
        for (const t of s.allowedTools) {
          if (!registeredToolIds.has(t)) return false;
          if (!agentToolIds.has(t)) return false;
        }
      }
      return true;
    });
}

export async function bindSkillToAgent(workspaceId: string, agentId: string, skillId: string): Promise<void> {
  if (!getAgentDefinition(agentId)) {
    throw new Error('Agent 不存在。');
  }
  const skill = lookupSkill(skillId);
  if (!skill) {
    throw new Error('Skill 不存在。');
  }
  if (skill.compatibility !== 'compatible') {
    throw new Error(`Skill 不兼容 (${skill.compatibility})，无法绑定。`);
  }
  if (skill.allowedTools && skill.allowedTools.length > 0) {
    const def = getAgentDefinition(agentId);
    const agentToolIds = new Set(def?.toolIds ?? []);
    const registeredToolIds = new Set(listToolDefinitions().map((t) => t.id));
    const notRegistered = skill.allowedTools.filter((t) => !registeredToolIds.has(t));
    if (notRegistered.length > 0) {
      throw new Error(`Skill 请求的工具未注册：${notRegistered.join(', ')}`);
    }
    const notInAgent = skill.allowedTools.filter((t) => !agentToolIds.has(t));
    if (notInAgent.length > 0) {
      throw new Error(`Agent ${agentId} 未授权工具：${notInAgent.join(', ')}`);
    }
  }
  const pool = bindingsPool();
  await pool.query(
    `INSERT INTO agent_skill_bindings (workspace_id, agent_id, skill_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, agent_id, skill_id) DO NOTHING`,
    [workspaceId, agentId, skillId],
  );
}

export async function unbindSkillFromAgent(workspaceId: string, agentId: string, skillId: string): Promise<void> {
  const pool = bindingsPool();
  // internal idempotent unbind —— 行不存在 / 已解绑都视为正常返回。
  await pool.query(
    `DELETE FROM agent_skill_bindings WHERE workspace_id = $1 AND agent_id = $2 AND skill_id = $3`,
    [workspaceId, agentId, skillId],
  );
}

export async function getAgentSkillBindings(workspaceId: string, agentId: string): Promise<string[]> {
  const pool = bindingsPool();
  const result = await pool.query<{ skill_id: string }>(
    `SELECT skill_id FROM agent_skill_bindings WHERE workspace_id = $1 AND agent_id = $2`,
    [workspaceId, agentId],
  );
  return result.rows.map((r) => r.skill_id);
}

/**
 * `resolveSkillsForAgent` 与 `bindSkillToAgent` 共用的查找函数。
 *
 * 通过 closure 间接寻址，避免在 import 阶段把 `bindings.ts` 与 loader 状态
 * 模块（`registry.ts`）耦合——`registry.ts` 在加载后会调用 `setSkillLookup`
 * 把自己的 `getSkill` 接进来。
 */
let _lookup: (id: string) => SkillDefinition | undefined = () => undefined;

export function setSkillLookup(lookup: (id: string) => SkillDefinition | undefined): void {
  _lookup = lookup;
}

function lookupSkill(id: string): SkillDefinition | undefined {
  return _lookup(id);
}

// ─────────────────────────────────────────────────────────────────────────
// 测试注入：把 `agent_skill_bindings` 的 DB 调用从 `getDatabasePool()` 路由到
// 内存假实现，避免在集成测试里连接真实 PostgreSQL。
// 命名风格与同模块其他测试钩子（`setSkillLookup`）保持一致；生产路径
// 默认仍然走 `getDatabasePool()`。
// ─────────────────────────────────────────────────────────────────────────
let _bindingsPool: Pool | null = null;

export function _setBindingsPoolForTesting(pool: Pool | null): void {
  _bindingsPool = pool;
}

function bindingsPool(): Pool {
  return _bindingsPool ?? getDatabasePool();
}
