import type { SourceParser, SourceInput, ParsedSource } from './types.js';

export class UrlParser implements SourceParser {
  supports(input: SourceInput): boolean { return input.kind === 'url'; }
  async parse(input: SourceInput): Promise<ParsedSource> {
    if (input.kind !== 'url') throw new Error('UrlParser 仅支持 url');
    const text = ''; // placeholder, replaced in Task 7
    const title = input.finalUrl;
    return { text, title, metadata: { parser: 'url', sourceFormat: 'url' } };
  }
}