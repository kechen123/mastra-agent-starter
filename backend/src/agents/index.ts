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
 *
 * PR-3.3.1 — Staging Approval Probe Agent：
 *   - 默认不注册、绝不暴露在 `/agents`；
 *   - 仅当 ENABLE_STAGING_APPROVAL_PROBE=true **且** 部署档位 !== production
 *     才注册；
 *   - 若部署档位 === production 即便设置了开关也必须拒绝启动，与
 *     `tools/index.ts` 的相同守卫构成"Tool + Agent 双门"。
 */
import { registerAgent, getAgentDefinition } from '../core/agent/registry.js';
import { generalChatAgent } from './general-chat/agent.js';
import { knowledgeBaseAgent } from './knowledge-base/agent.js';
import { daymindAgent } from './daymind/agent.js';
import { stagingApprovalProbeAgentDefinition } from './staging-approval-probe/agent.js';

export function registerBuiltinAgents(): void {
  if (!getAgentDefinition(generalChatAgent.id)) registerAgent(generalChatAgent);
  if (!getAgentDefinition(knowledgeBaseAgent.id)) registerAgent(knowledgeBaseAgent);
  if (!getAgentDefinition(daymindAgent.id)) registerAgent(daymindAgent);
  if (process.env.ENABLE_STAGING_APPROVAL_PROBE === 'true') {
    if (process.env.DEPLOYMENT_PROFILE === 'production') {
      throw new Error('生产环境禁止启用审批探针 Agent。');
    }
    if (!getAgentDefinition(stagingApprovalProbeAgentDefinition.id)) registerAgent(stagingApprovalProbeAgentDefinition);
  }
}

registerBuiltinAgents();
