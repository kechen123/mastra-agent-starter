# Tool 模板

这是新增 Tool 的最小骨架，**不要直接注册**——它只是占位示例，避免新 Tool
不知道应该放在哪里、如何组织代码。

## 使用步骤

1. 在 `backend/src/tools/<your-id>/` 下新建一个目录，复制本目录下的
   `tool.ts` 作为起点。
2. 修改：
   - `id` / `displayName` / `description`。
   - `inputSchema` / `outputSchema`（推荐使用 Zod）。
   - `execute()` 的真实业务逻辑，注意处理 `abortSignal`。
   - `ToolDefinition.metadata` 中的 flags（readOnly / destructive /
     idempotent / openWorld / requiresRuntime）。
3. 若 Schema 较复杂，可在同目录下新增 `schema.ts` 与 `tool.ts` 共享 Zod 类型。
4. 在 `backend/src/tools/index.ts` 中追加一行：
   ```ts
   import { yourToolDefinition } from './your-id/tool.js';
   registerTool(yourToolDefinition);
   ```
5. 在目标 Agent 的 `backend/src/agents/<agent-id>/agent.ts` 的 `toolIds` 中添加 Tool ID。
6. 重启后端；新 Tool 会出现在 `GET /tools` 中。

## 关键约束

- **不要**修改 `core/tool/registry.ts`。所有 Tool 必须通过 `ToolDefinition` +
  `registerTool()` 接入。
- `execute()` 内必须支持 `abortSignal` 中断；遇到 `abortSignal.aborted` 时应
  立即返回（不要继续重）。
- `metadata` 中的 flags 必须如实填写。Capability UI 依赖它们展示 Tool 行为。