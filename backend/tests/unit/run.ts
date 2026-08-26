/**
 * Unit-test runner. Each `tests/unit/*.ts` fixture runs its assertions at
 * import-time (top-level `console.log` + `assert` calls) and exits with code
 * 1 on any failure. Importing the module IS the test.
 *
 * Run with: npx tsx tests/unit/run.ts
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const here = readdirSync(__dirname)
  .filter((f) => f.endsWith('.ts') && f !== 'run.ts')
  .sort();

for (const file of here) {
  console.log(`\n── ${file} ──`);
  await import(pathToFileURL(join(__dirname, file)).href);
}

console.log('\nAll unit fixtures completed.');
