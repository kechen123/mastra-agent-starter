import 'dotenv/config';

/**
 * 数据库向量维度硬约束。
 *
 * 原因：
 * - `backend/database/init.sql` 中 `document_chunks.embedding` 的列定义
 *   固定为 `vector(2048)`，是数据库 schema 的事实。
 * - 当前 Starter 不引入迁移机制；切换 Embedding 模型维度必须先把
 *   `database/init.sql` 与真实数据库同步迁移，再放宽本常量。
 *
 * 因此：
 * - `DATABASE_EMBEDDING_DIM` 是数据库 schema 的镜像，是不可变的真值。
 * - `EMBEDDING_DIM` 只是为了让运维一眼看清"模型必须与 schema 对齐"。
 * - 两个值不一致时，启动直接抛错，绝不静默继续。
 */
export const DATABASE_EMBEDDING_DIM = 2048;

export type DeploymentProfile = 'demo' | 'production';

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

/**
 * 部署档位是防误用开关，不是认证实现的替代品。
 *
 * 当前 Starter 还没有身份、租户和限流能力，因此只允许 `demo`：用于本地或
 * 受信任网络。`production` 会明确拒绝启动，防止把匿名模板误部署到公网。
 */
function resolveDeploymentProfile(): DeploymentProfile {
  const value = process.env.DEPLOYMENT_PROFILE ?? 'demo';
  if (value !== 'demo' && value !== 'production') {
    throw new Error('DEPLOYMENT_PROFILE 仅支持 demo 或 production。');
  }
  if (value === 'production') {
    throw new Error(
      '当前 Starter 不支持 DEPLOYMENT_PROFILE=production：认证、租户隔离与速率限制尚未实现。' +
        '请保持 demo 并仅部署在受信任网络，或先完成生产安全阶段。',
    );
  }
  return value;
}

/**
 * 应用级配置：所有字段都从环境变量读取并提供默认值。
 *
 * 命名约定：
 * - `appName` / `appShortName` 是产品名称（`Mastra Agent Starter` / `Mastra`），前端 UI 与
 *   `GET /capabilities` 都会回传，避免任何硬编码。
 *
 * LLM 模型配置：
 * - 当前 Starter 唯一正式启用的 Provider 是 DeepSeek，因此下面默认把
 *     `chatProvider` 固定为 `'deepseek'`；扩展由
 *     `infrastructure/llm/registry.ts` 负责。
 * - `chatModel` 是**不含** Provider 前缀的"短模型名"，例如 `deepseek-v4-flash`。
 *   真正拼接成完整模型 ID（`deepseek/deepseek-v4-flash`）发生在
 *   `infrastructure/llm/registry.ts:resolveDefaultChatModel()` 中。
 *
 * 历史兼容性说明：
 * - `AGENT_CHAT_MODEL` 形如 `deepseek/<model>` 时，可解析为对应的 Provider + 短模型名，
 *   但会输出"已废弃"的警告，建议改用 `LLM_PROVIDER` + `LLM_MODEL`。
 * - `AGENT_CHAT_MODEL` 形如 `<其他 Provider>/<model>` 时，明确拒绝；
 *   不允许通过旧变量静默启用未注册的 Provider。
 * - `XUANSHU_CHAT_MODEL` 不再被任何源码读取；设置后仅输出警告，不参与解析。
 *
 * 凭据校验：
 * - `DEEPSEEK_API_KEY` 的"是否存在"由 Provider Adapter 在真正创建 Agent 时检查
 *   （见 `infrastructure/llm/registry.ts:resolveDefaultChatModel()`）；
 *   本文件不读取、不输出 key 本身，也不强制启动期校验，
 *   以便 typecheck / 契约测试在无 key 的开发机或 CI 上顺利通过。
 */
if (process.env.XUANSHU_CHAT_MODEL && !process.env.AGENT_CHAT_MODEL && !process.env.LLM_MODEL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[config] 检测到 XUANSHU_CHAT_MODEL；该变量已废弃，请改用 LLM_PROVIDER + LLM_MODEL。' +
      '当前将忽略 XUANSHU_CHAT_MODEL。',
  );
}

/**
 * 解析 LLM 配置：包含新变量优先、旧变量兼容解析。
 *
 * 行为优先级（从高到低）：
 *   1. `LLM_PROVIDER` + `LLM_MODEL`（推荐）；
 *   2. `AGENT_CHAT_MODEL=deepseek/<model>`（兼容，输出弃用警告）；
 *   3. 默认值 `deepseek` + `deepseek-v4-flash`。
 *
 * 边界：
 * - 新变量中的 Provider 是否已注册，由 `infrastructure/llm/registry.ts` 统一判定；
 *   配置层不维护 Provider 白名单，以保证新增 Adapter 时无需修改本文件。
 * - `AGENT_CHAT_MODEL` 形如 `<其他 Provider>/<model>` → 抛错。该变量是 DeepSeek
 *   时代的兼容入口，不能借此静默启用其他 Provider。
 */
function resolveLlmConfig(): { chatProvider: string; chatModel: string; deprecated: boolean } {
  const rawProvider = process.env.LLM_PROVIDER;
  const rawModel = process.env.LLM_MODEL;
  const rawLegacy = process.env.AGENT_CHAT_MODEL;

  const hasNewProvider = rawProvider !== undefined && rawProvider !== '';
  const hasNewModel = rawModel !== undefined && rawModel !== '';
  const hasLegacy = rawLegacy !== undefined && rawLegacy !== '';

  // 1) 新变量优先。
  if (hasNewProvider || hasNewModel) {
    const provider = hasNewProvider ? (rawProvider as string) : 'deepseek';
    const model = hasNewModel ? (rawModel as string) : 'deepseek-v4-flash';
    // 同时存在旧变量时，仅在用户主动配置了新 Provider 或新 Model 时输出一次提示。
    if (hasLegacy) {
      // eslint-disable-next-line no-console
      console.warn(
        '[config] 检测到 AGENT_CHAT_MODEL；该变量已废弃，请改用 LLM_PROVIDER + LLM_MODEL。' +
          '当前已配置新变量，因此忽略 AGENT_CHAT_MODEL。',
      );
    }
    return { chatProvider: provider, chatModel: model, deprecated: false };
  }

  // 2) 旧 AGENT_CHAT_MODEL 兼容路径。
  if (hasLegacy) {
    const value = rawLegacy as string;
    // 与当前 Starter 唯一正式支持的 Provider 前缀 `deepseek/` 保持一致；
    // 这是"可被识别的旧变量"白名单，非 Provider-specific 校验逻辑。
    const prefix = 'deepseek/';
    if (!value.startsWith(prefix)) {
      throw new Error(
        `AGENT_CHAT_MODEL=${value} 不被允许：当前 Starter 仅启用 DeepSeek Provider；` +
          '如需新增其他厂商，请改用 LLM_PROVIDER + LLM_MODEL，并在 infrastructure/llm/providers 中实现并注册 Adapter。',
      );
    }
    const shortModel = value.slice(prefix.length);
    if (!shortModel) {
      throw new Error(
        `AGENT_CHAT_MODEL=${value} 缺少模型短名；推荐改用 LLM_PROVIDER=deepseek + LLM_MODEL=<model>。`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[config] AGENT_CHAT_MODEL=${value} 已废弃，请改用 LLM_PROVIDER=deepseek + LLM_MODEL=${shortModel}。`,
    );
    return { chatProvider: 'deepseek', chatModel: shortModel, deprecated: true };
  }

  // 3) 默认值。
  return { chatProvider: 'deepseek', chatModel: 'deepseek-v4-flash', deprecated: false };
}

/**
 * 加载配置时即校验向量维度契约。一旦失败立即抛错，避免运行期再因
 * 数据库列宽不一致而崩溃。
 */
const embeddingDim = positiveInteger('EMBEDDING_DIM', DATABASE_EMBEDDING_DIM);
if (embeddingDim !== DATABASE_EMBEDDING_DIM) {
  throw new Error(
    `Embedding 维度不一致：当前 EMBEDDING_DIM=${embeddingDim}，但数据库 schema 固定为 ${DATABASE_EMBEDDING_DIM}（document_chunks.embedding=vector(${DATABASE_EMBEDDING_DIM})）。` +
      '切换 Embedding 模型维度需要单独的数据迁移阶段，本 Starter 仅支持把 EMBEDDING_DIM 显式设置为 ' +
      `${DATABASE_EMBEDDING_DIM}。请勿通过修改环境变量绕过本检查。`,
  );
}

const llm = resolveLlmConfig();
const deploymentProfile = resolveDeploymentProfile();

export const config = {
  deploymentProfile,
  appName: process.env.APP_NAME ?? 'Mastra Agent Starter',
  appShortName: process.env.APP_SHORT_NAME ?? 'Mastra',
  // Provider / 短模型名。完整模型 ID（`deepseek/<model>`）由
  // `infrastructure/llm/registry.ts:resolveDefaultChatModel()` 构造。
  chatProvider: llm.chatProvider,
  chatModel: llm.chatModel,
  embeddingApiKey: process.env.EMBEDDING_API_KEY ?? '',
  embeddingBaseUrl: process.env.EMBEDDING_BASE_URL ?? '',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'doubao-embedding-vision-251215',
  embeddingDim,
  databaseEmbeddingDim: DATABASE_EMBEDDING_DIM,
} as const;
