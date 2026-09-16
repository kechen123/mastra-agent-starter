import type { SourceParser, SourceInput, ParsedSource } from './types.js';

export class TextParser implements SourceParser {
  supports(input: SourceInput): boolean { return input.kind === 'text'; }
  async parse(input: SourceInput): Promise<ParsedSource> {
    if (input.kind !== 'text') throw new Error('TextParser 仅支持 kind=text');
    const text = input.content.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text, title: input.title?.trim() || text.split('\n').find(Boolean)?.slice(0, 80) || '未命名文本记录',
      metadata: { parser: 'text', sourceFormat: 'txt' } };
  }
}