import type { SourceParser, SourceInput, ParsedSource } from './types.js';
import * as cheerio from 'cheerio';

export class UrlParser implements SourceParser {
  supports(input: SourceInput): boolean { return input.kind === 'url'; }
  async parse(input: SourceInput): Promise<ParsedSource> {
    if (input.kind !== 'url') throw new Error('UrlParser 仅支持 url');
    const $ = cheerio.load(input.body);
    $('script, style, noscript, template').remove();
    const title = $('title').first().text().trim() || input.finalUrl;
    // 主体正文：优先 main / article，回退到 body
    const main = $('main').first();
    const article = $('article').first();
    const root = main.length ? main : article.length ? article : $('body');
    const text = root.text().replace(/\s+/g, ' ').trim();
    return { text, title, metadata: { parser: 'url-html', sourceFormat: 'html' } };
  }
}