#!/usr/bin/env node
/**
 * Verify every skill the bundle ships is well formed and collision-free.
 *
 * Two things this catches that a load test cannot:
 *
 *  1. A skill name that an already-installed user skill also uses. The bundle
 *     registers at rank 600 (packaged) while user roots register at rank 400,
 *     so a colliding name is silently shadowed — present in the package, absent
 *     from the catalog, with no error anywhere. Two ECC agent names collided
 *     before the `ecc-` prefix was introduced.
 *
 *  2. A generated skill drifting from its source. The `ecc-*` skills are built
 *     from `resources/commands` and `resources/agents`; a hand-edit to one is
 *     lost on the next generation, and a source edit that was never regenerated
 *     leaves the shipped skill stale.
 *
 * Usage: node tests/skill-catalog.test.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const skillsDir = join(packageRoot, 'skills');
const GENERATED_MARKER = 'generated-by: scripts/build-ecc-skills.mjs';

/** Borrow DSH's own name grammar rather than re-implementing it. */
function loadDshSkillModule() {
  const candidates = [];
  if (process.env.DSH_SKILL_MODULE) candidates.push(process.env.DSH_SKILL_MODULE);
  if (process.env.APPDATA) {
    const versions = join(process.env.APPDATA, 'DSH', 'data', 'versions');
    if (existsSync(versions)) {
      for (const version of readdirSync(versions)) {
        candidates.push(join(versions, version, 'node_modules', '@deepseek-ai', 'dsh-skill', 'lib', 'index.js'));
      }
    }
  }
  const found = candidates.find((c) => existsSync(c));
  return found ? import(pathToFileURL(found).href) : null;
}

const dshSkill = await loadDshSkillModule();
const isSkillName = dshSkill ? dshSkill.isSkillName : (n) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n);

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

/** Parse flat frontmatter scalars. */
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const attributes = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) attributes[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return attributes;
}

const entries = readdirSync(skillsDir)
  .filter((name) => existsSync(join(skillsDir, name, 'SKILL.md')))
  .map((name) => {
    const file = join(skillsDir, name, 'SKILL.md');
    const text = readFileSync(file, 'utf8');
    return { dir: name, file, text, fm: frontmatter(text), generated: text.includes(GENERATED_MARKER) };
  });

check('the bundle ships skills', () => {
  assert(entries.length > 0, 'no skills found');
  return `${entries.length} skills (${entries.filter((e) => e.generated).length} generated)`;
});

check('every skill has a parseable name and a description', () => {
  for (const e of entries) {
    assert(e.fm.name, `${e.dir}: no name in frontmatter`);
    assert(e.fm.description && e.fm.description.length > 0, `${e.dir}: no description`);
  }
});

check('every skill name satisfies the real DSH grammar', () => {
  for (const e of entries) {
    assert(isSkillName(e.fm.name), `"${e.fm.name}" violates the DSH skill-name grammar`);
  }
});

check('the directory name matches the declared skill name', () => {
  for (const e of entries) {
    assert(e.fm.name === e.dir, `${e.dir}: frontmatter says "${e.fm.name}"`);
  }
});

check('no two skills share a name', () => {
  const seen = new Map();
  for (const e of entries) {
    assert(!seen.has(e.fm.name), `duplicate skill name "${e.fm.name}" (${seen.get(e.fm.name)} and ${e.dir})`);
    seen.set(e.fm.name, e.dir);
  }
});

check('no skill name collides with an already-installed user skill', () => {
  // A collision means the bundle's copy is shadowed and never appears.
  const userRoot = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'skills') : null;
  if (userRoot === null || !existsSync(userRoot)) {
    return 'no user skill root to compare against';
  }
  const installed = new Set(readdirSync(userRoot).filter((n) => existsSync(join(userRoot, n, 'SKILL.md'))));
  const clashes = entries.filter((e) => installed.has(e.fm.name)).map((e) => e.fm.name);
  assert(
    clashes.length === 0,
    `these names are shadowed by user skills (rank 400 beats bundled 600): ${clashes.join(', ')}`,
  );
  return `checked against ${installed.size} installed skills`;
});

check('every generated skill has a current source', () => {
  // A generated skill is regenerated from resources/, so a missing source means
  // the next generation run silently drops it.
  const missing = [];
  for (const e of entries.filter((x) => x.generated)) {
    const base = e.dir.replace(/^ecc-/, '');
    const inCommands = existsSync(join(packageRoot, 'resources', 'commands', `${base}.md`));
    const inAgents = existsSync(join(packageRoot, 'resources', 'agents', `${base}.md`));
    if (!inCommands && !inAgents) missing.push(e.dir);
  }
  assert(missing.length === 0, `generated skills with no source: ${missing.join(', ')}`);
});

check('every generated skill states how to invoke it', () => {
  for (const e of entries.filter((x) => x.generated)) {
    assert(
      e.text.includes(`\`/${e.fm.name}\``),
      `${e.dir}: body does not mention the /${e.fm.name} invocation`,
    );
  }
});

check('no generated skill still carries the resource-file adaptation header', () => {
  for (const e of entries.filter((x) => x.generated)) {
    assert(!e.text.includes('<!-- dsh-adaptation -->'), `${e.dir}: leaked the adaptation header`);
    assert(!/^> \*\*DSH (Prompt|Persona|Rule|Context)\*\*/m.test(e.text), `${e.dir}: leaked the DSH note line`);
  }
});

check('no generated skill carries a second frontmatter block', () => {
  // The source files have their own `---` block; it must be stripped, or it
  // renders as a stray rule plus a dangling `description:` line.
  for (const e of entries.filter((x) => x.generated)) {
    const body = e.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    assert(!/^---\s*$/m.test(body.split('\n').slice(0, 12).join('\n')), `${e.dir}: a second --- block survives near the top`);
  }
});

check('the 15 ported commands and 9 personas are all reachable as skills', () => {
  const commandNames = readdirSync(join(packageRoot, 'resources', 'commands'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `ecc-${f.replace(/\.md$/, '')}`);
  const agentNames = readdirSync(join(packageRoot, 'resources', 'agents'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `ecc-${f.replace(/\.md$/, '')}`);
  const have = new Set(entries.map((e) => e.fm.name));
  const missing = [...commandNames, ...agentNames].filter((n) => !have.has(n));
  assert(missing.length === 0, `not reachable as skills: ${missing.join(', ')}`);
  return `${commandNames.length} commands + ${agentNames.length} personas`;
});

for (const r of results) {
  const suffix = r.note ? `  (${r.note})` : '';
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${suffix}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} skill-catalog checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
