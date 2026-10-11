#!/usr/bin/env node
/**
 * Read a whole directory tree through the GitHub API, without downloading the
 * rendered README (which the contents API refuses above ~1 MB).
 *
 * Usage: GH_TOKEN=<token> node scripts/gh-tree.mjs <owner>/<repo> [pathPrefix] [--grep <text>]
 */
const token = process.env.GH_TOKEN;
const full = process.argv[2];
const prefix = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
const grepIndex = process.argv.indexOf('--grep');
const needle = grepIndex === -1 ? null : process.argv[grepIndex + 1];

const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-everything-claude-code',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  const body = await res.json();
  if (!res.ok) {
    console.error(`${path} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    process.exit(1);
  }
  return body;
}

const repoInfo = await api(`/repos/${full}`);
const tree = await api(`/repos/${full}/git/trees/${repoInfo.default_branch}?recursive=1`);

let paths = tree.tree.filter((e) => e.type === 'blob').map((e) => e.path);
if (prefix) paths = paths.filter((p) => p.startsWith(prefix));

console.log(`${full}@${repoInfo.default_branch}: ${paths.length} file(s)${prefix ? ` under ${prefix}` : ''}`);
if (tree.truncated) console.log('(warning: tree truncated by the API)');

if (!needle) {
  for (const p of paths.slice(0, 200)) console.log(`  ${p}`);
  process.exit(0);
}

// Grep mode: fetch each matching small text file and search it.
const hits = [];
for (const p of paths) {
  const res = await fetch(`https://api.github.com/repos/${full}/contents/${p}`, { headers });
  if (!res.ok) continue;
  const body = await res.json();
  if (body.encoding !== 'base64' || (body.size ?? 0) > 200000) continue;
  const text = Buffer.from(body.content.replace(/\n/g, ''), 'base64').toString('utf8');
  if (new RegExp(needle, 'i').test(text)) hits.push(p);
}
console.log(`\nfiles matching /${needle}/i: ${hits.length}`);
for (const p of hits.slice(0, 60)) console.log(`  ${p}`);
