#!/usr/bin/env node
/**
 * PreToolUse (edit|write): suggest compaction at a logical interval.
 *
 * ECC compacts strategically rather than at an arbitrary pressure point. The
 * counter lives in the OS temp directory, keyed by session id when the bridge
 * provides one, so the reminder tracks a real session instead of the process.
 * Non-blocking.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPayload, warn, pass } from './lib.mjs';

const INTERVAL = 50;

const payload = await readPayload();
const sessionKey = String(payload.session_id ?? process.env.CLAUDE_SESSION_ID ?? 'default').replace(
  /[^\w.-]/g,
  '_',
);
const dir = join(tmpdir(), 'ecc-dsh');

let count = 0;
try {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `edits-${sessionKey}`);
  try {
    count = Number.parseInt(readFileSync(file, 'utf8'), 10) || 0;
  } catch {
    count = 0;
  }
  count += 1;
  writeFileSync(file, String(count));
} catch {
  pass();
}

if (count > 0 && count % INTERVAL === 0) {
  warn(
    `[ECC hook] ${count} file edits this session — a natural checkpoint.\n` +
      '[ECC hook] Consider compacting the conversation before starting the next phase.',
  );
} else {
  pass();
}
