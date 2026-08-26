import { registerApiRoute } from '@mastra/core/server';
import {
  listSkills,
  getSkill,
  loadInstalledSkills,
  ensureSkillRegistryLoaded,
  bindSkillToAgent,
  unbindSkillFromAgent,
} from '../skills/registry.js';
import {
  previewMarketSkill,
  installMarketSkill,
  updateMarketSkill,
  uninstallMarketSkill,
  searchMarketSkills,
  listPopularMarketSkills,
  type MarketSkillInfo,
  type SkillPreview,
} from '../skills/market.js';
import { assertSafeSkillName } from '@mastra/server/handlers/skills-sh-shared';

function parseSkillTriple(input: unknown): { owner: string; repo: string; skillName: string } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { owner, repo, skillName } = input as Record<string, unknown>;
  if (typeof owner !== 'string' || typeof repo !== 'string' || typeof skillName !== 'string') return null;
  const trimmedOwner = owner.trim();
  const trimmedRepo = repo.trim();
  const trimmedSkill = skillName.trim();
  if (!trimmedOwner || !trimmedRepo || !trimmedSkill) return null;
  try {
    return {
      owner: assertSafeSkillName(trimmedOwner),
      repo: assertSafeSkillName(trimmedRepo),
      skillName: assertSafeSkillName(trimmedSkill),
    };
  } catch {
    return null;
  }
}

export const listSkillsRoute = registerApiRoute('/skills', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => {
    // Hydration gate — even if the boot-time preload is still in flight or has
    // failed and been retried, await a shared Promise so the registered view
    // reflects the filesystem + DB index before we serialise.
    await ensureSkillRegistryLoaded();
    const skills = listSkills();
    return context.json(
      skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        source: s.source,
        compatibility: s.compatibility,
        hasScripts: s.hasScripts,
        allowedTools: s.allowedTools,
        metadata: s.metadata,
      })),
    );
  },
});

export const getSkillRoute = registerApiRoute('/skills/:id', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => {
    await ensureSkillRegistryLoaded();
    const id = context.req.param('id');
    const skill = getSkill(id);
    if (!skill) {
      return context.json({ message: 'Skill 不存在。' }, 404);
    }
    return context.json({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      compatibility: skill.compatibility,
      hasScripts: skill.hasScripts,
      allowedTools: skill.allowedTools,
      metadata: skill.metadata,
    });
  },
});

export const searchMarketSkillsRoute = registerApiRoute('/skills/market/search', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => {
    const query = context.req.query('q') ?? '';
    const limitRaw = context.req.query('limit');
    const limit = limitRaw ? Math.min(Math.max(Number.parseInt(limitRaw, 10) || 20, 1), 50) : 20;
    try {
      const results = query.trim().length === 0
        ? await listPopularMarketSkills({ limit })
        : await searchMarketSkills(query.trim(), { limit });
      return context.json({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : '搜索失败';
      return context.json({ message }, 502);
    }
  },
});

export const listPopularMarketSkillsRoute = registerApiRoute('/skills/market/popular', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => {
    try {
      const results: MarketSkillInfo[] = await listPopularMarketSkills({ limit: 20 });
      return context.json({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : '获取热门失败';
      return context.json({ message }, 502);
    }
  },
});

export const previewSkillRoute = registerApiRoute('/skills/market/preview', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    const body = await context.req.json<unknown>();
    const parsed = parseSkillTriple(body);
    if (!parsed) {
      return context.json({ message: '需要 owner、repo、skillName 三个非空字符串字段。' }, 400);
    }
    try {
      const preview: SkillPreview | null = await previewMarketSkill(parsed.owner, parsed.repo, parsed.skillName);
      if (!preview) {
        return context.json({ message: '未找到对应的 Skill。' }, 404);
      }
      return context.json(preview);
    } catch (err) {
      const message = err instanceof Error ? err.message : '预览失败';
      return context.json({ message }, 502);
    }
  },
});

export const installSkillRoute = registerApiRoute('/skills/market/install', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    const body = await context.req.json<unknown>();
    const parsed = parseSkillTriple(body);
    if (!parsed) {
      return context.json({ message: '需要 owner、repo、skillName 三个非空字符串字段。' }, 400);
    }
    try {
      // Ensure the registry reflects any prior installs before we mutate it.
      await ensureSkillRegistryLoaded();
      const installed: SkillPreview = await installMarketSkill(parsed.owner, parsed.repo, parsed.skillName);
      // installMarketSkill already triggers a loadInstalledSkills refresh
      // internally; mark the gate complete so subsequent ensure calls are O(1).
      await ensureSkillRegistryLoaded();
      return context.json(installed);
    } catch (err) {
      const message = err instanceof Error ? err.message : '安装失败';
      return context.json({ message }, 502);
    }
  },
});

export const updateSkillRoute = registerApiRoute('/skills/:id/update', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    await ensureSkillRegistryLoaded();
    const id = context.req.param('id');
    try {
      const updated = await updateMarketSkill(id);
      await ensureSkillRegistryLoaded();
      if (!updated) {
        return context.json({ message: '未找到对应的 Skill。' }, 404);
      }
      return context.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : '更新失败';
      return context.json({ message }, 500);
    }
  },
});

export const removeSkillRoute = registerApiRoute('/skills/:id', {
  method: 'DELETE',
  requiresAuth: false,
  handler: async (context) => {
    await ensureSkillRegistryLoaded();
    const id = context.req.param('id');
    try {
      await uninstallMarketSkill(id);
      await ensureSkillRegistryLoaded();
      return context.json({ message: '已卸载。' });
    } catch (err) {
      const message = err instanceof Error ? err.message : '卸载失败';
      return context.json({ message }, 500);
    }
  },
});

export const bindSkillRoute = registerApiRoute('/skills/:id/bind', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    await ensureSkillRegistryLoaded();
    const id = context.req.param('id');
    const body = await context.req.json<unknown>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return context.json({ message: '请求体必须是 JSON 对象。' }, 400);
    }
    const { agentId } = body as Record<string, unknown>;
    if (typeof agentId !== 'string' || !agentId.trim()) {
      return context.json({ message: 'agentId 不能为空。' }, 400);
    }
    try {
      await bindSkillToAgent(agentId.trim(), id);
      return context.json({ message: '绑定成功。' });
    } catch (err) {
      const message = err instanceof Error ? err.message : '绑定失败';
      return context.json({ message }, 400);
    }
  },
});

export const unbindSkillRoute = registerApiRoute('/skills/:id/unbind', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    await ensureSkillRegistryLoaded();
    const id = context.req.param('id');
    const body = await context.req.json<unknown>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return context.json({ message: '请求体必须是 JSON 对象。' }, 400);
    }
    const { agentId } = body as Record<string, unknown>;
    if (typeof agentId !== 'string' || !agentId.trim()) {
      return context.json({ message: 'agentId 不能为空。' }, 400);
    }
    try {
      await unbindSkillFromAgent(agentId.trim(), id);
      return context.json({ message: '解绑成功。' });
    } catch (err) {
      const message = err instanceof Error ? err.message : '解绑失败';
      return context.json({ message }, 400);
    }
  },
});
