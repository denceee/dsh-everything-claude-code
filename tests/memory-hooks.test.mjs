#!/usr/bin/env node
/**
 * Verify the two ECC hooks the Claude Code bridge cannot run are now covered.
 *
 * ECC's `PreCompact` and `SessionEnd` hooks are not in the seven events the DSH
 * bridge supports, so this port had no memory persistence at all — a known gap.
 * A bridge cannot be extended from outside it, but DSH exposes the same two
 * moments as native host events, which the plugin can listen to.
 *
 * This drives those listeners with synthetic events and asserts the notes land
 * on disk, so the replacements are proven rather than declared.
 *
 * Usage: node tests/memory-hooks.test.mjs
 */
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

const results = [];
async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: typeof note === 'string' ? note : undefined });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Point the plugin's note directory at a scratch home, so a test run cannot
// litter the real one.
const scratch = mkdtempSync(join(tmpdir(), 'ecc-memory-'));
process.env.DSH_HOME = scratch;

/** Load the plugin with a context that records listeners instead of requiring one. */
const listeners = new Map();
const warnings = [];
const infos = [];
const ctx = {
  logger: { warn: (m) => warnings.push(m), info: (m) => infos.push(m) },
  effect: (factory) => factory(),
  on: (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(handler);
    return () => {};
  },
  skills: { registerProvider: () => () => {} },
  inject: () => {},
};

const plugin = await import(pathToFileURL(join(packageRoot, 'index.js')).href);

await check('apply registers listeners without throwing', () => {
  plugin.apply(ctx, {});
  assert(listeners.size > 0, 'no listeners registered');
  return [...listeners.keys()].join(', ');
});

await check('it listens for the compaction marker', () => {
  assert(listeners.has('session/event'), 'no session/event listener; PreCompact has no replacement');
});

await check('it listens for agent disposal', () => {
  assert(listeners.has('agent/disposed'), 'no agent/disposed listener; SessionEnd has no replacement');
});

await check('the compaction listener reacts to a real compaction/start event', () => {
  const [handler] = listeners.get('session/event');
  handler({ id: 'session-test-1' }, { type: 'compaction/start', seq: 1, time: Date.now(), data: {} });
  const dir = join(scratch, 'sessions', 'memory');
  assert(existsSync(dir), `note directory was not created: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.includes('compaction'));
  assert(files.length === 1, `expected one compaction note file, found ${files.length}`);
  const text = readFileSync(join(dir, files[0]), 'utf8');
  assert(text.includes('compaction started'), `note does not describe the compaction: ${text}`);
  assert(text.includes('session-test-1'), 'note does not name the session');
  return files[0];
});

await check('the compaction listener ignores every other session event', () => {
  const [handler] = listeners.get('session/event');
  const dir = join(scratch, 'sessions', 'memory');
  const before = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]);
  for (const type of ['turn/start', 'tool/call', 'assistant/message', 'compaction/end']) {
    handler({ id: 'session-test-1' }, { type, seq: 2, time: Date.now(), data: {} });
  }
  const after = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]);
  assert(
    JSON.stringify(before) === JSON.stringify(after),
    'a non-compaction event wrote a note',
  );
});

await check('the disposal listener records a session ending', () => {
  const [handler] = listeners.get('agent/disposed');
  handler({ agent: { id: 'session-test-2' } });
  const dir = join(scratch, 'sessions', 'memory');
  const files = readdirSync(dir).filter((f) => f.includes('sessions'));
  assert(files.length === 1, `expected one session note file, found ${files.length}`);
  const text = readFileSync(join(dir, files[0]), 'utf8');
  assert(text.includes('ended'), `note does not describe the end: ${text}`);
  assert(text.includes('session-test-2'), 'note does not name the session');
  return files[0];
});

await check('notes accumulate rather than replacing each other', () => {
  const [disposed] = listeners.get('agent/disposed');
  disposed({ agent: { id: 'session-test-3' } });
  const dir = join(scratch, 'sessions', 'memory');
  const file = readdirSync(dir).find((f) => f.includes('sessions'));
  const lines = readFileSync(join(dir, file), 'utf8').trim().split('\n');
  assert(lines.length === 2, `expected two appended notes, found ${lines.length}`);
  assert(lines[1].includes('session-test-3'), 'the second note is missing');
});

await check('a malformed event does not throw', () => {
  // A memory hook must never be able to break the session it records.
  const [sessionEvent] = listeners.get('session/event');
  const [disposed] = listeners.get('agent/disposed');
  sessionEvent(undefined, { type: 'compaction/start' });
  disposed({});
  disposed(undefined);
  return 'handled missing fields without throwing';
});

await check('the note timestamps use ECCs own format', () => {
  const dir = join(scratch, 'sessions', 'memory');
  const file = readdirSync(dir).find((f) => f.includes('sessions'));
  const text = readFileSync(join(dir, file), 'utf8');
  // ECC wrote `[YYYY-MM-DD HH:MM:SS]`; this port keeps the date and minute.
  //
  // Written as a regex literal, not `new RegExp("…\\d…")`: inside a string,
  // `\d` needs doubling, and getting that wrong produces `\\d`, which matches a
  // literal backslash and silently never matches. The literal has no such trap.
  // The note is a Markdown bullet, so the timestamp follows "- ", not the line
  // start. Anchoring at `^\d` matched nothing while the output looked correct.
  const pattern = /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} \u2014 /m;
  assert(pattern.test(text), `timestamp does not match "YYYY-MM-DD HH:MM": ${text.split('\n')[0]}`);
  return text.split('\n')[0].slice(2, 18);
});

await check('success narration goes to info, not to the warning channel', () => {
  assert(infos.length > 0, 'nothing was narrated at all');
  assert(warnings.length === 0, `unexpected warnings: ${warnings.join(' | ')}`);
  return `${infos.length} info message(s), 0 warnings`;
});

await check('a write failure is logged and swallowed, not thrown', () => {
  // Point the home at a path that cannot be created, then fire a listener.
  const blocked = join(scratch, 'blocked');
  rmSync(blocked, { recursive: true, force: true });
  mkdirSync(blocked, { recursive: true });
  // A FILE where the directory needs to be, so mkdir inside appendNote fails.
  writeFileSync(join(blocked, 'file-not-dir'), 'x');
  process.env.DSH_HOME = join(blocked, 'file-not-dir');

  const before = warnings.length;
  const [disposed] = listeners.get('agent/disposed');
  disposed({ agent: { id: 'session-blocked' } });
  assert(warnings.length > before, 'the failure was silent');
  return 'logged and contained';
});

for (const r of results) {
  const suffix = r.note ? `  (${r.note})` : '';
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${suffix}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} memory-hook checks passed`);

rmSync(scratch, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
