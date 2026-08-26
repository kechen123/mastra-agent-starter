/**
 * Pure-function unit tests for `classifyFromFiles` and `analyzeCompatibility`.
 *
 * No filesystem, DB, network, or model invocation — input is `string[]`,
 * output is the discriminated compatibility verdict. Covers the rules that
 * keep scripts and shell tools out of the bindable Skill list.
 *
 * Note: `analyzeCompatibility` calls into the Tool/Agent registries. We pass
 * `agentId` only for agent-scoped checks; the Tool side is allowed to return
 * "missing" because no Tools are registered in this isolated test process.
 *
 * Run with: npx tsx tests/unit/skill-script-classification.ts
 */
import { classifyFromFiles, analyzeCompatibility } from '../../src/core/skill/compatibility.js';

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

console.log('[skill] script classification');

const r = classifyFromFiles([]);
assert('empty → hasScripts=false, hasExecutableExt=false',
  r.hasScripts === false && r.hasExecutableExt === false);

const r2 = classifyFromFiles(['README.md', 'SKILL.md', 'docs/notes.md']);
assert('plain markdown only → compatible',
  r2.hasScripts === false && r2.hasExecutableExt === false);

const r3 = classifyFromFiles(['SKILL.md', 'scripts/run.sh']);
assert('root-level .sh + scripts/ → hasScripts AND hasExecutableExt',
  r3.hasScripts === true && r3.hasExecutableExt === true);

const r4 = classifyFromFiles(['lib/scripts/x.py']);
assert('nested scripts/ → hasScripts even when not at root',
  r4.hasScripts === true);

const r5 = classifyFromFiles(['tools.sh']);
assert('.sh extension is detected by basename, not full path',
  r5.hasExecutableExt === true);

const r6 = classifyFromFiles(['SKILL.md', 'bin/x', 'bin/y']);
assert('extensionless files in bin/ → no exec',
  r6.hasExecutableExt === false);

const r7 = classifyFromFiles(['SKILL.md', 'scripts/']);
assert('an empty scripts/ directory entry → hasScripts',
  r7.hasScripts === true);

const r8 = classifyFromFiles(['SKILL.md', 'deep/nested/scripts/x.js']);
assert('deeply nested scripts/ → hasScripts',
  r8.hasScripts === true);

console.log('\n[skill] analyzeCompatibility');

// Scripts → requires-runtime with reason mentioning executable files
const a1 = analyzeCompatibility(['scripts/run.sh'], []);
assert('has scripts → requires-runtime',
  a1.compatibility === 'requires-runtime' && /executable/i.test(a1.reason));

// No scripts, no allowed-tools → compatible
const a2 = analyzeCompatibility(['SKILL.md', 'README.md']);
assert('plain docs → compatible',
  a2.compatibility === 'compatible' && a2.reason === 'ok');

// allowed-tools referencing a tool that is NOT registered in the empty test
// registry → requires-runtime with reason mentioning "not registered".
const a3 = analyzeCompatibility(['SKILL.md'], ['does-not-exist']);
assert('unregistered tool → requires-runtime',
  a3.compatibility === 'requires-runtime' && /not registered/i.test(a3.reason));

// Empty allowed-tools array is treated the same as no allowed-tools.
const a4 = analyzeCompatibility(['SKILL.md'], []);
assert('empty allowed-tools → compatible',
  a4.compatibility === 'compatible');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
