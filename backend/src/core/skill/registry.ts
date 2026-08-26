/**
 * Skill 注册表门面。
 *
 * 这一层只承担四件事：
 *   1. 持有 `builtin / local / installed` 三张内存索引；
 *   2. 暴露一次性的幂等加载入口（ensureSkillRegistryLoaded）；
 *   3. 暴露 getSkill / listSkills 给上游路由 + bootstrap；
 *   4. 把 parser / compatibility / discovery / bindings 的导出名 re-export 出去，
 *      保持历史 import 路径不变（兼容性是契约的一部分）。
 *
 * 拆分后：
 *   - parser.ts        : allowed-tools / name / description 解析（纯函数）
 *   - compatibility.ts : 文件清单 → hasScripts/hasExecutableExt → compatibility
 *   - discovery.ts     : 文件系统扫描（含 _template 跳过；详见 readSkillMdEntries）
 *   - bindings.ts      : Agent ↔ Skill 绑定 + 已安装项的 DB CRUD
 *
 * _template 跳过：位于 `discovery.ts` 的 `readSkillMdEntries` 中显式 continue，
 * 保证模板不会被错误地暴露给前端或 API。详见：
 *   - discovery.ts 中 `if (id === '_template') continue;`
 *   - tests/contracts/run.ts 中对该源码文本的校验。
 */
import { createSkill, type InlineSkill } from '@mastra/core/skills';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { listAgentDefinitions } from '../agent/registry.js';
import {
  BUILTIN_SKILLS_DIR,
  LOCAL_SKILLS_DIR,
  MARKET_SKILLS_DIR,
  type SkillDefinition,
  classifyFromFiles,
  deriveAllowedTools,
  discoverLocalSkills,
  discoverMarketplaceSkills,
  getMarketSkillsDir,
  getMarketSkillsRootAbsolute,
  isPathStrictlyUnder,
  listFilesRecursive,
  loadBuiltinSkills,
  parseSkillMdMeta,
} from './discovery.js';
import {
  parseAllowedToolsFromFrontmatter,
} from './parser.js';
import { analyzeCompatibility } from './compatibility.js';
import {
  setSkillLookup,
  resolveSkillsForAgent,
  bindSkillToAgent,
  unbindSkillFromAgent,
  getAgentSkillBindings,
  _setBindingsPoolForTesting,
} from './bindings.js';

// ─────────────────────────────────────────────────────────────────────────
// 重新导出——保持现有 import 路径与单元测试 fixture 不变
// ─────────────────────────────────────────────────────────────────────────
export {
  BUILTIN_SKILLS_DIR,
  LOCAL_SKILLS_DIR,
  MARKET_SKILLS_DIR,
  type SkillDefinition,
  classifyFromFiles,
  deriveAllowedTools,
  discoverLocalSkills,
  discoverMarketplaceSkills,
  getMarketSkillsDir,
  getMarketSkillsRootAbsolute,
  isPathStrictlyUnder,
  listFilesRecursive,
  loadBuiltinSkills,
  parseSkillMdMeta,
  parseAllowedToolsFromFrontmatter,
  analyzeCompatibility,
  resolveSkillsForAgent,
  bindSkillToAgent,
  unbindSkillFromAgent,
  getAgentSkillBindings,
  _setBindingsPoolForTesting,
};

// ─────────────────────────────────────────────────────────────────────────
// 内存注册表 + 加载闸门
// ─────────────────────────────────────────────────────────────────────────
const builtinSkills = new Map<string, SkillDefinition>();
const installedSkills = new Map<string, SkillDefinition>();
const localSkills = new Map<string, SkillDefinition>();

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
 * 幂等的加载入口。首次触发、并发共享同一个 Promise；成功后所有后续调用
 * 直接 resolve。如果加载失败，回滚快照并清空闸门，下一次调用者可以重试。
 *
 * 注意：直接返回缓存的 Promise 而不是包一层 `async`，让调用方可以用
 * `p1 === p2` 观察到并发共享——便于离线契约测试与外部链路等待。
 */
export function ensureSkillRegistryLoaded(): Promise<void> {
  if (hydrationCompleted) return Promise.resolve();
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

// 让 bindings 模块通过 closure 访问 getSkill，保持单点查询
setSkillLookup(getSkill);

// ─────────────────────────────────────────────────────────────────────────
// 内置 / 本地 Skills 列表
// ─────────────────────────────────────────────────────────────────────────
function loadIntoBuiltin(): void {
  loadBuiltinSkills(builtinSkills);
}

function loadIntoLocal(): void {
  discoverLocalSkills(localSkills);
}

/**
 * 单次、可等待的 hydration。DB 错误必须向外抛出，确保
 * `ensureSkillRegistryLoaded()` 能拒绝并清除 in-flight Promise，
 * 让后续调用可以重试；不允许把"部分列表"伪装成完整注册表。
 *
 * 数据库错误即视为"加载失败"——文件系统部分（builtin / local / marketplace）
 * 在重试前会被 `restoreRegistry` 一起回滚，调用方始终看到一致的视图。
 */
async function hydrateInstalledFromDb(): Promise<void> {
  const pool = getDatabasePool();
  const result = await pool.query<{
    id: string;
    name: string;
    description: string;
    source: string;
    location: string;
    compatibility: string;
    has_scripts: boolean;
    metadata: unknown;
    allowed_tools?: string[];
  }>(
    `SELECT id, name, description, source, location, compatibility, has_scripts, metadata, allowed_tools FROM skills_installed ORDER BY installed_at DESC`,
  );
  for (const row of result.rows) {
    // 每次加载都重新读盘：DB 中的 has_scripts 可能是过期的（例如卸载后
    // 文件残留，或安装后被外部放入新脚本）。
    let files: string[] = [];
    if (row.location && existsSync(row.location)) {
      files = listFilesRecursive(row.location);
    }
    const { hasScripts, hasExecutableExt } = classifyFromFiles(files);
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
            ...((row.metadata as Record<string, unknown>) ?? {}),
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
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      skill,
    });
  }
}

/**
 * 默认 loader：刷新 builtin / local / installed 三张索引，全程单次可等待。
 *
 * 顺序：
 *  1. builtin / local 是纯文件系统扫描，失败概率极低，错误会向上抛。
 *  2. marketplace 同样纯文件系统，写入 `installedSkills` Map。
 *  3. `hydrateInstalledFromDb()` 是单次可等待的 DB 查询；它的失败
 *     会让 `ensureSkillRegistryLoaded` 进入"未完成 + in-flight 已清空"
 *     状态，下次调用可以重试。
 *
 * 不能再次 fire-and-forget 调用 `hydrateInstalledFromDb`——那会触发
 * 两次 DB hydration，且把第二次的错误吞掉。
 */
export async function loadInstalledSkills(): Promise<void> {
  loadIntoBuiltin();
  loadIntoLocal();
  installedSkills.clear();
  discoverMarketplaceSkills(installedSkills);
  await hydrateInstalledFromDb();
}

// ─────────────────────────────────────────────────────────────────────────
// 已安装项 CRUD（仍由本文件直接持有——它们和 hydration 的语义同源）
// ─────────────────────────────────────────────────────────────────────────
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

export function listInstalledAgentIds(): string[] {
  return listAgentDefinitions().map((d) => d.id);
}

// ─────────────────────────────────────────────────────────────────────────
// 查询接口
// ─────────────────────────────────────────────────────────────────────────
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
