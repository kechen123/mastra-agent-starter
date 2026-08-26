import type { DocumentParser, ParsedDocument } from './types.js';
import { MinerUClient, MinerUClientError } from './mineru-client.js';

/**
 * MinerU 3.4.5 文档解析器。
 *
 * 已实现：
 * - 调用 MinerUClient 执行真实 HTTP 请求
 * - mapMinerUResult() 映射已验证的响应结构
 *
 * 响应结构（来自 /openapi.json 与源码核验）：
 * {
 *   status: "completed",
 *   error: null,
 *   version: "3.4.5",
 *   results: {
 *     "<服务端文件名>": { md_content: "..." }
 *   }
 * }
 */

interface MinerUResultEntry {
  md_content?: unknown;
}

interface MinerUResponse {
  status?: unknown;
  error?: unknown;
  results?: Record<string, unknown>;
}

export class MinerUParser implements DocumentParser {
  constructor(private readonly client = new MinerUClient()) {}

  supports(input: { filename: string; mimeType?: string }): boolean {
    const ext = input.filename.split('.').pop()?.toLowerCase();
    return ext === 'pdf' || ext === 'docx';
  }

  async parse(input: {
    filename: string;
    mimeType?: string;
    buffer: Buffer;
  }): Promise<ParsedDocument> {
    const raw = await this.client.parseFile(input);
    const parsed = mapMinerUResult(raw);
    const ext = input.filename.split('.').pop()?.toLowerCase();
    return {
      markdown: parsed.markdown,
      metadata: {
        sourceFormat: ext === 'docx' ? 'docx' : 'pdf',
        parser: 'mineru',
      },
    };
  }
}

function mapMinerUResult(raw: unknown): { markdown: string } {
  if (!isPlainObject(raw)) {
    throw new MinerUClientError('MinerU 解析返回了无效的响应格式。');
  }

  const response = raw as MinerUResponse;

  if (response.status !== 'completed') {
    throw new MinerUClientError('MinerU 解析未能成功完成。');
  }

  if (!isPlainObject(response.results)) {
    throw new MinerUClientError('MinerU 解析结果缺失。');
  }

  const entries = Object.values(response.results);
  if (entries.length !== 1) {
    throw new MinerUClientError('MinerU 解析返回了意外的结果数量。');
  }

  const single = entries[0];
  if (!isPlainObject(single)) {
    throw new MinerUClientError('MinerU 解析结果格式无效。');
  }

  const mdContent = (single as MinerUResultEntry).md_content;
  if (typeof mdContent !== 'string' || mdContent.trim().length === 0) {
    throw new MinerUClientError('MinerU 解析返回的 Markdown 内容为空。');
  }

  return { markdown: mdContent };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}