#!/usr/bin/env node
/**
 * Replay a hook script exactly as the DSH bridge does, and print its raw
 * exit code, stdout, and stderr — including the crash output that the bridge
 * collapses into a bounded `stderrSummary`.
 *
 * Usage: node tests/replay-hook.mjs <script> '<json payload>'
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

const script = process.argv[2];
const payload = process.argv[3] ?? '{}';

const result = spawnSync(process.execPath, [join(packageRoot, 'hooks', 'scripts', script)], {
  input: payload,
  encoding: 'utf8',
  env: { ...process.env, CLAUDE_PLUGIN_ROOT: packageRoot, CLAUDE_PROJECT_DIR: packageRoot },
  timeout: 30000,
});

console.log(`script:  ${script}`);
console.log(`exit:    ${result.status}`);
console.log(`stdout:  ${JSON.stringify(result.stdout)}`);
console.log(`stderr:  ${result.stderr ? result.stderr.slice(0, 1200) : '(empty)'}`);
