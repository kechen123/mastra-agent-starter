import { createSkill } from '@mastra/core/skills';
import type { InlineSkill, Skill } from '@mastra/core/skills';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabasePool } from '../../database/pool.js';
import { listAgentDefinitions, getAgentDefinition } from '../agents/registry.js';
import { listToolDefinitions } from '../tools/registry.js';
import { structuredSummarySkill } from './builtins.js';

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'marketplace' | 'local';
  location: string;
  compatibility: 'compatible' | 'requires-runtime' | 'unsupported' | 'unknown';
  instructions?: string;
  references?: string[];
  scripts?: string[];
  hasScripts: boolean;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  skill: InlineSkill | null; // null for non-compatible / requires-runtime skills
}

const BUILTIN_SKILLS_DIR = new URL('.', import.meta.url).pathname;
const MARKET_SKILLS_DIR = new URL('../../../market-skills', import.meta.url).pathname;

// In-memory registry
const builtinSkills = new Map<string, SkillDefinition>();
const installedSkills = new Map<string, SkillDefinition>();

function toSkillId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
}

function analyzeSkillCompatibility(
  location: string,
  hasScripts: boolean,
  allowedTools?: string[],
): 'compatible' | 'requires-runtime' | 'unsupported' | 'unknown' {
  if (hasScripts) {
    return 'requires-runtime';
  }
  if (allowedTools && allowedTools.length > 0) {
    const availableTools = new Set(listToolDefinitions().map((t) => t.id));
    const allAvailable = allowedTools.every((t) => availableTools.has(t));
    if (!allAvailable) {
      return 'requires-runtime';
    }
  }
  // Check for shell/python/node scripts in directory
  try {
    const entries = readdirSync(location);
    const scriptLike = entries.some((e) =>
      /\.(sh|py|js|ts|mjs|cjs)$/.test(e) || e === 'scripts',
    );
    if (scriptLike) {
      return 'requires-runtime';
    }
  } catch {
    // ignore
  }
  return 'compatible';
}

export function loadBuiltinSkills(): void {
  builtinSkills.clear();
  const skill = structuredSummarySkill;
  const id = toSkillId(skill.name);
  builtinSkills.set(id, {
    id,
    name: skill.name,
    description: skill.description,
    source: 'builtin',
    location: join(BUILTIN_SKILLS_DIR, 'structured-summary'),
    compatibility: 'compatible',
    instructions: skill.instructions,
    hasScripts: false,
    allowedTools: (skill.metadata?.['allowed-tools'] as string[]) ?? undefined,
    metadata: skill.metadata ?? {},
    skill,
  });
}

export async function loadInstalledSkills(): Promise<void> {
  installedSkills.clear();
  const pool = getDatabasePool();
  const result = await pool.query<
    { id: string; name: string; description: string; source: string; location: string; compatibility: string; has_scripts: boolean; metadata: unknown; allowed_tools?: string[] }
  >(
    `SELECT id, name, description, source, location, compatibility, has_scripts, metadata, allowed_tools FROM skills_installed ORDER BY installed_at DESC`,
  );
  for (const row of result.rows) {
    let skill: InlineSkill | null = null;
    if (row.compatibility === 'compatible') {
      try {
        const instructions = readFileSync(join(row.location, 'SKILL.md'), 'utf-8');
        skill = createSkill({
          name: row.id,
          description: row.description,
          instructions,
          compatibility: [row.compatibility],
          metadata: {
            ...(row.metadata as Record<string, unknown> ?? {}),
            source: row.source,
          },
          ...(row.allowed_tools ? { 'allowed-tools': row.allowed_tools } : {}),
        });
      } catch {
        // Fallback: skill exists but cannot be loaded into runtime
        skill = null;
      }
    }
    installedSkills.set(row.id, {
      id: row.id,
      name: row.name,
      description: row.description,
      source: row.source as 'builtin' | 'marketplace' | 'local',
      location: row.location,
      compatibility: row.compatibility as SkillDefinition['compatibility'],
      hasScripts: row.has_scripts,
      allowedTools: row.allowed_tools,
      metadata: (row.metadata as Record<string, unknown> ?? {}),
      skill,
    });
  }
}

export function getSkill(id: string): SkillDefinition | undefined {
  return builtinSkills.get(id) ?? installedSkills.get(id);
}

export function listSkills(): SkillDefinition[] {
  return [
    ...Array.from(builtinSkills.values()),
    ...Array.from(installedSkills.values()),
  ];
}

export function resolveSkills(ids: string[]): SkillDefinition[] {
  return ids.map((id) => getSkill(id)).filter((s): s is SkillDefinition => !!s && s.compatibility === 'compatible');
}

export async function saveInstalledSkill(
  id: string,
  name: string,
  description: string,
  source: 'marketplace' | 'local',
  location: string,
  compatibility: SkillDefinition['compatibility'],
  hasScripts: boolean,
  metadata?: Record<string, unknown>,
  allowedTools?: string[],
): Promise<void> {
  const pool = getDatabasePool();
  await pool.query(
    `INSERT INTO skills_installed (id, name, description, source, location, compatibility, has_scripts, metadata, allowed_tools)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       source = EXCLUDED.source,
       location = EXCLUDED.location,
       compatibility = EXCLUDED.compatibility,
       has_scripts = EXCLUDED.has_scripts,
       metadata = EXCLUDED.metadata,
       allowed_tools = EXCLUDED.allowed_tools,
       updated_at = now()`,
    [id, name, description, source, location, compatibility, hasScripts, JSON.stringify(metadata ?? {}), allowedTools ?? null],
  );
}

export async function removeInstalledSkill(id: string): Promise<void> {
  const pool = getDatabasePool();
  // Delete bindings first
  await pool.query(`DELETE FROM agent_skill_bindings WHERE skill_id = $1`, [id]);
  // Delete installed record
  await pool.query(`DELETE FROM skills_installed WHERE id = $1`, [id]);
  // Refresh registry
  await loadInstalledSkills();
}

export async function getAgentSkillBindings(agentId: string): Promise<string[]> {
  const pool = getDatabasePool();
  const result = await pool.query<{ skill_id: string }>(
    `SELECT skill_id FROM agent_skill_bindings WHERE agent_id = $1 AND enabled = true`,
    [agentId],
  );
  return result.rows.map((r) => r.skill_id);
}

export async function bindSkillToAgent(agentId: string, skillId: string): Promise<void> {
  if (!getAgentDefinition(agentId)) {
    throw new Error('Agent 不存在。');
  }
  const skill = getSkill(skillId);
  if (!skill) {
    throw new Error('Skill 不存在。');
  }
  if (skill.compatibility !== 'compatible') {
    throw new Error(`Skill 不兼容 (${skill.compatibility})，无法绑定。`);
  }
  const pool = getDatabasePool();
  await pool.query(
    `INSERT INTO agent_skill_bindings (agent_id, skill_id, enabled)
     VALUES ($1, $2, true)
     ON CONFLICT (agent_id, skill_id) DO UPDATE SET enabled = true, updated_at = now()`,
    [agentId, skillId],
  );
}

export async function unbindSkillFromAgent(agentId: string, skillId: string): Promise<void> {
  const pool = getDatabasePool();
  await pool.query(
    `DELETE FROM agent_skill_bindings WHERE agent_id = $1 AND skill_id = $2`,
    [agentId, skillId],
  );
}

export function getMarketSkillsDir(): string {
  return MARKET_SKILLS_DIR;
}

// Initialize
loadBuiltinSkills();
