#!/usr/bin/env node
/**
 * Publish this repository's committed files through the GitHub Git Data API.
 *
 * Why not `git push`: on the authoring host git's smart-HTTP upload stalls
 * indefinitely while `api.github.com` answers in under half a second, so the
 * API is the working transport. This is a normal, supported publishing path —
 * it is not a workaround that changes the repository's content.
 *
 * Efficiency: the Trees API accepts inline `content` for each entry, so the
 * whole tree is created in ONE request instead of one blob request per file.
 *
 * The token is read from GH_TOKEN and is never printed.
 *
 * Usage: GH_TOKEN=<token> node scripts/gh-publish.mjs <owner>/<repo> [ref] [--message "..."]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('GH_TOKEN is not set');
  process.exit(2);
}

const full = process.argv[2];
if (!full || !full.includes('/')) {
  console.error('usage: node gh-publish.mjs <owner>/<repo> [ref] [--message "..."]');
  process.exit(2);
}
const [owner, repo] = full.split('/');
const refIndex = process.argv.indexOf('--message');
const branch = process.argv[3] && process.argv[3] !== '--message' ? process.argv[3] : 'main';
const message =
  refIndex !== -1 && process.argv[refIndex + 1]
    ? process.argv[refIndex + 1]
    : 'Publish dsh-everything-claude-code';

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-everything-claude-code',
  'content-type': 'application/json; charset=utf-8',
};

/** JSON request with the body encoded as UTF-8 bytes (never as a JS string). */
async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body), 'utf8') }),
  });
  let parsed = null;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** Files tracked by git, in a stable order. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: packageRoot, encoding: 'utf8' });
  return out.split('\0').filter(Boolean).sort();
}

/** Refuse anything that is not plain text: the inline-content path needs UTF-8. */
function readTextFile(rel) {
  const buf = readFileSync(join(packageRoot, rel));
  const text = buf.toString('utf8');
  if (Buffer.from(text, 'utf8').length !== buf.length || text.includes('\u0000')) {
    throw new Error(`"${rel}" is not UTF-8 text; it needs a blob upload instead`);
  }
  return text;
}

const files = trackedFiles();
if (files.length === 0) {
  console.error('no tracked files; commit first');
  process.exit(1);
}

console.log(`repository : ${owner}/${repo}`);
console.log(`branch     : ${branch}`);
console.log(`files      : ${files.length}`);

// 1. Build the tree with every file's content inline.
const tree = files.map((path) => ({
  path,
  mode: '100644',
  type: 'blob',
  content: readTextFile(path),
}));

// 2. Detect whether the branch already exists, so a re-run appends rather than
//    failing on an existing ref. A repository with no commits answers 409
//    ("Git Repository is empty"), which is the fresh-publish case, not an error.
const refPath = `/repos/${owner}/${repo}/git/ref/heads/${branch}`;
const existingRef = await api('GET', refPath);
let parentCommit = null;
let baseTree = null;
if (existingRef.status === 200) {
  parentCommit = existingRef.body.object.sha;
  console.log(`existing   : ${branch} at ${parentCommit.slice(0, 7)}`);
  const parent = await api('GET', `/repos/${owner}/${repo}/git/commits/${parentCommit}`);
  if (parent.status === 200) baseTree = parent.body.tree.sha;
} else if (existingRef.status === 404) {
  console.log('existing   : none (fresh branch)');
} else if (existingRef.status === 409) {
  // A repository with no commits rejects the Trees API with 409 until it has
  // one commit. The Contents API bootstraps that first commit (and the branch)
  // in a single request, after which the tree path applies normally.
  console.log('existing   : none (bootstrapping the first commit)');
  const seedPath = '.gitignore';
  const seedContent = readTextFile(seedPath);
  const seed = await api('PUT', `/repos/${owner}/${repo}/contents/${seedPath}`, {
    message: 'chore: initialize repository',
    content: Buffer.from(seedContent, 'utf8').toString('base64'),
    branch,
  });
  if (seed.status !== 201) {
    console.error(`bootstrap failed: ${seed.status} ${JSON.stringify(seed.body).slice(0, 300)}`);
    process.exit(1);
  }
  parentCommit = seed.body.commit.sha;
  baseTree = seed.body.commit.tree.sha;
  console.log(`bootstrap  : ${parentCommit.slice(0, 7)} (${seedPath})`);
} else {
  console.error(`cannot read ref: ${existingRef.status} ${JSON.stringify(existingRef.body).slice(0, 200)}`);
  process.exit(1);
}

// 3. Create the tree.
const treeRes = await api('POST', `/repos/${owner}/${repo}/git/trees`, {
  ...(baseTree ? { base_tree: baseTree } : {}),
  tree,
});
if (treeRes.status !== 201) {
  console.error(`tree failed: ${treeRes.status} ${JSON.stringify(treeRes.body).slice(0, 300)}`);
  process.exit(1);
}
console.log(`tree       : ${treeRes.body.sha.slice(0, 7)}`);

// 4. Create the commit.
const commitRes = await api('POST', `/repos/${owner}/${repo}/git/commits`, {
  message,
  tree: treeRes.body.sha,
  ...(parentCommit ? { parents: [parentCommit] } : {}),
});
if (commitRes.status !== 201) {
  console.error(`commit failed: ${commitRes.status} ${JSON.stringify(commitRes.body).slice(0, 300)}`);
  process.exit(1);
}
console.log(`commit     : ${commitRes.body.sha.slice(0, 7)}`);

// 5. Point the branch at it.
//
// GitHub's ref routes are asymmetric: reading one ref uses `/git/ref/{ref}`
// (singular) while updating it uses `/git/refs/{ref}` (plural). Using the
// singular form for PATCH returns 404 even when the ref exists.
const refRes = parentCommit
  ? await api('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      sha: commitRes.body.sha,
      force: false,
    })
  : await api('POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commitRes.body.sha,
    });
if (refRes.status !== 200 && refRes.status !== 201) {
  console.error(`ref failed: ${refRes.status} ${JSON.stringify(refRes.body).slice(0, 300)}`);
  process.exit(1);
}
console.log(`ref        : ${refRes.body.ref ?? `refs/heads/${branch}`}`);
console.log(`\npublished: https://github.com/${owner}/${repo}/tree/${branch}`);
