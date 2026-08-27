import { registerApiRoute } from '@mastra/core/server';
import { listAgentDefinitions } from '../../core/agent/registry.js';
import { getDocumentParserConfig } from '../../modules/documents/parsers/config.js';
import { config } from '../../config.js';
import {
  resolveDefaultChatModelId,
  resolveDefaultChatModelInfo,
} from '../../infrastructure/llm/registry.js';

/**
 * 能力声明接口：返回前端所需的运行期开关、可用 Agent 列表与品牌信息。
 * 不返回 Tool / Skill 的细节，那些由各自的资源接口负责。
 *
 * 品牌字段（`app`）由后端 `config` 单一来源下发，前端只负责展示，禁止在
 * 前端硬编码品牌字样。
 *
 * 模型字段：
 * - `defaultChatModel` 保留以兼容旧前端，是 Agent 实际使用的完整模型 ID
 *   （形如 `deepseek/deepseek-v4-flash`）。
 * - `llm` 是新增的"Provider-aware"非敏感描述，包含 provider / model /
 *   displayName。当前 Starter 仅启用 DeepSeek；前端不需要据此选模型，
 *   仅作为 UI 展示信息。
 */
export const capabilitiesRoute = registerApiRoute('/capabilities', {
  method: 'GET',
  requiresAuth: true,
  handler: async (context) => {
    const parserConfig = getDocumentParserConfig();
    const defs = listAgentDefinitions();
    return context.json({
      app: {
        name: config.appName,
        shortName: config.appShortName,
      },
      documentFormats: parserConfig.documentFormats,
      mineruEnabled: parserConfig.mineruEnabled,
      chatAgents: defs.map((d) => ({
        id: d.id,
        name: d.name,
        requiresKnowledgeBase: d.capabilities.knowledgeBase,
      })),
      // 能力接口只描述当前配置，不应因 API Key 尚未配置而不可访问。
      // 真正创建 Agent 时才由 resolveDefaultChatModel() 校验凭据。
      defaultChatModel: resolveDefaultChatModelId(),
      llm: resolveDefaultChatModelInfo(),
    });
  },
});
