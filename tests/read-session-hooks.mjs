#!/usr/bin/env node
/**
 * Read DSH session logs and report hook-bridge activity.
 *
 * A session log is a JSONL stream written as MANY concatenated Zstandard
 * frames (one per flush) — this session's log holds 557 of them. Node's
 * streaming decoder stops at the end of the first frame, so it returned 1
 * record out of thousands. Decoding must advance frame by frame instead.
 *
 * Usage: node tests/read-session-hooks.mjs [session-dir-or-file] [--all]
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Offsets of every Zstandard frame in `buffer`. */
function frameOffsets(buffer) {
  const offsets = [];
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, index, index + 4) === 0) offsets.push(index);
  }
  return offsets;
}

/** Decode every concatenated frame of a session log into UTF-8 text. */
function decodeAllFrames(buffer) {
  const offsets = frameOffsets(buffer);
  const parts = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index];
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'));
    } catch {
      // A partial trailing frame is normal while a session is still writing.
    }
  }
  return parts.join('');
}

/** Resolve the newest `session*.jsonl.zstd` under a directory or file. */
function resolveTarget(input) {
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

const target = resolveTarget(process.argv[2] ?? '.');
if (!target) {
  console.error('no session log found');
  process.exit(1);
}

const buffer = readFileSync(target);
const frames = frameOffsets(buffer).length;
const text = decodeAllFrames(buffer);
const lines = text.split('\n').filter(Boolean);

console.log(`log:    ${target}`);
console.log(`frames: ${frames}`);
console.log(`records:${lines.length}\n`);

const hookRecords = [];
const kinds = new Map();
const points = new Map();
for (const line of lines) {
  if (!line.includes('hook/')) continue;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }
  const blob = JSON.stringify(record);
  if (!blob.includes('hook/invoked') && !blob.includes('hook/result')) continue;
  hookRecords.push(record);
  const kind = blob.includes('hook/invoked') ? 'hook/invoked' : 'hook/result';
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  const point = record?.event?.point ?? record?.point ?? record?.data?.point;
  if (point) points.set(point, (points.get(point) ?? 0) + 1);
}

console.log('--- hook bridge activity ---');
for (const [kind, count] of kinds) console.log(`${kind}: ${count}`);
if (points.size > 0) {
  console.log('\nby hook point:');
  for (const [point, count] of [...points].sort()) console.log(`  ${point}: ${count}`);
}

if (hookRecords.length === 0) {
  console.log('\nNo hook/* records. The bridge appends these only inside an open turn,');
  console.log('so a session with no tool call at a hook point shows none.');
} else {
  console.log('\nlast 3 records:');
  for (const record of hookRecords.slice(-3)) {
    console.log(JSON.stringify(record).slice(0, 500));
    console.log('');
  }
}
