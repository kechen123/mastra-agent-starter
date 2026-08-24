/**
 * 轻量验证脚本：Parser Registry、PlainTextParser、MinerUParser 映射与边界行为。
 * 不依赖测试框架。
 */

import { getParser } from '../mastra/document-parsers/parser-registry.js';
import { PlainTextParser } from '../mastra/document-parsers/plain-text-parser.js';
import { MinerUParser } from '../mastra/document-parsers/mineru-parser.js';
import { UnsupportedDocumentTypeError } from '../mastra/document-parsers/types.js';
import { MinerUClient, MinerUClientError } from '../mastra/document-parsers/mineru-client.js';
import { getDocumentParserConfig } from '../mastra/document-parsers/config.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

/* ---------- fake MinerUClient helpers ---------- */

function makeFakeClient(response: unknown): MinerUClient {
  return {
    parseFile: async () => response,
  } as unknown as MinerUClient;
}

const VALID_RESPONSE = {
  status: 'completed',
  error: null,
  version: '3.4.5',
  results: {
    'test.pdf': { md_content: '# 标题\n\n正文内容。' },
  },
};

/* ---------- main ---------- */

async function main() {
  // ===== 默认关闭模式 =====
  console.log('默认关闭模式 (ENABLE_MINERU=false)');
  const originalEnableMinerU = process.env.ENABLE_MINERU;
  process.env.ENABLE_MINERU = 'false';

  assert(getParser({ filename: 'a.txt' }) instanceof PlainTextParser, 'txt → PlainTextParser');
  assert(getParser({ filename: 'a.md' }) instanceof PlainTextParser, 'md → PlainTextParser');

  let pdfThrew = false;
  try {
    getParser({ filename: 'a.pdf' });
  } catch (e) {
    pdfThrew = e instanceof UnsupportedDocumentTypeError;
  }
  assert(pdfThrew, 'pdf → UnsupportedDocumentTypeError (MinerU 关闭)');

  let docxThrew = false;
  try {
    getParser({ filename: 'a.docx' });
  } catch (e) {
    docxThrew = e instanceof UnsupportedDocumentTypeError;
  }
  assert(docxThrew, 'docx → UnsupportedDocumentTypeError (MinerU 关闭)');

  const configOff = getDocumentParserConfig();
  assert(configOff.mineruEnabled === false, 'config.mineruEnabled === false');
  assert(JSON.stringify(configOff.documentFormats) === JSON.stringify(['txt', 'md']), 'documentFormats = [txt, md]');

  // ===== 开启模式 =====
  console.log('\n开启模式 (ENABLE_MINERU=true)');
  process.env.ENABLE_MINERU = 'true';

  assert(getParser({ filename: 'a.txt' }) instanceof PlainTextParser, 'txt → PlainTextParser');
  assert(getParser({ filename: 'a.md' }) instanceof PlainTextParser, 'md → PlainTextParser');
  assert(getParser({ filename: 'a.pdf' }) instanceof MinerUParser, 'pdf → MinerUParser');
  assert(getParser({ filename: 'a.docx' }) instanceof MinerUParser, 'docx → MinerUParser');
  assert(getParser({ filename: 'a.PDF' }) instanceof MinerUParser, 'PDF (大写) → MinerUParser');

  const configOn = getDocumentParserConfig();
  assert(configOn.mineruEnabled === true, 'config.mineruEnabled === true');
  assert(JSON.stringify(configOn.documentFormats) === JSON.stringify(['txt', 'md', 'pdf', 'docx']), 'documentFormats = [txt, md, pdf, docx]');

  let exeThrew = false;
  try {
    getParser({ filename: 'a.exe' });
  } catch (e) {
    exeThrew = e instanceof UnsupportedDocumentTypeError;
  }
  assert(exeThrew, 'exe → UnsupportedDocumentTypeError');

  // ===== PlainTextParser =====
  console.log('\nPlainTextParser');
  const pt = new PlainTextParser();
  const txt = await pt.parse({ filename: 'test.txt', buffer: Buffer.from('Hello\r\nWorld\r\n\r\n\r\n!') });
  assert(txt.markdown === 'Hello\nWorld\n\n!', 'normalizeText: CRLF + 多换行折叠');
  assert(txt.metadata.parser === 'plain-text', 'metadata.parser === plain-text');
  assert(txt.metadata.sourceFormat === 'txt', 'metadata.sourceFormat === txt');

  const md = await pt.parse({ filename: 'test.md', buffer: Buffer.from('# Title\n\nContent') });
  assert(md.metadata.sourceFormat === 'md', 'md sourceFormat');

  // ===== MinerUParser — 3.4.5 响应映射 =====
  console.log('\nMinerUParser — 3.4.5 响应映射');

  // 1. 成功映射
  const muOk = new MinerUParser(makeFakeClient(VALID_RESPONSE));
  const okResult = await muOk.parse({ filename: 'report.pdf', buffer: Buffer.from('') });
  assert(okResult.markdown === '# 标题\n\n正文内容。', '成功提取 results[*].md_content');
  assert(okResult.metadata.parser === 'mineru', 'metadata.parser === mineru');
  assert(okResult.metadata.sourceFormat === 'pdf', 'metadata.sourceFormat === pdf');

  // 2. DOCX sourceFormat
  const muDocx = new MinerUParser(makeFakeClient({
    ...VALID_RESPONSE,
    results: { 'file.docx': { md_content: 'DOCX 内容' } },
  }));
  const docxResult = await muDocx.parse({ filename: 'file.docx', buffer: Buffer.from('') });
  assert(docxResult.metadata.sourceFormat === 'docx', 'docx sourceFormat');

  // 3. status = failed
  let statusFailedThrew = false;
  let statusFailedMsg = '';
  try {
    await new MinerUParser(makeFakeClient({
      status: 'failed',
      error: 'some internal detail that must not leak',
      results: {},
    })).parse({ filename: 'x.pdf', buffer: Buffer.from('') });
  } catch (e) {
    statusFailedThrew = e instanceof MinerUClientError;
    statusFailedMsg = e instanceof Error ? e.message : '';
  }
  assert(statusFailedThrew, 'status=failed 抛出 MinerUClientError');
  assert(!statusFailedMsg.includes('internal detail'), 'status=failed 错误消息不暴露原始内容');

  // 4. 空 md_content
  let emptyMdThrew = false;
  try {
    await new MinerUParser(makeFakeClient({
      status: 'completed',
      results: { 'x.pdf': { md_content: '   ' } },
    })).parse({ filename: 'x.pdf', buffer: Buffer.from('') });
  } catch (e) {
    emptyMdThrew = e instanceof MinerUClientError;
  }
  assert(emptyMdThrew, '空 md_content 抛出 MinerUClientError');

  // 5. 多结果
  let multiResultThrew = false;
  try {
    await new MinerUParser(makeFakeClient({
      status: 'completed',
      results: {
        'a.pdf': { md_content: 'A' },
        'b.pdf': { md_content: 'B' },
      },
    })).parse({ filename: 'x.pdf', buffer: Buffer.from('') });
  } catch (e) {
    multiResultThrew = e instanceof MinerUClientError;
  }
  assert(multiResultThrew, '多结果 results 抛出 MinerUClientError');

  // 6. 缺失 results
  let missingResultsThrew = false;
  try {
    await new MinerUParser(makeFakeClient({
      status: 'completed',
      results: undefined,
    })).parse({ filename: 'x.pdf', buffer: Buffer.from('') });
  } catch (e) {
    missingResultsThrew = e instanceof MinerUClientError;
  }
  assert(missingResultsThrew, '缺失 results 抛出 MinerUClientError');

  // 7. 非对象响应
  let nonObjectThrew = false;
  try {
    await new MinerUParser(makeFakeClient('not json')).parse({ filename: 'x.pdf', buffer: Buffer.from('') });
  } catch (e) {
    nonObjectThrew = e instanceof MinerUClientError;
  }
  assert(nonObjectThrew, '非对象响应抛出 MinerUClientError');

  // 恢复环境变量
  if (originalEnableMinerU !== undefined) {
    process.env.ENABLE_MINERU = originalEnableMinerU;
  } else {
    delete process.env.ENABLE_MINERU;
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
