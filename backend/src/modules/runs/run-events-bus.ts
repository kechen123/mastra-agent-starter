/**
 * 多实例 SSE 扇出：
 *   - DB 是事件数据来源，LISTEN/NOTIFY 只做唤醒；
 *   - 每个 backend 进程打开一条专属 pg client，监听 channel 'agent_run_events_channel'；
 *   - 收到 NOTIFY 后通过 fan-out hub 唤醒所有订阅了对应 runId 的本地 SSE 连接。
 *
 * 设计动机（architecture-v2.md §决策 4）：
 *   SSE 长连接天然只跟单进程绑定；多实例时，事件写在哪台机器的内存都不算数。
 *   DB 是事实来源 + LISTEN/NOTIFY 是唤醒信号，二者结合让任一实例的 POST 写入
 *   都能被本机的 SSE 连接拉到。
 */
import { Client } from 'pg';
import { getDatabasePool } from '../../infrastructure/database/pool.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { listRunEvents } from './repository.js';

export const RUN_EVENTS_CHANNEL = 'agent_run_events_channel';

type Subscriber = (eventId: number) => void;

/**
 * 单进程级 fan-out hub：runId → Set<callback>。
 * 注册：SSE handler 调 `subscribe(runId, cb)` 拿到 unsubscribe；
 * 唤醒：bus 收到 NOTIFY 后调所有该 runId 的 cb。
 */
class RunEventsBus {
  private subscribers = new Map<string, Set<Subscriber>>();
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
      logger.warn({ msg: 'DATABASE_URL 未配置；Run events bus 未启动（仅适合本地脚本）' });
      return;
    }
    const client = new Client({ connectionString: url });
    client.on('error', (err) => {
      logger.error({ msg: 'Run events bus 连接错误', err: { name: err.name, message: err.message } });
    });
    client.on('notification', (msg) => {
      if (msg.channel !== RUN_EVENTS_CHANNEL || !msg.payload) return;
      const sepIdx = msg.payload.indexOf(':');
      if (sepIdx < 0) return;
      const runId = msg.payload.slice(0, sepIdx);
      const eventIdStr = msg.payload.slice(sepIdx + 1);
      const eventId = Number(eventIdStr);
      if (!Number.isFinite(eventId)) return;
      const set = this.subscribers.get(runId);
      if (!set || set.size === 0) return;
      for (const cb of set) {
        try { cb(eventId); } catch (err) { logger.error({ msg: 'fan-out callback error', err }); }
      }
    });
    await client.connect();
    await client.query(`LISTEN ${RUN_EVENTS_CHANNEL}`);
    this.listener = client;
    this.started = true;
    logger.info({ msg: 'Run events bus 已订阅 LISTEN channel', channel: RUN_EVENTS_CHANNEL });
  }

  async stop(): Promise<void> {
    if (this.listener) {
      try { await this.listener.query(`UNLISTEN ${RUN_EVENTS_CHANNEL}`); } catch { /* ignore */ }
      try { await this.listener.end(); } catch { /* ignore */ }
      this.listener = null;
    }
    this.subscribers.clear();
    this.started = false;
  }

  subscribe(runId: string, cb: Subscriber): () => void {
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

const globalKey = Symbol.for('xuanshu-agent/run-events-bus');
type GlobalRef = typeof globalThis & { [globalKey]?: RunEventsBus };
const globalRef = globalThis as GlobalRef;

export function getRunEventsBus(): RunEventsBus {
  if (!globalRef[globalKey]) {
    globalRef[globalKey] = new RunEventsBus();
  }
  return globalRef[globalKey]!;
}

/**
 * 拉取 `lastEventId` 之后的所有事件。SSE handler 在订阅 bus 之前先调一次，
 * 拿到截止当前 DB 状态的全量回放，再切到 bus 实时唤醒。
 */
export async function replayEventsSince(
  runId: string,
  workspaceId: string,
  lastEventId: number,
): Promise<Awaited<ReturnType<typeof listRunEvents>>> {
  return listRunEvents({ runId, workspaceId, afterId: lastEventId, limit: 5000 }, getDatabasePool());
}