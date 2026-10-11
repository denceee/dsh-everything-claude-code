#!/usr/bin/env node
/**
 * PreToolUse (pwsh): ask for confirmation before `git push`.
 *
 * The DSH bridge honors `ask` for PreToolUse, so this surfaces an approval
 * prompt instead of pushing silently. `allow` would not pre-approve anything,
 * which is why this hook never returns it.
 */
import { readPayload, commandOf, ask, pass } from './lib.mjs';

const payload = await readPayload();
if (/\bgit\s+push\b/.test(commandOf(payload))) {
  ask('Review the diff and the target branch before pushing.');
} else {
  pass();
}
