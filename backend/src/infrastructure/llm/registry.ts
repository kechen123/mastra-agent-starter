import type { LlmProviderAdapter, MastraCompatibleModel, ProviderConfig } from './types.js';
import { deepseekAdapter } from './providers/deepseek.js';
import { createMinimaxAdapter } from './providers/minimax.js';
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
 * - 当前 Starter 已注册 DeepSeek 与 MiniMax 两个 Provider；
 *   新增厂商必须先实现并注册对应 Adapter，再通过环境变量切换。
 * - 不实现自动扫描、动态 import、插件热加载；
 *   一切走显式静态表，避免隐式副作用。
 *
 * 关于 MiniMax 的 region：
 *   - 默认 `PROVIDERS` 表中的 `minimax` Adapter 不携带 region；
 *   - 调用 `resolveDefaultChatModel()` 时，本文件会读 `config.minimaxRegion`
 *     并按 `createMinimaxAdapter({ region })` 重新构造一份"携带 region"
 *     的 Adapter 实例，仅在本次调用范围内使用；
 *   - `PROVIDERS` 静态表本身不被覆写，避免影响其它只读描述路径
 *     （如 `/capabilities` 通过 `listProviderIds()` 读到的 id 集合不变）。
 */
const PROVIDERS: Readonly<Record<string, LlmProviderAdapter>> = Object.freeze({
  [deepseekAdapter.id]: deepseekAdapter,
  [minimaxAdapterId()]: createMinimaxAdapter(),
});

/**
 * 让 Object.freeze 的 key 与字符串字面量解耦——避免在多处手写
 * `'minimax'` 拼写漂移；MiniMax Adapter id 由 minimax 模块自身持有。
 */
function minimaxAdapterId(): string {
  // 通过工厂构造的默认实例取 id；这样"id 是 Adapter 的属性"这一契约保持一致。
  return createMinimaxAdapter().id;
}

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
        `当前 Starter 已支持 DeepSeek、MiniMax；如需新增其他厂商，请在 infrastructure/llm/providers 中实现并注册 Adapter。当前已注册：${registered}。`,
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
 * 解析"完整模型 ID"（即框架可识别的字符串，如 `deepseek/deepseek-v4-flash`）。
 *
 * 此函数是 `/capabilities` 等只读描述接口的推荐入口；调用方只关心
 * "用户输入了什么模型"，不需要知道 Provider 怎么拼字符串、是否需要前缀。
 *
 * 不要在 Agent factory 真正构造 Agent 时使用本结果——Agent 必须调用
 * `resolveDefaultChatModel()`，以拿到一个已固定 baseURL / apiKey 的
 * `LanguageModel` 实例（对 MiniMax 而言）或一个交由 Mastra 内置
 * dispatch 解析的字符串（对 DeepSeek 而言）。
 */
export function resolveModelId(providerId: string, model: string): string {
  return resolveProvider(providerId).resolveModelId(model);
}

/**
 * 解析"默认聊天模型 Provider Adapter"。
 *
 * 当上游没有指定 Provider 时返回当前 Starter 默认 Provider
 * （目前由 `config.chatProvider` 决定，默认仍是 DeepSeek）。
 * 未来若增加可热切换的多 Provider，此函数仍是通用入口，
 * 不再 hard-code 默认值。
 */
export function resolveDefaultProvider(): LlmProviderAdapter {
  return resolveProvider(config.chatProvider);
}

/**
 * 解析"默认聊天模型"的完整模型 ID（框架可识别的字符串）。
 *
 * 调用方不需要关心：
 *   - Provider 怎么拼字符串（是否要加 `<provider>/` 前缀）；
 *   - 默认值是什么；
 *   - 凭据怎么校验；
 *   - 配置如何兼容旧变量。
 *
 * 此函数供 `/capabilities` 等只读描述路径使用；Agent factory 必须调用
 * `resolveDefaultChatModel()`，以便在真正发起模型调用前校验凭据并拿到
 * 已固定 baseURL 的 Language Model。
 *
 * 调用时机：
 *   - 仅在"真正要创建 Agent"或"对外暴露模型信息"时调用；
 *   - 不要在 import 副作用阶段调用，否则会让 typecheck / 契约测试因
 *     未配置当前 Provider 的 API Key 而失败。
 */
export function resolveDefaultChatModelId(): string {
  const adapter = resolveProvider(config.chatProvider);
  return adapter.resolveModelId(config.chatModel);
}

/**
 * 解析默认聊天模型（Language Model 实例或交由 Mastra 解析的字符串），并校验
 * Provider 凭据。
 *
 * 仅供真正创建 Agent、发起模型调用的路径使用。若只是展示配置（例如
 * `/capabilities`），请使用 `resolveDefaultChatModelId()`，避免因尚未配置
 * API Key 而让初始化页面失效。
 *
 * 返回类型 `MastraCompatibleModel | string`：
 *   - DeepSeek：返回 `deepseek/<model>` 字符串，由 Mastra 内置 dispatch
 *     解析（与 PR-5.2 之前的路径完全一致，不改变请求路径）；
 *   - MiniMax：返回 `LanguageModelV3` 实例，baseURL / apiKey 在构造时已
 *     按 `MINIMAX_REGION` 固定，绕开 Mastra 内置 Provider Registry
 *     "minimax → 国际站"的硬编码。
 */
export function resolveDefaultChatModel(): MastraCompatibleModel | string {
  const providerConfig: ProviderConfig =
    config.chatProvider === createMinimaxAdapter().id
      ? { region: config.minimaxRegion }
      : {};
  const adapter =
    config.chatProvider === createMinimaxAdapter().id
      ? createMinimaxAdapter(providerConfig)
      : resolveProvider(config.chatProvider);
  // 凭据校验推迟到"真的要消费该 Provider"的时刻。错误信息由 adapter
  // 提供，明确中文且不泄露密钥内容。
  adapter.assertCredentials();
  return adapter.resolveLanguageModel(config.chatModel);
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
