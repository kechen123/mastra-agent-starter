import type { SourceParser, SourceInput, ParsedSource } from './types.js';
import { extensionOf } from './types.js';

export class DocxParser implements SourceParser {
  supports(input: SourceInput): boolean { return input.kind === 'file' && extensionOf(input.filename) === 'docx'; }
  async parse(input: SourceInput): Promise<ParsedSource> {
    if (input.kind !== 'file') throw new Error('DocxParser 仅支持 file');
    const text = ''; // placeholder, replaced in Task 4
    return { text, title: input.filename, metadata: { parser: 'docx-local', sourceFormat: 'docx' } };
  }
}