import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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

function isPrivateOrLoopback(ip: string): boolean {
  // IPv4
  if (ip.includes('.')) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return true;
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
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  // fe80::/10 link-local: first 16-bit word in [0xfe80, 0xfebf]
  {
    const m = lower.match(/^([0-9a-f]{1,4}):/);
    if (m && m[1]!.length === 4) {
      const first = parseInt(m[1]!, 16);
      if (first >= 0xfe80 && first <= 0xfebf) return true;
    }
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  // IPv4-mapped IPv6: ::ffff:a.b.c.d
  if (lower.startsWith('::ffff:')) return isPrivateOrLoopback(lower.slice(7));
  return false;
}

async function assertSafeHostname(hostname: string): Promise<void> {
  // 已为 IP 字面量
  if (isIP(hostname)) {
    if (isPrivateOrLoopback(hostname)) throw new UnsafeUrlError(`拒绝访问 IP：${hostname}`);
    return;
  }
  // DNS 解析 → IP
  const records = await lookup(hostname, { all: true });
  for (const r of records) {
    if (isPrivateOrLoopback(r.address)) throw new UnsafeUrlError(`拒绝访问域名 ${hostname}（解析到私有地址 ${r.address}）`);
  }
}

export class UrlFetcher {
  async fetch(input: { url: string }): Promise<FetchedUrl> {
    let current = input.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let u: URL;
      try { u = new URL(current); } catch { throw new UnsupportedUrlError(`URL 解析失败：${current}`); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsupportedUrlError(`仅支持 http/https：${current}`);
      await assertSafeHostname(u.hostname);
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(u.toString(), {
          method: 'GET',
          redirect: 'manual',
          headers: { 'user-agent': 'Daymind/1.0', 'accept': 'text/html,text/plain,application/xhtml+xml' },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(t);
        if (err instanceof Error && err.name === 'AbortError') throw new UrlFetchTimeoutError(`URL 抓取超时：${current}`);
        throw new Error(`URL 抓取失败：${(err as Error).message.slice(0, 200)}`);
      }
      clearTimeout(t);
      const sc = response.status;
      if (sc >= 300 && sc < 400) {
        const loc = response.headers.get('location');
        if (!loc) throw new Error(`重定向缺少 Location：${current}`);
        if (hop === MAX_REDIRECTS) throw new Error(`URL 重定向超过 ${MAX_REDIRECTS} 跳：${current}`);
        current = new URL(loc, u).toString();
        continue;
      }
      if (!response.ok) throw new Error(`URL 抓取返回 ${sc}：${current}`);
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!/text\/html|text\/plain|application\/xhtml\+xml/.test(contentType)) throw new UnsupportedUrlError(`不支持的 Content-Type：${contentType}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('URL 响应无 body');
      const decoder = new TextDecoder('utf-8');
      let received = 0;
      let body = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } throw new UrlFetchTooLargeError(`URL 响应超过 ${MAX_BYTES} 字节`); }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      return { finalUrl: u.toString(), body, fetchedAt: new Date().toISOString(), contentType };
    }
    throw new Error(`URL 重定向循环：${input.url}`);
  }
}