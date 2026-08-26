# Skill 系统文档

## 概述

Skill 是玄枢的模块化指令单元，用于扩展 Agent 的特定能力。与 Tool 不同，Skill 主要通过**系统提示词注入**影响 Agent 行为，而非执行代码。

Skill 来源分为三类：
- **builtin**: 系统内置，随版本发布
- **marketplace**: 从 skills.sh 官方市场安装
- **local**: 从 `backend/market-skills/<id>/SKILL.md` 文件系统发现

## Skill Registry

`backend/src/mastra/skills/registry.ts` 管理技能的注册和解析：

- `loadBuiltinSkills()`: 加载内置技能到内存
- `discoverLocalSkills()`: 从文件系统扫描 `market-skills/<id>/SKILL.md`
- `loadInstalledSkills()`: 从 `skills_installed` 表加载，每次都会基于磁盘文件列表重新校验兼容性
- `getSkill(id)`: 获取技能定义（builtin → installed → local 顺序）
- `listSkills()`: 列出所有技能（内置 + 已安装 + 本地）
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

结构化摘要技能，引导 Agent 生成三段式摘要：
- 核心结论
- 关键事实
- 注意事项

由 `backend/src/mastra/skills/builtins.ts` 直接导出，无外部 SKILL.md 文件。

## 技能市场 (skills.sh)

`backend/src/mastra/skills/market.ts` 实现市场集成，**通过 `@mastra/server` 提供的官方 helpers 调用官方 API**：

- `searchMarketSkills(query)`: 调用 `searchSkillsSh()`（GET `/api/skills?query=...`）
- `listPopularMarketSkills()`: 调用 `getPopularSkillsSh()`（GET `/api/skills/top`）
- `previewMarketSkill(owner, repo, skillName)`: 调用 `previewSkillsSh()` + `fetchSkillFiles()`，根据返回的文件列表计算兼容性
- `installMarketSkill(owner, repo, skillName)`: 拉取文件、写入 `market-skills/<owner>/<repo>/<skillName>/`，写入 `skills_installed` 表
- `updateMarketSkill(id)`: 重新拉取并更新
- `uninstallMarketSkill(id)`: 删除本地文件、清理数据库、刷新注册表

安装流程：
1. 搜索或浏览 skills.sh，选择 `owner/repo/skillName`
2. 调用 `previewSkillsSh()` + `fetchSkillFiles()` 获取 SKILL.md 与完整文件清单
3. 使用 `assertSafeSkillName()` 与 `assertSafeFilePath()` 验证每个返回路径，**拒绝任何越界或绝对路径**
4. 写入文件到 `backend/market-skills/<owner>/<repo>/<skillName>/`
5. 写入 `skills_installed` 表
6. 重新调用 `loadInstalledSkills()`

**前端必须从搜索/热门结果中选择技能**，不允许任意输入 owner/repo。

## Agent-Skill 绑定

`backend/src/mastra/skills/registry.ts` 提供绑定 API：

- `bindSkillToAgent(agentId, skillId)`: 绑定技能到 Agent（仅允许 `compatible`，会自动拒绝 `requires-runtime`）
- `unbindSkillFromAgent(agentId, skillId)`: 解绑
- `getAgentSkillBindings(agentId)`: 获取 Agent 的已启用绑定列表

绑定关系存储在 `agent_skill_bindings` 表：
- `agent_id` + `skill_id` 联合主键
- `enabled`: 布尔值，支持软禁用

运行时，Agent 的技能集合 = 数据库中的 `boundSkillIds`（不含任何硬编码默认值）。`requires-runtime` 技能在 `resolveSkills()` 阶段就会被过滤掉。

## 前端技能管理

前端在「技能」模块提供：
- 技能列表：显示来源、兼容性状态
- 市场安装：搜索 skills.sh，从搜索结果中预览并安装
- 卸载：非内置技能可卸载（同时清理磁盘文件、DB 记录、Agent 绑定）
- Agent 绑定：仅 `compatible` 技能可勾选/取消绑定

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

3. 启动后端时 `discoverLocalSkills()` 会自动发现该技能
4. 通过 `POST /skills/:id/bind` 绑定到目标 Agent

### 方法 2：skills.sh 官方市场

1. 在前端「技能」模块搜索关键词或浏览热门
2. 从搜索结果中选择 `owner/repo/skillName`
3. 预览后点击「安装到本地」即可
