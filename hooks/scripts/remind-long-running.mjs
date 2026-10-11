#!/usr/bin/env node
/**
 * PreToolUse (pwsh): remind that long build/test commands suit a background job.
 * Non-blocking: it writes a note to stderr and continues.
 */
import { readPayload, commandOf, warn, pass } from './lib.mjs';

const LONG_RUNNING =
  /\b(npm (install|test|ci)|pnpm (install|test)|yarn (install|test)?|bun (install|test)|cargo (build|test)|make|docker|pytest|vitest|playwright)\b/;

const payload = await readPayload();
if (LONG_RUNNING.test(commandOf(payload))) {
  warn(
    '[ECC hook] Long-running command. If it takes minutes, run it as a background ' +
      'job and collect it with job_output.',
  );
} else {
  pass();
}
