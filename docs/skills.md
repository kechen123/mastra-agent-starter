# Skill 系统文档

## 概述

Skill 是Mastra Agent Starter的模块化指令单元，用于扩展 Agent 的特定能力。与 Tool 不同，Skill 主要通过**系统提示词注入**影响 Agent 行为，而非执行代码。

Skill 来源分为三类：
- **builtin**: 系统内置，随版本发布（`backend/src/skills/builtin/<id>/SKILL.md`）
- **local**: 本地自定义（`backend/src/skills/local/<id>/SKILL.md`）
- **marketplace**: 从 skills.sh 官方市场安装（`backend/market-skills/<owner>/<repo>/<skill>/SKILL.md`）

`_template` 目录会被注册器跳过，**不会污染 Skill 列表**——它是新增 Skill 的占位示例。

## Skill Registry

位于 `backend/src/core/skill/registry.ts`：

- `loadBuiltinSkills()`: 扫描 `backend/src/skills/builtin/<id>/SKILL.md`
- `discoverLocalSkills()`: 扫描 `backend/src/skills/local/<id>/SKILL.md`
- `discoverMarketplaceSkills()`: 扫描 `backend/market-skills/<owner>/<repo>/<skill>/`
- `loadInstalledSkills()`: 从全局 `skill_packages` 表加载，并每次基于磁盘文件列表重新校验兼容性
- `getSkill(id)`: 获取技能定义（builtin → installed → local 顺序）
- `listSkills()`: 列出所有技能（内置 + 已安装 + 本地）
- `resolveSkillsForAgent(agentId, ids)`: 仅返回 `compatibility === 'compatible'` 且 `allowedTools ⊆ agent.toolIds` 的技能

## SkillDefinition 结构

```typescript
interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'marketplace' | 'local';
  location: string;                // 本地路径
  compatibility: 'compatible' | 'requires-runtime' | 'unsupported' | 'unknown';
  instructions?: string;           // SKILL.md 正文
  files?: string[];                // 实际扫描到的文件列表
  hasScripts: boolean;             // 是否包含 scripts/ 目录或脚本文件
  allowedTools?: string[];         // 依赖的工具 ID
  metadata?: Record<string, unknown>;
  skill: InlineSkill | null;      // 可执行的技能实例（仅 compatible）
}
```

## 兼容性检测（基于真实文件列表）

兼容性检测**完全基于磁盘上的真实文件**（由 `listFilesRecursive()` 扫描得出）：

1. 包含 `scripts/` 目录 → `requires-runtime`
2. 文件名匹配 `\.(sh|bash|zsh|ps1|bat|cmd|py|js|ts|mjs|cjs|rb|pl)$` → `requires-runtime`
3. `allowed-tools` 中包含当前系统不存在的工具 → `requires-runtime`
4. 否则 → `compatible`

`requires-runtime` 的技能可以预览和安装，但 **永远无法被绑定**（`bindSkillToAgent()` 会拒绝任何非 `compatible` 的技能）。这是为了防止通过 skill 注入可执行代码。

## 内置技能

### structured-summary

**ID**: `structured-summary`
**位置**: `backend/src/skills/builtin/structured-summary/SKILL.md`

结构化摘要技能，引导 Agent 生成三段式摘要：
- 核心结论
- 关键事实
- 注意事项

`SKILL.md` 是该技能指令的唯一来源，**禁止在 TypeScript 中复制硬编码版本**。

## 技能市场 (skills.sh)

`backend/src/infrastructure/external-skills/market.ts` 实现市场集成，**通过 `@mastra/server` 提供的官方 helpers 调用官方 API**：

- `searchMarketSkills(query)`: 调用 `searchSkillsSh()`（GET `/api/skills?query=...`）
- `listPopularMarketSkills()`: 调用 `getPopularSkillsSh()`（GET `/api/skills/top`）
- `previewMarketSkill(owner, repo, skillName)`: 调用 `previewSkillsSh()` + `fetchSkillFiles()`，根据返回的文件列表计算兼容性
- `installMarketSkill(workspaceId, owner, repo, skillName)`: 拉取文件、写入 `market-skills/<owner>/<repo>/<skillName>/`，写入全局 `skill_packages` 并在当前 Workspace 启用
- `updateMarketSkill(workspaceId, id)`: 重新拉取、更新全局包并确保当前 Workspace 启用
- `uninstallMarketSkill(id)`: 删除本地文件、清理数据库、刷新注册表

安装流程：
1. 搜索或浏览 skills.sh，选择 `owner/repo/skillName`
2. 调用 `previewSkillsSh()` + `fetchSkillFiles()` 获取 SKILL.md 与完整文件清单
3. 使用 `assertSafeSkillName()` 与 `assertSafeFilePath()` 验证每个返回路径，**拒绝任何越界或绝对路径**
4. 写入文件到 `backend/market-skills/<owner>/<repo>/<skillName>/`
5. 写入全局 `skill_packages`，并写入当前 Workspace 的 `workspace_skills(enabled=true)`
6. 重新调用 `loadInstalledSkills()`

**前端必须从搜索/热门结果中选择技能**，不允许任意输入 owner/repo。

## Agent-Skill 绑定

`backend/src/core/skill/registry.ts` 提供绑定 API：

- `bindSkillToAgent(agentId, skillId)`: 绑定技能到 Agent（仅允许 `compatible`，会自动拒绝 `requires-runtime`）
- `unbindSkillFromAgent(workspaceId, agentId, skillId)`: 解绑
- `getAgentSkillBindings(workspaceId, agentId)`: 获取 Workspace 中已启用的 Agent 绑定列表

Skill 使用三层表达：

- `skill_packages`：全局安装包目录；所有 Workspace 共享，不含 `workspace_id`。
- `workspace_skills`：Workspace 是否启用某全局 Skill。
- `agent_skill_bindings`：Workspace 内 Agent 与 Skill 的绑定；主键为 `workspace_id` + `agent_id` + `skill_id`，并保留 `enabled`。

运行时仅解析同时满足 Workspace 已启用、绑定已启用且兼容的 Skill。

运行时，Agent 的技能集合 = 数据库中的 `boundSkillIds`（不含任何硬编码默认值）。`requires-runtime` 技能在 `resolveSkillsForAgent()` 阶段就会被过滤掉。

## 前端技能管理

前端在「技能」模块提供：
- 技能列表：显示来源、兼容性状态
- 市场安装：搜索 skills.sh，从搜索结果中预览并安装
- 卸载：非内置技能可卸载（同时清理磁盘文件、DB 记录、Agent 绑定）
- Agent 绑定：仅 `compatible` 技能可勾选/取消绑定

## 添加自定义 Skill

### 方法 1：本地 SKILL.md（推荐）

1. 创建目录 `backend/src/skills/local/my-skill/`
2. 编写 `SKILL.md`，包含 YAML Front Matter：

```markdown
---
name: 我的技能
description: 这是一段描述
allowed-tools: [calculator]
---

# 指令

这是注入 Agent system prompt 的完整指令内容。
```

3. 启动后端时 `discoverLocalSkills()` 会自动发现该技能
4. 通过 `POST /skills/:id/bind` 绑定到目标 Agent

### 方法 2：skills.sh 官方市场

1. 在前端「技能」模块搜索关键词或浏览热门
2. 从搜索结果中选择 `owner/repo/skillName`
3. 预览后点击「安装到本地」即可
