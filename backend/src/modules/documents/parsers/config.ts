/**
 * 集中配置模块：唯一读取与 MinerU / 文档解析相关的环境变量。
 *
 * 规则：
 * - ENABLE_MINERU 默认 false，仅值为 "true" 时启用。
 * - 不得在其他文件散落读取这些环境变量。
 */

export interface DocumentParserConfig {
  mineruEnabled: boolean;
  mineruApiBaseUrl: string;
  mineruParseTimeoutMs: number;
  documentFormats: string[];
}

export function getDocumentParserConfig(): DocumentParserConfig {
  const mineruEnabled = process.env.ENABLE_MINERU === 'true';
  const mineruApiBaseUrl = (process.env.MINERU_API_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
  const mineruParseTimeoutMs = Number(process.env.MINERU_PARSE_TIMEOUT_MS ?? 120_000);
  const documentFormats = mineruEnabled
    ? ['txt', 'md', 'pdf', 'docx']
    : ['txt', 'md'];

  return {
    mineruEnabled,
    mineruApiBaseUrl,
    mineruParseTimeoutMs,
    documentFormats,
  };
}