/**
 * Run SSE 端点：把 agent_run_events 转成标准 text/event-stream。
 *
 * 协议（architecture-v2.md §6.4 + PR-2.4）：
 *   - 支持 `Last-Event-ID` 头（标准）；
 *   - 同时兼容严格校验的 `lastEventId` query 参数（前端 sessionStorage 恢复用）；
 *   - 回放 id > lastEventId 的历史事件，再订阅 bus 实时唤醒；
 *   - 每条持久化事件 SSE 帧 `id` 是 BIGINT IDENTITY；
 *   - **双通道**：除 checkpoint 持久化事件外，SSE 同时通过
 *     `agent_run_live_deltas_channel` 收实时增量，发送 `content-delta` 帧
 *     （**不带** SSE id、不进入 lastEventId 计数）；
 *   - 客户端断开 → cancel bus 订阅（持久化 + 实时增量）；
 *   - workspace / 用户归属校验：事件在 DB 内已按 workspace_id 索引，handler
 *     再做一次 getRunById 校验避免被攻击者越权订阅；
 *   - 持久化事件发送串行化：单一 in-flight 任务 + lastDeliveredId 守卫保证
 *     id 严格递增，绝不回退、绝不重发。
 */
import type { Context } from 'hono';
import { ensureRunReadable } from './service.js';
import { listRunEvents, type RunEventRow } from './repository.js';
import { getRunEventsBus } from './run-events-bus.js';
import { getLiveDeltaBus, type LiveDeltaPayload } from './live-delta-bus.js';
import { logRequest } from '../../infrastructure/logging/request-id.js';

const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export interface SseRunEventStreamOptions {
  runId: string;
  workspaceId: string;
  lastEventId: number;
}

/**
 * 测试 hook：注入 repo 实现。仅单元测试使用；不导出到生产代码。
 */
export interface RunRepositoryLike {
  getRunById(runId: string, workspaceId: string): Promise<unknown>;
  listRunEvents(options: { runId: string; workspaceId: string; afterId?: number; limit?: number }): Promise<RunEventRow[]>;
  insertRunEvent(args: unknown): Promise<unknown>;
}

export interface RunBusSubscribeHandle {
  (): void;
}

export interface RunEventBusLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(runId: string, cb: (eventId: number) => void): RunBusSubscribeHandle;
}

export interface LiveDeltaBusLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(runId: string, cb: (payload: LiveDeltaPayload) => void): RunBusSubscribeHandle;
}

let repositoryOverride: RunRepositoryLike | null = null;
let busFactoryOverride: (() => RunEventBusLike) | null = null;
let liveDeltaBusFactoryOverride: (() => LiveDeltaBusLike) | null = null;

export function __setRunRepositoryForTesting(repo: RunRepositoryLike | null): void {
  repositoryOverride = repo;
}

export function __setRunEventsBusFactoryForTesting(factory: (() => RunEventBusLike) | null): void {
  busFactoryOverride = factory;
}

export function __setLiveDeltaBusFactoryForTesting(factory: (() => LiveDeltaBusLike) | null): void {
  liveDeltaBusFactoryOverride = factory;
}

function resolveRepo(): {
  getRunById: (runId: string, workspaceId: string) => Promise<unknown>;
  listRunEvents: typeof listRunEvents;
} {
  if (repositoryOverride) {
    return {
      getRunById: repositoryOverride.getRunById as never,
      listRunEvents: repositoryOverride.listRunEvents as never,
    };
  }
  return {
    async getRunById(runId, workspaceId) {
      // 走 service 层做 workspace 校验
      const { ensureRunReadable } = await import('./service.js');
      return ensureRunReadable(workspaceId, runId);
    },
    listRunEvents,
  };
}

function resolveBus(): RunEventBusLike {
  if (busFactoryOverride) return busFactoryOverride();
  return getRunEventsBus() as unknown as RunEventBusLike;
}

function resolveLiveDeltaBus(): LiveDeltaBusLike {
  if (liveDeltaBusFactoryOverride) return liveDeltaBusFactoryOverride();
  return getLiveDeltaBus() as unknown as LiveDeltaBusLike;
}

export async function streamRunEvents(
  options: SseRunEventStreamOptions,
): Promise<Response> {
  const repo = resolveRepo();
  const run = await repo.getRunById(options.runId, options.workspaceId);
  if (!run) {
    return new Response(
      JSON.stringify({ error_code: 'NOT_FOUND', message: '资源不存在。' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const encoder = new TextEncoder();
  let unsubscribeBus: RunBusSubscribeHandle | null = null;
  let unsubscribeLiveDelta: RunBusSubscribeHandle | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: string): void => {
        try { controller.enqueue(encoder.encode(chunk)); } catch { /* ignore */ }
      };
      const sendFrame = (event: RunEventRow): void => {
        enqueue(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      };
      const sendDeltaFrame = (text: string): void => {
        // 实时增量：仅 event + data，不带 id 行；EventSource 不会更新 lastEventId，
        // 刷新 / 重连时不参与 lastEventId 回放。
        enqueue(`event: content-delta\ndata: ${JSON.stringify({ runId: options.runId, text })}\n\n`);
      };
      const sendComment = (line: string): void => {
        enqueue(`: ${line}\n\n`);
      };

      // 回放：先写历史，再订阅实时事件，避免"先写实时 → 错过回放"竞态。
      const historical = await repo.listRunEvents({
        runId: options.runId,
        workspaceId: options.workspaceId,
        afterId: options.lastEventId,
      });
      for (const event of historical) {
        sendFrame(event);
      }
      // 客户端拿到的最新 id；用于下次断线重连的 Last-Event-ID。
      let lastDeliveredId = historical.length > 0 ? historical[historical.length - 1]!.id : options.lastEventId;
      enqueue(`retry: 5000\n\n`);

      // 持久化事件通道：串行化处理，每次只有一个 listRunEvents 在飞；
      // 严格按 id 顺序发送，绝不重发、绝不让 lastDeliveredId 回退。
      let inflight: Promise<void> = Promise.resolve();
      const bus = resolveBus();
      await bus.start();
      unsubscribeBus = bus.subscribe(options.runId, (eventId: number) => {
        if (eventId <= lastDeliveredId) return;
        // 串行化：把本次处理挂在上一次之后，并 await 之——保证 in-flight 查询
        // 顺序推进、lastDeliveredId 不会因为并发查询导致回退或重复发送。
        inflight = inflight.then(async () => {
          const events = await repo.listRunEvents({
            runId: options.runId,
            workspaceId: options.workspaceId,
            afterId: lastDeliveredId,
            limit: 100,
          });
          for (const event of events) {
            sendFrame(event);
          }
          if (events.length > 0) {
            lastDeliveredId = events[events.length - 1]!.id;
          }
        }).catch(() => { /* ignore */ });
      });

      // 实时增量通道：与持久化事件完全独立，不带 id，不串行化；
      // 缺失允许——下一次 checkpoint 会兜底覆盖。
      const liveBus = resolveLiveDeltaBus();
      await liveBus.start();
      unsubscribeLiveDelta = liveBus.subscribe(options.runId, (payload) => {
        // 仅当 payload 文本非空时推送。缺失的实时增量不影响最终一致性。
        if (!payload.text) return;
        sendDeltaFrame(payload.text);
      });

      keepaliveTimer = setInterval(() => sendComment('keepalive'), SSE_KEEPALIVE_INTERVAL_MS);
      keepaliveTimer.unref?.();

      logRequest('info', {
        msg: 'SSE 订阅已建立',
        workspaceId: options.workspaceId,
        runId: options.runId,
      });
    },
    cancel() {
      if (unsubscribeBus) unsubscribeBus();
      if (unsubscribeLiveDelta) unsubscribeLiveDelta();
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      logRequest('info', {
        msg: 'SSE 订阅已断开',
        workspaceId: options.workspaceId,
        runId: options.runId,
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * 解析 Last-Event-ID 头 / query。规范允许整数；缺省 / 非法 → 0。
 */
export function parseLastEventId(raw: string | null | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * 给 legacy /ask 旧 SSE 流补齐"标准 Last-Event-ID"语义。新协议唯一 SSE
 * 入口是 /runs/:runId/events；旧 /ask 仍然直连，但不再视为可靠恢复来源。
 */
export const _legacySseNote = '/ask SSE 流不携带 id 字段，前端不得用其做断线恢复';

export type HonoSseContext = Context;