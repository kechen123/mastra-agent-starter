import type { SourceParser, SourceInput, ParsedSource } from './types.js';
import { extensionOf } from './types.js';
import { getDocument, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfPageBlock { page: number; text: string }

/**
 * 真实 PDF 文本抽取（pdfjs-dist@4）。
 *
 * 为什么用 pdfjs-dist：
 *   - pdf-parse@1.1.x bundled pdf.js@1.10.100（2017 年），在 Node 22+ 上对所有
 *     合法 PDF 报 "bad XRef entry"（pdfkit 输出的最小 PDF 同样无法解析）。
 *   - pdfjs-dist@4 是 Mozilla 官方维护版本，Node 18+ 原生支持，文本提取稳定。
 *   - 选用 `pdfjs-dist/legacy/build/pdf.mjs` 子路径（而非顶层 `build/pdf.mjs`）
 *     以确保在 Node ESM 下无需 bundler 配置即可 import。
 *
 * 输出契约：
 *   - `metadata.pageCount` = 真实页数（PDF 自身 numPages）
 *   - `metadata.pageBlocks: Array<{ page, text }>` = 逐页文本，按 PDF 物理页号顺序
 *   - `text` = 全文，按 `\n\n` 拼接，便于后续 chunk 拆分与 heading 归属
 *   - 空文本抛 `PDF_EMPTY` warning，service 层会转 SourceRejectedError
 */
export class PdfParser implements SourceParser {
  supports(input: SourceInput): boolean { return input.kind === 'file' && extensionOf(input.filename) === 'pdf'; }
  async parse(input: SourceInput): Promise<ParsedSource> {
    if (input.kind !== 'file') throw new Error('PdfParser 仅支持 file');
    let pdf: PDFDocumentProxy;
    try {
      const data = new Uint8Array(input.buffer.buffer, input.buffer.byteOffset, input.buffer.byteLength);
      const loadingTask = getDocument({
        data,
        useSystemFonts: true,
        isEvalSupported: false,
        disableFontFace: true,
        verbosity: 0,
      });
      pdf = await loadingTask.promise;
    } catch (err) {
      throw new Error(`PDF 解析失败：${(err as Error).message.slice(0, 200)}`);
    }
    const pages: PdfPageBlock[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      let page: PDFPageProxy;
      try {
        page = await pdf.getPage(pageNumber);
      } catch (err) {
        throw new Error(`PDF 第 ${pageNumber} 页读取失败：${(err as Error).message.slice(0, 200)}`);
      }
      let content;
      try {
        content = await page.getTextContent();
      } catch (err) {
        throw new Error(`PDF 第 ${pageNumber} 页文本提取失败：${(err as Error).message.slice(0, 200)}`);
      }
      let lastY: number | undefined;
      let text = '';
      for (const raw of content.items) {
        const item = raw as { str?: string; transform?: number[]; hasEOL?: boolean };
        const y = item.transform?.[5];
        if (lastY !== undefined && y !== undefined && lastY !== y) {
          text += '\n';
        }
        text += item.str ?? '';
        if (item.hasEOL) text += '\n';
        lastY = y;
      }
      pages.push({ page: pageNumber, text });
    }
    // 释放 worker 资源（pdfjs-dist 内部持有 transferable buffer）
    try { await pdf.cleanup(); } catch { /* best-effort */ }
    try { await pdf.destroy(); } catch { /* best-effort */ }

    const realPages = pages.filter((b) => b.text.replace(/\s+/g, '').length > 0);
    if (realPages.length === 0) {
      return {
        text: '',
        title: input.filename,
        metadata: { parser: 'pdf-local', sourceFormat: 'pdf', pageCount: pdf.numPages },
        warnings: ['PDF 文本抽取为空（可能为扫描型或加密文件）'],
      };
    }
    const fullText = realPages.map((b) => b.text).join('\n\n')
      .replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (fullText.length === 0) {
      return {
        text: '',
        title: input.filename,
        metadata: { parser: 'pdf-local', sourceFormat: 'pdf', pageCount: pdf.numPages },
        warnings: ['PDF 文本抽取为空（可能为扫描型或加密文件）'],
      };
    }
    // pageBlocks 必须保留原始文本（含换行），否则 service.ts 的 splitWithAttribution
    // 按 `pageStarts.offset = sum(pageBlocks[i].text.length) + 2` 推算 char offset，
    // 与 `fullText = realPages.map(b => b.text).join('\n\n')` 实际拼接出来的位置对不上，
    // chunk.page 会落进不存在的页号（实测从 4 页物理 PDF 落出 page=3,4）。
    return {
      text: fullText,
      title: input.filename,
      metadata: {
        parser: 'pdf-local',
        sourceFormat: 'pdf',
        pageCount: pdf.numPages,
        pageBlocks: realPages.map((b) => ({ page: b.page, text: b.text })),
      },
    };
  }
}