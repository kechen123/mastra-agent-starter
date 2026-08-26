export interface ParsedDocument {
  markdown: string;
  metadata: {
    sourceFormat: string;
    parser: string;
    title?: string;
    pageCount?: number;
  };
  warnings?: string[];
}

export interface DocumentParser {
  supports(input: { filename: string; mimeType?: string }): boolean;
  parse(input: {
    filename: string;
    mimeType?: string;
    buffer: Buffer;
  }): Promise<ParsedDocument>;
}

export class UnsupportedDocumentTypeError extends Error {
  constructor(filename: string) {
    super(`不支持的文件格式：${filename}`);
    this.name = 'UnsupportedDocumentTypeError';
  }
}