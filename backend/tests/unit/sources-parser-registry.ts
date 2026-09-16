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

if (failed > 0) process.exitCode = 1;