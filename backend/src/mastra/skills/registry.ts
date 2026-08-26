import { createSkill } from '@mastra/core/skills';
import type { InlineSkill } from '@mastra/core/skills';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabasePool } from '../../database/pool.js';
import { getAgentDefinition, listAgentDefinitions } from '../agents/registry.js';
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
  files?: string[];
  hasScripts: boolean;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  skill: InlineSkill | null; // null for non-compatible / requires-runtime skills
}

// Resolve on-disk roots via fileURLToPath so Windows paths (file:///C:/...)
// are converted to "C:\\..." instead of relying on new URL(...).pathname.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const BUILTIN_SKILLS_DIR = HERE;
const MARKET_SKILLS_DIR = fileURLToPath(new URL('../../../market-skills', import.meta.url));

// In-memory registry. DB is only an index of bindings/install metadata — the
// filesystem is the source of truth for what files actually exist.
const builtinSkills = new Map<string, SkillDefinition>();
const installedSkills = new Map<string, SkillDefinition>();
const localSkills = new Map<string, SkillDefinition>();

// ─────────────────────────────────────────────────────────────────────────
// Hydration gate
// ─────────────────────────────────────────────────────────────────────────
//
// Routes and runtime code that READ installed skills must call
// `await ensureSkillRegistryLoaded()` first. The first caller kicks off a
// shared `Promise<void>`. All concurrent callers await the same Promise —
// the registry is loaded exactly once. On failure we restore the previous
// snapshot so a transient DB error never empties an otherwise-good registry,
// and we clear the in-flight Promise so the next caller can retry.
//
// Boot-time `preloadSkillRegistry()` is a non-blocking optimisation only;
// route correctness MUST NOT depend on it being complete by first request.

type RegistryLoader = () => Promise<void>;
let activeLoader: RegistryLoader = loadInstalledSkills;
let hydrationPromise: Promise<void> | null = null;
let hydrationCompleted = false;

type RegistrySnapshot = {
  builtin: Map<string, SkillDefinition>;
  installed: Map<string, SkillDefinition>;
  local: Map<string, SkillDefinition>;
};

function snapshotRegistry(): RegistrySnapshot {
  return {
    builtin: new Map(builtinSkills),
    installed: new Map(installedSkills),
    local: new Map(localSkills),
  };
}

function restoreRegistry(snap: RegistrySnapshot): void {
  builtinSkills.clear();
  installedSkills.clear();
  localSkills.clear();
  for (const [k, v] of snap.builtin) builtinSkills.set(k, v);
  for (const [k, v] of snap.installed) installedSkills.set(k, v);
  for (const [k, v] of snap.local) localSkills.set(k, v);
}

/**
 * Idempotent hydration. First caller triggers a real load; concurrent callers
 * share the same in-flight Promise. Subsequent callers (after success) get a
 * resolved Promise. If the loader throws we restore the previous snapshot and
 * reset the gate so the next caller can retry.
 */
export async function ensureSkillRegistryLoaded(): Promise<void> {
  if (hydrationCompleted) return;
  if (hydrationPromise) return hydrationPromise;
  const snap = snapshotRegistry();
  hydrationPromise = (async () => {
    try {
      await activeLoader();
      hydrationCompleted = true;
    } catch (err) {
      // Restore the pre-load state so a transient DB failure doesn't leave
      // the registry empty when previously-loaded entries still exist.
      restoreRegistry(snap);
      hydrationPromise = null;
      throw err;
    }
  })();
  return hydrationPromise;
}

/** Non-blocking boot-time preload. Correctness does NOT depend on this. */
export function preloadSkillRegistry(): void {
  void ensureSkillRegistryLoaded().catch((err) => {
    console.error('[boot] failed to pre-load installed skills:', err);
  });
}

/** Whether hydration has succeeded at least once. */
export function isSkillRegistryLoaded(): boolean {
  return hydrationCompleted;
}

/**
 * @internal Replace the load function used by ensureSkillRegistryLoaded().
 * Used by tests/fixtures to inject a counter loader without requiring a real
 * PostgreSQL connection. Pass `null` to restore the production loader.
 */
export function _setSkillRegistryLoaderForTesting(loader: RegistryLoader | null): void {
  activeLoader = loader ?? loadInstalledSkills;
  // Invalidate the gate so the next ensure call picks up the new loader.
  hydrationPromise = null;
  hydrationCompleted = false;
}

// Match a path's last segment against this list of executable extensions.
// Use it on the FILE NAME (basename), not the full path, so we never confuse
// "tools.sh" (a regular folder) with a real script.
const SCRIPT_EXT_PATTERN = /\.(sh|bash|zsh|ps1|bat|cmd|py|js|ts|mjs|cjs|rb|pl)$/i;

function toSkillId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx === -1 ? path : path.slice(idx + 1);
}

function isExecutableFileName(name: string): boolean {
  return SCRIPT_EXT_PATTERN.test(name);
}

function isScriptsDirEntry(relativePath: string): boolean {
  // ANY path segment equals "scripts" → a scripts/ directory exists at that
  // depth (root-level "scripts", nested "lib/scripts", "a/b/scripts/x", etc.).
  const normalized = relativePath.replace(/[\\/]/g, sep);
  return normalized.split(sep).some((seg) => seg === 'scripts');
}

/**
 * Walk a skill directory and return the list of relative file paths.
 * - Files are emitted with their full relative path (forward slashes).
 * - Any directory named `scripts` (at the root OR nested) is emitted as its
 *   full relative path so classification rules can detect it.
 */
export function listFilesRecursive(location: string): string[] {
  const result: string[] = [];
  const stack: string[] = [location];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const rel = relative(location, full).replace(/\\/g, '/');
      if (st.isDirectory()) {
        if (entry === 'scripts') {
          // Emit the relative path so callers see "scripts" or "lib/scripts"
          // depending on depth. classification uses isScriptsDirEntry() which
          // splits on `/` and looks at the FIRST segment.
          result.push(rel);
        }
        stack.push(full);
      } else if (st.isFile()) {
        result.push(rel);
      }
    }
  }
  return result;
}

/**
 * Classify a skill from its actual file listing (relative paths).
 * - hasScripts: a `scripts/` directory exists ANYWHERE in the tree
 * - hasExecutableExt: any file in ANY directory has a script extension
 */
export function classifyFromFiles(files: string[]): { hasScripts: boolean; hasExecutableExt: boolean } {
  let hasScripts = false;
  let hasExecutableExt = false;
  for (const f of files) {
    if (isScriptsDirEntry(f)) {
      hasScripts = true;
    }
    if (isExecutableFileName(basename(f))) {
      hasExecutableExt = true;
    }
  }
  return { hasScripts, hasExecutableExt };
}

/**
 * Parse allowed-tools out of a SKILL.md-style frontmatter.
 *
 * Accepts all of:
 *   allowed-tools: [calculator, get-current-time]          (inline list)
 *   allowed-tools: calculator, get-current-time            (comma-separated)
 *   allowed-tools: calculator                              (single string)
 *   allowed-tools:                                        (block list)
 *     - calculator
 *     - get-current-time
 *   allowed-tools: ["calculator", "get-current-time"]      (inline + quoted)
 *   allowed-tools: 'calculator', 'get-current-time'        (comma + quoted)
 *
 * Quoted forms are normalised — surrounding ' or " are stripped.
 *
 * The key may appear anywhere inside the frontmatter body (not just the
 * first line) so it works with mixed-in extra fields like `name:` or
 * `description:`.
 */
export function parseAllowedToolsFromFrontmatter(content: string): string[] {
  // Frontmatter is delimited by --- lines at the very top.
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const body = fmMatch[1] ?? '';

  // Find the allowed-tools key anywhere in the frontmatter body.
  const keyMatch = body.match(/^[ \t]*allowed-tools[ \t]*:[ \t]*(.*)$/m);
  if (!keyMatch) return [];
  const keyOffset = (keyMatch.index ?? 0) + keyMatch[0].length;

  const inlineValue = (keyMatch[1] ?? '').trim();
  if (inlineValue) {
    // Inline form: list / comma / single (with optional surrounding quotes).
    return parseInlineAllowedTools(inlineValue);
  }

  // Block list form. Read lines after the key until we hit a non-list line.
  const after = body.slice(keyOffset);
  const tools: string[] = [];
  for (const line of after.split('\n')) {
    const m = line.match(/^[ \t]*-[ \t]*(.+?)[ \t]*$/);
    if (!m) {
      if (line.trim() === '') continue;
      break;
    }
    const v = stripQuotes((m[1] ?? '').trim());
    if (v) tools.push(v);
  }
  return tools;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function parseInlineAllowedTools(raw: string): string[] {
  let r = raw.trim();
  // Strip a single pair of outer [] if present.
  if (r.startsWith('[') && r.endsWith(']')) {
    r = r.slice(1, -1);
  }
  return r
    .split(',')
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0);
}

/**
 * Re-derive allowed-tools from a SKILL.md on disk. Frontmatter wins over the
 * persisted DB column so a freshly-edited SKILL.md is reflected on the next
 * load. filesystem is the source of truth.
 */
export function deriveAllowedTools(skillMdPath: string, persisted?: string[] | null): string[] {
  if (existsSync(skillMdPath)) {
    try {
      const content = readFileSync(skillMdPath, 'utf-8');
      const parsed = parseAllowedToolsFromFrontmatter(content);
      if (parsed.length > 0) return parsed;
    } catch {
      // ignore — fall back to persisted
    }
  }
  return persisted ?? [];
}

/**
 * Compute final compatibility for a skill.
 *
 * Rules (in order):
 *  1. ANY executable file (`scripts/` dir or any script-extension file at
 *     any depth) → `requires-runtime` (unbindable, never injected).
 *  2. The skill requests allowed-tools that are not in the Tool Registry
 *     → `requires-runtime` (we don't have them; can't honour the contract).
 *  3. The skill requests allowed-tools that ARE in the Tool Registry but
 *     the agent (when binding) does not have them in its toolIds
 *     → `requires-runtime` for THAT agent (but the skill itself may be
 *     compatible for other agents).
 *  4. Otherwise → `compatible`.
 *
 * Note: allowed-tools MUST NOT widen the agent's authorization. The agent
 * keeps its own toolIds; we just check overlap.
 */
export function analyzeCompatibility(
  files: string[],
  allowedTools?: string[],
  agentId?: string,
): { compatibility: 'compatible' | 'requires-runtime'; reason: string } {
  const { hasScripts, hasExecutableExt } = classifyFromFiles(files);
  if (hasScripts || hasExecutableExt) {
    return { compatibility: 'requires-runtime', reason: 'contains executable files' };
  }
  const registeredToolIds = new Set(listToolDefinitions().map((t) => t.id));
  if (allowedTools && allowedTools.length > 0) {
    const missing = allowedTools.filter((t) => !registeredToolIds.has(t));
    if (missing.length > 0) {
      return {
        compatibility: 'requires-runtime',
        reason: `requested tools not registered: ${missing.join(', ')}`,
      };
    }
    if (agentId) {
      const def = getAgentDefinition(agentId);
      if (!def) {
        return { compatibility: 'requires-runtime', reason: 'agent not found' };
      }
      const agentToolIds = new Set(def.toolIds ?? []);
      const notInAgent = allowedTools.filter((t) => !agentToolIds.has(t));
      if (notInAgent.length > 0) {
        return {
          compatibility: 'requires-runtime',
          reason: `agent ${agentId} does not have tools: ${notInAgent.join(', ')}`,
        };
      }
    }
  }
  return { compatibility: 'compatible', reason: 'ok' };
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
    files: [],
    hasScripts: false,
    allowedTools: (skill.metadata?.['allowed-tools'] as string[]) ?? undefined,
    metadata: skill.metadata ?? {},
    skill,
  });
}

/** Discover SKILL.md files placed directly on disk under market-skills/<id>/. */
export function discoverLocalSkills(): void {
  localSkills.clear();
  if (!existsSync(MARKET_SKILLS_DIR)) {
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(MARKET_SKILLS_DIR);
  } catch {
    return;
  }
  for (const id of entries) {
    const dir = join(MARKET_SKILLS_DIR, id);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skillMd = join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const files = listFilesRecursive(dir);
    const allowedTools = deriveAllowedTools(skillMd);
    const { compatibility } = analyzeCompatibility(files, allowedTools);
    let skill: InlineSkill | null = null;
    if (compatibility === 'compatible') {
      try {
        const instructions = readFileSync(skillMd, 'utf-8');
        skill = createSkill({
          name: id,
          description: `${id} (local)`,
          instructions,
          compatibility: ['compatible'],
          metadata: { source: 'local' },
        });
      } catch {
        skill = null;
      }
    }
    const { hasScripts, hasExecutableExt } = classifyFromFiles(files);
    localSkills.set(id, {
      id,
      name: id,
      description: '本地 SKILL.md',
      source: 'local',
      location: dir,
      compatibility,
      files,
      hasScripts: hasScripts || hasExecutableExt,
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      skill,
      metadata: { source: 'local', filesystem: true },
    });
  }
}

export async function loadInstalledSkills(): Promise<void> {
  installedSkills.clear();
  discoverLocalSkills();
  const pool = getDatabasePool();
  const result = await pool.query<
    { id: string; name: string; description: string; source: string; location: string; compatibility: string; has_scripts: boolean; metadata: unknown; allowed_tools?: string[] }
  >(
    `SELECT id, name, description, source, location, compatibility, has_scripts, metadata, allowed_tools FROM skills_installed ORDER BY installed_at DESC`,
  );
  for (const row of result.rows) {
    // Re-derive file evidence from disk each load — the DB row may be stale
    // (e.g. an uninstalled skill's files are still on disk, or new scripts
    // were dropped in after install).
    let files: string[] = [];
    if (row.location && existsSync(row.location)) {
      files = listFilesRecursive(row.location);
    }
    const { hasScripts, hasExecutableExt } = classifyFromFiles(files);

    // filesystem is the source of truth: any script file → requires-runtime.
    // Use the FULL classifyFromFiles result, not just hasScripts.
    const diskSaysExecutable = hasScripts || hasExecutableExt;

    // Re-derive allowed-tools from SKILL.md frontmatter; fall back to DB.
    const skillMdPath = join(row.location, 'SKILL.md');
    const allowedTools = deriveAllowedTools(skillMdPath, row.allowed_tools ?? null);

    // Re-classify based on disk evidence + frontmatter.
    const persistedCompat = row.compatibility as SkillDefinition['compatibility'];
    let finalCompatibility: SkillDefinition['compatibility'] = persistedCompat;
    if (diskSaysExecutable) {
      finalCompatibility = 'requires-runtime';
    } else {
      const probe = analyzeCompatibility(files, allowedTools);
      if (probe.compatibility === 'requires-runtime') {
        finalCompatibility = 'requires-runtime';
      }
    }

    let skill: InlineSkill | null = null;
    if (finalCompatibility === 'compatible' && existsSync(skillMdPath)) {
      try {
        const instructions = readFileSync(skillMdPath, 'utf-8');
        skill = createSkill({
          name: row.id,
          description: row.description,
          instructions,
          compatibility: ['compatible'],
          metadata: {
            ...(row.metadata as Record<string, unknown> ?? {}),
            source: row.source,
          },
          ...(allowedTools.length > 0 ? { 'allowed-tools': allowedTools } : {}),
        });
      } catch {
        skill = null;
      }
    }
    installedSkills.set(row.id, {
      id: row.id,
      name: row.name,
      description: row.description,
      source: row.source as 'builtin' | 'marketplace' | 'local',
      location: row.location,
      compatibility: finalCompatibility,
      files,
      hasScripts: diskSaysExecutable,
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      metadata: (row.metadata as Record<string, unknown> ?? {}),
      skill,
    });
  }
}

export function getSkill(id: string): SkillDefinition | undefined {
  return builtinSkills.get(id) ?? installedSkills.get(id) ?? localSkills.get(id);
}

export function listSkills(): SkillDefinition[] {
  return [
    ...Array.from(builtinSkills.values()),
    ...Array.from(installedSkills.values()),
    ...Array.from(localSkills.values()),
  ];
}

/**
 * Resolve which skills to actually inject into a specific agent.
 * - Filters out anything that isn't `compatible`.
 * - For each compatible skill, also requires that every entry in
 *   skill.allowedTools is in the agent's toolIds. If not, drop the skill
 *   for THIS agent (its compatibility against the global tool registry is
 *   still 'compatible', but it is not bindable to this specific agent).
 * - Importantly, the agent's toolIds is never widened by what a skill
 *   requests — we only check the INTERSECTION.
 */
export function resolveSkillsForAgent(agentId: string, ids: string[]): SkillDefinition[] {
  const def = getAgentDefinition(agentId);
  if (!def) return [];
  const agentToolIds = new Set(def.toolIds ?? []);
  const registeredToolIds = new Set(listToolDefinitions().map((t) => t.id));
  return ids
    .map((id) => getSkill(id))
    .filter((s): s is SkillDefinition => {
      if (!s) return false;
      if (s.compatibility !== 'compatible') return false;
      if (s.allowedTools && s.allowedTools.length > 0) {
        for (const t of s.allowedTools) {
          if (!registeredToolIds.has(t)) return false; // tool gone from registry
          if (!agentToolIds.has(t)) return false; // agent not authorized for tool
        }
      }
      return true;
    });
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
  // Refresh registry (filesystem discovery is rerun as part of this)
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
    // Non-compatible skills (e.g. requires-runtime from shipping scripts) MUST
    // never be bound — they could otherwise smuggle executable code into the
    // agent runtime.
    throw new Error(`Skill 不兼容 (${skill.compatibility})，无法绑定。`);
  }
  // allowed-tools intersection check: the agent must have every requested
  // tool in its own toolIds. The skill MUST NOT widen the agent's authz.
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

/**
 * Returns the canonical absolute path of the market-skills directory. Used by
 * the uninstall path to verify a target is strictly under this root.
 */
export function getMarketSkillsRootAbsolute(): string {
  return resolve(MARKET_SKILLS_DIR);
}

/** Returns true iff `target` resolves to a path strictly under `root`. */
export function isPathStrictlyUnder(target: string, root: string): boolean {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  if (resolvedTarget === resolvedRoot) return false; // root itself is not "under"
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === '' || rel.startsWith('..')) return false;
  return true;
}

export function listInstalledAgentIds(): string[] {
  return listAgentDefinitions().map((d) => d.id);
}

// Initialize
loadBuiltinSkills();
