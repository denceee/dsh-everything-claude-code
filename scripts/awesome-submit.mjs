#!/usr/bin/env node
/**
 * Prepare the awesome-dsh-plugin submission: fork, entry file, branch.
 *
 * The list keeps one YAML file per plugin under `data/plugins/`, named
 * `<owner>__<repo>.yml`. Its READMEs are generated, so the entry file is the
 * whole submission and nothing else should be edited.
 *
 * This script stops before opening the pull request, so the PR can be opened
 * deliberately (repository age is gated by CI — see the caller).
 *
 * The token comes from GH_TOKEN and is never printed.
 *
 * Usage: GH_TOKEN=<token> node scripts/awesome-submit.mjs [--pr]
 */
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('GH_TOKEN is not set');
  process.exit(2);
}

const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin';
const OWNER = 'denceee';
const FORK = `${OWNER}/awesome-dsh-plugin`;
const PLUGIN_REPO = `${OWNER}/dsh-everything-claude-code`;
const ENTRY_PATH = 'data/plugins/denceee__dsh-everything-claude-code.yml';
const BRANCH = 'add-dsh-everything-claude-code';
const openPr = process.argv.includes('--pr');

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-everything-claude-code',
  'content-type': 'application/json; charset=utf-8',
};

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

// The entry. `category` follows the list's own precedent: other bundles whose
// payload is a set of agent skills are filed under `skill` (for example
// PerryLink/dsh-skill-pack-security). Every claim here is checkable in the
// plugin repository, and the guide checks them.
//
// `en` is quoted because it contains ": ", which YAML would otherwise read as
// a nested key.
const entry = `url: https://github.com/${PLUGIN_REPO}
name: ${PLUGIN_REPO}
category: skill
description:
  en: 'Ports everything-claude-code to DeepSeek Harness as 11 registered skills, an "Everything Claude Code" agent preset, adapted Claude Code hooks, and a Settings page.'
  zh: '把 everything-claude-code 移植到 DeepSeek Harness：11 个已注册技能、一个「Everything Claude Code」Agent 预设、适配后的 Claude Code 钩子，以及一个设置页面。'
`;

console.log(`entry file : ${ENTRY_PATH}`);
console.log(`branch     : ${BRANCH}`);
console.log(`plugin repo: ${PLUGIN_REPO}\n`);

// 1. Fork (idempotent: an existing fork is reused).
let fork = await api('GET', `/repos/${FORK}`);
if (fork.status === 404) {
  console.log('forking…');
  const created = await api('POST', `/repos/${UPSTREAM}/forks`, { default_branch_only: true });
  if (created.status !== 202 && created.status !== 200) {
    console.error(`fork failed: ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
    process.exit(1);
  }
  // The fork is prepared asynchronously; poll until it is readable.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    fork = await api('GET', `/repos/${FORK}`);
    if (fork.status === 200) break;
  }
}
if (fork.status !== 200) {
  console.error(`fork not readable: ${fork.status}`);
  process.exit(1);
}
console.log(`fork       : ${fork.body.full_name} (parent ${fork.body.parent?.full_name ?? '?'})`);

// 2. Confirm the upstream file does not already exist (duplicate guard).
const existing = await api('GET', `/repos/${UPSTREAM}/contents/${ENTRY_PATH}`);
if (existing.status === 200) {
  console.error(`an entry already exists at ${ENTRY_PATH}; nothing to submit`);
  process.exit(1);
}
console.log('duplicate  : none upstream');

// 3. Create the branch explicitly.
//
// The Contents API does NOT create a missing branch: writing to an unknown
// `branch` fails with 404 "Branch ... not found". The ref must exist first, so
// it is created from the fork's default branch head.
const baseRef = await api('GET', `/repos/${FORK}/git/ref/heads/${fork.body.default_branch}`);
if (baseRef.status !== 200) {
  console.error(`cannot read the fork's base ref: ${baseRef.status}`);
  process.exit(1);
}
const existingBranch = await api('GET', `/repos/${FORK}/git/ref/heads/${BRANCH}`);
if (existingBranch.status === 200) {
  console.log(`branch     : ${BRANCH} already exists (reusing)`);
} else {
  const made = await api('POST', `/repos/${FORK}/git/refs`, {
    ref: `refs/heads/${BRANCH}`,
    sha: baseRef.body.object.sha,
  });
  if (made.status !== 201) {
    console.error(`branch creation failed: ${made.status} ${JSON.stringify(made.body).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`branch     : ${BRANCH} created at ${baseRef.body.object.sha.slice(0, 7)}`);
}

// 4. Put the entry on that branch.
const put = await api('PUT', `/repos/${FORK}/contents/${ENTRY_PATH}`, {
  message: `Add ${PLUGIN_REPO} to the list

Ports everything-claude-code to DeepSeek Harness as 11 skills, an agent preset,
adapted Claude Code hooks, and a Settings page.`,
  content: Buffer.from(entry, 'utf8').toString('base64'),
  branch: BRANCH,
});
if (put.status !== 201 && put.status !== 200) {
  console.error(`entry upload failed: ${put.status} ${JSON.stringify(put.body).slice(0, 300)}`);
  process.exit(1);
}
console.log(`entry      : committed (${put.body.commit.sha.slice(0, 7)})`);

// 5. Verify what actually landed, rather than trusting the write.
const check = await api('GET', `/repos/${FORK}/contents/${ENTRY_PATH}?ref=${BRANCH}`);
if (check.status !== 200) {
  console.error(`cannot read back the entry: ${check.status}`);
  process.exit(1);
}
const landed = Buffer.from(check.body.content.replace(/\n/g, ''), 'base64').toString('utf8');
console.log('\n--- entry on the branch ---');
console.log(landed);

// 6. Optionally open the pull request.
if (!openPr) {
  console.log('PR not opened (pass --pr to open it).');
  console.log(`compare: https://github.com/${UPSTREAM}/compare/main...${OWNER}:${BRANCH}?expand=1`);
  process.exit(0);
}

const pr = await api('POST', `/repos/${UPSTREAM}/pulls`, {
  title: `Add ${PLUGIN_REPO}`,
  head: `${OWNER}:${BRANCH}`,
  base: 'main',
  body: `Adds \`${ENTRY_PATH}\` — one entry, one file, nothing else touched.

**Plugin:** https://github.com/${PLUGIN_REPO}

**What it does.** Ports [everything-claude-code](https://github.com/WorldFlowAI/everything-claude-code)
(MIT) to DSH: 11 skills published through the runtime skill registry, an
"Everything Claude Code" agent preset carrying the ECC working agreement,
Claude Code hooks adapted for the DSH bridge, and a Settings page.

**Why \`skill\`.** The payload is a set of agent skills, matching how other
skill packs on the list are filed.

**Installable:** \`dsh.bundle.patch\` is declared in \`package.json\` and the
patch files are committed (no build step, no install scripts).

**Verified on** DSH \`0.2.0-rc.2\`, profile \`desktop\`: 79 checks across 6 test
suites, plus live evidence that the blocking hooks deny and the preset registers.

Two things the entry does **not** claim, because they are not true: ECC's
\`PreCompact\`/\`SessionEnd\` hooks are not ported (the bridge does not support
those events), and the \`Stop\` hook warns rather than blocks. Both are stated
in the repository's README under "Known limits".`,
});
if (pr.status !== 201) {
  console.error(`PR failed: ${pr.status} ${JSON.stringify(pr.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`\nPR opened: ${pr.body.html_url}`);
