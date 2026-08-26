import type { LlmProviderAdapter } from '../types.js';

/**
 * DeepSeek Provider Adapter —— 当前 Starter 唯一正式启用的 LLM Provider。
 *
 * 这是后端代码中"唯一一个"知道以下事实的地方：
 *   - DeepSeek 的 Provider id 是 `deepseek`；
 *   - Mastra 实际消费的完整模型 ID 形如 `deepseek/<model>`；
 *   - DeepSeek 的凭据来自环境变量 `DEEPSEEK_API_KEY`；
 *   - 缺失 API Key 时不允许启动。
 *
 * 任何其他模块（Agent factory、Runtime、Route、Config、Frontend）
 * 都不得重复出现以上事实；它们只能调用
 * `resolveDefaultChatModel()` / `provider.assertCredentials()` 这类
 * 通用接口，把实现细节收敛在本文件内。
 *
 * 错误信息规则：
 *   - 使用明确中文；
 *   - 严禁把 API Key、Header、Authorization 字符串写进错误信息。
 */
export const deepseekAdapter: LlmProviderAdapter = {
  id: 'deepseek',
  displayName: 'DeepSeek',

  resolveModelId(model: string): string {
    // DeepSeek 在 Mastra 中的模型字符串约定是 `${providerId}/${model}`。
    // 例如 `deepseek/deepseek-v4-flash`、`deepseek/deepseek-v3`。
    // 这里不做额外校验（model 合法性由框架 + Provider SDK 负责），
    // 避免在本适配器里硬编码未知模型白名单导致新增模型时要再改此处。
    return `${this.id}/${model}`;
  },

  assertCredentials(): void {
    // 仅读取环境变量，绝不打印 / 写入 key 本身。
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        'DeepSeek Provider 缺少凭据：请在 backend/.env 中配置 DEEPSEEK_API_KEY 后再启动。',
      );
    }
  },
};

/**
 * 当前默认模型短名（不含 `deepseek/` 前缀）。
 *
 * 之所以不直接写完整模型 ID，是因为 config.ts 与 agents/*.ts 都要求
 * "短模型名"这一形式；真正拼接发生在 DeepSeek adapter 的
 * `resolveModelId()` 中。这样切换 Provider 时，default model 短名可由
 * 对应 adapter 提供，避免在 config 中散落 `deepseek/` 前缀。
 */
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';