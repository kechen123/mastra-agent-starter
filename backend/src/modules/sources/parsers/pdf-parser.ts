import type { SourceParser, SourceInput, ParsedSource } from './types.js';
import { extensionOf } from './types.js';

export class PdfParser implements SourceParser {
  supports(input: SourceInput): boolean { return input.kind === 'file' && extensionOf(input.filename) === 'pdf'; }
  async parse(input: SourceInput): Promise<ParsedSource> {
    if (input.kind !== 'file') throw new Error('PdfParser 仅支持 file');
    const text = ''; // placeholder, replaced in Task 3
    return { text, title: input.filename, metadata: { parser: 'pdf-local', sourceFormat: 'pdf' } };
  }
}