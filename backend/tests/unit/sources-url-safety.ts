import { UrlFetcher, UnsafeUrlError, UnsupportedUrlError } from '../../src/modules/sources/parsers/url-fetcher.js';

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
if (failed > 0) process.exitCode = 1;