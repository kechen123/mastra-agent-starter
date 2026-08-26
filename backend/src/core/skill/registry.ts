import { createSkill } from '@mastra/core/skills';
import type { InlineSkill } from '@mastra/core/skills';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { getAgentDefinition, listAgentDefinitions } from '../agent/registry.js';
import { listToolDefinitions } from '../tool/registry.js';

/**
 * SkillDefinition：注册表中的最小可用单元。
 *
 * - source：builtin（仓库内置）、local（业务方直接放盘）、marketplace（市场安装）。
 * - compatibility：
 *   - compatible：可被绑定并注入；
 *   - requires-runtime：含脚本/可执行扩展名，禁止绑定；
 *   - unsupported / unknown：未通过兼容性检查。
 * - `skill`：真正传给 Mastra 的 InlineSkill。
 *   非 compatible 时为 null，前端只展示不能绑定。
 */
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
  skill: InlineSkill | null; // null 表示非 compatible / requires-runtime
}

/**
 * 三个真实目录：
 * - builtin：仓库内置（随源码发布，删除风险低）。
 * - local  ：业务方手动放入 `backend/src/skills/local/<id>/`。
 * - marketplace：市场安装到 `backend/market-skills/<owner>/<repo>/<skillName>/`。
 *
 * 使用 fileURLToPath 把 file:///C:/... 转成系统原生路径，避免依赖
 * new URL(...).pathname 的不一致行为。
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const BUILTIN_SKILLS_DIR = resolve(HERE, '../../skills/builtin');
const LOCAL_SKILLS_DIR = resolve(HERE, '../../skills/local');
const MARKET_SKILLS_DIR = fileURLToPath(new URL('../../../../market-skills', import.meta.url));

/**
 * 内存注册表。DB 只承担"绑定关系 + 安装元数据"的角色，
 * 真实文件是否存在以文件系统为准——一旦 SKILL.md 被删除，DB 行也失去意义。
 */
const builtinSkills = new Map<string, SkillDefinition>();
const installedSkills = new Map<string, SkillDefinition>();
const localSkills = new Map<string, SkillDefinition>();

// ─────────────────────────────────────────────────────────────────────────
// 加载闸门
// ─────────────────────────────────────────────────────────────────────────
//
// 任何"读取已安装 Skill"的路由 / Runtime 都必须在最前面 await ensureSkillRegistryLoaded()。
// 首次调用者会触发一个共享 Promise，其他并发调用者等待同一个 Promise——
// 保证 Skill 注册表只被真正加载一次。
//
// 失败时回滚到加载前的快照：避免一次瞬时的 DB 错误让整个可用列表消失；
// 并清空 in-flight Promise 让下次调用可以重试。
//
// 启动期的 preloadSkillRegistry() 只是非阻塞的优化；任何路径的"正确性"
// 都不得依赖该 preload 提前完成。

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
 * 幂等的加载入口。首次触发、并发共享同一个 Promise；
 * 成功后所有后续调用直接 resolve。如果加载失败，回滚快照并清空闸门，
 * 下次调用者可以重试。
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
      restoreRegistry(snap);
      hydrationPromise = null;
      throw err;
    }
  })();
  return hydrationPromise;
}

/** 启动期非阻塞预加载。任何路径正确性都不依赖此项。 */
export function preloadSkillRegistry(): void {
  void ensureSkillRegistryLoaded().catch((err) => {
    console.error('[boot] failed to pre-load installed skills:', err);
  });
}

/** 是否至少成功加载过一次。 */
export function isSkillRegistryLoaded(): boolean {
  return hydrationCompleted;
}

/**
 * @internal 测试钩子。仅 tests/fixtures 用于注入计数器加载器，
 * 避免在单测里连接真实 PostgreSQL。传 null 恢复生产 loader。
 */
export function _setSkillRegistryLoaderForTesting(loader: RegistryLoader | null): void {
  activeLoader = loader ?? loadInstalledSkills;
  hydrationPromise = null;
  hydrationCompleted = false;
}

/**
 * 用 basename 匹配脚本扩展名（不要对完整路径匹配，避免把名为 "tools.sh" 的
 * 普通目录当成脚本）。
 */
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
  // 任意路径段等于 "scripts" 即视为存在 scripts/ 目录（顶层或嵌套均可，
  // 例 "lib/scripts" / "a/b/scripts/x"）。
  const normalized = relativePath.replace(/[\\/]/g, sep);
  return normalized.split(sep).some((seg) => seg === 'scripts');
}

/**
 * 递归遍历 Skill 目录，输出相对路径列表。
 * - 文件使用完整相对路径（统一正斜杠）。
 * - 名为 `scripts` 的目录（任何深度）整体输出，供上层判定。
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
 * 根据文件清单判断是否包含脚本：
 * - hasScripts：任意深度存在 `scripts/` 目录；
 * - hasExecutableExt：任意目录中存在可执行扩展名的文件。
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
 * 从 SKILL.md frontmatter 中解析 allowed-tools。
 *
 * 支持两种格式：
 * 1. 内联数组：`allowed-tools: [calculator, get-current-time]`
 * 2. YAML 列表：
 *    allowed-tools:
 *      - calculator
 *      - get-current-time
 *
 * 文档与示例必须与本函数支持的格式保持一致，否则会被解析为空。
 */
export function parseAllowedToolsFromFrontmatter(content: string): string[] {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const body = fmMatch[1] ?? '';

  const keyMatch = body.match(/^[ \t]*allowed-tools[ \t]*:[ \t]*(.*)$/m);
  if (!keyMatch) return [];
  const keyOffset = (keyMatch.index ?? 0) + keyMatch[0].length;

  const inlineValue = (keyMatch[1] ?? '').trim();
  if (inlineValue) {
    return parseInlineAllowedTools(inlineValue);
  }

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
  if (r.startsWith('[') && r.endsWith(']')) {
    r = r.slice(1, -1);
  }
  return r
    .split(',')
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0);
}

/**
 * 从 SKILL.md 重新推导 allowed-tools。frontmatter 优先级高于 DB 列，
 * 让现场修改 SKILL.md 后下次加载立即生效——文件系统是权威来源。
 */
export function deriveAllowedTools(skillMdPath: string, persisted?: string[] | null): string[] {
  if (existsSync(skillMdPath)) {
    try {
      const content = readFileSync(skillMdPath, 'utf-8');
      const parsed = parseAllowedToolsFromFrontmatter(content);
      if (parsed.length > 0) return parsed;
    } catch {
      // 解析失败时静默回退到 DB 列
    }
  }
  return persisted ?? [];
}

/**
 * 计算 Skill 的最终兼容性。
 *
 * 规则（按顺序）：
 *  1. 任意可执行文件（scripts/ 目录或任意位置的脚本扩展名文件）
 *     → `requires-runtime`（不可绑定、不可注入）。
 *  2. Skill 请求的 allowed-tools 未在 Tool Registry 注册
 *     → `requires-runtime`（无法履约）。
 *  3. Skill 请求的 allowed-tools 已注册，但绑定时目标 Agent 的 toolIds 没有
 *     → 针对该 Agent 是 `requires-runtime`（对其他 Agent 仍可 compatible）。
 *  4. 其它情况 → `compatible`。
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

/**
 * 解析 SKILL.md 中最小 frontmatter 字段（name、description）。
 * 仅 builtin / local 发现流程使用——SKILL.md 是权威来源。
 */
function parseSkillMdMeta(content: string): { name: string; description: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  let name = '';
  let description = '';
  if (fmMatch) {
    const body = fmMatch[1] ?? '';
    const nameMatch = body.match(/^[ \t]*name[ \t]*:[ \t]*(.+?)[ \t]*$/m);
    if (nameMatch) name = stripQuotes(nameMatch[1]?.trim() ?? '');
    const descMatch = body.match(/^[ \t]*description[ \t]*:[ \t]*(.+?)[ \t]*$/m);
    if (descMatch) description = stripQuotes(descMatch[1]?.trim() ?? '');
  }
  // 回退：H1 标题或首段 blockquote
  if (!name) {
    const h1 = content.match(/^#\s+(.+)/m);
    if (h1) name = h1[1]?.trim() ?? '';
  }
  if (!description) {
    const descLine = content.match(/^>\s*(.+)/m);
    if (descLine) description = descLine[1]?.trim() ?? '';
  }
  return { name, description };
}

function readSkillMdEntries(rootDir: string): { id: string; dir: string }[] {
  if (!existsSync(rootDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return [];
  }
  const result: { id: string; dir: string }[] = [];
  for (const id of entries) {
    const dir = join(rootDir, id);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    // 跳过 _template：模板仅给开发者参考，绝不允许被当作 Skill 注册，
    // 否则会被前端/API 看到一份"未完成"的占位。
    if (id === '_template') continue;
    const skillMd = join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    result.push({ id, dir });
  }
  return result;
}

function buildSkillFromDir(
  id: string,
  dir: string,
  source: 'builtin' | 'local' | 'marketplace',
): SkillDefinition | null {
  const skillMd = join(dir, 'SKILL.md');
  let content: string;
  try {
    content = readFileSync(skillMd, 'utf-8');
  } catch {
    return null;
  }
  const files = listFilesRecursive(dir);
  const allowedTools = deriveAllowedTools(skillMd);
  const { compatibility } = analyzeCompatibility(files, allowedTools);
  const { hasScripts, hasExecutableExt } = classifyFromFiles(files);
  const meta = parseSkillMdMeta(content);
  let skill: InlineSkill | null = null;
  if (compatibility === 'compatible') {
    skill = createSkill({
      name: meta.name || id,
      description: meta.description || `${id} (${source})`,
      instructions: content,
      compatibility: ['compatible'],
      metadata: { source, ...(allowedTools.length > 0 ? { 'allowed-tools': allowedTools } : {}) },
      ...(allowedTools.length > 0 ? { 'allowed-tools': allowedTools } : {}),
    });
  }
  return {
    id,
    name: meta.name || id,
    description: meta.description || `${id} (${source})`,
    source,
    location: dir,
    compatibility,
    instructions: content,
    files,
    hasScripts: hasScripts || hasExecutableExt,
    allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
    metadata: { source, filesystem: true },
    skill,
  };
}

export function loadBuiltinSkills(): void {
  builtinSkills.clear();
  for (const { id, dir } of readSkillMdEntries(BUILTIN_SKILLS_DIR)) {
    const def = buildSkillFromDir(id, dir, 'builtin');
    if (def) builtinSkills.set(id, def);
  }
}

/** 发现 `skills/local/<id>/` 下手动放置的 SKILL.md。 */
export function discoverLocalSkills(): void {
  localSkills.clear();
  for (const { id, dir } of readSkillMdEntries(LOCAL_SKILLS_DIR)) {
    const def = buildSkillFromDir(id, dir, 'local');
    if (def) localSkills.set(id, def);
  }
}

/**
 * 发现 `backend/market-skills/<owner>/<repo>/<skillName>/` 下的市场 Skill。
 *
 * Market Skill 也同时记录在 `skills_installed` DB 表里。文件系统扫描的
 * 意义是补充 DB 索引：
 * - DB 行丢失但文件还在；
 * - 通过文件系统直接物化的安装（不走安装 API）。
 *
 * 目录层级不超过 3 层（owner/repo/skillName），更深的层级直接忽略，
 * 与安装契约保持一致。
 */
export function discoverMarketplaceSkills(): void {
  if (!existsSync(MARKET_SKILLS_DIR)) return;
  // 仅遍历 3 层：owner / repo / skillName，更深层视为越界。
  let owners: string[];
  try {
    owners = readdirSync(MARKET_SKILLS_DIR);
  } catch {
    return;
  }
  for (const owner of owners) {
    const ownerDir = join(MARKET_SKILLS_DIR, owner);
    let st;
    try {
      st = statSync(ownerDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let repos: string[];
    try {
      repos = readdirSync(ownerDir);
    } catch {
      continue;
    }
    for (const repo of repos) {
      const repoDir = join(ownerDir, repo);
      let st2;
      try {
        st2 = statSync(repoDir);
      } catch {
        continue;
      }
      if (!st2.isDirectory()) continue;
      let skillNames: string[];
      try {
        skillNames = readdirSync(repoDir);
      } catch {
        continue;
      }
      for (const skillName of skillNames) {
        const dir = join(repoDir, skillName);
        let st3;
        try {
          st3 = statSync(dir);
        } catch {
          continue;
        }
        if (!st3.isDirectory()) continue;
        const skillMd = join(dir, 'SKILL.md');
        if (!existsSync(skillMd)) continue;
        const id = `${owner}/${repo}/${skillName}`;
        const def = buildSkillFromDir(id, dir, 'marketplace');
        if (def) installedSkills.set(id, def);
      }
    }
  }
}

export async function loadInstalledSkills(): Promise<void> {
  installedSkills.clear();
  discoverLocalSkills();
  discoverMarketplaceSkills();
  const pool = getDatabasePool();
  const result = await pool.query<
    { id: string; name: string; description: string; source: string; location: string; compatibility: string; has_scripts: boolean; metadata: unknown; allowed_tools?: string[] }
  >(
    `SELECT id, name, description, source, location, compatibility, has_scripts, metadata, allowed_tools FROM skills_installed ORDER BY installed_at DESC`,
  );
  for (const row of result.rows) {
    // 每次加载都重新读盘，DB 中的 has_scripts 可能是过期的：
    // 例如卸载后文件残留，或安装后被外部放入新脚本。
    let files: string[] = [];
    if (row.location && existsSync(row.location)) {
      files = listFilesRecursive(row.location);
    }
    const { hasScripts, hasExecutableExt } = classifyFromFiles(files);

    // 文件系统是权威：发现脚本 → 直接升级为 requires-runtime。
    const diskSaysExecutable = hasScripts || hasExecutableExt;

    // 重新从 SKILL.md 解析 allowed-tools，DB 列仅作为兜底。
    const skillMdPath = join(row.location, 'SKILL.md');
    const allowedTools = deriveAllowedTools(skillMdPath, row.allowed_tools ?? null);

    // 综合"磁盘证据 + frontmatter"重新分类。
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
 * 解析"实际注入到某个 Agent"的 Skill 列表：
 * - 只保留 compatibility === 'compatible' 的 Skill。
 * - 对每个 compatible Skill，要求其 allowedTools 全部命中 Agent 的 toolIds。
 *   否则针对该 Agent 丢弃该 Skill。
 *
 * 注：Skill 永远不能扩展 Agent 的 toolIds，所有越权请求必须降级为
 * `requires-runtime` 或在解析阶段被丢弃。
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
          if (!registeredToolIds.has(t)) return false;
          if (!agentToolIds.has(t)) return false;
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
  await pool.query(`DELETE FROM agent_skill_bindings WHERE skill_id = $1`, [id]);
  await pool.query(`DELETE FROM skills_installed WHERE id = $1`, [id]);
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

export function getMarketSkillsRootAbsolute(): string {
  return resolve(MARKET_SKILLS_DIR);
}

/** target 必须严格位于 root 之下（不允许 root 自身或更外层路径）。 */
export function isPathStrictlyUnder(target: string, root: string): boolean {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  if (resolvedTarget === resolvedRoot) return false;
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === '' || rel.startsWith('..')) return false;
  return true;
}

export function listInstalledAgentIds(): string[] {
  return listAgentDefinitions().map((d) => d.id);
}