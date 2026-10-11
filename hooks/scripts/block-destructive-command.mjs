#!/usr/bin/env node
/**
 * PreToolUse (pwsh): refuse a destructive shell command.
 *
 * These are the operations that cannot be undone from the shell: a force push
 * rewrites history other clones already hold, `git reset --hard` and
 * `git clean -f` discard work with no reflog entry, and a recursive delete of
 * an unscoped path takes files that are not in git at all.
 *
 * Ordinary work is untouched on purpose. `git push`, `git reset HEAD~1`,
 * `git branch -d`, `git clean -n`, and `rm -rf ./node_modules` all pass —
 * a guard that fires on routine commands gets switched off, and then it
 * protects nothing.
 */
import { readPayload, commandOf, workspaceRoots, block, pass } from './lib.mjs';
import { findDestructive } from './risk.mjs';

const payload = await readPayload();
// Every directory that bounds the session, not just the current one: DSH 0.2.1
// made the session directory mutable, so a single value would flag a legitimate
// delete of the original workspace once the session moved elsewhere.
const found = findDestructive(commandOf(payload), workspaceRoots(payload));

if (found === undefined) {
  pass();
} else {
  block(
    `[ECC hook] BLOCKED: ${found.why}\n` +
      `[ECC hook] Matched rule: ${found.id}\n` +
      '[ECC hook] If this is genuinely intended, run it outside the agent, or make it a\n' +
      '[ECC hook] dry run first (--dry-run / -n) so the effect can be reviewed.',
  );
}
