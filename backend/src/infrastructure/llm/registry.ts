import type { LlmProviderAdapter } from './types.js';
import { deepseekAdapter } from './providers/deepseek.js';
import { config } from '../../config.js';

/**
 * LLM Provider Registry —— Starter 唯一允许"按名字查找 Provider Adapter"
 * 的地方。
 *
 * 设计动机：
 * - Agent factory / Core Runtime / Routes 都不允许 import 具体 Provider；
 *   它们只能通过 `resolveProvider()`、`resolveDefaultChatModel()`、
 *   `resolveModelId()` 这类通用函数获取所需信息。
 * - 新增 Provider 时，仅需：
 *     1. 新增 `infrastructure/llm/providers/<provider>.ts` 实现
 *        `LlmProviderAdapter`；
 *     2. 在本文件 `PROVIDERS` 表中追加一项；
 *   不允许修改 Agent、Runtime、Routes、Frontend 业务代码。
 *
 * 强约束：
 * - 当前 Starter 仅启用 DeepSeek；其余 Provider 显式不在此处注册。
 * - 不实现自动扫描、动态 import、插件热加载；
 *   一切走显式静态表，避免隐式副作用。
 */
const PROVIDERS: Readonly<Record<string, LlmProviderAdapter>> = Object.freeze({
  [deepseekAdapter.id]: deepseekAdapter,
});

/**
 * 按 Provider id 解析 Adapter。
 *
 * 找不到时（拼写错误、未注册的 Provider）抛错，
 * 错误信息使用明确中文，且绝不泄露任何密钥 / Header 内容。
 */
export function resolveProvider(providerId: string): LlmProviderAdapter {
  const adapter = PROVIDERS[providerId];
  if (!adapter) {
    const registered = Object.keys(PROVIDERS).join('、') || '（无）';
    throw new Error(
      `未注册的 LLM Provider "${providerId}"。` +
        `当前 Starter 仅启用 DeepSeek Provider；如需新增其他厂商，请在 infrastructure/llm/providers 中实现并注册 Adapter。当前已注册：${registered}。`,
    );
  }
  return adapter;
}

/**
 * 列出当前所有已注册 Provider 的 id。
 * 主要用于 `/capabilities` 之类的自描述接口与调试日志。
 */
export function listProviderIds(): string[] {
  return Object.keys(PROVIDERS);
}

/**
 * 解析"完整模型 ID"（即框架实际消费的字符串，如 `deepseek/deepseek-v4-flash`）。
 *
 * 此函数是 Agent factory 的唯一推荐入口；调用方只关心"用户输入了什么模型"，
 * 不需要知道 Provider 怎么拼字符串、是否需要前缀。
 */
export function resolveModelId(providerId: string, model: string): string {
  return resolveProvider(providerId).resolveModelId(model);
}

/**
 * 解析"默认聊天模型 Provider Adapter"。
 *
 * 当上游没有指定 Provider 时返回当前 Starter 默认 Provider
 * （目前就是 DeepSeek）。未来若增加可热切换的多 Provider，
 * 此函数仍是通用入口，只是不再 hard-code 默认值。
 */
export function resolveDefaultProvider(): LlmProviderAdapter {
  return resolveProvider(config.chatProvider);
}

/**
 * 解析"默认聊天模型"的完整模型 ID（框架实际消费的字符串）。
 *
 * 调用方不需要关心：
 *   - Provider 怎么拼字符串（是否要加 `<provider>/` 前缀）；
 *   - 默认值是什么；
 *   - 凭据怎么校验；
 *   - 配置如何兼容旧变量。
 *
 * 此函数供 `/capabilities` 等只读描述路径使用；Agent factory 必须调用
 * `resolveDefaultChatModel()`，以便在真正发起模型调用前校验凭据。
 *
 * 调用时机：
 *   - 仅在"真正要创建 Agent"或"对外暴露模型信息"时调用；
 *   - 不要在 import 副作用阶段调用，否则会让 typecheck / 契约测试因
 *     未配置 `DEEPSEEK_API_KEY` 而失败。
 */
export function resolveDefaultChatModelId(): string {
  const adapter = resolveProvider(config.chatProvider);
  return adapter.resolveModelId(config.chatModel);
}

/**
 * 解析默认聊天模型，并校验 Provider 凭据。
 *
 * 仅供真正创建 Agent、发起模型调用的路径使用。若只是展示配置（例如
 * `/capabilities`），请使用 `resolveDefaultChatModelId()`，避免因尚未配置
 * API Key 而让初始化页面失效。
 */
export function resolveDefaultChatModel(): string {
  const adapter = resolveProvider(config.chatProvider);
  // 凭据校验推迟到"真的要消费该 Provider"的时刻。错误信息由 adapter
  // 提供，明确中文且不泄露密钥内容。
  adapter.assertCredentials();
  return resolveDefaultChatModelId();
}

/**
 * 解析"默认聊天模型 Provider Adapter"，并附带展示信息。
 * 用于 `/capabilities` 等对外描述接口，避免在 routes 中重复拼接字段。
 */
export function resolveDefaultChatModelInfo(): {
  provider: string;
  model: string;
  displayName: string;
} {
  const adapter = resolveProvider(config.chatProvider);
  return {
    provider: adapter.id,
    model: config.chatModel,
    displayName: adapter.displayName,
  };
}
