import { getDocumentParserConfig } from './config.js';
import { PlainTextParser } from './plain-text-parser.js';
import { MinerUParser } from './mineru-parser.js';
import { UnsupportedDocumentTypeError, type DocumentParser } from './types.js';

export function getParser(input: {
  filename: string;
  mimeType?: string;
}): DocumentParser {
  const { mineruEnabled } = getDocumentParserConfig();

  const parsers: DocumentParser[] = [new PlainTextParser()];
  if (mineruEnabled) {
    parsers.push(new MinerUParser());
  }

  const parser = parsers.find((p) => p.supports(input));
  if (!parser) {
    throw new UnsupportedDocumentTypeError(input.filename);
  }
  return parser;
}