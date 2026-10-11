#!/usr/bin/env node
/**
 * PreToolUse (edit|write): warn about `console.log` left in a JS/TS file.
 *
 * Non-blocking on purpose: an edit is often the first half of a change, and
 * blocking mid-edit would fight the author. The `Stop` hook reports leftovers
 * at the end of the turn, which is where the reminder actually lands.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readPayload, filePathOf, warn, pass } from './lib.mjs';

const path = filePathOf(await readPayload());
if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path) || !existsSync(path)) {
  pass();
} else {
  const hits = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (/console\.log/.test(line)) hits.push(`${index + 1}: ${line.trim()}`);
  });
  if (hits.length === 0) {
    pass();
  } else {
    warn(
      `[ECC hook] console.log found in ${path}\n` +
        hits
          .slice(0, 5)
          .map((hit) => `[ECC hook]   ${hit}`)
          .join('\n'),
    );
  }
}
