/**
 * 基于文件系统的 Skill 发现。
 *
 * 三个根：
 *  - builtin：     `backend/src/skills/builtin/<id>/SKILL.md`（随源码发布）
 *  - local：       `backend/src/skills/local/<id>/SKILL.md`（业务方手动放入）
 *  - marketplace： `backend/market-skills/<owner>/<repo>/<skillName>/SKILL.md`
 *
 * 共同约束：
 *  - `_template` 永远不进入注册表（discovery.ts 的 readSkillMdEntries 已跳过）。
 *  - 文件系统是权威来源：已安装 Skill 重新加载时也必须重新扫描并校验兼容性。
 *  - 市场目录最多 3 层（owner/repo/skillName），更深的层级直接忽略。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkill, type InlineSkill } from '@mastra/core/skills';
import { parseAllowedToolsFromFrontmatter, parseSkillMdMeta } from './parser.js';
import { analyzeCompatibility, classifyFromFiles } from './compatibility.js';

export { classifyFromFiles, parseSkillMdMeta };

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
  skill: InlineSkill | null;
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const BUILTIN_SKILLS_DIR = resolve(HERE, '../../skills/builtin');
export const LOCAL_SKILLS_DIR = resolve(HERE, '../../skills/local');
export const MARKET_SKILLS_DIR = fileURLToPath(
  new URL('../../../../market-skills', import.meta.url),
);

/**
 * 递归遍历 Skill 目录，输出相对路径列表。
 * - 文件用完整相对路径（统一正斜杠）。
 * - 名为 `scripts` 的目录（任意深度）整体输出，供上层判定。
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
 * 从 SKILL.md 重新推导 allowed-tools。frontmatter 优先级高于 DB 列，
 * 这样现场修改 SKILL.md 后下次加载立即生效——文件系统是权威来源。
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

/** builtin：扫描 `backend/src/skills/builtin/<id>/SKILL.md`。 */
export function loadBuiltinSkills(target: Map<string, SkillDefinition>): void {
  target.clear();
  for (const { id, dir } of readSkillMdEntries(BUILTIN_SKILLS_DIR)) {
    const def = buildSkillFromDir(id, dir, 'builtin');
    if (def) target.set(id, def);
  }
}

/** local：扫描 `backend/src/skills/local/<id>/SKILL.md`。 */
export function discoverLocalSkills(target: Map<string, SkillDefinition>): void {
  target.clear();
  for (const { id, dir } of readSkillMdEntries(LOCAL_SKILLS_DIR)) {
    const def = buildSkillFromDir(id, dir, 'local');
    if (def) target.set(id, def);
  }
}

/**
 * marketplace：扫描 `backend/market-skills/<owner>/<repo>/<skillName>/`。
 * 目录层级不超过 3 层（owner/repo/skillName），更深的层级直接忽略。
 */
export function discoverMarketplaceSkills(target: Map<string, SkillDefinition>): void {
  if (!existsSync(MARKET_SKILLS_DIR)) return;
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
        if (def) target.set(id, def);
      }
    }
  }
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
