import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest, RequestOptions as HttpRequestOptions } from 'node:http';
import { request as httpsRequest, RequestOptions as HttpsRequestOptions } from 'node:https';
import { URL } from 'node:url';

export class UnsupportedUrlError extends Error { constructor(m: string) { super(m); this.name = 'UnsupportedUrlError'; } }
export class UnsafeUrlError extends Error { constructor(m: string) { super(m); this.name = 'UnsafeUrlError'; } }
export class UrlFetchTimeoutError extends Error { constructor(m: string) { super(m); this.name = 'UrlFetchTimeoutError'; } }
export class UrlFetchTooLargeError extends Error { constructor(m: string) { super(m); this.name = 'UrlFetchTooLargeError'; } }

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export interface FetchedUrl {
  finalUrl: string;
  body: string;
  fetchedAt: string;
  contentType: string;
}

/**
 * 将任意 IPv6 表示拆出嵌入的 IPv4 段。
 *
 * `::ffff:7f00:1` 这种 IPv4-mapped 形式按 RFC 5952 / RFC 4291 §2.5.5.2
 * 等价于 `::ffff:127.0.0.1`。但 Node 的 `isIP` / `lookup` 会原样把它当成
 * 一个独立的 IPv6 字面量，而不去翻译最后 32 位的"看起来像 IPv4"段；
 * 攻击者完全可以利用这点绕开针对纯 IPv4 内网网段的拒绝逻辑。
 *
 * 本函数把所有 IPv4-mapped (含 `::ffff:`、`0::ffff:`、`0:0:0:0:0:ffff:`、
 * 任意双冒号前缀 + IPv4 末两段) 都折叠为归一化的 "::ffff:a.b.c.d"，
 * 然后把 IPv4 段交给 isPrivateOrLoopback IPv4 分支判定。
 */
function extractEmbeddedIPv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  // 形式 A: ::ffff:a.b.c.d （最常见；可能前面还有 0: / 0:0: 等）
  {
    const m = lower.match(/^(.*?):ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (m) return m[2]!;
  }
  // 形式 B: ::ffff:7f00:1 这种"压缩成 hex 段"的 IPv4-mapped（低位 32 位写成两个 16-bit 段）。
  // RFC 4291 允许 IPv4-mapped 地址把最后 32 位写成 hex 段而不是点分。
  // 我们只在地址内确实存在 `ffff` 段时才认为是 IPv4-mapped。
  {
    const m = lower.match(/^(.*?):ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (m) {
      const hi = parseInt(m[2]!, 16);
      const lo = parseInt(m[3]!, 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const a = (hi >> 8) & 0xff;
        const b = hi & 0xff;
        const c = (lo >> 8) & 0xff;
        const d = lo & 0xff;
        if ([a, b, c, d].every((x) => x >= 0 && x <= 255)) return `${a}.${b}.${c}.${d}`;
      }
    }
  }
  // 形式 C: NAT64 well-known prefix 64:ff9b::/96 —— 最后 32 位也是 IPv4。
  // 本任务把任何"在 IPv6 字面量里出现点分 IPv4 段"的形态都识别成 IPv4 嵌入，
  // 包括 [::1.2.3.4] 这种实现特定的写法（libuv 内部把 a.b.c.d 拼回 32 位 IPv4）。
  {
    const m = lower.match(/^([0-9a-f:]*?)([\d]{1,3}\.[\d]{1,3}\.[\d]{1,3}\.[\d]{1,3})$/);
    if (m && m[1] !== '' && m[1] !== undefined) {
      const dot = m[2]!;
      // 严格验证 IPv4 各段 0-255
      const parts = dot.split('.').map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
        return dot;
      }
    }
  }
  return null;
}

export function isPrivateOrLoopback(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4 分支
  if (lower.includes('.') && !lower.includes(':')) {
    const parts = lower.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 127 || a === 0) return true;
    if (a === 10) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b! >= 64 && b! <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // Benchmark
    return false;
  }
  // IPv6 分支
  if (lower === '::1') return true;
  // fe80::/10 link-local: 第一个 16-bit 段在 [0xfe80, 0xfebf]
  {
    const m = lower.match(/^([0-9a-f]{1,4}):/);
    if (m && m[1]!.length === 4) {
      const first = parseInt(m[1]!, 16);
      if (first >= 0xfe80 && first <= 0xfebf) return true;
    } else if (m && parseInt(m[1]!, 16) >= 0xfe80 && parseInt(m[1]!, 16) <= 0xfebf) {
      // 段被压缩成 <4 位的 hex（如 fe80::1、febf::1）
      return true;
    }
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  // IPv4-mapped IPv6: 折叠为内嵌 IPv4 再判一次
  const embeddedV4 = extractEmbeddedIPv4(lower);
  if (embeddedV4) return isPrivateOrLoopback(embeddedV4);
  return false;
}

/**
 * 把 hostname 安全解析为 IP 集合。**不**接受 hostname 字符串直接进入连接路径——
 * 调用方必须用返回的 IP 之一完成 TCP 连接（参见 `connectPinned`），以阻止
 * DNS rebinding（lookup 与 fetch 之间 hostname 重新解析到内网 IP）。
 */
async function resolveAndValidate(hostname: string): Promise<string[]> {
  if (isIP(hostname)) {
    if (isPrivateOrLoopback(hostname)) throw new UnsafeUrlError(`拒绝访问 IP：${hostname}`);
    return [hostname];
  }
  const records = await lookup(hostname, { all: true });
  if (records.length === 0) throw new UnsafeUrlError(`域名无解析：${hostname}`);
  const ips: string[] = [];
  for (const r of records) {
    if (isPrivateOrLoopback(r.address)) {
      throw new UnsafeUrlError(`拒绝访问域名 ${hostname}（解析到私有地址 ${r.address}）`);
    }
    ips.push(r.address);
  }
  return ips;
}

/**
 * 把传入的 hostname 替换为已校验的 IP 字面量（host header 仍保留原 hostname），
 * 用 node:http(s).request 直接发起，避免 undici 的 fetch 重新走系统 DNS。
 * 这是消除 DNS rebinding TOCTOU 的关键。
 */
interface PinnedRequestResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function pinnedHttpRequest(
  u: URL,
  validatedIps: string[],
  signal: AbortSignal,
): Promise<PinnedRequestResult> {
  // 选第一个 validated IP；如果想 IP 轮换可在此扩展，但本任务固定第一个即可。
  const pinnedIp = validatedIps[0]!;
  const isHttps = u.protocol === 'https:';
  const opts: HttpRequestOptions | HttpsRequestOptions = {
    method: 'GET',
    protocol: u.protocol,
    hostname: pinnedIp,             // 用 IP 建立连接
    port: u.port || (isHttps ? 443 : 80),
    path: `${u.pathname || '/'}${u.search || ''}`,
    headers: {
      'host': u.host,                // 但 Host header 仍是原始 hostname，让对端虚拟主机正常工作
      'user-agent': 'Daymind/1.0',
      'accept': 'text/html,text/plain,application/xhtml+xml',
    },
    // lookup 回调：仍要求 Node 用 pinnedIp 解析，防止任何 race。
    lookup: (_hostname, _options, cb) => cb(null, [{ address: pinnedIp, family: isIP(pinnedIp) === 4 ? 4 : 6 }]),
  };
  const lib = isHttps ? httpsRequest : httpRequest;
  return new Promise<PinnedRequestResult>((resolve, reject) => {
    const req = lib(opts, (res) => {
      const status = res.statusCode ?? 0;
      const headers = res.headers as Record<string, string | string[] | undefined>;
      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;
      res.on('data', (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.byteLength;
        if (received > MAX_BYTES) {
          aborted = true;
          req.destroy(new UrlFetchTooLargeError(`URL 响应超过 ${MAX_BYTES} 字节`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (aborted) return;
        resolve({ status, headers, body: Buffer.concat(chunks).toString('utf-8') });
      });
      res.on('error', (err) => reject(err));
    });
    req.on('error', (err) => reject(err));
    if (signal) {
      const onAbort = () => { req.destroy(new UrlFetchTimeoutError(`URL 抓取超时`)); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

export class UrlFetcher {
  async fetch(input: { url: string }): Promise<FetchedUrl> {
    let current = input.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let u: URL;
      try { u = new URL(current); } catch { throw new UnsupportedUrlError(`URL 解析失败：${current}`); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsupportedUrlError(`仅支持 http/https：${current}`);
      // 关键：先解析并校验，再用校验过的 IP 连接。
      const validatedIps = await resolveAndValidate(u.hostname);
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let result: PinnedRequestResult;
      try {
        result = await pinnedHttpRequest(u, validatedIps, controller.signal);
      } catch (err) {
        clearTimeout(t);
        if (err instanceof UrlFetchTimeoutError) throw err;
        if (err instanceof UrlFetchTooLargeError) throw err;
        if (err instanceof Error && err.name === 'AbortError') throw new UrlFetchTimeoutError(`URL 抓取超时：${current}`);
        throw new Error(`URL 抓取失败：${(err as Error).message.slice(0, 200)}`);
      }
      clearTimeout(t);
      const sc = result.status;
      if (sc >= 300 && sc < 400) {
        const locRaw = result.headers['location'];
        const loc = Array.isArray(locRaw) ? locRaw[0] : locRaw;
        if (!loc) throw new Error(`重定向缺少 Location：${current}`);
        if (hop === MAX_REDIRECTS) throw new Error(`URL 重定向超过 ${MAX_REDIRECTS} 跳：${current}`);
        current = new URL(loc, u).toString();
        continue;
      }
      if (sc < 200 || sc >= 300) throw new Error(`URL 抓取返回 ${sc}：${current}`);
      const contentTypeRaw = result.headers['content-type'];
      const contentType = (Array.isArray(contentTypeRaw) ? contentTypeRaw[0] : contentTypeRaw ?? '').toLowerCase();
      if (!/text\/html|text\/plain|application\/xhtml\+xml/.test(contentType)) throw new UnsupportedUrlError(`不支持的 Content-Type：${contentType}`);
      return { finalUrl: u.toString(), body: result.body, fetchedAt: new Date().toISOString(), contentType };
    }
    throw new Error(`URL 重定向循环：${input.url}`);
  }
}
