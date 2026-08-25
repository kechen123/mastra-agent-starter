# Skill 系统文档

## 概述

Skill 是玄枢的模块化指令单元，用于扩展 Agent 的特定能力。与 Tool 不同，Skill 主要通过**系统提示词注入**影响 Agent 行为，而非执行代码。

Skill 来源分为三类：
- **builtin**: 系统内置，随版本发布
- **marketplace**: 从 skills.sh 市场安装
- **local**: 本地开发（预留）

## Skill Registry

`backend/src/mastra/skills/registry.ts` 管理技能的注册和解析：

- `loadBuiltinSkills()`: 加载内置技能到内存
- `loadInstalledSkills()`: 从数据库 `skills_installed` 表加载
- `getSkill(id)`: 获取技能定义
- `listSkills()`: 列出所有技能（内置 + 已安装）
- `resolveSkills(ids)`: 仅返回 `compatibility === 'compatible'` 的技能实例

## SkillDefinition 结构

```typescript
interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'marketplace' | 'local';
  location: string;                // 本地路径
  compatibility: 'compatible' | 'requires-runtime' | 'unsupported' | 'unknown';
  instructions?: string;           // SKILL.md 内容
  hasScripts: boolean;             // 是否包含脚本
  allowedTools?: string[];         // 依赖的工具 ID
  metadata?: Record<string, unknown>;
  skill: InlineSkill | null;      // 可执行的技能实例（仅 compatible）
}
```

## 兼容性检测

`analyzeSkillCompatibility()` 自动检测技能兼容性：

1. 若 `hasScripts === true`，标记为 `requires-runtime`
2. 若 `allowedTools` 中包含当前系统不存在的工具，标记为 `requires-runtime`
3. 扫描技能目录中的 `.sh/.py/.js/.ts` 文件或 `scripts/` 目录，若存在则标记为 `requires-runtime`
4. 否则标记为 `compatible`

`requires-runtime` 的技能可以预览和安装，但不会注入 Agent 运行时（防止执行不可信代码）。

## 内置技能

### structured-summary

**ID**: `structured-summary`

结构化摘要技能，引导 Agent 生成三段式摘要：
- 核心结论
- 关键事实
- 注意事项

位于 `backend/src/mastra/skills/structured-summary/`。

## 技能市场 (skills.sh)

`backend/src/mastra/skills/market.ts` 实现市场集成：

- `previewMarketSkill(owner, repo)`: 从 GitHub raw 获取 `SKILL.md` 内容预览
- `installMarketSkill(owner, repo)`: 下载保存到 `backend/market-skills/{id}/`
- `updateMarketSkill(id)`: 重新拉取并更新
- `uninstallMarketSkill(id)`: 删除本地文件并从数据库移除

安装流程：
1. 下载 `https://raw.githubusercontent.com/{owner}/{repo}/main/SKILL.md`
2. 解析 YAML Front Matter（标题、描述、兼容性、依赖工具）
3. 保存到 `backend/market-skills/{skill-id}/`
4. 写入 `skills_installed` 表
5. 重新调用 `loadInstalledSkills()`

## Agent-Skill 绑定

`backend/src/mastra/skills/registry.ts` 提供绑定 API：

- `bindSkillToAgent(agentId, skillId)`: 绑定技能到 Agent（仅允许 `compatible`）
- `unbindSkillFromAgent(agentId, skillId)`: 解绑
- `getAgentSkillBindings(agentId)`: 获取 Agent 的已启用绑定列表

绑定关系存储在 `agent_skill_bindings` 表：
- `agent_id` + `skill_id` 联合主键
- `enabled`: 布尔值，支持软禁用

运行时，Agent 的技能集合 = `defaultSkillIds`（硬编码） ∪ `boundSkillIds`（数据库绑定）。

## 前端技能管理

前端在「技能」模块提供：
- 技能列表：显示来源、兼容性状态
- 市场安装：输入 GitHub owner/repo 预览并安装
- 卸载：非内置技能可卸载
- Agent 绑定：为每个 Agent 勾选/取消技能绑定

## 添加自定义 Skill

### 方法 1：本地 SKILL.md（推荐）

1. 创建目录 `backend/market-skills/my-skill/`
2. 编写 `SKILL.md`，包含 YAML Front Matter：

```markdown
---
name: 我的技能
description: 这是一段描述
compatibility: compatible
allowed-tools: [calculator]
---

# 指令

这是注入 Agent system prompt 的完整指令内容。
```

3. 调用 `saveInstalledSkill()` 注册到数据库
4. 调用 `loadInstalledSkills()` 加载到运行时

### 方法 2：GitHub 市场

1. 在 GitHub 创建仓库，根目录放置 `SKILL.md`
2. 在前端「技能」模块输入 `owner/repo` 安装
