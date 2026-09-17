export type SensitiveDataKind = 'api_key' | 'access_token' | 'password' | 'bearer_token' | 'private_key' | 'database_url';

export interface SensitiveDataScanResult {
  hasSensitiveData: boolean;
  kinds: SensitiveDataKind[];
  redactedContent: string;
}

const RULES: Array<{ kind: SensitiveDataKind; pattern: RegExp }> = [
  { kind: 'private_key', pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/gi },
  { kind: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi },
  { kind: 'database_url', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi },
  { kind: 'api_key', pattern: /\b(?:sk|pk|ghp|gho|AIza)[-_A-Za-z0-9]{16,}\b/g },
  { kind: 'access_token', pattern: /\b(?:access[_-]?token|refresh[_-]?token)\s*[:=]\s*['"]?[^\s'"]{12,}/gi },
  { kind: 'password', pattern: /(?:\b(?:password|passwd|pwd)\b|密码)\s*[:=：]\s*['"]?[^\s'"]{6,}/gi },
];

/** 只使用本地确定性规则；调用方必须在持久化、LLM、Embedding 前调用。 */
export function scanSensitiveData(content: string): SensitiveDataScanResult {
  const kinds = new Set<SensitiveDataKind>();
  let redactedContent = content;
  for (const rule of RULES) {
    redactedContent = redactedContent.replace(rule.pattern, (match) => {
      kinds.add(rule.kind);
      const separator = match.search(/[:=：]/);
      return separator >= 0 ? `${match.slice(0, separator + 1)} [SECRET]` : '[SECRET]';
    });
  }
  return { hasSensitiveData: kinds.size > 0, kinds: [...kinds], redactedContent };
}
