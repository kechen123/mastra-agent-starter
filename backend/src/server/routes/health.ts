import { registerApiRoute } from '@mastra/core/server';
import { config } from '../../config.js';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { resolveDefaultChatModel } from '../../infrastructure/llm/registry.js';

/**
 * 存活检查只回答进程是否能接收请求，不访问数据库或外部 Provider。
 * 负载均衡器可用它区分“进程死亡”和“依赖尚未就绪”。
 */
export const healthRoute = registerApiRoute('/healthz', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => context.json({ status: 'ok' }),
});

/**
 * 就绪检查验证完整 Starter 的关键依赖：数据库、当前 LLM 凭据与知识库向量化配置。
 * 对客户端仅返回检查项名称，详细异常只写服务端日志，避免泄露连接串或凭据。
 */
export const readinessRoute = registerApiRoute('/readyz', {
  method: 'GET',
  requiresAuth: false,
  handler: async (context) => {
    const failed: string[] = [];
    try {
      await getDatabasePool().query('SELECT 1');
    } catch (error) {
      console.error('[readyz] database check failed:', error);
      failed.push('database');
    }
    try {
      resolveDefaultChatModel();
    } catch (error) {
      console.error('[readyz] LLM configuration check failed:', error);
      failed.push('llm');
    }
    if (!config.embeddingApiKey || !config.embeddingBaseUrl) {
      failed.push('embedding');
    }
    // readiness 响应显式声明 RAG / 向量检索是否启用；客户端用此标志
    // 决定是否提示"未配置向量知识库问答"。注意：embedding 凭据缺失
    // 不会让整个 readiness 失败（Core 模式仍可用），仅作为 informational 字段。
    const ragEnabled = config.ragEnabled;
    const vectorRetrievalConfigured = ragEnabled
      && Boolean(config.embeddingApiKey)
      && Boolean(config.embeddingBaseUrl);
    return failed.length === 0
      ? context.json({ status: 'ready', ragEnabled, vectorRetrievalConfigured })
      : context.json(
          { status: 'not-ready', checks: failed, ragEnabled, vectorRetrievalConfigured },
          503,
        );
  },
});
