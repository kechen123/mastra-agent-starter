import { SourceParserRegistry } from '../../src/modules/sources/parsers/registry.js';
import { UnsupportedSourceFormatError } from '../../src/modules/sources/parsers/types.js';

let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

console.log('[sources-parser] registry routing');

const reg = new SourceParserRegistry();

// Text always supported
const textResult = await reg.parse({ kind: 'text', content: 'hello', title: 't' });
assert('text parsed', textResult.text === 'hello' && textResult.metadata.parser === 'text');

// Plain text file
const txtBuffer = Buffer.from('line one\nline two\n', 'utf-8');
const txtResult = await reg.parse({ kind: 'file', filename: 'note.txt', mimeType: 'text/plain', buffer: txtBuffer });
assert('txt parsed', txtResult.text.includes('line one') && txtResult.metadata.parser === 'plain-text-file');

// Markdown file: headings extracted
const mdBuffer = Buffer.from('# Title\n\nbody\n\n## Sub\n\nmore\n', 'utf-8');
const mdResult = await reg.parse({ kind: 'file', filename: 'note.md', mimeType: 'text/markdown', buffer: mdBuffer });
assert('md headings extracted', (mdResult.metadata.headings ?? []).includes('Title') && (mdResult.metadata.headings ?? []).includes('Sub'));

// Unknown extension rejected
let threw = false;
try { await reg.parse({ kind: 'file', filename: 'evil.xyz', buffer: Buffer.from('x') }); }
catch (e) { threw = e instanceof UnsupportedSourceFormatError; }
assert('unknown extension rejected', threw);

// 真实 PDF：使用 pdf-parse 自带测试 PDF，避免外部下载依赖
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const pdfPath = resolve(__dirname, '..', '..', 'node_modules', 'pdf-parse', 'test', 'data', '05-versions-space.pdf');
let pdfBuffer: Buffer | null = null;
try { pdfBuffer = readFileSync(pdfPath); } catch { /* pdf-parse 可能未自带样本，跳过 */ }
if (pdfBuffer) {
  const pdfResult = await reg.parse({ kind: 'file', filename: 'sample.pdf', mimeType: 'application/pdf', buffer: pdfBuffer });
  assert('pdf parsed has text', pdfResult.text.length > 50);
  assert('pdf pageCount > 0', (pdfResult.metadata.pageCount ?? 0) > 0);
  assert('pdf parser identifier', pdfResult.metadata.parser === 'pdf-local');
} else {
  console.log('  · pdf sample missing, skipping pdf assertion');
}

import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
let docxBuffer: Buffer | null = null;
try {
  // mammoth 自带 samples
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const samplePath = resolve(__dirname, '..', '..', 'node_modules', 'mammoth', 'test', 'test-data', 'single-paragraph.docx');
  docxBuffer = readFileSync(samplePath);
} catch { /* skip */ }
if (docxBuffer) {
  const docxResult = await reg.parse({ kind: 'file', filename: 'sample.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxBuffer });
  assert('docx parsed has text', docxResult.text.length > 0);
  assert('docx parser identifier', docxResult.metadata.parser === 'docx-local');
} else {
  console.log('  · docx sample missing, skipping docx assertion');
}

// URL HTML parsing
const html = '<!doctype html><html><head><title>Hello</title><style>body{color:red}</style><script>alert(1)</script></head><body><h1>Title</h1><p>body one</p><p>body two</p></body></html>';
const urlInput = { kind: 'url' as const, originalUrl: 'https://example.com/', finalUrl: 'https://example.com/', fetchedAt: new Date().toISOString(), body: html };
const urlResult = await reg.parse(urlInput);
assert('url title extracted', urlResult.title === 'Hello');
assert('url body extracted', urlResult.text.includes('body one') && urlResult.text.includes('body two'));
assert('url strips scripts/styles', !urlResult.text.includes('alert(1)') && !urlResult.text.includes('color:red'));
assert('url parser identifier', urlResult.metadata.parser === 'url-html');

if (failed > 0) process.exitCode = 1;