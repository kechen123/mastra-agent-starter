/**
 * LLM Provider Adapter 通用契约。
 *
 * 目标：
 * - 当前 Starter 已注册 DeepSeek、MiniMax 两个 Provider；所有 Provider 的
 *   "配置 / 模型 ID 拼装 / 凭据校验 / 真正模型构造"收敛到
 *   `infrastructure/llm/` 之内。
 * - 未来新增 Provider 时：
 *     1. 在 `infrastructure/llm/providers/<provider>.ts` 实现本接口；
 *     2. 在 `infrastructure/llm/registry.ts` 显式 import 并注册；
 *     3. 不需要修改任何 Agent、Runtime、Route、Frontend 业务代码。
 *
 * 强约束：
 * - 本文件不得 import 任何具体 Provider（如 deepseek.ts / minimax.ts），
 *   也不得读取任何 Provider-specific 的环境变量；
 *   它只描述"通用契约"。
 * - 错误信息不得包含真实密钥、完整 Header 或环境变量内容。
 *
 * 返回模型对象的语义：
 * - `resolveModelId()` 仅发射"框架可识别的完整模型 ID 字符串"，仅用于：
 *     - `/capabilities` 描述接口；
 *     - 日志 / 调试输出；
 *     - Run 元数据落库（`agent_runs.model` 等）。
 *   Agent factory 真正调用模型时**不**应使用本方法的返回值，而是调用
 *   `resolveLanguageModel()`。
 * - `resolveLanguageModel()` 返回"可被 Mastra Agent 直接消费的 Language Model"。
 *   默认实现：返回 `resolveModelId()` 的字符串结果，由 Mastra 内置
 *   Provider Registry / dispatch 解析（如 DeepSeek 走的路径）。
 *   覆写实现：返回真实的 AI SDK Provider 构造的 `LanguageModelV3` 实例
 *   （如 MiniMax 通过官方 Anthropic 兼容端点走 cn / global）。
 *   返回类型 `MastraCompatibleModel | string` 中：
 *     - 字符串路径：完全等价于历史行为，不改变 Provider 的请求路径；
 *     - 对象路径：构造时即固定 baseURL / apiKey，绕开 Mastra 内置
 *       Provider Registry 的固定默认（如 minimax 默认指向国际站）。
 */
import type { LanguageModelV3 } from '@ai-sdk/provider-v6';

/**
 * 与 Mastra 1.65 内置 dispatch 兼容的最小 Language Model 形态。
 *
 * 取名 `MastraCompatibleModel` 是为了：
 * - 不耦合到 Mastra 内部 `MastraLanguageModelV3`（那是 dist 私有类型）；
 * - 直接以 AI SDK v6 的 `LanguageModelV3` 作为契约面；
 * - 后续若 AI SDK 主版本切换，类型 import 由 Adapter 自身负责，
 *   本文件只声明"形如 LanguageModelV3 即可"。
 */
export type MastraCompatibleModel = LanguageModelV3;

export interface LlmProviderAdapter {
  /**
   * 短横线小写 Provider id（如 `deepseek`），用于环境变量 `LLM_PROVIDER`。
   * 必须是全局唯一的稳定字符串；新增 Provider 时禁止与已有 id 重名。
   */
  readonly id: string;

  /**
   * 人类可读的展示名（如 `DeepSeek`），用于 `/capabilities` 与 UI。
   * 严禁暴露密钥、URL 路径或环境变量名等敏感字段。
   */
  readonly displayName: string;

  /**
   * 把"用户配置的模型短名"转换成"框架可识别的完整模型 ID"。
   *
   * 例如 DeepSeek / MiniMax 的实现都是 `return '${this.id}/${model}'`。
   * 仅供 capabilities / 日志 / Run 元数据使用；不要在 Agent factory
   * 真正构造 Agent 时使用本结果——它会再次回到 Mastra 内置 Registry，
   * 失去 Adapter 构造阶段"绕开 Mastra 默认 dispatch"的能力。
   */
  resolveModelId(model: string): string;

  /**
   * 把"用户配置的模型短名"解析成"Agent 工厂可直接消费的 Language Model"。
   *
   * 默认实现：返回 `this.resolveModelId(model)` 字符串，由 Mastra 内置
   * Provider Registry 解析（DeepSeek 走的就是这条路径）。
   *
   * Provider 需要"绕过 Mastra 内置 dispatch、强制指定 baseURL"时
   * （例如 MiniMax 必须按 `MINIMAX_REGION` 选择 cn / global 端点），
   * 必须**覆写**本方法，并返回由对应 AI SDK Provider 构造的
   * `LanguageModelV3` 实例；不要在 Adapter 内引入"字符串前缀 + 让
   * Mastra 再解析一次"的绕路方案，那样既绕不开 Mastra 的硬编码 baseURL，
   * 也会让"测试构造出来的模型实例指向何处"不可观测。
   *
   * 调用时机：
   *   - 仅在"真正要创建 Agent"或"对外暴露模型信息"时调用；
   *   - 不要在 import 副作用阶段调用，否则会让 typecheck / 契约测试因
   *     未配置对应 API Key 而失败。
   */
  resolveLanguageModel(model: string): MastraCompatibleModel | string;

  /**
   * 校验运行期所必需的凭据（如 API Key）。
   *
   * 失败时必须抛错：
   * - 错误信息使用明确中文；
   * - 严禁把密钥、Header、环境变量值直接写入错误信息；
   * - 仅在"真正要创建 Agent 或解析默认模型"时调用，
   *   不要在 import 副作用阶段触发，否则会让 typecheck / 静态 lint 失败。
   */
  assertCredentials(): void;
}

/**
 * Adapter 构造 Language Model 时使用的辅助选项。
 *
 * 与 Adapter 自身契约解耦，避免把"如何构造"塞进 `LlmProviderAdapter` 接口。
 * Registry 在解析时把 `ProviderConfig` 传给具体 Adapter，让 Adapter 自行
 * 决定是否使用 / 如何使用（如读取 region 环境变量、构造 baseURL 等）。
 *
 * 当前字段：
 * - `region`：当前 Adapter 解析时所属的逻辑区域（如 MiniMax 的 cn / global）。
 *   Adapter 必须在自身白名单中查表，禁止让任意环境变量直接指定 URL。
 *
 * 未来若其它 Adapter 也需要类似上下文（如自定义 baseURL / 自定义 headers），
 * 在此扩展即可，不要让 Adapter 直接 `process.env` 读取跨 Adapter 的环境变量。
 */
export interface ProviderConfig {
  /** 逻辑区域；具体取值由 Adapter 自行定义并校验。 */
  readonly region?: string;
}
