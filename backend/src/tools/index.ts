/**
 * 具体 Tool 的唯一权威注册入口。
 *
 * Core 层（`backend/src/core/tool/`）不导入任何具体 Tool；只有本文件
 * 是注册 `ToolDefinition` 的模块。
 *
 * 新增 Tool 步骤：
 *   1. 在 `backend/src/tools/<id>/tool.ts`（复杂 schema 可拆出
 *      `tools/<id>/schema.ts`）导出 `ToolDefinition`（见 `core/tool/registry.ts`）。
 *   2. 在本文件下追加一行 `registerTool(<yourDef>);`。
 *   3. 在需要它的 AgentDefinition.toolIds 中追加新 tool id。
 *   4. 重启后端，新 Tool 会出现在 `GET /tools` 接口中。
 *
 * Phase 3.0 — Tool 注册路径改为 Mastra 公共注册入口：
 *   `buildGlobalToolMap()` 返回所有已注册 Tool 的 `{ id → tool }` 字典，
 *   由 `infrastructure/mastra/instance.ts` 注入 `new Mastra({ tools })`。
 *   具体 Agent 不再 inline 持有 tools；Agent 通过 `mastra.tools` 拿同一份
 *   注册表，per-request 通过 `activeTools` 过滤可用子集。这样"重启后
 *   工具可恢复"有统一来源，而不是每个 per-request Agent 临时持有一份。
 */
import { registerTool } from '../core/tool/registry.js';
import { calculatorDefinition } from './calculator/tool.js';
import { getCurrentTimeDefinition } from './get-current-time/tool.js';

registerTool(calculatorDefinition);
registerTool(getCurrentTimeDefinition);