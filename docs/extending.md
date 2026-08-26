# 扩展指南

本文档说明如何新增 Agent / Tool / Skill / HTTP Route。**所有扩展遵循同一原则：往 `core/` 之外添加新文件，绝不修改 `core/`。**

## 添加新 Agent

1. **新建目录**：`backend/src/agents/<your-id>/`
2. **复制模板**：从 `backend/src/agents/_template/` 复制 `agent.ts` 和 `instructions.ts`
3. **编辑 `agent.ts`**：
   - `id` —— 稳定的小写连字符 ID
   - `name` —— 中文展示名
   - `description` —— 一句话说明用途
   - `toolIds` —— 需要哪些 Tool，不填则默认空数组
   - `capabilities` —— 关键字段：
     - `knowledgeBase: true` → 启用 RAG 检索（同时需要 `citations: true`）
     - `tools: true` → 运行时注入 `toolIds`
     - `skills: true` → 运行时按 DB 绑定注入 Skill
   - `factory` —— 返回一个 `new Agent({...})`，`tools` 与 `skills` 参数直接展开
4. **编辑 `instructions.ts`**：把你的系统提示词放在那里
5. **注册** —— 编辑 `backend/src/agents/index.ts`，追加：
   ```typescript
   import { yourAgent } from './your-id/agent.js';
   registerAgent(yourAgent);
   ```
6. **重启后端** —— 新 Agent 会出现在 `GET /agents`

> **不要修改** `backend/src/core/agent/*` 任何文件。运行时是通用 driver，所有差异通过 `capabilities` 与 `factory` 表达。

## 添加新 Tool

1. **新建目录**：`backend/src/tools/<your-id>/`
2. **复制模板**：从 `backend/src/tools/_template/` 复制 `tool.ts`
3. **编辑 `tool.ts`**：
   - `id` —— Tool id（必须全局唯一）
   - `description` —— LLM 看得到，决定何时调用
   - `inputSchema` / `outputSchema` —— 用 `z.object({...})`
   - `execute()` —— 实现时务必尊重 `abortSignal`（遇到 `aborted` 直接返回）
   - `metadata` —— 四个 flag 如实填写（readOnly / destructive / idempotent / openWorld，可选 requiresRuntime）
4. **（可选）** 在同目录下添加 `schema.ts` 共享复杂 Zod 类型
5. **注册** —— 编辑 `backend/src/tools/index.ts`，追加：
   ```typescript
   import { yourToolDefinition } from './your-id/tool.js';
   registerTool(yourToolDefinition);
   ```
6. **挂载到 Agent** —— 编辑 `backend/src/agents/<agent>/agent.ts`，把 Tool id 加进该 Agent 的 `toolIds`
7. **重启后端** —— 新 Tool 会出现在 `GET /tools`

> **不要修改** `backend/src/core/tool/registry.ts`。

## 添加新 Skill

Mastra Agent Starter 的 Skill 是文件系统驱动的，**新增 Skill 不需要写一行 TypeScript**。

### 本地自定义 Skill

1. 在 `backend/src/skills/local/<your-skill-id>/` 下新建目录
2. 编写 `SKILL.md`：

```markdown
---
name: 我的技能
description: 一句话说明这个 Skill 帮助 Agent 完成什么任务
allowed-tools: [calculator, get-current-time]
---

# 任务目标

## 工作步骤

1. …
2. …
```

3. 重启后端 → `discoverLocalSkills()` 自动发现 → 出现在 `GET /skills`
4. 通过 `POST /skills/:id/bind` 绑定到目标 Agent

`_template/` 目录会被注册器跳过，可放心放占位示例。

### 内置 Skill（随版本发布）

步骤同上，但目录放在 `backend/src/skills/builtin/<id>/`。

> **不要修改** `backend/src/core/skill/registry.ts`。`SKILL.md` 是该 Skill 指令的唯一来源，禁止在 TS 中复制硬编码版本。

## 添加新 HTTP Route

1. 在 `backend/src/server/routes/<your-feature>.ts` 新建文件
2. 使用 `registerApiRoute()` 导出路由：

```typescript
import { registerApiRoute } from '@mastra/core/server';

export const yourRoute = registerApiRoute('/your-path', {
  method: 'POST',
  requiresAuth: false,
  handler: async (context) => {
    const body = await context.req.json<unknown>();
    return context.json({ ok: true });
  },
});
```

3. 编辑 `backend/src/server/bootstrap.ts`，在 `apiRoutes` 数组中追加 `yourRoute`
4. 重启后端 → 新路由立即生效

> **不要修改** `backend/src/mastra/index.ts` 以外的核心装配文件。所有路由都在 `backend/src/server/bootstrap.ts` 装配，`mastra/index.ts` 仅做 `new Mastra({ server: { apiRoutes } })`。

## 修改数据库 Schema

**只修改 `backend/database/init.sql`**。禁止创建额外的 SQL 文件。开发环境允许重置数据库；生产环境由迁移脚本负责（不在本仓库管理）。

## 修改业务逻辑

业务逻辑分布在 `backend/src/modules/` 下：

| 模块 | 职责 |
|------|------|
| `conversations/` | 会话/消息/工具执行审计 |
| `knowledge/` | 知识库 CRUD + RAG 检索 |
| `documents/` | 文档解析与入库 |
| `citations/` | Citation 类型 |

修改模块时记得同步 `backend/src/modules/*/types.ts` 中的类型定义。