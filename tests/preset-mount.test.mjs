#!/usr/bin/env node
/**
 * Verify the agent preset would actually MOUNT.
 *
 * A preset row can be registered and still fail to mount: every child row names
 * a package the Loader must resolve, and one unresolvable name fails the whole
 * preset. The registry then reports it as `broken` and the preset never appears
 * in the session picker — a silent failure, because a declaration that cannot
 * activate is not a startup error.
 *
 * This resolves each child `name` the way the Loader does: from the profile's
 * node_modules first, then from the dsh installation's.
 *
 * Usage: node tests/preset-mount.test.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const presetPath = join(packageRoot, 'presets', 'everything-claude-code.patch.yml');

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push({ name, ok: true, note });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Pull every child row from the preset's `plugins:` tree.
 *
 * A child row is a `- id: X` line followed by its `name:` line. Nesting is
 * irrelevant here: `cordis:group` rows hold children at a deeper indent, and
 * every one of them still needs to resolve.
 */
function parseChildRows(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === 'plugins:');
  if (start === -1) throw new Error('no plugins: key found');
  const rows = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (line.length - line.trimStart().length === 0) break;
    const idMatch = /^- id:\s*(.+)$/.exec(trimmed);
    const nameMatch = /^name:\s*'?([^']+)'?$/.exec(trimmed);
    if (idMatch) {
      if (current) rows.push(current);
      current = { id: idMatch[1].trim(), name: undefined };
    } else if (nameMatch && current && current.name === undefined) {
      current.name = nameMatch[1].trim();
    }
  }
  if (current) rows.push(current);
  return rows;
}

const presetText = readFileSync(presetPath, 'utf8');
const rows = parseChildRows(presetText);

/** Directories a package name may resolve from, in Loader order. */
function resolutionRoots() {
  const roots = [];
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (profileDir) roots.push({ label: 'profile', dir: join(profileDir, 'node_modules') });
  if (process.env.APPDATA) {
    const versions = join(process.env.APPDATA, 'DSH', 'data', 'versions');
    if (existsSync(versions)) {
      for (const version of readdirSync(versions)) {
        roots.push({ label: `install/${version}`, dir: join(versions, version, 'node_modules') });
      }
    }
  }
  if (process.env.LOCALAPPDATA) {
    roots.push({
      label: 'app.asar',
      dir: join(
        process.env.LOCALAPPDATA,
        'Programs',
        'DeepSeek Harness',
        'resources',
        'app.asar',
        'dsh',
        'node_modules',
      ),
    });
  }
  return roots;
}

const roots = resolutionRoots();

/** Resolve a package name to the root that provides it, or null. */
function resolves(name) {
  const rel = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
  for (const root of roots) {
    if (existsSync(join(root.dir, rel))) return root.label;
  }
  return null;
}

check('the resolver found at least one package root', () => {
  assert(roots.length > 0, 'no resolution roots; cannot verify mounting');
  return roots.map((r) => r.label).join(', ');
});

check('the preset declares child rows', () => {
  assert(rows.length > 0, 'no child rows parsed');
  return `${rows.length} rows`;
});

check('every child row has both an id and a name', () => {
  for (const row of rows) {
    assert(row.id, 'a row has no id');
    assert(row.name, `row "${row.id}" has no name`);
  }
});

check('every child package resolves from the profile or the installation', () => {
  const missing = [];
  for (const row of rows) {
    // `cordis:group` and other `cordis:` names are Loader built-ins, not npm
    // packages, so there is nothing on disk to resolve.
    if (row.name.startsWith('cordis:')) continue;
    if (!resolves(row.name)) missing.push(`${row.id} -> ${row.name}`);
  }
  assert(missing.length === 0, `unresolvable child rows:\n      ${missing.join('\n      ')}`);
});

check('child row ids are unique', () => {
  const seen = new Set();
  for (const row of rows) {
    assert(!seen.has(row.id), `duplicate id "${row.id}"`);
    seen.add(row.id);
  }
});

check('the persona row is present and resolves', () => {
  const persona = rows.find((r) => r.id === 'persona');
  assert(persona, 'no persona row; the preset would not set an identity');
  assert(persona.name === '@deepseek-ai/dsh-persona', `persona name is ${persona.name}`);
});

check('the skill rows the preset promises are present', () => {
  const ids = rows.map((r) => r.id);
  for (const required of ['skill-filesystem', 'tool-skill']) {
    assert(ids.includes(required), `missing "${required}"`);
  }
});

check('every name is an official package or the cordis group marker', () => {
  for (const row of rows) {
    assert(
      row.name.startsWith('@deepseek-ai/') || row.name.startsWith('cordis:'),
      `unexpected namespace for "${row.id}": ${row.name}`,
    );
  }
});

check('every skill the persona tells the model to load actually exists', () => {
  // Only the persona's own prose counts. Scanning the whole file would also
  // match row ids and comments, which are not instructions to the model.
  const prefixBlock = /^\s*prefix:\s*\|\n([\s\S]*?)(?=\n\s{0,20}\S+:|\n\s*-\s*id:)/m.exec(presetText);
  assert(prefixBlock, 'could not locate the persona prefix block');
  const promptSkills = [...new Set([...prefixBlock[1].matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)].map((m) => m[1]))];
  assert(promptSkills.length > 0, 'the persona names no skills');
  const missing = promptSkills.filter((n) => !existsSync(join(packageRoot, 'skills', n, 'SKILL.md')));
  assert(missing.length === 0, `persona names skills that do not exist: ${missing.join(', ')}`);
  return `${promptSkills.length} names, all present`;
});

for (const r of results) {
  const suffix = r.note ? `  (${r.note})` : '';
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${suffix}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} preset-mount checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
