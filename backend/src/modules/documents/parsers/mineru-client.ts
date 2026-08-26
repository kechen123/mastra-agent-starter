/**
 * HTTP adapter：MinerU 文档解析 Client（3.4.5）。
 *
 * 已实现：真实 POST /file_parse 请求、multipart 构造、超时控制、
 * 受控错误脱敏。
 *
 * 待补齐（仅在服务可用后）：无——当前已实现全部骨架内容。
 */

import { getDocumentParserConfig } from './config.js';

export interface MinerUClientConfig {
  baseUrl: string;
  timeoutMs: number;
}

export class MinerUClientError extends Error {
  constructor(
    message: string,
    readonly cause?: Error,
  ) {
    super(message);
    this.name = 'MinerUClientError';
  }
}

export class MinerUParseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MinerUParseError';
  }
}

export function getMinerUConfig(): MinerUClientConfig {
  const { mineruApiBaseUrl, mineruParseTimeoutMs } = getDocumentParserConfig();
  return { baseUrl: mineruApiBaseUrl, timeoutMs: mineruParseTimeoutMs };
}

export class MinerUClient {
  constructor(private readonly config: MinerUClientConfig = getMinerUConfig()) {}

  async parseFile(input: {
    filename: string;
    mimeType?: string;
    buffer: Buffer;
  }): Promise<unknown> {
    const url = new URL(`${this.config.baseUrl}/file_parse`);

    const form = new FormData();
    const blob = new Blob([new Uint8Array(input.buffer)], { type: input.mimeType ?? 'application/octet-stream' });
    form.append('files', blob, input.filename);
    form.append('return_md', 'true');
    form.append('parse_method', 'auto');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        // 不暴露原始 response body 或 status text
        throw new MinerUParseError('MinerU 解析服务返回错误响应。', response.status);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new MinerUParseError('MinerU 解析服务返回的响应格式无效。');
      }

      return body;
    } catch (error) {
      if (error instanceof MinerUParseError || error instanceof MinerUClientError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new MinerUClientError('MinerU 解析请求超时。');
      }

      throw new MinerUClientError(
        '无法连接到 MinerU 解析服务。',
        error instanceof Error ? error : undefined,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}