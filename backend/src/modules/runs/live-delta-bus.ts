/**
 * 实时增量 fan-out bus（双通道 SSE 的第二条）。
 *
 * 与 `run-events-bus.ts` 的关键差异：
 *   - 监听独立 channel `agent_run_live_deltas_channel`（与持久化事件 bus
 *     完全分离），payload 是 `{ runId, text }` 的 JSON；
 *   - callback 收到的不是 eventId，而是 `{ runId, text }`；SSE handler 据
 *     此直接推送 `content-delta` 帧（不带 SSE id）；
 *   - 实时增量的低延迟优先于公平性：callback 同步执行，无内部串行化——
 *     它推送的事件根本不带 id，不存在 lastDeliveredId 回退问题。
 *
 * 仍然使用单进程级 fan-out hub + LISTEN/NOTIFY 唤醒机制：每个 backend 实例
 * 开一条专属 pg client，所有 SSE 连接共享 LISTEN。
 */
import { Client } from 'pg';
import { logger } from '../../infrastructure/logging/logger.js';
import { LIVE_DELTA_CHANNEL } from './repository.js';

export interface LiveDeltaPayload {
  runId: string;
  text: string;
}

export type LiveDeltaSubscriber = (payload: LiveDeltaPayload) => void;

/**
 * 把原始 pg NOTIFY payload 安全解析为结构。解析失败记日志并丢弃，避免一条
 * 异常 payload 把整条 fan-out 链炸掉。空 payload 视为无内容（不调用 callback）。
 */
function parseLiveDeltaPayload(raw: string): LiveDeltaPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { runId?: unknown; text?: unknown };
    if (typeof parsed.runId !== 'string' || parsed.runId.length === 0) return null;
    if (typeof parsed.text !== 'string' || parsed.text.length === 0) return null;
    return { runId: parsed.runId, text: parsed.text };
  } catch (err) {
    logger.warn({ msg: 'live delta payload 解析失败（已丢弃）', err });
    return null;
  }
}

class LiveDeltaBus {
  private subscribers = new Map<string, Set<LiveDeltaSubscriber>>();
  private listener: Client | null = null;
  private started = false;
  private startingPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startingPromise) return this.startingPromise;
    this.startingPromise = this.doStart();
    try {
      await this.startingPromise;
    } finally {
      this.startingPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    const url = process.env.DATABASE_URL;
    if (!url) {
      logger.warn({ msg: 'DATABASE_URL 未配置；Live delta bus 未启动（仅适合本地脚本）' });
      return;
    }
    const client = new Client({ connectionString: url });
    client.on('error', (err) => {
      logger.error({ msg: 'Live delta bus 连接错误', err: { name: err.name, message: err.message } });
    });
    client.on('notification', (msg) => {
      if (msg.channel !== LIVE_DELTA_CHANNEL || !msg.payload) return;
      const payload = parseLiveDeltaPayload(msg.payload);
      if (!payload) return;
      const set = this.subscribers.get(payload.runId);
      if (!set || set.size === 0) return;
      for (const cb of set) {
        try { cb(payload); } catch (err) { logger.error({ msg: 'live delta fan-out callback error', err }); }
      }
    });
    await client.connect();
    await client.query(`LISTEN ${LIVE_DELTA_CHANNEL}`);
    this.listener = client;
    this.started = true;
    logger.info({ msg: 'Live delta bus 已订阅 LISTEN channel', channel: LIVE_DELTA_CHANNEL });
  }

  async stop(): Promise<void> {
    if (this.listener) {
      try { await this.listener.query(`UNLISTEN ${LIVE_DELTA_CHANNEL}`); } catch { /* ignore */ }
      try { await this.listener.end(); } catch { /* ignore */ }
      this.listener = null;
    }
    this.subscribers.clear();
    this.started = false;
  }

  subscribe(runId: string, cb: LiveDeltaSubscriber): () => void {
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(cb);
    return () => {
      const cur = this.subscribers.get(runId);
      if (!cur) return;
      cur.delete(cb);
      if (cur.size === 0) this.subscribers.delete(runId);
    };
  }

  /** 测试 / 调试：当前订阅者数量。 */
  size(): number {
    let total = 0;
    for (const s of this.subscribers.values()) total += s.size;
    return total;
  }
}

const globalKey = Symbol.for('xuanshu-agent/live-delta-bus');
type GlobalRef = typeof globalThis & { [globalKey]?: LiveDeltaBus };
const globalRef = globalThis as GlobalRef;

export function getLiveDeltaBus(): LiveDeltaBus {
  if (!globalRef[globalKey]) {
    globalRef[globalKey] = new LiveDeltaBus();
  }
  return globalRef[globalKey]!;
}