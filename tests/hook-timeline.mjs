#!/usr/bin/env node
/**
 * Timeline of hook-bridge activity in one session log.
 *
 * Answers the question a decision count cannot: WHEN did each matcher start
 * firing, and did any hook ever return a blocking decision? That distinguishes
 * "the hook is broken" from "the hook went live after I tested it".
 *
 * Usage: node tests/hook-timeline.mjs <session-dir-or-file>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeAll(buffer) {
  const offsets = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i);
  }
  const parts = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offsets[i], end)).toString('utf8'));
    } catch {
      /* partial trailing frame */
    }
  }
  return parts.join('');
}

function resolve(input) {
  const stat = statSync(input);
  if (stat.isFile()) return input;
  let best = null;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (entry.endsWith('.jsonl.zstd') && (!best || s.mtimeMs > best.mtime)) best = { path: full, mtime: s.mtimeMs };
    }
  };
  walk(input);
  return best?.path;
}

const target = resolve(process.argv[2]);
const records = [];
for (const line of decodeAll(readFileSync(target)).split('\n')) {
  if (!line.includes('hook/')) continue;
  try {
    const record = JSON.parse(line);
    if (record.type === 'hook/invoked' || record.type === 'hook/result') records.push(record);
  } catch {
    /* skip */
  }
}

const stamp = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });

const byMatcher = new Map();
for (const r of records) {
  if (r.type !== 'hook/invoked') continue;
  const key = r.data?.matcher ?? '(none)';
  const entry = byMatcher.get(key) ?? { count: 0, first: Infinity, last: 0 };
  entry.count += 1;
  entry.first = Math.min(entry.first, r.time);
  entry.last = Math.max(entry.last, r.time);
  byMatcher.set(key, entry);
}

console.log(`log: ${target}`);
console.log(`records: ${records.length}\n`);
console.log('matcher           count   first fired            last fired');
for (const [matcher, e] of [...byMatcher].sort((a, b) => a[1].first - b[1].first)) {
  console.log(`${matcher.padEnd(16)} ${String(e.count).padStart(5)}   ${stamp(e.first)}   ${stamp(e.last)}`);
}

const blocking = records.filter((r) => r.type === 'hook/result' && r.data?.decision && r.data.decision !== 'pass');
console.log(`\nblocking decisions: ${blocking.length}`);
for (const r of blocking.slice(0, 10)) {
  console.log(`  ${stamp(r.time)} point=${r.data.point} decision=${r.data.decision} exit=${r.data.exitCode}`);
}

const failed = records.filter((r) => r.type === 'hook/result' && r.data?.exitCode !== undefined && r.data.exitCode !== 0);
console.log(`\nnon-zero exits: ${failed.length}`);
for (const r of failed.slice(0, 10)) {
  console.log(`  ${stamp(r.time)} point=${r.data.point} exit=${r.data.exitCode} decision=${r.data.decision}`);
  if (r.data.stderrSummary) console.log(`    ${String(r.data.stderrSummary).slice(0, 160).replace(/\n/g, ' | ')}`);
}
