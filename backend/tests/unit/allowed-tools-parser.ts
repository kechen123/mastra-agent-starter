/**
 * Pure-function unit tests for `parseAllowedToolsFromFrontmatter`.
 *
 * No filesystem, DB, network, or model invocation — input is a string, output
 * is a string[]. These cover every supported frontmatter shape documented in
 * the source comment of `core/skill/parser.ts`.
 *
 * Run with: npx tsx tests/unit/allowed-tools-parser.ts
 */
import { parseAllowedToolsFromFrontmatter } from '../../src/core/skill/parser.js';

let passed = 0;
let failed = 0;
function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(label: string, actual: string[], expected: string[]): void {
  const ok =
    actual.length === expected.length && actual.every((v, i) => v === expected[i]);
  if (!ok) {
    assert(label, false, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    assert(label, true);
  }
}

console.log('[allowed-tools] parser');

// (1) No frontmatter
eq('no frontmatter → []', parseAllowedToolsFromFrontmatter('plain text'), []);

// (2) Frontmatter without the key
eq(
  'frontmatter without allowed-tools → []',
  parseAllowedToolsFromFrontmatter('---\nname: x\n---\nbody'),
  [],
);

// (3) Inline list
eq(
  'inline list `[a, b]`',
  parseAllowedToolsFromFrontmatter('---\nallowed-tools: [calculator, get-current-time]\n---\nbody'),
  ['calculator', 'get-current-time'],
);

// (4) Comma-separated list
eq(
  'comma list `a, b`',
  parseAllowedToolsFromFrontmatter('---\nallowed-tools: calculator, get-current-time\n---\nbody'),
  ['calculator', 'get-current-time'],
);

// (5) Single value
eq(
  'single value',
  parseAllowedToolsFromFrontmatter('---\nallowed-tools: calculator\n---\nbody'),
  ['calculator'],
);

// (6) YAML block list
eq(
  'YAML block list',
  parseAllowedToolsFromFrontmatter(
    '---\nallowed-tools:\n  - calculator\n  - "get-current-time"\n---\nbody',
  ),
  ['calculator', 'get-current-time'],
);

// (7) Empty inline list
eq(
  'empty inline list `[]` → []',
  parseAllowedToolsFromFrontmatter('---\nallowed-tools: []\n---\nbody'),
  [],
);

// (8) Quoted forms (single quotes)
eq(
  'single-quoted values',
  parseAllowedToolsFromFrontmatter("---\nallowed-tools: ['a', 'b']\n---\nbody"),
  ['a', 'b'],
);

// (9) Block list with mixed quoting and trailing whitespace
eq(
  'block list with mixed quoting',
  parseAllowedToolsFromFrontmatter(
    '---\nallowed-tools:\n  - "alpha"\n  - \'beta\'\n  - gamma\n---\nbody',
  ),
  ['alpha', 'beta', 'gamma'],
);

// (10) Empty block (no items)
eq(
  'empty block → []',
  parseAllowedToolsFromFrontmatter('---\nallowed-tools:\n---\nbody'),
  [],
);

// (11) Other keys present alongside allowed-tools
eq(
  'mixed keys',
  parseAllowedToolsFromFrontmatter(
    '---\nname: x\ndescription: y\nallowed-tools: [a, b]\n---\nbody',
  ),
  ['a', 'b'],
);

// (12) Block list terminated by non-list line breaks the parse correctly
eq(
  'block list followed by other key stops at boundary',
  parseAllowedToolsFromFrontmatter(
    '---\nallowed-tools:\n  - a\n  - b\nname: z\n---\nbody',
  ),
  ['a', 'b'],
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
