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
  enableWorkspaceSkill,
  removeInstalledSkill,
  loadInstalledSkills,
  getSkill,
  // 共用的分类、解析、兼容性逻辑是单一权威。
  classifyFromFiles,
  parseAllowedToolsFromFrontmatter,
  analyzeCompatibility,
  listFilesRecursive,
} from '../../core/skill/registry.js';

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
 * 预览 / 安装结果。
 *
 * 关键约定：allowed-tools、compatibility 与 reason 必须与注册表安装后真正
 * 计算的值完全一致——它们都来自共享的 `analyzeCompatibility`，调用方看到的
 * 就是同一份契约。
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

/**
 * 解析市场安装 Skill 的真实磁盘目录。
 *
 * 优先使用本仓库自带的 `backend/market-skills/`，仅在缺失时回退到
 * `core/skill/registry` 计算的目录，保证开发与生产环境行为一致。
 */
function marketRoot(): string {
  // FIX: const fallback = fileURLToPath(new URL('../../../market-skills', import.meta.url));
  // market-skills 位于 backend/market-skills/。从本文件
  // backend/src/infrastructure/external-skills/market.ts 出发，
  // 需要向上 ../../../market-skills（到 backend/，再进入 market-skills/）。
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
    // skills.sh 应当始终返回格式合规的 id；解析失败时降级为 unknown。
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
 * 仅用 skills.sh 返回的"类磁盘"输入（文件路径 + SKILL.md 内容）构造
 * SkillPreview。
 *
 * 关键点：与 `loadInstalledSkills()` 复用同一套 helper，保证预览阶段返回
 * 的 compatibility 与安装后注册表落库的值一致——用户所见即所得。
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

export async function installMarketSkill(workspaceId: string, owner: string, repo: string, skillName: string): Promise<SkillPreview> {
  const preview = await previewMarketSkill(owner, repo, skillName);
  if (!preview) {
    throw new Error('无法获取 Skill 详情，请确认 owner/repo/skillName 是否正确。');
  }

  const root = marketRoot();
  const dir = join(root, preview.owner, preview.repo, preview.skillName);
  mkdirSync(dir, { recursive: true });

  // 重新拉取带内容的文件列表进行本地物化。返回的路径一律 sanitize，
  // 防止恶意上游把内容写到 `dir` 之外。
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

  // ── 物化后重新分类 ─────────────────────────────────────────────────────
  // 用磁盘上的真实文件再跑一次分类与兼容性，避免预览与落库结果不一致。
  const onDiskFiles = listFilesRecursive(dir);
  const onDiskAllowedTools = parseAllowedToolsFromFrontmatter(preview.skillMd);
  const onDiskAnalysis = analyzeCompatibility(onDiskFiles, onDiskAllowedTools);
  const finalCompatibility = onDiskAnalysis.compatibility;
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
  await enableWorkspaceSkill(workspaceId, preview.id);
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

export async function updateMarketSkill(workspaceId: string, id: string): Promise<SkillPreview | null> {
  const skill = getSkill(id);
  if (!skill || skill.source !== 'marketplace') {
    throw new Error('仅支持更新市场来源的 Skill。');
  }
  const parsed = parseSkillId(id);
  if (!parsed) {
    throw new Error('Skill ID 格式无效，应为 owner/repo/skillName。');
  }
  return installMarketSkill(workspaceId, parsed.owner, parsed.repo, parsed.skillName);
}

export async function uninstallMarketSkill(id: string): Promise<void> {
  const skill = getSkill(id);
  if (!skill) {
    throw new Error('Skill 未安装。');
  }
  // 严格的来源校验：仅 marketplace Skill 可通过该路径卸载。
  // builtin / local（仅磁盘）永远不会被这里清理。
  if (skill.source !== 'marketplace') {
    throw new Error(
      `仅 marketplace Skill 可卸载，当前 source='${skill.source}'。` +
        `builtin 与 local Skill 不通过此接口清理。`,
    );
  }
  if (!skill.location) {
    throw new Error('Skill 缺少 location，无法定位待删除目录。');
  }
  // 把目标路径解析为绝对路径，并校验它"严格"位于 backend/market-skills 之下。
  // 越界情形（例如被篡改的 location 指向 /etc 或指向 symlink）会被拒绝。
  const marketRoot = getMarketSkillsRootAbsolute();
  const absoluteTarget = resolve(skill.location);
  if (!isPathStrictlyUnder(absoluteTarget, marketRoot)) {
    throw new Error(
      `拒绝越界删除：${absoluteTarget} 不在 ${marketRoot} 之内。` +
        ` (relative='${relative(marketRoot, absoluteTarget)}')`,
    );
  }

  // 顺序固定：先删运行时文件 → 再删 DB 行 → 最后刷新注册表。
  if (existsSync(absoluteTarget)) {
    rmSync(absoluteTarget, { recursive: true, force: true });
  }
  await removeInstalledSkill(id);
}
