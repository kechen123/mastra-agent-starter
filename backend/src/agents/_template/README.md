# Agent 模板

这是新增 Agent 的最小骨架，**不要直接注册**——它只是占位示例，避免新 Agent
不知道应该放在哪里、如何组织代码。

## 使用步骤

1. 在 `backend/src/agents/<your-id>/` 下新建一个目录，复制本目录下的
   `agent.ts`、`instructions.ts` 作为起点。
2. 修改：
   - `agent.ts` 中的 `id` / `name` / `description` / `model` / `toolIds` /
     `capabilities` 字段。
   - `instructions.ts` 中的系统提示词。
   - `createTemplateAgent` 工厂的命名（与你的 Agent id 对齐）。
3. 在 `backend/src/agents/index.ts` 中追加一行：
   ```ts
   import { yourAgent } from './your-id/agent.js';
   registerAgent(yourAgent);
   ```
4. 重启后端；新 Agent 会出现在 `GET /agents` 中。

## 关键约束

- **不要**修改 `core/agent/types.ts` 或 `core/agent/registry.ts`。所有 Agent
  必须通过 `AgentDefinition` + `registerAgent()` 接入。
- **不要**在 Agent 内硬编码 `if (id === 'general-chat')` 这类分支。所有能力差异
  通过 `capabilities` 矩阵与 `factory` 注入。
- **不要**直接读取 `config.chatModel`、`process.env`、`DEEPSEEK_API_KEY`，
  也不要拼接 `provider/model` 字符串。模型解析统一走
  `infrastructure/llm/registry.ts:resolveDefaultChatModel()`。
- 若 Agent 需要使用现有 Tool，仅需在 `toolIds` 中列出 Tool id，运行时自动注入。
- 若 Agent 需要绑定 Skill，请在 UI 端通过 `POST /skills/:id/bind` 绑定，不要
  在 Agent 定义里写死 Skill 列表。