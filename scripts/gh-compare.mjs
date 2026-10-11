#!/usr/bin/env node
/**
 * Compare the local working tree against the published GitHub tree.
 *
 * Why this exists: this repository is published through the Git Data API rather
 * than `git push`, so the remote commits are API-generated and carry different
 * SHAs than the local ones. That makes `git status` useless as a "is it pushed?"
 * check — it only compares against the local remote-tracking ref. The real
 * question is whether the published *content* matches the working tree, and only
 * a per-file digest comparison answers it.
 *
 * Usage: GH_TOKEN=<token> node scripts/gh-compare.mjs [owner/repo] [branch]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const token = process.env.GH_TOKEN;
const repo = process.argv[2] ?? 'denceee/dsh-everything-claude-code';
const branch = process.argv[3] ?? 'main';

const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-everything-claude-code',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

/** Git's blob hash: sha1("blob <len>\0" + content), which is what the API reports. */
function gitBlobHash(buffer) {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`, 'utf8'), buffer]))
    .digest('hex');
}

/** Every tracked file with its git blob hash. */
function localFiles() {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: packageRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const map = new Map();
  for (const p of paths) {
    const full = join(packageRoot, p);
    if (!existsSync(full)) continue;
    map.set(p, gitBlobHash(readFileSync(full)));
  }
  return map;
}

const local = localFiles();

const treeRes = await fetch(
  `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
  { headers },
);
if (!treeRes.ok) {
  console.error(`cannot read the remote tree: ${treeRes.status}`);
  process.exit(1);
}
const tree = await treeRes.json();
if (tree.truncated) console.log('warning: the remote tree listing was truncated\n');

const remote = new Map(tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));

console.log(`repo      : ${repo}@${branch}`);
console.log(`local     : ${local.size} tracked file(s)`);
console.log(`remote    : ${remote.size} blob(s)\n`);

const onlyLocal = [...local.keys()].filter((p) => !remote.has(p)).sort();
const onlyRemote = [...remote.keys()].filter((p) => !local.has(p)).sort();
const differing = [...local.keys()]
  .filter((p) => remote.has(p) && remote.get(p) !== local.get(p))
  .sort();

console.log(`only local  : ${onlyLocal.length}`);
for (const p of onlyLocal.slice(0, 20)) console.log(`   + ${p}`);
console.log(`only remote : ${onlyRemote.length}`);
for (const p of onlyRemote.slice(0, 20)) console.log(`   - ${p}`);
console.log(`different   : ${differing.length}`);
for (const p of differing.slice(0, 20)) console.log(`   ~ ${p}`);

const inSync = onlyLocal.length === 0 && onlyRemote.length === 0 && differing.length === 0;
console.log(`\n--- verdict ---`);
console.log(inSync ? 'IN SYNC: the published content matches the working tree.' : 'OUT OF SYNC: publish to update the remote.');
process.exit(inSync ? 0 : 1);
