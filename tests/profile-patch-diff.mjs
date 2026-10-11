#!/usr/bin/env node
/**
 * Compare the rows in the profile patch against its backups.
 *
 * The profile patch is the last composition layer. Rows the user or an
 * integration pack added can disappear when something rewrites that file, and a
 * dropped row is silent: the feature it configured simply stops existing.
 *
 * This reports which row ids were lost, so a rewrite cannot pass unnoticed.
 *
 * Usage: node tests/profile-patch-diff.mjs <profile-dir>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const profileDir = process.argv[2];
if (!profileDir || !existsSync(profileDir)) {
  console.error('usage: node profile-patch-diff.mjs <profile-dir>');
  process.exit(2);
}

/** Every `- id: X` row in a patch file, in file order. */
function rowIds(text) {
  return text
    .split(/\r?\n/)
    .map((l) => /^-\s*id:\s*(.+?)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].replace(/^["']|["']$/g, ''));
}

const files = readdirSync(profileDir)
  .filter((n) => n === 'cordis.patch.yml' || n.startsWith('cordis.patch.yml'))
  .map((n) => ({ name: n, path: join(profileDir, n) }));

if (files.length === 0) {
  console.error('no cordis.patch.yml found in', profileDir);
  process.exit(1);
}

const parsed = files.map((f) => {
  const text = readFileSync(f.path, 'utf8');
  return { ...f, text, ids: rowIds(text), bytes: Buffer.byteLength(text, 'utf8') };
});

const current = parsed.find((p) => p.name === 'cordis.patch.yml');
console.log(`current: ${current.name}  (${current.bytes} B, ${current.ids.length} rows)\n`);

console.log('row ids in the CURRENT patch:');
for (const id of current.ids) console.log(`  ${id}`);
console.log('');

let lostAny = false;
for (const backup of parsed.filter((p) => p.name !== 'cordis.patch.yml')) {
  const lost = backup.ids.filter((id) => !current.ids.includes(id));
  const added = current.ids.filter((id) => !backup.ids.includes(id));
  console.log(`--- ${backup.name}  (${backup.bytes} B, ${backup.ids.length} rows) ---`);
  console.log(`  rows present there but MISSING now: ${lost.length}`);
  for (const id of lost) console.log(`     - ${id}`);
  if (added.length > 0) console.log(`  rows added since: ${added.join(', ')}`);
  console.log('');
  if (lost.length > 0) lostAny = true;
}

console.log('--- verdict ---');
if (lostAny) {
  console.log('Rows from a backup are absent from the current patch.');
  console.log('Check whether each was removed on purpose before restoring it.');
} else {
  console.log('The current patch still carries every row its backups had.');
}
