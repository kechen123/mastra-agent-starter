import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMarketSkillsDir, saveInstalledSkill, removeInstalledSkill, loadInstalledSkills, getSkill } from './registry.js';

export interface MarketSkillInfo {
  id: string;
  name: string;
  description: string;
  source: string;
  owner: string;
  repo: string;
  compatibility: 'compatible' | 'requires-runtime' | 'unsupported' | 'unknown';
  hasScripts: boolean;
  installable: boolean;
}

export interface SkillPreview {
  id: string;
  name: string;
  description: string;
  source: string;
  skillMd: string;
  compatibility: 'compatible' | 'requires-runtime' | 'unsupported' | 'unknown';
  files: string[];
  hasScripts: boolean;
}

const MARKET_ORIGIN = 'https://raw.githubusercontent.com';

function sanitizePathSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, '');
}

function detectCompatibility(skillMd: string, files: string[]): SkillPreview['compatibility'] {
  const hasScripts = files.some((f) =>
    f.startsWith('scripts/') || /\.(sh|py|js|ts|mjs|cjs)$/.test(f),
  );
  if (hasScripts) return 'requires-runtime';
  const allowedToolsMatch = skillMd.match(/allowed-tools:\s*\n?\s*-\s*(\S+)/);
  if (allowedToolsMatch) {
    // If there are allowed-tools but no corresponding tools in registry, requires-runtime
    // Actual runtime check will happen during binding
  }
  return 'compatible';
}

export async function searchMarketSkills(query: string): Promise<MarketSkillInfo[]> {
  // Use GitHub search API via MCP if available; fallback to scanning local market cache
  // For now: return empty with note that market search requires external provider
  return [];
}

export async function previewMarketSkill(owner: string, repo: string): Promise<SkillPreview | null> {
  const safeOwner = sanitizePathSegment(owner);
  const safeRepo = sanitizePathSegment(repo);
  const id = `${safeOwner}/${safeRepo}`;

  try {
    const skillMdUrl = `${MARKET_ORIGIN}/${safeOwner}/${safeRepo}/main/SKILL.md`;
    const response = await fetch(skillMdUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      return null;
    }
    const skillMd = await response.text();

    // Parse minimal metadata from SKILL.md header
    const nameMatch = skillMd.match(/^#\s+(.+)/m);
    const descMatch = skillMd.match(/##?\s*描述\s*\n+(.+)/m) || skillMd.match(/##?\s*Description\s*\n+(.+)/m);
    const name = nameMatch?.[1]?.trim() || safeRepo;
    const description = descMatch?.[1]?.trim() || '';

    // Assume typical structure for preview; real file listing would need GH API
    const files = ['SKILL.md'];
    const hasScripts = /scripts|shell|bash|python|node|cli/i.test(skillMd);
    const compatibility = detectCompatibility(skillMd, files);

    return {
      id,
      name,
      description,
      source: `github:${id}`,
      skillMd,
      compatibility,
      files,
      hasScripts,
    };
  } catch {
    return null;
  }
}

export async function installMarketSkill(owner: string, repo: string): Promise<SkillPreview> {
  const preview = await previewMarketSkill(owner, repo);
  if (!preview) {
    throw new Error('无法获取 Skill 预览，请检查仓库是否存在。');
  }

  const dir = join(getMarketSkillsDir(), sanitizePathSegment(owner), sanitizePathSegment(repo));
  mkdirSync(dir, { recursive: true });

  const skillMdPath = join(dir, 'SKILL.md');
  writeFileSync(skillMdPath, preview.skillMd, 'utf-8');

  const installable = preview.compatibility === 'compatible';
  await saveInstalledSkill(
    preview.id,
    preview.name,
    preview.description,
    'marketplace',
    dir,
    preview.compatibility,
    preview.hasScripts,
    { source: preview.source, installable },
  );
  await loadInstalledSkills();

  return preview;
}

export async function updateMarketSkill(id: string): Promise<SkillPreview | null> {
  const skill = getSkill(id);
  if (!skill || skill.source !== 'marketplace') {
    throw new Error('仅支持更新市场来源的 Skill。');
  }
  const parts = id.split('/');
  if (parts.length !== 2) {
    throw new Error('Skill ID 格式无效。');
  }
  const [owner, repo] = parts;
  return installMarketSkill(owner, repo);
}

export async function uninstallMarketSkill(id: string): Promise<void> {
  const skill = getSkill(id);
  if (!skill) {
    throw new Error('Skill 未安装。');
  }
  if (skill.source === 'builtin') {
    throw new Error('内置 Skill 不能卸载。');
  }

  // Remove runtime files
  if (existsSync(skill.location)) {
    rmSync(skill.location, { recursive: true, force: true });
  }

  // Remove DB record and bindings
  await removeInstalledSkill(id);
}
