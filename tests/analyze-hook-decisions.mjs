#!/usr/bin/env node
/**
 * Report the decision distribution of hook-bridge records in a session log,
 * then replay the PreToolUse decisions against the hook scripts on disk.
 *
 * Usage: node tests/analyze-hook-decisions.mjs <session-dir-or-file>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function frameOffsets(buffer) {
  const offsets = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i);
  }
  return offsets;
}

function decodeAllFrames(buffer) {
  const offsets = frameOffsets(buffer);
  const parts = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'));
    } catch {
      /* partial trailing frame */
    }
  }
  return parts.join('');
}

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

const target = resolveTarget(process.argv[2]);
const text = decodeAllFrames(readFileSync(target));
const records = [];
for (const line of text.split('\n')) {
  if (!line.includes('hook/')) continue;
  try {
    const record = JSON.parse(line);
    if (record.type === 'hook/result' || record.type === 'hook/invoked') records.push(record);
  } catch {
    /* not JSON */
  }
}

const results = records.filter((r) => r.type === 'hook/result');
const invoked = records.filter((r) => r.type === 'hook/invoked');

console.log(`results: ${results.length}, invocations: ${invoked.length}\n`);

const decisions = new Map();
const exits = new Map();
for (const r of results) {
  const d = r.data?.decision ?? '(absent)';
  decisions.set(d, (decisions.get(d) ?? 0) + 1);
  const e = r.data?.exitCode ?? '(absent)';
  exits.set(e, (exits.get(e) ?? 0) + 1);
}

console.log('decision distribution:');
for (const [k, v] of [...decisions].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log('\nexitCode distribution:');
for (const [k, v] of [...exits].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

// Which matchers actually fired?
const matchers = new Map();
for (const r of invoked) {
  const m = r.data?.matcher ?? '(none)';
  matchers.set(m, (matchers.get(m) ?? 0) + 1);
}
console.log('\ninvocation matchers:');
for (const [k, v] of [...matchers].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

// Show the non-pass results with their stderr, which is where a block lives.
const interesting = results.filter((r) => r.data?.decision && r.data.decision !== 'pass');
console.log(`\nnon-pass results: ${interesting.length}`);
for (const r of interesting.slice(0, 15)) {
  console.log(`  seq=${r.seq} point=${r.data.point} decision=${r.data.decision} exit=${r.data.exitCode}`);
  if (r.data.stderrSummary) console.log(`    stderr: ${String(r.data.stderrSummary).slice(0, 200).replace(/\n/g, ' | ')}`);
}
