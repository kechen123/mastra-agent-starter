/**
 * 具体 Agent 的唯一权威注册入口。
 *
 * Core 层（`backend/src/core/agent/`）不导入任何具体 Agent；只有本文件
 * 知道哪些具体 Agent 存在。
 *
 * 新增 Agent 步骤：
 *   1. 在 `backend/src/agents/<id>/{agent.ts, instructions.ts}` 导出
 *      一个 `AgentDefinition`（见 `core/agent/types.ts`）。
 *   2. 在本文件下追加一行 `registerAgent(<yourDef>);`。
 *   3. 重启后端，新 Agent 会出现在 `GET /agents` 接口中。
 */
import { registerAgent } from '../core/agent/registry.js';
import { generalChatAgent } from './general-chat/agent.js';
import { knowledgeBaseAgent } from './knowledge-base/agent.js';

registerAgent(generalChatAgent);
registerAgent(knowledgeBaseAgent);