/**
 * V2 协议下 conversations / messages / runs 共享的 handler 工厂。
 *
 * 设计目标：
 *   - /v1/v2alpha/* 与 /v1/* 共享业务逻辑，路由文件只是"挂前缀 + 绑 handler"；
 *   - 旧根路径路由（/ask /conversations）继续保留，并通过同一 service 调用，
 *     但响应头加 Deprecation / Sunset；
 *   - 幂等性、workspace 校验、agent_runs 单事务副作用统一在本文件里完成。
 */
import { config } from '../../../config.js';
import { getAgentDefinition } from '../../../core/agent/registry.js';
import { isUuid } from '../../../core/execution/sse.js';
import { abortExecution } from '../../../core/execution/controller.js';
import { abortRunByMessage } from '../../../core/execution/run-executor.js';
import { InputValidationError } from '../../error-mapping.js';
import {
  fingerprintRequest,
  isUuid as isUuidKey,
  lookupIdempotency,
  storeIdempotency,
  claimOrLookupIdempotency,
  finalizeIdempotency,
} from '../../../modules/idempotency/repository.js';
import {
  convergeRunningToolExecutions,
} from '../../../modules/conversations/tool-executions.js';
import {
  createDraftConversation,
  createUserMessageAndQueuedRun,
  stopRunByMessageId,
} from '../../../modules/runs/service.js';
import {
  getConversationWithMessages,
} from '../../../modules/conversations/service.js';
import { getDatabasePool } from '../../../infrastructure/database/pool.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import {
  applyRequestIdHeader,
  logRequest,
  resolveRequestId,
} from '../../../infrastructure/logging/request-id.js';

export interface AuthedCtxLike {
  req: {
    raw?: Request;
    json: <T = unknown>() => Promise<T>;
    param: (n: string) => string;
    header?: (n: string) => string | undefined;
  };
  json: (data: unknown, status?: number) => Response;
}

export interface AuthedHandlerContext {
  workspaceId: string;
  userId: string;
  username: string;
}

export type AuthedHandler = (
  auth: AuthedHandlerContext,
  context: AuthedCtxLike,
) => Promise<Response>;

const EVENT_RUN_URL_PREFIX = '/runs/';
const EVENT_RUN_URL_SUFFIX = '/events';

function buildEventsUrl(runId: string, base: 'v2alpha' | 'v1'): string {
  const prefix = base === 'v2alpha' ? '/v1/v2alpha' : '/v1';
  return `${prefix}${EVENT_RUN_URL_PREFIX}${runId}${EVENT_RUN_URL_SUFFIX}`;
}

function readIdempotencyKey(context: AuthedCtxLike): string {
  const header = context.req.header?.('idempotency-key') ?? null;
  if (!header || !isUuidKey(header)) {
    throw new InputValidationError('缺少或非法的 Idempotency-Key（必须为 UUID）。');
  }
  return header;
}

function readAgentId(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InputValidationError('请求体必须是 JSON 对象。');
  }
  const agentId = (body as Record<string, unknown>).agentId;
  if (typeof agentId !== 'string' || !getAgentDefinition(agentId)) {
    throw new InputValidationError('agentId 无效。');
  }
  return agentId;
}

function readKnowledgeBaseId(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const kbId = (body as Record<string, unknown>).knowledgeBaseId;
  if (kbId === undefined || kbId === null || kbId === '') return null;
  if (typeof kbId !== 'string' || !isUuid(kbId)) {
    throw new InputValidationError('knowledgeBaseId 格式不正确。');
  }
  return kbId;
}

function readContent(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InputValidationError('请求体必须是 JSON 对象。');
  }
  const content = (body as Record<string, unknown>).content;
  if (typeof content !== 'string') {
    throw new InputValidationError('content 必须是字符串。');
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new InputValidationError('请输入问题。');
  }
  if (trimmed.length > 2000) {
    throw new InputValidationError('问题不能超过 2000 个字符。');
  }
  return trimmed;
}

interface RunDeps {
  base: 'v2alpha' | 'v1';
  requestId: string;
}

export const sharedHandlers = {
  /**
   * POST /conversations — 创建服务端 draft conversation。
   */
  createConversation(auth: AuthedHandlerContext, context: AuthedCtxLike, deps: RunDeps): Promise<Response> {
    return runHandler(auth, context, deps, async () => {
      const body = await context.req.json<unknown>();
      const agentId = readAgentId(body);
      const kbId = readKnowledgeBaseId(body);
      const idemKey = readIdempotencyKey(context);
      const fingerprint = fingerprintRequest('POST', '/conversations', { agentId, knowledgeBaseId: kbId });

      const pool = getDatabasePool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // 串行化声明：同一 (ws, user, key) 并发请求，第二个会阻塞到第一个 commit，
        // 然后命中缓存并返回相同响应。
        const claim = await claimOrLookupIdempotency(client, {
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          key: idemKey,
          fingerprint,
        });
        if ('mismatch' in claim && claim.mismatch) {
          await client.query('ROLLBACK');
          return context.json(
            { error_code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency-Key 已被用于其它请求。' },
            409,
          );
        }
        if ('hit' in claim) {
          await client.query('ROLLBACK');
          return context.json(claim.hit.body, claim.hit.status);
        }
        // claimed: true — 本事务独占 key；继续副作用。
        // 知识库存在性 + 工作区隔离
        if (kbId) {
          const kbCheck = await client.query<{ id: string }>(
            'SELECT id FROM knowledge_bases WHERE id = $1 AND workspace_id = $2',
            [kbId, auth.workspaceId],
          );
          if (kbCheck.rows.length === 0) {
            throw new InputValidationError('knowledgeBaseId 不存在或不属于当前 Workspace。');
          }
        }
        const created = await createDraftConversation(client, {
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          agentId,
          knowledgeBaseId: kbId,
        });
        await finalizeIdempotency(client, {
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          key: idemKey,
          responseStatus: 201,
          responseBody: created,
        });
        await client.query('COMMIT');
        logRequest('info', {
          msg: 'POST /conversations 201',
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          conversationId: created.id,
        });
        return context.json(created, 201);
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      } finally {
        client.release();
      }
    });
  },

  /**
   * POST /conversations/:id/messages — 写 user message + 创建 queued Run。
   *
   * 协议顺序（V2 §6.2）：
   *   1. draft → active + 标题触发；
   *   2. INSERT user message；
   *   3. INSERT assistant pending, current_run_id=NULL；
   *   4. INSERT agent_runs(status='queued')；
   *   5. INSERT agent_run_events(type='run-queued') + NOTIFY；
   *   6. UPDATE messages.current_run_id；
   *   7. 写 idempotency_keys 缓存；
   */
  createMessage(auth: AuthedHandlerContext, context: AuthedCtxLike, deps: RunDeps): Promise<Response> {
    return runHandler(auth, context, deps, async () => {
      const conversationId = context.req.param('id');
      if (!isUuid(conversationId)) {
        throw new InputValidationError('id 格式不正确。');
      }
      const body = await context.req.json<unknown>();
      const content = readContent(body);
      const idemKey = readIdempotencyKey(context);
      const fingerprint = fingerprintRequest('POST', `/conversations/${conversationId}/messages`, { content });

      const pool = getDatabasePool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // 串行化声明：同一 (ws, user, key) 并发请求，第二个会阻塞到第一个 commit，
        // 然后命中缓存并返回相同响应。确保只产生一次 createUserMessageAndQueuedRun。
        const claim = await claimOrLookupIdempotency(client, {
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          key: idemKey,
          fingerprint,
        });
        if ('mismatch' in claim && claim.mismatch) {
          await client.query('ROLLBACK');
          return context.json(
            { error_code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency-Key 已被用于其它请求。' },
            409,
          );
        }
        if ('hit' in claim) {
          await client.query('ROLLBACK');
          return context.json(claim.hit.body, claim.hit.status);
        }
        // claimed: true — 本事务独占 key。

        // 校验会话归属当前 workspace + 取 agentId
        const convRow = await client.query<{ agent_id: string }>(
          `SELECT agent_id FROM conversations
            WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
          [conversationId, auth.workspaceId],
        );
        const conv = convRow.rows[0];
        if (!conv) {
          await client.query('ROLLBACK');
          return context.json(
            { error_code: 'NOT_FOUND', message: '资源不存在。' },
            404,
          );
        }

        const result = await createUserMessageAndQueuedRun(client, {
          workspaceId: auth.workspaceId,
          conversationId,
          userMessageContent: content,
          agentId: conv.agent_id,
          provider: config.chatProvider,
          model: config.chatModel,
          userId: auth.userId,
          requestId: deps.requestId,
        });

        const responseBody = {
          userMessageId: result.userMessage.id,
          assistantMessageId: result.assistantMessage.id,
          runId: result.run.id,
          eventsUrl: buildEventsUrl(result.run.id, deps.base),
        };
        await finalizeIdempotency(client, {
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          key: idemKey,
          responseStatus: 202,
          responseBody,
        });
        await client.query('COMMIT');
        logRequest('info', {
          msg: 'POST /conversations/:id/messages 202',
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          conversationId,
          runId: result.run.id,
        });
        return context.json(responseBody, 202);
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        if ((err as Error).name === 'ConversationActiveRunError') {
          return context.json(
            {
              error_code: 'CONVERSATION_CONFLICT_ACTIVE_RUN',
              message: (err as Error).message,
            },
            409,
          );
        }
        throw err;
      } finally {
        client.release();
      }
    });
  },

  /**
   * GET /runs/:runId/events — SSE 订阅 + 历史回放。
   *
   * lastEventId 来源（按优先级，互不重复）：
   *   1. 标准 `Last-Event-ID` header（浏览器在 EventSource 自动重连时携带）；
   *   2. 严格校验的 `lastEventId` query 参数（前端用 sessionStorage 恢复
   *      时使用——浏览器对新建 EventSource 不会自动带 header）；
   *   3. 缺省 → 0。
   */
  async streamRunEvents(auth: AuthedHandlerContext, context: AuthedCtxLike, deps: RunDeps): Promise<Response> {
    const runId = context.req.param('runId');
    if (!isUuid(runId)) {
      return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
    }
    const headerVal = context.req.header?.('last-event-id') ?? null;
    const queryVal = (() => {
      const raw = context.req as { query?: (name: string) => string | undefined };
      return raw.query?.('lastEventId') ?? null;
    })();
    const { parseLastEventId, streamRunEvents } = await import('../../../modules/runs/sse.js');
    // 优先 header；query 是 sessionStorage 恢复路径，与 header 不可能同时为非零合法值。
    const lastEventId = parseLastEventId(headerVal) || parseLastEventId(queryVal);
    const response = await streamRunEvents({
      runId,
      workspaceId: auth.workspaceId,
      lastEventId,
    });
    applyRequestIdHeader(response, deps.requestId);
    return response;
  },

  /**
   * GET /conversations/:id — 详情（含消息 + currentRunId）。
   * 兼容旧 conversations route；按需暴露 currentRunId 给前端恢复用。
   */
  async getConversation(auth: AuthedHandlerContext, context: AuthedCtxLike, deps: RunDeps): Promise<Response> {
    const id = context.req.param('id');
    if (!isUuid(id)) {
      return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
    }
    const detail = await getConversationWithMessages(auth.workspaceId, id);
    if (!detail) {
      return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
    }
    // 注入每条 message 的 currentRunId（供前端 SSE 重连）
    const pool = getDatabasePool();
    const ids = detail.messages.map((m) => m.id);
    let currentRunByMessage = new Map<string, string>();
    if (ids.length > 0) {
      const r = await pool.query<{ id: string; current_run_id: string | null }>(
        `SELECT id, current_run_id FROM messages WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      currentRunByMessage = new Map(r.rows.map((row) => [row.id, row.current_run_id ?? '']));
    }
    const messages = detail.messages.map((m) => ({
      ...m,
      currentRunId: currentRunByMessage.get(m.id) ?? null,
    }));
    const responseBody = { conversation: detail.conversation, messages };
    const response = context.json(responseBody);
    applyRequestIdHeader(response, deps.requestId);
    return response;
  },

  /**
   * POST /messages/:id/stop — V2 主用停 Run 入口。
   *
   * 行为（V2 §6.3 + §6.4）：
   *   1. workspace 隔离校验（消息不存在 / 跨 workspace → 404）；
   *   2. 同时命中旧 ask-driver 与新 run-executor 控制器；
   *   3. 在同一事务内收敛 Run + message + run-stopped 事件；
   *      WHERE status IN ('queued','running','waiting_approval') 防止
   *      executor 的 finally 又把 stopped 写成 completed；
   *   4. 收敛 running 的 tool_executions。
   */
  async stopMessage(auth: AuthedHandlerContext, context: AuthedCtxLike, deps: RunDeps): Promise<Response> {
    const id = context.req.param('id');
    if (!isUuid(id)) {
      return context.json({ error_code: 'INPUT_VALIDATION_FAILED', message: '消息 ID 格式不正确。' }, 422);
    }
    const pool = getDatabasePool();
    const ownerRow = await pool.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM messages WHERE id = $1`,
      [id],
    );
    if (!ownerRow.rows[0] || ownerRow.rows[0].workspace_id !== auth.workspaceId) {
      return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
    }
    const legacy = abortExecution(id);
    const runnerAborted = abortRunByMessage(id);
    const controllerAlive = legacy.success || runnerAborted;
    const partialContent = legacy.partialContent ?? '';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 即便 controller 已死，也再走一次事务收敛，确保
      // "DB 行 active 但 controller 已被 GC" 场景不漏收敛。
      const result = await stopRunByMessageId(client, {
        workspaceId: auth.workspaceId,
        assistantMessageId: id,
        partialContent: partialContent || '',
      });
      await client.query('COMMIT');
      if ('missing' in result) {
        return context.json({ error_code: 'NOT_FOUND', message: '资源不存在。' }, 404);
      }
      // 已有 run-stopped 记录
      try {
        await convergeRunningToolExecutions(auth.workspaceId, id);
      } catch (err) {
        logger.error({ msg: 'convergeRunningToolExecutions failed', err, assistantMessageId: id });
      }
      const responseBody = {
        runId: result.stopped ? result.run.id : result.run.id,
        status: result.stopped ? 'stopped' : result.run.status,
        contentLength: result.stopped ? result.contentLength : 0,
        controllerAlive,
      };
      const response = context.json(responseBody);
      applyRequestIdHeader(response, deps.requestId);
      logRequest('info', {
        msg: 'V2 stop message',
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        assistantMessageId: id,
        controllerAlive,
        stopped: result.stopped,
      });
      return response;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      logger.error({ msg: 'V2 stop message failed', err, assistantMessageId: id });
      const response = context.json(
        { error_code: 'INTERNAL_ERROR', message: '服务端内部错误。' },
        500,
      );
      applyRequestIdHeader(response, deps.requestId);
      return response;
    } finally {
      client.release();
    }
  },
};

async function runHandler(
  auth: AuthedHandlerContext,
  context: AuthedCtxLike,
  deps: RunDeps,
  body: () => Promise<Response>,
): Promise<Response> {
  try {
    const response = await body();
    applyRequestIdHeader(response, deps.requestId);
    return response;
  } catch (err) {
    if (err instanceof InputValidationError) {
      const response = context.json(
        { error_code: 'INPUT_VALIDATION_FAILED', message: err.message },
        422,
      );
      applyRequestIdHeader(response, deps.requestId);
      return response;
    }
    logger.error({ msg: 'handler  handler 失败', err });
    const response = context.json(
      { error_code: 'INTERNAL_ERROR', message: '服务端内部错误。' },
      500,
    );
    applyRequestIdHeader(response, deps.requestId);
    return response;
  }
}

export function resolveRequestIdFromContext(context: AuthedCtxLike): string {
  const req = context.req as { raw?: Request };
  const raw = req.raw;
  if (raw instanceof Request) return resolveRequestId(raw);
  return resolveRequestId(new Request('http://internal'));
}
