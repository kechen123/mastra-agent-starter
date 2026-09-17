export interface ParsedSection {
  heading?: string;
  page?: number;
  startChar: number;
  endChar: number;
}

export interface PdfPageBlock { page: number; text: string }

export interface ParsedSource {
  text: string;
  title: string;
  metadata: {
    parser: string;
    sourceFormat: string;
    pageCount?: number;
    headings?: string[];
    /** PDF 页级文本块；service 据此把 page 写到每个 chunk 的 metadata.page。 */
    pageBlocks?: PdfPageBlock[];
    /** DOCX 顶层 heading 列表；保留供 chunk metadata.heading 候选。 */
    headingSections?: Array<{ heading: string; startChar: number; endChar: number; page?: number }>;
  };
  sections?: ParsedSection[];
  warnings?: string[];
}

export type SourceInput =
  | { kind: 'text'; content: string; title?: string }
  | { kind: 'file'; filename: string; mimeType?: string; buffer: Buffer }
  | { kind: 'url'; originalUrl: string; finalUrl: string; fetchedAt: string; body: string };

export interface SourceParser {
  supports(input: SourceInput): boolean;
  parse(input: SourceInput): Promise<ParsedSource>;
}

export class UnsupportedSourceFormatError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedSourceFormatError'; }
}

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i < 0 ? '' : filename.slice(i + 1).toLowerCase();
}
