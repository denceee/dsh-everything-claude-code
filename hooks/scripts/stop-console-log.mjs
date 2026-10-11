#!/usr/bin/env node
/**
 * Stop: report `console.log` left behind in files modified this turn.
 *
 * Non-blocking. A blocking Stop hook forces another model step, and the bridge
 * always reports `stop_hook_active: false`, so an unconditional block would
 * loop forever. This hook only warns.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { warn, pass } from './lib.mjs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

try {
  git(['rev-parse', '--git-dir']);
} catch {
  pass();
  process.exit(process.exitCode ?? 0);
}

const modified = git(['diff', '--name-only', 'HEAD'])
  .split('\n')
  .map((line) => line.trim())
  .filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file) && existsSync(file));

const offenders = modified.filter((file) => {
  try {
    return readFileSync(file, 'utf8').includes('console.log');
  } catch {
    return false;
  }
});

if (offenders.length === 0) {
  pass();
} else {
  warn(
    `[ECC hook] console.log remains in: ${offenders.join(', ')}\n` +
      '[ECC hook] Remove it before committing.',
  );
}
