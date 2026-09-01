import type { DocumentParser, ParsedDocument } from './types.js';

export class PlainTextParser implements DocumentParser {
  supports(input: { filename: string; mimeType?: string }): boolean {
    const ext = input.filename.split('.').pop()?.toLowerCase();
    return ext === 'txt' || ext === 'md';
  }

  async parse(input: {
    filename: string;
    mimeType?: string;
    buffer: Buffer;
  }): Promise<ParsedDocument> {
    const text = normalizeText(
      new TextDecoder('utf-8', { fatal: true }).decode(input.buffer),
    );
    const ext = input.filename.split('.').pop()?.toLowerCase();
    return {
      markdown: text,
      metadata: {
        sourceFormat: ext === 'md' ? 'md' : 'txt',
        parser: 'plain-text',
      },
    };
  }
}

export function normalizeText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}