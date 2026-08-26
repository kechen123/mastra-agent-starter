/**
 * LLM Provider Adapter 通用契约。
 *
 * 目标：
 * - 当前 Starter 仅启用 DeepSeek，但把所有 Provider 的"配置 / 模型 ID 拼装 /
 *   凭据校验"收敛到 `infrastructure/llm/` 之内。
 * - 未来新增 Provider 时：
 *     1. 在 `infrastructure/llm/providers/<provider>.ts` 实现本接口；
 *     2. 在 `infrastructure/llm/registry.ts` 显式 import 并注册；
 *     3. 不需要修改任何 Agent、Runtime、Route、Frontend 业务代码。
 *
 * 强约束：
 * - 本文件不得 import 任何具体 Provider（如 deepseek.ts），
 *   也不得读取任何 Provider-specific 的环境变量；
 *   它只描述"通用契约"。
 * - 错误信息不得包含真实密钥、完整 Header 或环境变量内容。
 */
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
   * 把"用户配置的模型短名"转换成"框架实际消费的完整模型 ID"。
   *
   * 例如 DeepSeek 的实现就是 `return '${this.id}/${model}'`。
   * 这样 Agent factory 永远不需要知道 provider/model 字符串怎么拼。
   *
   * 未来若某个 Provider 使用其他格式（如直连 endpoint 的 OpenAI-compatible
   * 部署），实现者可在此自由决定输出字符串结构，但必须保持契约稳定。
   */
  resolveModelId(model: string): string;

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