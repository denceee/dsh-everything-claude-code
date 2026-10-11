#!/usr/bin/env node
/**
 * Set the repository topics and description.
 *
 * Topics drive discovery in GitHub search and in curated plugin lists, so they
 * are part of publishing rather than an afterthought. Names follow the DSH
 * ecosystem convention: `dsh`, `deepseek-harness`, `plugin`, plus function tags.
 *
 * The token comes from GH_TOKEN and is never printed.
 *
 * Usage: GH_TOKEN=<token> node scripts/gh-meta.mjs <owner>/<repo>
 */
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('GH_TOKEN is not set');
  process.exit(2);
}
const full = process.argv[2];
if (!full || !full.includes('/')) {
  console.error('usage: node gh-meta.mjs <owner>/<repo>');
  process.exit(2);
}
const [owner, repo] = full.split('/');

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-everything-claude-code',
  'content-type': 'application/json; charset=utf-8',
};

/** Topics must be lowercase, and GitHub caps 20 per repository. */
const TOPICS = [
  'dsh',
  'deepseek-harness',
  'plugin',
  'dsh-plugin',
  'claude-code',
  'everything-claude-code',
  'agent-preset',
  'skills',
  'hooks',
  'ai-agents',
  'developer-tools',
];

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body), 'utf8') }),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

const current = await api('GET', `/repos/${owner}/${repo}`);
if (current.status !== 200) {
  console.error(`cannot read repository: ${current.status}`);
  process.exit(1);
}

const topics = await api('PUT', `/repos/${owner}/${repo}/topics`, { names: TOPICS });
if (topics.status !== 200) {
  console.error(`topics failed: ${topics.status} ${JSON.stringify(topics.body).slice(0, 300)}`);
  process.exit(1);
}
console.log('topics:', (topics.body.names ?? []).join(', '));

const description = await api('PATCH', `/repos/${owner}/${repo}`, {
  description:
    'Adapts everything-claude-code to DeepSeek Harness: 11 skills, an ECC agent preset, ' +
    'adapted Claude Code hooks, and a Chinese Settings page.',
  homepage: '',
});
if (description.status !== 200) {
  console.error(`description failed: ${description.status} ${JSON.stringify(description.body).slice(0, 200)}`);
  process.exit(1);
}
console.log('description set');
console.log('url:', current.body.html_url);
