#!/usr/bin/env node
/**
 * Print the exact type diff for one package between two DSH versions.
 *
 * `probe-alpha.mjs` reports *that* a declaration changed; this reports *what*
 * changed, which is what a fix is written against.
 *
 * Usage: node scripts/probe-alpha-diff.mjs <pkg> <from> <to> [file]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const [pkg, from, to, only] = process.argv.slice(2);
if (!pkg || !from || !to) {
  console.error('usage: node scripts/probe-alpha-diff.mjs <pkg> <from> <to> [relative-file]');
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-diff-'));

function npmPack(spec, dest) {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = ['pack', spec, '--pack-destination', dest];
  return existsSync(cli)
    ? execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });
}

function fetchPackage(spec) {
  const dir = join(scratch, spec.replace(/[@/]/g, '_'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"probe","private":true}');
  const name = npmPack(spec, dir)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.tgz'))
    .pop();
  const out = join(dir, 'x');
  mkdirSync(out, { recursive: true });
  execFileSync('tar', ['-xzf', join(dir, name), '-C', out], { stdio: 'ignore' });
  return join(out, 'package');
}

const oldRoot = fetchPackage(`${pkg}@${from}`);
const newRoot = fetchPackage(`${pkg}@${to}`);
const target = only ?? 'lib/types/index.d.ts';

const a = readFileSync(join(oldRoot, target), 'utf8').split(/\r?\n/);
const b = readFileSync(join(newRoot, target), 'utf8').split(/\r?\n/);

console.log(`${pkg}`);
console.log(`${target}`);
console.log(`  ${from} -> ${to}\n`);

// A simple LCS-free diff is enough for a declaration file: report removals and
// additions separately, which is what an API change looks like.
const setB = new Set(b);
const setA = new Set(a);
const removed = a.filter((line) => !setB.has(line));
const added = b.filter((line) => !setA.has(line));

if (removed.length === 0 && added.length === 0) {
  console.log('  identical');
} else {
  if (removed.length > 0) {
    console.log(`  REMOVED (${removed.length}):`);
    for (const line of removed) console.log(`    - ${line.trim()}`);
  }
  if (added.length > 0) {
    console.log(`\n  ADDED (${added.length}):`);
    for (const line of added) console.log(`    + ${line.trim()}`);
  }
}

rmSync(scratch, { recursive: true, force: true });
