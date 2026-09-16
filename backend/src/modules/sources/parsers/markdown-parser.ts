import type { SourceParser, SourceInput, ParsedSource } from './types.js';
import { extensionOf } from './types.js';
import { normalizeText } from './plain-text-file.js';

export class MarkdownParser implements SourceParser {
  supports(input: SourceInput): boolean {
    return input.kind === 'file' && extensionOf(input.filename) === 'md';
  }
  async parse(input: SourceInput): Promise<ParsedSource> {
    if (input.kind !== 'file') throw new Error('MarkdownParser 仅支持 file');
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(input.buffer);
    const text = normalizeText(raw);
    const headings = [...raw.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => m[1]!.trim()).filter(Boolean);
    const titleMatch = headings[0] ?? input.filename.replace(/\.md$/i, '');
    return { text, title: titleMatch, metadata: { parser: 'markdown', sourceFormat: 'md', headings } };
  }
}