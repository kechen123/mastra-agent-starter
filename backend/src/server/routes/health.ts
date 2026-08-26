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
    return failed.length === 0
      ? context.json({ status: 'ready' })
      : context.json({ status: 'not-ready', checks: failed }, 503);
  },
});
