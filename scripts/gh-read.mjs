#!/usr/bin/env node
/**
 * Read a repository's file listing and one file's text through the GitHub API.
 *
 * The web page for a GitHub blob renders through JavaScript, so fetching it
 * returns navigation chrome instead of the document. The contents API returns
 * the actual bytes.
 *
 * Usage: GH_TOKEN=<token> node scripts/gh-read.mjs <owner>/<repo> [path]
 */
const token = process.env.GH_TOKEN;
const full = process.argv[2];
const wanted = process.argv[3];

if (!full || !full.includes('/')) {
  console.error('usage: node gh-read.mjs <owner>/<repo> [path]');
  process.exit(2);
}

const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-everything-claude-code',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

/** Decode the contents API payload, which is base64 with embedded newlines. */
function decodeContent(entry) {
  if (entry.encoding !== 'base64') return entry.content ?? '';
  return Buffer.from(entry.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

if (!wanted) {
  const res = await fetch(`https://api.github.com/repos/${full}/contents/`, { headers });
  const body = await res.json();
  if (!res.ok) {
    console.error(`listing failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`files in ${full} (default branch):`);
  for (const entry of body) {
    console.log(`  ${entry.type === 'dir' ? 'd' : '-'} ${entry.name}  (${entry.size ?? 0} B)`);
  }
  process.exit(0);
}

const res = await fetch(`https://api.github.com/repos/${full}/contents/${wanted}`, { headers });
const body = await res.json();
if (!res.ok) {
  console.error(`read failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  process.exit(1);
}
console.log(decodeContent(body));
