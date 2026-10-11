#!/usr/bin/env node
/**
 * Run every check for the dsh-everything-claude-code bundle.
 * Usage: node tests/run-all.mjs
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' });
  if (result.status !== 0) failed += 1;
}

console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
process.exit(failed === 0 ? 0 : 1);
