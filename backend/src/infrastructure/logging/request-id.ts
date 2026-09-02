/**
 * Request ID：每个 API 请求生成 / 透传 `requestId`。
 *
 * 协议：
 *   - 入站读取 `X-Request-ID` 头；缺省 / 非合法 → 生成新 ID；
 *   - 响应头回填 `X-Request-ID`；
 *   - 同请求上下文（withAuthenticatedWorkspace 包装的 handler）
 *     通过 AsyncLocalStorage 向下游透传，service / repository 拿到
 *     `requestId` 后写入日志与 `agent_runs.request_id`。
 *
 * 阶段 2 验收：requestId 可在响应 / 日志 / agent_runs 中关联。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const storage = new AsyncLocalStorage<{ requestId: string }>();

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * 从 Request 解析 / 生成 requestId：
 *   - 入站有合法 UUID X-Request-ID → 透传；
 *   - 否则 → 生成新 UUID。
 */
export function resolveRequestId(request: Request): string {
  const header = request.headers.get('x-request-id');
  if (header && UUID_PATTERN.test(header)) return header;
  return randomUUID();
}

/**
 * 在 handler 入口处创建上下文：所有下游 await 链都拿得到 `requestId`。
 */
export function withRequestId<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ requestId }, fn);
}

/**
 * 把 requestId 写入响应头（X-Request-ID）。
 * 调用方拿到 Response 后调一次，把头补齐。
 */
export function applyRequestIdHeader(response: Response, requestId: string): Response {
  if (response.headers.get('x-request-id')) return response;
  response.headers.set('X-Request-ID', requestId);
  return response;
}

/**
 * 写一条带 requestId 的日志。handler / service / executor 都通过本
 * 函数集中输出，避免散落 `logger.info(...)` 写漏字段。
 */
export interface RequestLogContext {
  requestId?: string;
  workspaceId?: string;
  userId?: string;
  conversationId?: string;
  runId?: string;
  assistantMessageId?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  tokens?: { input?: number; output?: number };
  errorCode?: string;
  stopped?: boolean;
  controllerAlive?: boolean;
  eventId?: number;
  msg: string;
}

export function logRequest(level: 'info' | 'warn' | 'error', ctx: RequestLogContext): void {
  const baseFields: Record<string, unknown> = {
    requestId: ctx.requestId ?? getRequestId(),
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    provider: ctx.provider,
    model: ctx.model,
    durationMs: ctx.durationMs,
    errorCode: ctx.errorCode,
  };
  if (ctx.tokens) {
    if (ctx.tokens.input !== undefined) baseFields.inputTokens = ctx.tokens.input;
    if (ctx.tokens.output !== undefined) baseFields.outputTokens = ctx.tokens.output;
  }
  // 清理 undefined 字段，避免日志里出现大量 noise。
  for (const [k, v] of Object.entries(baseFields)) {
    if (v === undefined) delete baseFields[k];
  }
  if (level === 'error') {
    logger.error(baseFields, ctx.msg);
  } else if (level === 'warn') {
    logger.warn(baseFields, ctx.msg);
  } else {
    logger.info(baseFields, ctx.msg);
  }
}