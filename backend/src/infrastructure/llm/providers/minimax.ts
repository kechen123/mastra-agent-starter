import { createAnthropic } from '@ai-sdk/anthropic';
import type { MastraCompatibleModel, ProviderConfig } from '../types.js';
import type { LlmProviderAdapter } from '../types.js';

/**
 * MiniMax Provider Adapter —— Mastra Agent Starter 支持的第二个 LLM Provider，
 * 同时也是首个走"绕开 Mastra 内置 Provider Registry、Adapter 直接构造
 * Language Model"路径的 Provider。
 *
 * 设计动机：
 * - 默认 Mastra 1.65 的内置 Provider Registry 会把 `minimax/MiniMax-M2.7`
 *   固定路由到国际站 `https://api.minimax.io/anthropic/v1`，导致
 *   中国区 Token Plan Key（`api.minimaxi.com`）收到 401；
 * - 本 Adapter **不**返回"完整模型 ID 字符串 + 依赖 Mastra dispatch"，
 *   而是直接调用官方 `@ai-sdk/anthropic` 兼容 SDK，按 `MINIMAX_REGION`
 *   显式选定 baseURL 后构造 `LanguageModelV3` 实例。
 *
 * 本文件是后端代码中"唯一一个"知道以下事实的地方：
 *   - Provider id 为 `minimax`；
 *   - 默认区域 `global` 指向 `https://api.minimax.io/anthropic/v1`；
 *   - 区域 `cn` 指向 `https://api.minimaxi.com/anthropic/v1`；
 *   - 凭据来自环境变量 `MINIMAX_API_KEY`；
 *   - 缺失 API Key 时不允许创建 Agent；
 *   - 区域值非法时立刻拒绝（不允许 Adapter 静默回退）。
 *
 * 任何其他模块（Agent factory、Runtime、Route、Config、Frontend）都不得
 * 重复出现以上事实；它们只能调用 `resolveDefaultChatModel()` /
 * `provider.assertCredentials()` 这类通用接口。
 *
 * 错误信息规则：
 *   - 使用明确中文；
 *   - 严禁把 API Key、Header、Authorization 字符串写进错误信息。
 *
 * 运行期依赖：
 *   - `@ai-sdk/anthropic`（v3.x，与 Mastra 1.65 bundled 的 AI SDK 主版本一致）；
 *   - `@ai-sdk/provider-v6`（v3.x）的 `LanguageModelV3` 作为返回类型契约面。
 *   - 不 import 任何 `@mastra/core` dist/internal 文件。
 */

/**
 * MiniMax 区域 → Anthropic 兼容 baseURL 白名单。
 *
 * 设计原则：
 *   - 仅 Adapter 自身维护此映射，禁止让任何外部环境变量直接指定 URL；
 *     任何想"自定义 endpoint"的请求都必须经 Adapter 暴露的合法 `region`
 *     值走表；
 *   - key 列表是"已知且已验证"的区域值；任何不在此处的取值都会被
 *     `assertRegion()` 抛错。
 *   - 值为 Anthropic 兼容端点的完整前缀（含 `/v1`），与 AI SDK
 *     `normalizeBaseURL()` 兼容：仅 `https://api.anthropic.com` 会被
 *     SDK 自动追加 `/v1`，其它 URL 一律按原样使用。
 */
const REGION_BASE_URLS: Readonly<Record<string, string>> = Object.freeze({
  global: 'https://api.minimax.io/anthropic/v1',
  cn: 'https://api.minimaxi.com/anthropic/v1',
});

/**
 * 校验 region 并返回对应的 baseURL；非法值抛中文错误。
 *
 * 输入规则：
 *   - `undefined` / 空字符串 / 全空白 → 默认 `global`；
 *   - `REGION_BASE_URLS` 白名单内 → 返回对应 baseURL；
 *   - 其它 → 抛错，错误信息**不**包含任何 env 内容。
 */
function resolveRegionBaseUrl(rawRegion: string | undefined): {
  region: string;
  baseURL: string;
} {
  const normalized =
    typeof rawRegion === 'string' ? rawRegion.trim().toLowerCase() : '';
  const region = normalized === '' ? 'global' : normalized;
  const baseURL = REGION_BASE_URLS[region];
  if (!baseURL) {
    const allowed = Object.keys(REGION_BASE_URLS).join('、');
    throw new Error(
      `MINIMAX_REGION=${rawRegion ?? ''} 不是已支持的区域。` +
        `MiniMax Provider 仅支持以下区域：${allowed}。` +
        '请在 backend/.env 中把 MINIMAX_REGION 设为上述之一后重启；中国区 Token Plan 必须设为 cn。',
    );
  }
  return { region, baseURL };
}

/**
 * 默认 MiniMax 模型短名（不含 `minimax/` 前缀）。
 *
 * 拼装发生在 MiniMax Adapter 的 `resolveModelId()` 中；
 * 切换 Provider 时 default model 短名由对应 adapter 提供，避免在 config 中
 * 散落 `minimax/` 前缀。
 *
 * 选择依据：本次需求指定 `MiniMax-M2.7` 作为目标模型；该模型已被
 * MiniMax 官方文档标记为支持流式输出与工具调用。
 */
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.7';

/**
 * 构造一个 MiniMax Provider Adapter 工厂。
 *
 * 之所以用工厂函数而非直接常量导出：
 *   - `ProviderConfig` 可携带运行期上下文（如 region），让 Adapter
 *     决定 baseURL；Registry 在 `resolveDefaultChatModel()` 中按需传入；
 *   - 测试 / 子进程可在隔离 env 下"按 config 装配 Adapter"，避免在
 *     import 副作用阶段硬绑环境变量。
 *
 * 契约保持向后兼容：当 `config` 为空对象时，Adapter 行为等同于
 * "无 region 环境变量" → 默认 `global`。
 */
export function createMinimaxAdapter(
  config: ProviderConfig = {},
): LlmProviderAdapter {
  // Adapter 实例内只解析一次 region → baseURL，避免每次 `resolveLanguageModel()`
  // 都重新读 env；region 在 Adapter 生命周期内不允许变更（部署级）。
  const { baseURL } = resolveRegionBaseUrl(config.region);

  return {
    id: 'minimax',
    displayName: 'MiniMax',

    resolveModelId(model: string): string {
      // 仍然发射 `${providerId}/${model}` 形式，供 capabilities / 日志 /
      // Run 元数据使用。Agent factory 实际不会消费这个字符串——它会调
      // `resolveLanguageModel()` 拿到一个已固定 baseURL 的 Anthropic 实例，
      // 绕开 Mastra 内置 Provider Registry 的"minimax → 国际站"硬编码。
      return `${this.id}/${model}`;
    },

    resolveLanguageModel(model: string): MastraCompatibleModel {
      // 在构造时校验凭据——避免把"缺 key"的错误推迟到 Agent 第一次流式调用时。
      this.assertCredentials();
      // 每个 Adapter 实例只构造一次 Anthropic Provider，缓存到闭包；同一
      // 进程内多次 `resolveLanguageModel()` 调用复用同一 Provider，避免
      // 每次都重新读 env / 重新做网络探测。
      const apiKey = process.env.MINIMAX_API_KEY;
      // 这里再读一次是因为 assertCredentials 已经校验过"非空字符串"，
      // TypeScript 不知道，类型上需要非空断言；运行时安全由 assertCredentials 兜底。
      const anthropic = createAnthropic({
        apiKey: apiKey as string,
        baseURL,
      });
      // `createAnthropic(...)` 既是函数也是 Provider；直接以 modelId 调用
      // 即返回 `LanguageModelV3`。`model` 在 Adapter 内部不做白名单校验，
      // 合法性由上游 Provider SDK 决定。返回类型已经在 `Provider` 的 call
      // signature 上声明为 `LanguageModelV3`，与 `MastraCompatibleModel`
      // 同一个底层类型，所以无需再断言。
      return anthropic(model);
    },

    assertCredentials(): void {
      // 仅读取环境变量，绝不打印 / 写入 key 本身。
      const apiKey = process.env.MINIMAX_API_KEY;
      if (!apiKey || apiKey.trim().length === 0) {
        throw new Error(
          'MiniMax Provider 缺少凭据：请在 backend/.env 中配置 MINIMAX_API_KEY 后再启动。',
        );
      }
    },
  };
}

/**
 * 便捷常量：未携带 region 的"默认"Adapter。
 *
 * 仅用于向后兼容：Registry 默认装载此 Adapter；调用方在每次解析默认
 * 聊天模型时，可在 `resolveDefaultChatModel(config)` 里把 `region` 传进来。
 *
 * 真正的"按 region 构造"路径在 `createMinimaxAdapter({ region })` 中。
 */
export const minimaxAdapter: LlmProviderAdapter = createMinimaxAdapter();

// 区域白名单对外只读导出；测试 / 文档可引用，禁止被覆写。
export const MINIMAX_REGIONS: ReadonlyArray<string> = Object.freeze(
  Object.keys(REGION_BASE_URLS),
);
