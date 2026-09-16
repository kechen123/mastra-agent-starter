import { MarkdownParser } from '../../src/modules/sources/parsers/markdown-parser.js';

let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

const md = `# Top\n\nintro\n\n## Section A\n\naaa\n\n### Subsection A.1\n\nbbb\n\n## Section B\n\nccc\n`;
const parser = new MarkdownParser();
const result = await parser.parse({ kind: 'file', filename: 'doc.md', mimeType: 'text/markdown', buffer: Buffer.from(md, 'utf-8') });
assert('first heading used as title', result.title === 'Top');
assert('all headings captured', JSON.stringify(result.metadata.headings) === JSON.stringify(['Top', 'Section A', 'Subsection A.1', 'Section B']));
assert('text normalized', !result.text.includes('\r\n') && !result.text.includes('\n\n\n'));
if (failed > 0) process.exitCode = 1;