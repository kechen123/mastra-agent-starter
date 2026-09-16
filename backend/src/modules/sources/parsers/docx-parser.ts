import type { SourceParser, SourceInput, ParsedSource } from './types.js';
import { extensionOf } from './types.js';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';

export class DocxParser implements SourceParser {
  supports(input: SourceInput): boolean { return input.kind === 'file' && extensionOf(input.filename) === 'docx'; }
  async parse(input: SourceInput): Promise<ParsedSource> {
    if (input.kind !== 'file') throw new Error('DocxParser 仅支持 file');
    let raw: Awaited<ReturnType<typeof mammoth.extractRawText>>;
    let html: Awaited<ReturnType<typeof mammoth.convertToHtml>>;
    try {
      [raw, html] = await Promise.all([
        mammoth.extractRawText({ buffer: input.buffer }),
        mammoth.convertToHtml({ buffer: input.buffer }),
      ]);
    } catch (err) {
      throw new Error(`DOCX 解析失败：${(err as Error).message.slice(0, 200)}`);
    }
    const text = (raw.value ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const $ = cheerio.load(html.value ?? '');
    const headings = $('h1, h2, h3, h4, h5, h6').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    return { text, title: input.filename, metadata: { parser: 'docx-local', sourceFormat: 'docx', headings: headings.length > 0 ? headings : undefined } };
  }
}
