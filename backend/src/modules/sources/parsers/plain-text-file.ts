import type { SourceParser, SourceInput, ParsedSource } from './types.js';
import { extensionOf } from './types.js';

export function normalizeText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export class PlainTextFileParser implements SourceParser {
  supports(input: SourceInput): boolean {
    return input.kind === 'file' && extensionOf(input.filename) === 'txt';
  }
  async parse(input: SourceInput): Promise<ParsedSource> {
    if (input.kind !== 'file') throw new Error('PlainTextFileParser 仅支持 file');
    const text = normalizeText(new TextDecoder('utf-8', { fatal: true }).decode(input.buffer));
    const title = input.filename.replace(/\.txt$/i, '');
    return { text, title, metadata: { parser: 'plain-text-file', sourceFormat: 'txt' } };
  }
}