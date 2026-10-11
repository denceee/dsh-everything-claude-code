#!/usr/bin/env node
/**
 * Create the GitHub repository if it does not exist, then report its state.
 *
 * Uses the REST API through Node's fetch so the JSON body is UTF-8 correct;
 * PowerShell's Invoke-RestMethod mangles non-ASCII bodies. The token comes from
 * the environment and is never written anywhere.
 *
 * Usage: GH_TOKEN=<token> node scripts/gh-create-repo.mjs <owner>/<repo> [description]
 */
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('GH_TOKEN is not set');
  process.exit(2);
}

const full = process.argv[2];
const description = process.argv[3] ?? '';
if (!full || !full.includes('/')) {
  console.error('usage: node gh-create-repo.mjs <owner>/<repo> [description]');
  process.exit(2);
}
const [owner, repo] = full.split('/');

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-everything-claude-code',
  'content-type': 'application/json; charset=utf-8',
};

/** Request helper that surfaces the status and parsed body. */
async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body), 'utf8') }),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: parsed };
}

// 1. Does it already exist?
const existing = await api('GET', `/repos/${owner}/${repo}`);
if (existing.status === 200) {
  console.log(`exists: ${existing.body.full_name}`);
  console.log(`url:    ${existing.body.html_url}`);
  console.log(`clone:  ${existing.body.clone_url}`);
  process.exit(0);
}
if (existing.status !== 404) {
  console.error(`unexpected status ${existing.status} while reading ${full}`);
  console.error(JSON.stringify(existing.body).slice(0, 300));
  process.exit(1);
}

// 2. Create it.
const created = await api('POST', '/user/repos', {
  name: repo,
  description,
  private: false,
  has_issues: true,
  has_wiki: false,
  has_projects: false,
  auto_init: false,
});
if (created.status !== 201) {
  console.error(`create failed: ${created.status}`);
  console.error(JSON.stringify(created.body).slice(0, 400));
  process.exit(1);
}
console.log(`created: ${created.body.full_name}`);
console.log(`url:     ${created.body.html_url}`);
console.log(`clone:   ${created.body.clone_url}`);
