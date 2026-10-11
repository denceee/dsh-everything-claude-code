#!/usr/bin/env node
/**
 * Survey how the awesome list categorizes entries similar to this one.
 *
 * Choosing a category is a content decision that should follow the list's own
 * precedent, not a guess. This scans entries whose description mentions
 * skills/presets/ports and reports the category distribution, so the choice is
 * grounded in how comparable plugins were actually filed.
 *
 * Usage: GH_TOKEN=<token> node scripts/awesome-survey.mjs
 */
const token = process.env.GH_TOKEN;
const LIST = 'awesome-dsh-plugin/awesome-dsh-plugin';

const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-everything-claude-code',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

const info = await (await fetch(`https://api.github.com/repos/${LIST}`, { headers })).json();
const tree = await (
  await fetch(`https://api.github.com/repos/${LIST}/git/trees/${info.default_branch}?recursive=1`, { headers })
).json();
const paths = tree.tree
  .filter((e) => e.type === 'blob' && e.path.startsWith('data/plugins/') && e.path.endsWith('.yml'))
  .map((e) => e.path);

// A deterministic, spread sample: the API is rate-limited and a full scan of
// 4489 files is unnecessary to read a category convention.
const stride = Math.ceil(paths.length / 240);
const sample = paths.filter((_, i) => i % stride === 0);
console.log(`surveying ${sample.length} of ${paths.length} entries (stride ${stride})\n`);

const categories = new Map();
const interesting = [];

for (const path of sample) {
  const res = await fetch(`https://api.github.com/repos/${LIST}/contents/${path}`, { headers });
  if (!res.ok) continue;
  const body = await res.json();
  if (body.encoding !== 'base64') continue;
  const text = Buffer.from(body.content.replace(/\n/g, ''), 'base64').toString('utf8');

  const category = /^category:\s*(\S+)/m.exec(text)?.[1];
  if (category) categories.set(category, (categories.get(category) ?? 0) + 1);

  if (/skills?|preset|everything|port(ed)?\b|bundle of|collection of/i.test(text)) {
    interesting.push({ path: path.replace('data/plugins/', ''), category, text });
  }
}

console.log('--- category distribution (sample) ---');
for (const [cat, n] of [...categories].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${cat}`);
}

console.log(`\n--- entries mentioning skills/preset/collection: ${interesting.length} ---`);
for (const item of interesting.slice(0, 12)) {
  const en = /en:\s*'?([^'\n]{0,160})/.exec(item.text)?.[1] ?? '';
  console.log(`  [${item.category}] ${item.path}`);
  console.log(`      ${en}`);
}
