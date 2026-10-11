#!/usr/bin/env node
/**
 * Duplicate check against the awesome list, by filename.
 *
 * 4489 entry files exist; fetching each one to grep its description is far too
 * slow and would hammer the API. Entry filenames encode owner and repo
 * (`owner__repo.yml`), so a name-pattern scan answers the duplicate question
 * directly: is there already an entry for this repo, or a near-name neighbour?
 *
 * Usage: GH_TOKEN=<token> node scripts/awesome-dupcheck.mjs
 */
const token = process.env.GH_TOKEN;
const LIST = 'awesome-dsh-plugin/awesome-dsh-plugin';

const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-everything-claude-code',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

const repoInfo = await (await fetch(`https://api.github.com/repos/${LIST}`, { headers })).json();
const tree = await (
  await fetch(`https://api.github.com/repos/${LIST}/git/trees/${repoInfo.default_branch}?recursive=1`, { headers })
).json();

const entries = tree.tree
  .filter((e) => e.type === 'blob' && e.path.startsWith('data/plugins/') && e.path.endsWith('.yml'))
  .map((e) => e.path.replace('data/plugins/', '').replace(/\.yml$/, ''));

console.log(`entry files: ${entries.length}\n`);

/** Report a pattern hit, so an exact duplicate is distinguishable from a neighbour. */
function report(label, pattern) {
  const hits = entries.filter((name) => pattern.test(name));
  console.log(`${label}: ${hits.length}`);
  for (const h of hits) console.log(`   ${h}`);
  console.log('');
  return hits;
}

const exact = report('exact repo (denceee__dsh-everything-claude-code)', /^denceee__dsh-everything-claude-code$/);
report('any owner with "everything-claude-code"', /everything-claude-code/i);
report('any "everything" in the name', /everything/i);
report('any "claude-code" in the name', /claude-code/i);
report('any "claude" in the name', /claude/i);

console.log('--- verdict ---');
if (exact.length > 0) {
  console.log('DUPLICATE: this repo already has an entry.');
} else {
  console.log('no existing entry for this repo.');
}
