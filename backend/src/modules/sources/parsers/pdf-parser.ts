import type { SourceParser, SourceInput, ParsedSource } from './types.js';
import { extensionOf } from './types.js';
// @ts-expect-error pdf-parse ships without TypeScript declarations.
import pdfParse from 'pdf-parse';

export class PdfParser implements SourceParser {
  supports(input: SourceInput): boolean { return input.kind === 'file' && extensionOf(input.filename) === 'pdf'; }
  async parse(input: SourceInput): Promise<ParsedSource> {
    if (input.kind !== 'file') throw new Error('PdfParser 仅支持 file');
    let parsed: Awaited<ReturnType<typeof pdfParse>>;
    try {
      parsed = await pdfParse(input.buffer);
    } catch (err) {
      throw new Error(`PDF 解析失败：${(err as Error).message.slice(0, 200)}`);
    }
    const text = (parsed.text ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length === 0) {
      // 扫描型 PDF / 加密 PDF：真实抽取为空，不伪造 page。
      return { text: '', title: input.filename, metadata: { parser: 'pdf-local', sourceFormat: 'pdf' }, warnings: ['PDF 文本抽取为空（可能为扫描型或加密文件）'] };
    }
    const pageCount = parsed.numpages ?? undefined;
    return { text, title: input.filename, metadata: { parser: 'pdf-local', sourceFormat: 'pdf', pageCount } };
  }
}