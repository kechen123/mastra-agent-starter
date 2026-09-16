import type { SourceInput, ParsedSource, SourceParser } from './types.js';
import { UnsupportedSourceFormatError } from './types.js';
import { TextParser } from './text-parser.js';
import { PlainTextFileParser } from './plain-text-file.js';
import { MarkdownParser } from './markdown-parser.js';
import { PdfParser } from './pdf-parser.js';
import { DocxParser } from './docx-parser.js';
import { UrlParser } from './url-parser.js';

export class SourceParserRegistry {
  private readonly parsers: SourceParser[];
  constructor(parsers?: SourceParser[]) {
    this.parsers = parsers ?? [
      new TextParser(),
      new PlainTextFileParser(),
      new MarkdownParser(),
      new PdfParser(),
      new DocxParser(),
      new UrlParser(),
    ];
  }
  async parse(input: SourceInput): Promise<ParsedSource> {
    const p = this.parsers.find(p => p.supports(input));
    if (!p) throw new UnsupportedSourceFormatError(`不支持的 Source 类型：${describe(input)}`);
    return p.parse(input);
  }
}

function describe(input: SourceInput): string {
  if (input.kind === 'text') return 'text';
  if (input.kind === 'file') return `file(${input.filename})`;
  return `url(${input.originalUrl})`;
}