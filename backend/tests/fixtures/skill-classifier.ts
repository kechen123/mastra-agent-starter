/**
 * Static verification fixture for skill classification + safe-uninstall guards.
 *
 * This is a STATIC fixture — it never executes any script it creates. It:
 *   1. Creates an isolated workspace under tests/.tmp/ (cleaned up on exit).
 *   2. Verifies classifyFromFiles on a variety of file listings.
 *   3. Verifies parseAllowedToolsFromFrontmatter across ALL standard forms:
 *        - inline list   `[a, b]`
 *        - comma         `a, b`
 *        - single        `a`
 *        - YAML block list
 *        - quoted forms  `"a", 'b'`
 *   4. Verifies isPathStrictlyUnder refuses:
 *        - the root itself
 *        - a sibling outside root
 *        - a `..` traversal
 *      and accepts a strictly nested subdir.
 *   5. Performs an install-then-poison scan without executing scripts.
 *   6. Verifies Preview == Reload classification for the same file set.
 *   7. Verifies a nested EMPTY `scripts/` directory → requires-runtime.
 *   8. Verifies concurrent ensureSkillRegistryLoaded() calls share the loader
 *      and only trigger one real load (idempotent hydration).
 *
 * Run with: npx tsx tests/fixtures/skill-classifier.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyFromFiles,
  isPathStrictlyUnder,
  listFilesRecursive,
  parseAllowedToolsFromFrontmatter,
  analyzeCompatibility,
  getMarketSkillsRootAbsolute,
  ensureSkillRegistryLoaded,
  isSkillRegistryLoaded,
  _setSkillRegistryLoaderForTesting,
} from '../../src/core/skill/registry.js';

let failed = 0;
let passed = 0;

function assert(label: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

const TMP = join(process.cwd(), 'tests', '.tmp');

function cleanup(): void {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }
}

cleanup();
mkdirSync(TMP, { recursive: true });

console.log('\n[1] classifyFromFiles — pure file listing');

// (1a) Empty listing → no scripts, no exec.
const empty = classifyFromFiles([]);
assert(
  'empty files → hasScripts=false, hasExecutableExt=false',
  empty.hasScripts === false && empty.hasExecutableExt === false,
);

// (1b) Plain README.md → no scripts, no exec.
const plain = classifyFromFiles(['README.md', 'SKILL.md', 'docs/notes.md']);
assert(
  'plain markdown only → compatible',
  plain.hasScripts === false && plain.hasExecutableExt === false,
);

// (1c) Root-level .sh
const rootSh = classifyFromFiles(['SKILL.md', 'run.sh']);
assert(
  'root-level .sh → hasExecutableExt=true',
  rootSh.hasExecutableExt === true && rootSh.hasScripts === false,
);

// (1d) Nested .py
const nestedPy = classifyFromFiles(['SKILL.md', 'lib/util.py']);
assert(
  'nested .py → hasExecutableExt=true (recursive scan)',
  nestedPy.hasExecutableExt === true && nestedPy.hasScripts === false,
);

// (1e) Deeply nested .js
const deepJs = classifyFromFiles(['SKILL.md', 'a/b/c/build.js']);
assert(
  'deeply nested .js → hasExecutableExt=true',
  deepJs.hasExecutableExt === true && deepJs.hasScripts === false,
);

// (1f) scripts/ at root
const scriptsRoot = classifyFromFiles(['SKILL.md', 'scripts']);
assert('scripts/ directory at root → hasScripts=true', scriptsRoot.hasScripts === true);

// (1g) scripts/ nested
const scriptsNested = classifyFromFiles(['SKILL.md', 'lib/scripts']);
assert('scripts/ directory nested → hasScripts=true', scriptsNested.hasScripts === true);

// (1h) every exec extension
for (const ext of ['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'py', 'js', 'ts', 'mjs', 'cjs', 'rb', 'pl']) {
  const r = classifyFromFiles([`SKILL.md`, `tool.${ext}`]);
  assert(`.${ext} at root → hasExecutableExt=true`, r.hasExecutableExt === true);
}

console.log('\n[2] parseAllowedToolsFromFrontmatter — all standard forms');

// (2a) inline list
const a = parseAllowedToolsFromFrontmatter(
  '---\nallowed-tools: [calculator, get-current-time]\n---\nbody',
);
assert(
  'inline list parses 2 tools',
  JSON.stringify(a) === JSON.stringify(['calculator', 'get-current-time']),
);

// (2b) comma-separated
const b = parseAllowedToolsFromFrontmatter(
  '---\nallowed-tools: calculator, get-current-time\n---\nbody',
);
assert(
  'comma-separated parses 2 tools',
  JSON.stringify(b) === JSON.stringify(['calculator', 'get-current-time']),
);

// (2c) single string
const c = parseAllowedToolsFromFrontmatter('---\nallowed-tools: calculator\n---\nbody');
assert('single string parses 1 tool', JSON.stringify(c) === JSON.stringify(['calculator']));

// (2d) missing frontmatter
const d = parseAllowedToolsFromFrontmatter('# no frontmatter here');
assert('no frontmatter → empty', JSON.stringify(d) === '[]');

// (2e) extra fields allowed
const e = parseAllowedToolsFromFrontmatter(
  '---\nname: foo\nallowed-tools: [a, b, c]\n---\nbody',
);
assert(
  'frontmatter with extra fields parses tools',
  JSON.stringify(e) === JSON.stringify(['a', 'b', 'c']),
);

// (2f) YAML block list — the standard form skills.sh repos use
const f = parseAllowedToolsFromFrontmatter(
  '---\nname: foo\nallowed-tools:\n  - calculator\n  - get-current-time\n---\nbody',
);
assert(
  'YAML block list parses 2 tools',
  JSON.stringify(f) === JSON.stringify(['calculator', 'get-current-time']),
);

// (2g) YAML block list with quoted values
const g = parseAllowedToolsFromFrontmatter(
  '---\nallowed-tools:\n  - "calculator"\n  - \'get-current-time\'\n---\nbody',
);
assert(
  'YAML block list with quoted values parses 2 tools',
  JSON.stringify(g) === JSON.stringify(['calculator', 'get-current-time']),
);

// (2h) inline list with double-quoted values
const h = parseAllowedToolsFromFrontmatter(
  '---\nallowed-tools: ["calculator", "get-current-time"]\n---\nbody',
);
assert(
  'inline list with double quotes parses 2 tools',
  JSON.stringify(h) === JSON.stringify(['calculator', 'get-current-time']),
);

// (2i) inline list with single-quoted values
const i = parseAllowedToolsFromFrontmatter(
  "---\nallowed-tools: ['calculator', 'get-current-time']\n---\nbody",
);
assert(
  'inline list with single quotes parses 2 tools',
  JSON.stringify(i) === JSON.stringify(['calculator', 'get-current-time']),
);

// (2j) comma + quoted
const j = parseAllowedToolsFromFrontmatter(
  '---\nallowed-tools: "calculator", \'get-current-time\'\n---\nbody',
);
assert(
  'comma-separated quoted values parse 2 tools',
  JSON.stringify(j) === JSON.stringify(['calculator', 'get-current-time']),
);

// (2k) empty allowed-tools → []
const k = parseAllowedToolsFromFrontmatter('---\nallowed-tools: []\n---\nbody');
assert('empty inline list → []', JSON.stringify(k) === '[]');

console.log('\n[3] analyzeCompatibility — allowed-tools intersection');

// (3a) no allowed-tools, no scripts → compatible
const cleanCompat = analyzeCompatibility(['SKILL.md'], []);
assert('clean SKILL.md → compatible', cleanCompat.compatibility === 'compatible');

// (3b) scripts → requires-runtime even without allowed-tools
const scriptsCompat = analyzeCompatibility(['SKILL.md', 'scripts']);
assert(
  'scripts/ → requires-runtime',
  scriptsCompat.compatibility === 'requires-runtime',
);

console.log('\n[4] isPathStrictlyUnder — uninstall safety');

// (4a) root itself is NOT under itself
const root = getMarketSkillsRootAbsolute();
const rootItself = root;
assert('root is not under itself', isPathStrictlyUnder(rootItself, root) === false);

// (4b) strictly nested subdir IS under root
const nestedOk = join(root, 'owner', 'repo', 'skill');
assert('nested subdir is under root', isPathStrictlyUnder(nestedOk, root) === true);

// (4c) sibling directory is NOT under root
const sibling = join(root, '..', 'sibling');
assert('sibling directory is not under root', isPathStrictlyUnder(sibling, root) === false);

// (4d) traversal attempt is NOT under root
const traversal = join(root, 'owner', '..', '..', 'evil');
assert('path traversal is not under root', isPathStrictlyUnder(traversal, root) === false);

console.log('\n[5] Real directory scan — install-then-poison scenario');

// Build a temporary skill directory, scan it, classify, then drop a poisoned
// file and re-scan. The point of the fixture is the re-scan after the change.
const poisoned = join(TMP, 'poisoned-skill');
mkdirSync(join(poisoned, 'docs'), { recursive: true });
writeFileSync(
  join(poisoned, 'SKILL.md'),
  '---\nname: poisoned\nallowed-tools: [calculator]\n---\nbody',
);
writeFileSync(join(poisoned, 'docs', 'readme.md'), '# readme');

const before = listFilesRecursive(poisoned);
const beforeClass = classifyFromFiles(before);
assert(
  'before poisoning → compatible',
  beforeClass.hasScripts === false && beforeClass.hasExecutableExt === false,
);
assert(
  'before poisoning → found SKILL.md and docs/readme.md',
  before.includes('SKILL.md') && before.includes('docs/readme.md'),
);

// Now drop a nested script and re-scan — the registry must reclassify to
// requires-runtime WITHOUT executing the script.
writeFileSync(join(poisoned, 'docs', 'evil.sh'), '#!/bin/sh\necho should-never-run');
const after = listFilesRecursive(poisoned);
const afterClass = classifyFromFiles(after);
assert(
  'after dropping nested .sh → hasExecutableExt=true',
  afterClass.hasExecutableExt === true,
);
assert('nested relative path preserved', after.includes('docs/evil.sh'));

console.log('\n[6] Empty nested scripts/ directory → requires-runtime');

// (6a) Nested empty scripts/ at root level
const nestedEmptyRoot = join(TMP, 'nested-empty-scripts-root');
mkdirSync(join(nestedEmptyRoot, 'scripts'), { recursive: true });
writeFileSync(join(nestedEmptyRoot, 'SKILL.md'), '---\nname: x\n---\nbody');
const nestedEmptyRootFiles = listFilesRecursive(nestedEmptyRoot);
const nestedEmptyRootClass = classifyFromFiles(nestedEmptyRootFiles);
assert(
  'empty scripts/ at root → hasScripts=true (empty dir still classified)',
  nestedEmptyRootClass.hasScripts === true,
);
assert(
  'empty scripts/ → requires-runtime even with zero files inside',
  analyzeCompatibility(nestedEmptyRootFiles, []).compatibility === 'requires-runtime',
);

// (6b) Deeply nested empty scripts/
const nestedEmptyDeep = join(TMP, 'deep-empty', 'lib', 'foo');
mkdirSync(join(nestedEmptyDeep, 'scripts'), { recursive: true });
writeFileSync(join(nestedEmptyDeep, 'SKILL.md'), '---\nname: x\n---\nbody');
const nestedEmptyDeepFiles = listFilesRecursive(nestedEmptyDeep);
const nestedEmptyDeepClass = classifyFromFiles(nestedEmptyDeepFiles);
assert(
  'empty scripts/ deeply nested → hasScripts=true',
  nestedEmptyDeepClass.hasScripts === true,
);
assert(
  'deeply nested empty scripts/ → requires-runtime',
  analyzeCompatibility(nestedEmptyDeepFiles, []).compatibility === 'requires-runtime',
);

console.log('\n[7] Preview == Reload consistency');

// Build a synthetic "skills.sh response" (file paths + SKILL.md body) and
// compute the preview-time compatibility. Then write those same files to
// disk, scan the directory, re-parse SKILL.md and re-classify. The two
// results MUST match — that is the guarantee install() + reload() make to
// every caller.
const previewScenario = join(TMP, 'preview-vs-reload');
mkdirSync(previewScenario, { recursive: true });
const previewSkillMd =
  '---\nname: hello\nallowed-tools:\n  - calculator\n  - get-current-time\n---\n# hello';
const previewFiles = ['SKILL.md', 'docs/notes.md'];

const previewTime = analyzeCompatibility(previewFiles, parseAllowedToolsFromFrontmatter(previewSkillMd));
const previewAllowedTools = parseAllowedToolsFromFrontmatter(previewSkillMd);

writeFileSync(join(previewScenario, 'SKILL.md'), previewSkillMd);
mkdirSync(join(previewScenario, 'docs'), { recursive: true });
writeFileSync(join(previewScenario, 'docs', 'notes.md'), '# notes');
const onDiskFiles = listFilesRecursive(previewScenario);
const onDiskAllowedTools = parseAllowedToolsFromFrontmatter(readFileSync(join(previewScenario, 'SKILL.md'), 'utf-8'));
const reloadTime = analyzeCompatibility(onDiskFiles, onDiskAllowedTools);

assert(
  'preview-time compatibility matches reload-time compatibility',
  previewTime.compatibility === reloadTime.compatibility,
);
assert(
  'preview-time reason matches reload-time reason',
  previewTime.reason === reloadTime.reason,
);
assert(
  'preview-time allowed-tools matches reload-time allowed-tools',
  JSON.stringify(previewAllowedTools) === JSON.stringify(onDiskAllowedTools),
);
assert(
  'preview-time compatibility equals reload-time compatibility (same value, both phases)',
  JSON.stringify({ c: previewTime.compatibility, r: previewTime.reason }) ===
    JSON.stringify({ c: reloadTime.compatibility, r: reloadTime.reason }),
);

// Now do the same for a "poisoned preview" — skills.sh claims compatible but
// the actual file list contains `scripts/run.sh`. Both phases must agree on
// requires-runtime.
const poisonedPreviewFiles = ['SKILL.md', 'scripts/run.sh'];
const poisonedPreviewCompat = analyzeCompatibility(
  poisonedPreviewFiles,
  parseAllowedToolsFromFrontmatter(previewSkillMd),
);
const poisonedReloadCompat = analyzeCompatibility(
  ['SKILL.md', 'scripts/run.sh'],
  [],
);
assert(
  'poisoned preview: compatibility = requires-runtime',
  poisonedPreviewCompat.compatibility === 'requires-runtime',
);
assert(
  'poisoned reload: compatibility = requires-runtime (matches preview)',
  poisonedReloadCompat.compatibility === 'requires-runtime',
);
assert(
  'poisoned preview == reload (both requires-runtime)',
  poisonedPreviewCompat.compatibility === poisonedReloadCompat.compatibility,
);

console.log('\n[7b] Missing/unauthorized tool → requires-runtime BUT hasScripts=false');

// A clean SKILL.md that requests an unknown tool. There are no `scripts/`
// and no executable-extension files — `hasScripts` MUST stay false even
// though compatibility is `requires-runtime`. This is the rule the
// market.ts install path must respect when persisting has_scripts.
{
  const cleanFiles = ['SKILL.md'];
  const allowedTools = ['unknown-tool'];
  const compat = analyzeCompatibility(cleanFiles, allowedTools);
  const { hasScripts, hasExecutableExt } = classifyFromFiles(cleanFiles);
  const derivedHasScripts = hasScripts || hasExecutableExt;

  assert(
    'missing-tool scenario: compatibility = requires-runtime',
    compat.compatibility === 'requires-runtime',
  );
  assert(
    'missing-tool scenario: hasScripts = false (no scripts/ present)',
    derivedHasScripts === false,
  );
  assert(
    'missing-tool scenario: classifyFromFiles → hasScripts=false, hasExecutableExt=false',
    hasScripts === false && hasExecutableExt === false,
  );

  // Also exercise the full materialised-on-disk round-trip used by
  // market.ts installMarketSkill so the on-disk path stays consistent.
  const missingToolDir = join(TMP, 'missing-tool-skill');
  mkdirSync(missingToolDir, { recursive: true });
  writeFileSync(
    join(missingToolDir, 'SKILL.md'),
    '---\nname: missing\nallowed-tools: [unknown-tool]\n---\nbody',
  );
  const onDisk = listFilesRecursive(missingToolDir);
  const onDiskClass = classifyFromFiles(onDisk);
  const onDiskCompat = analyzeCompatibility(onDisk, ['unknown-tool']);
  assert(
    'on-disk missing-tool scan: compatibility = requires-runtime',
    onDiskCompat.compatibility === 'requires-runtime',
  );
  assert(
    'on-disk missing-tool scan: hasScripts = false (filesystem-evidence only)',
    (onDiskClass.hasScripts || onDiskClass.hasExecutableExt) === false,
  );
}

console.log('\n[8] ensureSkillRegistryLoaded() — idempotent hydration');

// Install a counting loader. Concurrent calls MUST share the same Promise and
// only trigger ONE real load. After success subsequent calls must be O(1).
{
  let loadCount = 0;
  let release: () => void = () => {};
  const block = new Promise<void>((resolve) => {
    release = resolve;
  });
  _setSkillRegistryLoaderForTesting(async () => {
    loadCount++;
    await block; // hold the loader so concurrent calls overlap
  });

  // Fire 10 concurrent ensure calls BEFORE the loader resolves.
  const callers = Array.from({ length: 10 }, () => ensureSkillRegistryLoaded());
  // Wait a microtask so all callers are parked on the shared promise.
  await Promise.resolve();
  assert(
    '10 concurrent ensureSkillRegistryLoaded() calls triggered exactly 1 loader invocation',
    loadCount === 1,
  );
  assert('isSkillRegistryLoaded() returns false while loader is in flight', isSkillRegistryLoaded() === false);

  // Release the loader. All callers must resolve together.
  release();
  await Promise.all(callers);

  assert(
    'after loader resolves, isSkillRegistryLoaded() === true',
    isSkillRegistryLoaded() === true,
  );
  assert('loader was called exactly once across all callers', loadCount === 1);

  // A second round of ensure calls should NOT re-invoke the loader.
  await ensureSkillRegistryLoaded();
  await ensureSkillRegistryLoaded();
  assert('subsequent ensure calls do not re-invoke the loader', loadCount === 1);
}

// Failure path: a loader that throws must NOT leave the gate marked complete,
// and the next ensure call must retry.
{
  let attempts = 0;
  _setSkillRegistryLoaderForTesting(async () => {
    attempts++;
    throw new Error('synthetic DB failure');
  });
  // First call rejects.
  let threw = false;
  try {
    await ensureSkillRegistryLoaded();
  } catch {
    threw = true;
  }
  assert('loader throwing → ensure rejects', threw);
  assert(
    'loader throwing → isSkillRegistryLoaded() remains false',
    isSkillRegistryLoaded() === false,
  );
  // Second call must retry the loader — gate is reset on failure so transient
  // DB errors don't permanently break hydration.
  let threw2 = false;
  try {
    await ensureSkillRegistryLoaded();
  } catch {
    threw2 = true;
  }
  assert('loader throwing → next ensure call also rejects', threw2);
  assert(
    'loader throwing → next ensure call retries (attempts=2)',
    attempts === 2,
  );
}

// Restore the production loader so any later imports don't see the test one.
_setSkillRegistryLoaderForTesting(null);

console.log('\n--- cleanup ---');
cleanup();

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);