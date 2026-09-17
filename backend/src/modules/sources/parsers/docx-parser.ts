import type { SourceParser, SourceInput, ParsedSource } from './types.js';
import { extensionOf } from './types.js';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import JSZip from 'jszip';

// mammoth 默认样式映射下，DOCX 的 w:pStyle w:val="Heading1/2/..." 会被渲染成 <p>，
// 而不是 <h1>/<h2>。这里显式把这些样式 ID 映射为语义化标签，使 cheerio 能挑出 headings。
const DOCX_STYLE_MAP = [
  'p.Heading1 => h1:fresh',
  'p.Heading2 => h2:fresh',
  'p.Heading3 => h3:fresh',
  'p.Heading4 => h4:fresh',
  'p.Heading5 => h5:fresh',
  'p.Heading6 => h6:fresh',
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='heading 1'] => h1:fresh",
  "p[style-name='heading 2'] => h2:fresh",
  "p[style-name='heading 3'] => h3:fresh",
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
].join('\n');

/**
 * 直接读 word/document.xml 抓 w:pStyle w:val="HeadingN" 的段落，作为 mammoth 的 fallback。
 * mammoth 对最小 docx（缺少 styles.xml 或 _rels）经常丢失样式映射，
 * 直接 XML 扫描不受 styles 关系完整性影响，更可靠。
 */
async function readHeadingsFromDocumentXml(buffer: Buffer): Promise<string[]> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const docEntry = zip.file('word/document.xml');
    if (!docEntry) return [];
    const docXml = await docEntry.async('text');
    const $ = cheerio.load(docXml, { xmlMode: true });
    const out: string[] = [];
    $('w\\:p').each((_, pEl) => {
      const pStyleVal = $(pEl).find('w\\:pStyle').first().attr('w:val');
      if (pStyleVal && /^Heading[1-6]$/.test(pStyleVal)) {
        const txt = $(pEl).find('w\\:t').text().trim();
        if (txt) out.push(txt);
      }
    });
    return out;
  } catch {
    return [];
  }
}

export class DocxParser implements SourceParser {
  supports(input: SourceInput): boolean { return input.kind === 'file' && extensionOf(input.filename) === 'docx'; }
  async parse(input: SourceInput): Promise<ParsedSource> {
    if (input.kind !== 'file') throw new Error('DocxParser 仅支持 file');
    let raw: Awaited<ReturnType<typeof mammoth.extractRawText>>;
    let html: Awaited<ReturnType<typeof mammoth.convertToHtml>>;
    try {
      [raw, html] = await Promise.all([
        mammoth.extractRawText({ buffer: input.buffer }),
        mammoth.convertToHtml({ buffer: input.buffer }, { styleMap: DOCX_STYLE_MAP }),
      ]);
    } catch (err) {
      throw new Error(`DOCX 解析失败：${(err as Error).message.slice(0, 200)}`);
    }
    const text = (raw.value ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const $ = cheerio.load(html.value ?? '');
    const mammothHeadings = $('h1, h2, h3, h4, h5, h6').map((_, el) => $(el).text().trim()).get().filter(Boolean);

    // mammoth 没识别样式时（最小 docx 缺 styles.xml 等），fallback 到直接 XML 扫描。
    const fallbackHeadings = mammothHeadings.length === 0 ? await readHeadingsFromDocumentXml(input.buffer) : [];
    const headings = mammothHeadings.length > 0 ? mammothHeadings : fallbackHeadings;

    // 把每个 heading 在 plain text 中的位置记录下来，供 service 把 heading 写进 chunk metadata。
    const headingSections = headings.map((h) => {
      const idx = text.indexOf(h);
      return {
        heading: h,
        startChar: idx >= 0 ? idx : -1,
        endChar: idx >= 0 ? idx + h.length : -1,
      };
    }).filter(s => s.startChar >= 0);

    return {
      text,
      title: input.filename,
      metadata: {
        parser: 'docx-local',
        sourceFormat: 'docx',
        headings: headings.length > 0 ? headings : undefined,
        headingSections: headingSections.length > 0 ? headingSections : undefined,
      },
    };
  }
}