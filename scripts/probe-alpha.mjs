#!/usr/bin/env node
/**
 * Compare the harness packages this plugin depends on across two DSH versions.
 *
 * "Adapt for the latest alpha" is only answerable by diffing the *contracts*
 * the plugin consumes — the skill-provider service, the Claude Code hook bridge,
 * the agent-preset schema, and the persona schema. A version bump alone says
 * nothing; an unchanged contract means nothing to adapt, and a changed one names
 * exactly what to fix.
 *
 * Usage: node scripts/probe-alpha.mjs <from-version> <to-version> [package...]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';

const from = process.argv[2] ?? '0.2.0-rc.2';
const to = process.argv[3] ?? '0.2.1-alpha.2';
const packages = process.argv.slice(4);
const DEFAULT_PACKAGES = [
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-hooks-claude-code',
  '@deepseek-ai/dsh-agent-preset',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/cordis',
];

const targets = packages.length > 0 ? packages : DEFAULT_PACKAGES;
const scratch = mkdtempSync(join(tmpdir(), 'dsh-alpha-'));

/**
 * npm's CLI entry, invoked through the running Node rather than by name.
 *
 * `execFileSync('npm', …)` fails with ENOENT on Windows unless a shell resolves
 * the `.cmd` shim, and going through a shell would mean quoting every argument.
 * Running npm's own JS with the current interpreter avoids both.
 */
function npmPack(spec, dest) {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = ['pack', spec, '--pack-destination', dest];
  const output = existsSync(cli)
    ? execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  return output;
}

/** Fetch a package tarball and return its extracted root. */
function fetchPackage(spec) {
  const dir = join(scratch, spec.replace(/[@/]/g, '_'));
  mkdirSync(dir, { recursive: true });
  // npm treats the destination as a project, so it needs a manifest.
  writeFileSync(join(dir, 'package.json'), '{"name":"probe","private":true}');
  const name = npmPack(spec, dir)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.tgz'))
    .pop();
  if (!name) throw new Error(`npm pack produced no tarball for ${spec}`);
  const out = join(dir, 'x');
  mkdirSync(out, { recursive: true });
  execFileSync('tar', ['-xzf', join(dir, name), '-C', out], { stdio: 'ignore' });
  return join(out, 'package');
}

/** Every file under a root, as relative POSIX paths. */
function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(relative(root, full).replaceAll('\\', '/'));
    }
  };
  visit(root);
  return out.sort();
}

/** Compare the type declarations and READMEs, which state the contract. */
function diffContract(oldRoot, newRoot) {
  const oldFiles = walk(oldRoot);
  const newFiles = walk(newRoot);
  const onlyOld = oldFiles.filter((f) => !newFiles.includes(f));
  const onlyNew = newFiles.filter((f) => !oldFiles.includes(f));

  const changed = [];
  for (const rel of oldFiles.filter((f) => newFiles.includes(f))) {
    // Declaration files and docs describe the contract; implementation diffs are
    // noise here.
    if (!/\.(d\.ts|md|json)$/.test(rel)) continue;
    if (rel === 'package.json') continue;
    const a = readFileSync(join(oldRoot, rel), 'utf8');
    const b = readFileSync(join(newRoot, rel), 'utf8');
    if (a !== b) changed.push(rel);
  }
  return { onlyOld, onlyNew, changed };
}

console.log(`comparing ${from} -> ${to}\n`);

for (const pkg of targets) {
  const label = pkg.replace('@deepseek-ai/', '');
  process.stdout.write(`${label}\n`);
  let oldRoot;
  let newRoot;
  try {
    oldRoot = fetchPackage(`${pkg}@${from}`);
  } catch (error) {
    console.log(`  cannot fetch ${from}: ${String(error.message).slice(0, 80)}\n`);
    continue;
  }
  try {
    newRoot = fetchPackage(`${pkg}@${to}`);
  } catch (error) {
    console.log(`  not published at ${to}: ${String(error.message).slice(0, 80)}\n`);
    continue;
  }

  const oldVersion = JSON.parse(readFileSync(join(oldRoot, 'package.json'), 'utf8')).version;
  const newVersion = JSON.parse(readFileSync(join(newRoot, 'package.json'), 'utf8')).version;
  console.log(`  versions: ${oldVersion} -> ${newVersion}`);

  const { onlyOld, onlyNew, changed } = diffContract(oldRoot, newRoot);
  console.log(`  removed files: ${onlyOld.length === 0 ? '(none)' : onlyOld.join(', ')}`);
  console.log(`  added files  : ${onlyNew.length === 0 ? '(none)' : onlyNew.join(', ')}`);
  console.log(`  changed docs/types: ${changed.length === 0 ? '(none — contract unchanged)' : changed.join(', ')}`);
  console.log('');
}

rmSync(scratch, { recursive: true, force: true });
