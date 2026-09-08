/**
 * PR-3.3.0 — Tool inputs sanitization + hash.
 *
 * 责任:
 *   1. 把 Tool 输入参数从原始 JSON 转换成"已脱敏的 JSON 摘要"。
 *      摘要形态：每个 leaf 都按类型归一化成 `{kind, preview}` 结构，
 *      不存原值、不存加密后的值；
 *   2. 用 canonical JSON 序列化 + SHA-256 算 inputs_hash，用于恢复路径
 *      二次校验（防止 Tool 在审批后被悄悄改 args 绕过人工决策）；
 *   3. 不抛错：未知类型用 `{kind:'other', preview:''}` 表示，调用方拿到
 *      的就是确定性、可回放的 summary。
 *
 * 约束:
 *   - 不打印、不记录 raw inputs；本模块禁止 console.log 含 input 内容；
 *   - 输出大小上限：MAX_SUMMARY_KEYS 内字段被截断到 ~200，避免超长
 *     inputs 把 DB JSONB 撑爆；
 *   - 稳定排序：对象 key 按字母序排，确保 hash 在不同运行下相同。
 */
import { createHash } from 'node:crypto';

const MAX_SUMMARY_KEYS = 64;
const MAX_PREVIEW_CHARS = 200;
const MAX_TREE_DEPTH = 12;

export interface SanitizedLeaf {
  kind:
    | 'string'
    | 'number'
    | 'boolean'
    | 'null'
    | 'array'
    | 'object'
    | 'empty'
    | 'truncated'
    | 'other';
  preview: string;
  /** 数组 / 对象专属：被截断前的子元素数。 */
  count?: number;
}

export type SanitizedSummary = Record<string, SanitizedLeaf>;

function previewOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    return value.length > MAX_PREVIEW_CHARS
      ? `${value.slice(0, MAX_PREVIEW_CHARS)}…`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function sanitize(value: unknown, depth: number): SanitizedLeaf {
  if (depth > MAX_TREE_DEPTH) {
    return { kind: 'truncated', preview: '<depth>' };
  }
  if (value === null) return { kind: 'null', preview: 'null' };
  if (value === undefined) return { kind: 'empty', preview: '' };
  if (typeof value === 'string') {
    return { kind: 'string', preview: previewOf(value) };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return {
      kind: typeof value as 'number' | 'boolean',
      preview: previewOf(value),
    };
  }
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      preview: '',
      count: value.length,
    };
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return {
      kind: 'object',
      preview: '',
      count: Object.keys(obj).length,
    };
  }
  return { kind: 'other', preview: typeof value };
}

export interface SanitizeResult {
  hash: string;
  summary: SanitizedSummary;
}

/**
 * 把 Tool 调用入参转换为可持久化的"已脱敏摘要 + 哈希"。
 *
 * 行为：
 *   - 把每个 leaf 替换为 `{kind, preview, count?}`；
 *   - preview 是**有限**信息：长字符串截断到 MAX_PREVIEW_CHARS；
 *   - hash = sha256(canonical_json(summary))，用作恢复路径的二次校验；
 *   - 输入为空 / 非对象：返回空 summary + 同一 hash 派生规则。
 *
 * 注：本函数**不**对敏感字段名（如 'password' / 'token' / 'api_key'）
 * 做单独 mask——`preview` 字段本身就是"对长度预览"，调用方应把
 * preview 当作"已脱敏的展示文本"对待，绝不二次回放原文。
 */
export function sanitizeToolInputs(input: unknown): SanitizeResult {
  const summary: SanitizedSummary = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const truncated = keys.length > MAX_SUMMARY_KEYS;
    const useKeys = truncated ? keys.slice(0, MAX_SUMMARY_KEYS) : keys;
    for (const key of useKeys) {
      summary[key] = sanitize(obj[key], 0);
    }
    if (truncated) {
      summary['__truncated__'] = {
        kind: 'truncated',
        preview: `${keys.length - MAX_SUMMARY_KEYS} keys hidden`,
      };
    }
  }
  const hash = createHash('sha256')
    .update(JSON.stringify(summary))
    .digest('hex');
  return { hash, summary };
}