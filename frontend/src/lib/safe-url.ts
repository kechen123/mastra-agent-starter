const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const RELATIVE_URL_PATTERN = /^(?:\/(?!\/)|\.\.?\/|#|\?)/;

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/** 返回可安全放入 href 的目标；不在协议白名单内时返回 null。 */
export function sanitizeLinkTarget(rawTarget: string): string | null {
  const target = rawTarget.trim();
  if (!target || CONTROL_CHARACTER_PATTERN.test(target) || target.includes('\\')) return null;
  if (RELATIVE_URL_PATTERN.test(target)) return target;

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url.href;
  return null;
}
