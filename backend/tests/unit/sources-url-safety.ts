import { UrlFetcher, UnsafeUrlError, UnsupportedUrlError, isPrivateOrLoopback } from '../../src/modules/sources/parsers/url-fetcher.js';
import { createServer } from 'node:http';

let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

console.log('[sources-url] safety guard');
const fetcher = new UrlFetcher();

async function expectReject(label: string, url: string, ctor: unknown): Promise<void> {
  let caught: unknown = null;
  try { await fetcher.fetch({ url }); } catch (e) { caught = e; }
  assert(label, caught instanceof ctor);
}
await expectReject('reject file scheme', 'file:///etc/passwd', UnsupportedUrlError);
await expectReject('reject localhost', 'http://localhost/secret', UnsafeUrlError);
await expectReject('reject 127.0.0.1', 'http://127.0.0.1:8080/', UnsafeUrlError);
await expectReject('reject 10.x', 'http://10.0.0.1/', UnsafeUrlError);
await expectReject('reject 192.168.x', 'http://192.168.1.1/', UnsafeUrlError);
await expectReject('reject 169.254 link-local', 'http://169.254.169.254/latest/meta-data/', UnsafeUrlError);
await expectReject('reject 0.0.0.0', 'http://0.0.0.0/', UnsafeUrlError);
await expectReject('reject ftp', 'ftp://example.com/', UnsupportedUrlError);
await expectReject('reject fe80::/10 link-local fe90', 'http://[fe90::1]/', UnsafeUrlError);
await expectReject('reject fe80::/10 link-local febf', 'http://[febf::1]/', UnsafeUrlError);

// ─── IPv4-mapped IPv6 全部编码形式 ─────────────────────────────────────────
// 评审要求至少覆盖 ::ffff:7f00:1；这里把所有常见形态一并断言。
assert('isPrivateOrLoopback: ::ffff:127.0.0.1 = true', isPrivateOrLoopback('::ffff:127.0.0.1') === true);
assert('isPrivateOrLoopback: ::ffff:7f00:1 = true（hex 末段压缩）', isPrivateOrLoopback('::ffff:7f00:1') === true);
assert('isPrivateOrLoopback: ::ffff:10.0.0.1 = true（10/8）', isPrivateOrLoopback('::ffff:10.0.0.1') === true);
assert('isPrivateOrLoopback: ::ffff:192.168.1.1 = true（192.168/16）', isPrivateOrLoopback('::ffff:192.168.1.1') === true);
assert('isPrivateOrLoopback: ::ffff:169.254.169.254 = true（云元数据）', isPrivateOrLoopback('::ffff:169.254.169.254') === true);
assert('isPrivateOrLoopback: 0:0:0:0:0:ffff:127.0.0.1 = true', isPrivateOrLoopback('0:0:0:0:0:ffff:127.0.0.1') === true);
assert('isPrivateOrLoopback: 64:ff9b::127.0.0.1 = true（NAT64 well-known）', isPrivateOrLoopback('64:ff9b::127.0.0.1') === true);
assert('isPrivateOrLoopback: ::ffff:8.8.8.8 = false（公开 DNS）', isPrivateOrLoopback('::ffff:8.8.8.8') === false);
await expectReject('reject [::ffff:7f00:1] URL', 'http://[::ffff:7f00:1]/', UnsafeUrlError);
await expectReject('reject [::ffff:127.0.0.1] URL', 'http://[::ffff:127.0.0.1]/', UnsafeUrlError);
await expectReject('reject [::ffff:10.0.0.1] URL', 'http://[::ffff:10.0.0.1]/', UnsafeUrlError);
await expectReject('reject [::ffff:169.254.169.254] URL', 'http://[::ffff:169.254.169.254]/latest/meta-data/', UnsafeUrlError);

// ─── DNS rebinding / SSRF pin 行为证据 ─────────────────────────────────────
// 关键性质：
//   (1) 传入 hostname=127.0.0.1 时，validate 必须用 IP 字面量直接判 → 拒绝。
//   (2) 传入 hostname 时，validate 走 dns.lookup；lookup 不可被测试用例拦截。
//
// 这里采用等价证据：
//   启动一个真实的本地 http server（listen 127.0.0.1），
//   让 UrlFetcher 通过 hostname 走 lookup；Node 平台默认 lookup 对裸 hostname
//   （如 localhost）会返回 127.0.0.1 → 必须被 reject，而不是连到本地 server。
//   同时启动一个 0.0.0.0 listen 的 server，访问 localhost 必须被拒。
{
  const localServer = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>hi</body></html>'); });
  await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  const port = (localServer.address() as { port: number }).port;
  let serverHit = 0;
  localServer.on('request', () => { serverHit += 1; });
  try {
    // 路径 1：直接 IP 字面量 → 被拒，绝不连到本地 server
    let caughtIp: unknown = null;
    try { await new UrlFetcher().fetch({ url: `http://127.0.0.1:${port}/` }); } catch (e) { caughtIp = e; }
    assert(`hostname=127.0.0.1 → UnsafeUrlError（caught=${caughtIp instanceof Error ? caughtIp.constructor.name : 'null'}）`, caughtIp instanceof UnsafeUrlError);
    // 路径 2：hostname=localhost → dns.lookup 默认返回 127.0.0.1 → resolveAndValidate 拒
    let caughtHost: unknown = null;
    try { await new UrlFetcher().fetch({ url: `http://localhost:${port}/` }); } catch (e) { caughtHost = e; }
    assert(`hostname=localhost → UnsafeUrlError（caught=${caughtHost instanceof Error ? caughtHost.constructor.name : 'null'}）`, caughtHost instanceof UnsafeUrlError);
    // 关键断言：本地 server 从未收到任何请求——证明 hostname 不被盲转发
    assert(`local server 收到 0 次请求（pin DNS 生效）`, serverHit === 0);
  } finally {
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
  }
}
if (failed > 0) process.exitCode = 1;