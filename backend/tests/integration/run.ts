/**
 * Integration-test runner. Imports each `tests/integration/*.ts` fixture
 * in sorted order. Each fixture is responsible for its own setup/teardown
 * and exits with code 1 on any failure.
 *
 * Run with: npx tsx tests/integration/run.ts
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

console.log('\nAll integration fixtures completed.');
