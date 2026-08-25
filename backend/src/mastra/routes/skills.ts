import { registerApiRoute } from '@mastra/core/server';
import {
  listSkills,
  getSkill,
  loadInstalledSkills,
  saveInstalledSkill,
  removeInstalledSkill,
  bindSkillToAgent,
  unbindSkillFromAgent,
} from '../skills/registry.js';
import {
  previewMarketSkill,
  installMarketSkill,
  updateMarketSkill,
  uninstallMarketSkill,
} from '../skills/market.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{3}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export const listSkillsRoute = registerApiRoute('/skills', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => {
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

export const previewSkillRoute = registerApiRoute('/skills/preview', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    const body = await context.req.json<unknown>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return context.json({ message: '请求体必须是 JSON 对象。' }, 400);
    }
    const { owner, repo } = body as Record<string, unknown>;
    if (typeof owner !== 'string' || !owner.trim()) {
      return context.json({ message: 'owner 不能为空。' }, 400);
    }
    if (typeof repo !== 'string' || !repo.trim()) {
      return context.json({ message: 'repo 不能为空。' }, 400);
    }
    try {
      const preview = await previewMarketSkill(owner.trim(), repo.trim());
      return context.json(preview);
    } catch (err) {
      const message = err instanceof Error ? err.message : '预览失败';
      return context.json({ message }, 500);
    }
  },
});

export const installSkillRoute = registerApiRoute('/skills/install', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    const body = await context.req.json<unknown>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return context.json({ message: '请求体必须是 JSON 对象。' }, 400);
    }
    const { owner, repo } = body as Record<string, unknown>;
    if (typeof owner !== 'string' || !owner.trim()) {
      return context.json({ message: 'owner 不能为空。' }, 400);
    }
    if (typeof repo !== 'string' || !repo.trim()) {
      return context.json({ message: 'repo 不能为空。' }, 400);
    }
    try {
      const installed = await installMarketSkill(owner.trim(), repo.trim());
      await loadInstalledSkills();
      return context.json(installed);
    } catch (err) {
      const message = err instanceof Error ? err.message : '安装失败';
      return context.json({ message }, 500);
    }
  },
});

export const updateSkillRoute = registerApiRoute('/skills/:id/update', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    const id = context.req.param('id');
    try {
      const updated = await updateMarketSkill(id);
      await loadInstalledSkills();
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
    const id = context.req.param('id');
    try {
      await removeInstalledSkill(id);
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
