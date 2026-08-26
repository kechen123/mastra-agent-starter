import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  searchSkillsSh,
  getPopularSkillsSh,
  previewSkillsSh,
  fetchSkillFiles,
  assertSafeSkillName,
  assertSafeFilePath,
  type SkillsShSkillSummary,
} from '@mastra/server/handlers/skills-sh-shared';
import {
  getMarketSkillsDir,
  getMarketSkillsRootAbsolute,
  isPathStrictlyUnder,
  saveInstalledSkill,
  removeInstalledSkill,
  loadInstalledSkills,
  getSkill,
  // Shared classification + parsing + compatibility — single source of truth.
  classifyFromFiles,
  parseAllowedToolsFromFrontmatter,
  analyzeCompatibility,
  listFilesRecursive,
} from './registry.js';

export interface MarketSkillInfo {
  id: string;
  owner: string;
  repo: string;
  skillName: string;
  name: string;
  description: string;
  source: string;
  installs: number;
  compatibility: 'compatible' | 'requires-runtime' | 'unsupported' | 'unknown';
  hasScripts: boolean;
  installable: boolean;
}

/**
 * Preview/install result. Allowed-tools, compatibility and reason MUST be the
 * same values that the registry will compute after install — both come from
 * the shared `analyzeCompatibility` helper so callers see a single contract.
 */
export interface SkillPreview {
  id: string;
  owner: string;
  repo: string;
  skillName: string;
  name: string;
  description: string;
  source: string;
  skillMd: string;
  compatibility: 'compatible' | 'requires-runtime' | 'unsupported' | 'unknown';
  reason: string;
  files: string[];
  hasScripts: boolean;
  allowedTools?: string[];
}

/** Resolve the on-disk directory used to materialise market-installed skills. */
function marketRoot(): string {
  // MARKET_SKILLS_DIR is built via new URL('../../../market-skills', import.meta.url).pathname.
  // fileURLToPath() is used here for Windows-safe path handling.
  const fallback = fileURLToPath(new URL('../../../market-skills', import.meta.url));
  return existsSync(fallback) ? fallback : getMarketSkillsDir();
}

function parseSkillId(id: string): { owner: string; repo: string; skillName: string } | null {
  const parts = id.split('/');
  if (parts.length !== 3) return null;
  try {
    return {
      owner: assertSafeSkillName(parts[0]!),
      repo: assertSafeSkillName(parts[1]!),
      skillName: assertSafeSkillName(parts[2]!),
    };
  } catch {
    return null;
  }
}

function summariseContent(content: string): { name: string; description: string } {
  const nameMatch = content.match(/^#\s+(.+)/m);
  const descMatch = content.match(/^>\s*(.+)/m) || content.match(/^description:\s*(.+)/im);
  return {
    name: nameMatch?.[1]?.trim() ?? '',
    description: descMatch?.[1]?.trim() ?? '',
  };
}

export interface SearchOptions {
  limit?: number;
}

export async function searchMarketSkills(query: string, options: SearchOptions = {}): Promise<MarketSkillInfo[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const result = await searchSkillsSh({ q: query, limit });
  return result.skills.map((s) => summaryToInfo(s));
}

export async function listPopularMarketSkills(options: SearchOptions = {}): Promise<MarketSkillInfo[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const result = await getPopularSkillsSh({ limit, offset: 0 });
  return result.skills.map((s) => summaryToInfo(s));
}

function summaryToInfo(summary: SkillsShSkillSummary): MarketSkillInfo {
  const parsed = parseSkillId(summary.id);
  if (!parsed) {
    // skills.sh should always return well-formed ids; bail with unknown compatibility.
    return {
      id: summary.id,
      owner: '',
      repo: '',
      skillName: summary.id,
      name: summary.name,
      description: '',
      source: summary.topSource,
      installs: summary.installs,
      compatibility: 'unknown',
      hasScripts: false,
      installable: false,
    };
  }
  return {
    id: summary.id,
    owner: parsed.owner,
    repo: parsed.repo,
    skillName: parsed.skillName,
    name: summary.name,
    description: '',
    source: summary.topSource,
    installs: summary.installs,
    compatibility: 'unknown',
    hasScripts: false,
    installable: false,
  };
}

/**
 * Build a SkillPreview purely from the on-disk-equivalent inputs returned by
 * skills.sh (file paths + SKILL.md body). Uses the SAME helpers that
 * loadInstalledSkills() uses after install, so the preview's compatibility is
 * guaranteed to match what the registry will store once files are written.
 *
 * Empty `scripts/` directories and any other shape that the registry treats
 * as requires-runtime WILL appear here too — the classification logic is
 * identical to the one applied after materialisation.
 */
function buildPreview(
  id: string,
  owner: string,
  repo: string,
  skillName: string,
  rawFilePaths: string[],
  skillMd: string,
): SkillPreview {
  const filePaths = rawFilePaths.map((p) => assertSafeFilePath(p));
  const { hasScripts } = classifyFromFiles(filePaths);
  const allowedTools = parseAllowedToolsFromFrontmatter(skillMd);
  const { compatibility, reason } = analyzeCompatibility(filePaths, allowedTools);
  const summary = summariseContent(skillMd);
  return {
    id,
    owner,
    repo,
    skillName,
    name: summary.name || skillName,
    description: summary.description,
    source: `skills.sh:${id}`,
    skillMd,
    compatibility,
    reason,
    files: filePaths,
    hasScripts,
    allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
  };
}

export async function previewMarketSkill(owner: string, repo: string, skillName: string): Promise<SkillPreview | null> {
  const safeOwner = assertSafeSkillName(owner);
  const safeRepo = assertSafeSkillName(repo);
  const safeSkillName = assertSafeSkillName(skillName);
  const id = `${safeOwner}/${safeRepo}/${safeSkillName}`;

  const [previewResponse, filesResponse] = await Promise.all([
    previewSkillsSh({ owner: safeOwner, repo: safeRepo, skillName: safeSkillName }),
    fetchSkillFiles(safeOwner, safeRepo, safeSkillName),
  ]);
  if (!filesResponse) {
    return null;
  }

  return buildPreview(
    id,
    safeOwner,
    safeRepo,
    safeSkillName,
    filesResponse.files.map((f) => f.path),
    previewResponse.content,
  );
}

export async function installMarketSkill(owner: string, repo: string, skillName: string): Promise<SkillPreview> {
  const preview = await previewMarketSkill(owner, repo, skillName);
  if (!preview) {
    throw new Error('无法获取 Skill 详情，请确认 owner/repo/skillName 是否正确。');
  }

  const root = marketRoot();
  const dir = join(root, preview.owner, preview.repo, preview.skillName);
  mkdirSync(dir, { recursive: true });

  // Re-fetch files with content to materialise them locally. Always sanitise the
  // returned paths so a malicious upstream response cannot write outside `dir`.
  const filesResponse = await fetchSkillFiles(preview.owner, preview.repo, preview.skillName);
  if (!filesResponse) {
    throw new Error('Skill 文件列表获取失败。');
  }
  for (const entry of filesResponse.files) {
    const safeRel = assertSafeFilePath(entry.path);
    const target = join(dir, safeRel);
    if (!target.startsWith(dir)) {
      throw new Error(`非法文件路径：${entry.path}`);
    }
    mkdirSync(join(target, '..'), { recursive: true });
    if (entry.encoding === 'base64') {
      const buffer = Buffer.from(entry.content, 'base64');
      writeFileSync(target, buffer);
    } else {
      writeFileSync(target, entry.content, 'utf-8');
    }
  }

  // ── Materialised-state re-classification ───────────────────────────────────
  // After writing to disk we re-scan the actual on-disk tree and re-derive
  // allowed-tools from the freshly-written SKILL.md. The compatibility
  // computed here MUST equal `preview.compatibility` — both come from the
  // shared `analyzeCompatibility` helper. If the on-disk result ever diverged
  // (e.g. a malicious server claims "compatible" but sends a `scripts/` dir),
  // the registry will be refreshed with the on-disk truth and the installable
  // flag below reflects that authoritative reading.
  const onDiskFiles = listFilesRecursive(dir);
  const skillMdPath = join(dir, 'SKILL.md');
  const onDiskAllowedTools = parseAllowedToolsFromFrontmatter(preview.skillMd);
  const onDiskAnalysis = analyzeCompatibility(onDiskFiles, onDiskAllowedTools);
  const finalCompatibility = onDiskAnalysis.compatibility;
  // `hasScripts` is a pure filesystem-evidence flag: it must reflect whether
  // the on-disk tree actually contains `scripts/` or executable-extension
  // files. We MUST NOT derive it from `finalCompatibility` — a missing or
  // unauthorized tool can make compatibility `requires-runtime` without
  // any executable artefacts present, and in that case `hasScripts` stays
  // `false` so the SKILL is treated as non-executable for the agent runtime.
  const { hasScripts, hasExecutableExt } = classifyFromFiles(onDiskFiles);
  const finalHasScripts = hasScripts || hasExecutableExt;
  const installable = finalCompatibility === 'compatible';

  await saveInstalledSkill(
    preview.id,
    preview.name,
    preview.description,
    'marketplace',
    dir,
    finalCompatibility,
    finalHasScripts,
    { source: preview.source, installable, reason: onDiskAnalysis.reason },
    onDiskAllowedTools.length > 0 ? onDiskAllowedTools : undefined,
  );
  await loadInstalledSkills();

  return {
    ...preview,
    compatibility: finalCompatibility,
    reason: onDiskAnalysis.reason,
    files: onDiskFiles,
    hasScripts: finalHasScripts,
    allowedTools: onDiskAllowedTools.length > 0 ? onDiskAllowedTools : preview.allowedTools,
  };
}

export async function updateMarketSkill(id: string): Promise<SkillPreview | null> {
  const skill = getSkill(id);
  if (!skill || skill.source !== 'marketplace') {
    throw new Error('仅支持更新市场来源的 Skill。');
  }
  const parsed = parseSkillId(id);
  if (!parsed) {
    throw new Error('Skill ID 格式无效，应为 owner/repo/skillName。');
  }
  return installMarketSkill(parsed.owner, parsed.repo, parsed.skillName);
}

export async function uninstallMarketSkill(id: string): Promise<void> {
  const skill = getSkill(id);
  if (!skill) {
    throw new Error('Skill 未安装。');
  }
  // Strict source check: ONLY marketplace skills can be uninstalled via this
  // path. builtin and local (filesystem-only) skills are NEVER recursed into.
  if (skill.source !== 'marketplace') {
    throw new Error(
      `仅 marketplace Skill 可卸载，当前 source='${skill.source}'。` +
        `builtin 与 local Skill 不通过此接口清理。`,
    );
  }
  if (!skill.location) {
    throw new Error('Skill 缺少 location，无法定位待删除目录。');
  }
  // Resolve the target to an absolute, canonical path and verify it lives
  // STRICTLY under backend/market-skills. Anything outside (e.g. a symlink
  // pointing at /etc or a row whose location was tampered with) is refused.
  const marketRoot = getMarketSkillsRootAbsolute();
  const absoluteTarget = resolve(skill.location);
  if (!isPathStrictlyUnder(absoluteTarget, marketRoot)) {
    throw new Error(
      `拒绝越界删除：${absoluteTarget} 不在 ${marketRoot} 之内。` +
        ` (relative='${relative(marketRoot, absoluteTarget)}')`,
    );
  }

  // Order is preserved: delete runtime files → drop DB rows → refresh registry.
  if (existsSync(absoluteTarget)) {
    rmSync(absoluteTarget, { recursive: true, force: true });
  }
  await removeInstalledSkill(id);
}