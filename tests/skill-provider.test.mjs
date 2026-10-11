#!/usr/bin/env node
/**
 * Verify the Host half publishes skills through a *provider*, and that a body
 * edit is picked up on the next load.
 *
 * Why the provider shape matters: a `ctx.skills.register()` call carries its
 * `content` string, so the registry caches that body from plugin load onward.
 * An edited SKILL.md then never reaches the model —observed in this session,
 * where the skill tool returned pre-edit text while the file on disk was
 * already corrected. A provider's `get()` runs per load, so it cannot go stale.
 *
 * The name grammar is borrowed from the installed `@deepseek-ai/dsh-skill`
 * rather than re-implemented, so this fails if DSH's own rule changes.
 *
 * Usage: node tests/skill-provider.test.mjs
 */
import { join, dirname } from 'node:path';
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

/** Locate the installed DSH skill package to borrow its real name grammar. */
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
const isSkillName = dshSkill ? dshSkill.isSkillName : (name) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);

const results = [];
/**
 * Run one check, awaiting an async body.
 *
 * `check` must be awaited: an async callback returns a Promise, and without the
 * await the assertion runs after the reporting pass, so `candidates` stayed a
 * pending Promise and four checks failed on a non-iterable.
 */
async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: typeof note === 'string' ? note : undefined });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// --- load the plugin and capture what it registers -------------------------
let providerFactory = null;
const ctx = {
  logger: { warn: () => {}, info: () => {} },
  effect: (factory) => factory(),
  skills: {
    registerProvider: (create) => {
      providerFactory = create;
      return () => {};
    },
    register: () => {
      throw new Error('the Host half must register a provider, not individual skills');
    },
  },
};

const plugin = await import(pathToFileURL(join(packageRoot, 'index.js')).href);

await check('apply registers exactly one provider', () => {
  plugin.apply(ctx, {});
  assert(providerFactory !== null, 'registerProvider was not called');
});

let provider;
await check('the provider factory returns a provider', () => {
  provider = providerFactory({ signal: new AbortController().signal, invalidate: () => {} });
  assert(provider && typeof provider === 'object', 'factory returned nothing');
  assert(typeof provider.name === 'string' && provider.name.length > 0, 'provider has no name');
  assert(typeof provider.list === 'function', 'provider has no list()');
  assert(typeof provider.get === 'function', 'provider has no get()');
});

let candidates;
await check('list() returns every skill as a candidate', async () => {
  const out = await provider.list({});
  candidates = Array.isArray(out) ? out : out.candidates;
  assert(Array.isArray(candidates), 'list() did not return an array');
  assert(candidates.length === 11, `expected 11 candidates, got ${candidates.length}`);
});

await check('no candidate carries a content body (bodies must load on demand)', () => {
  for (const c of candidates) {
    assert(
      c.content === undefined,
      `"${c.name}" carries content at list() time —that body would be cached and go stale`,
    );
  }
});

await check('every candidate name satisfies the real DSH grammar', () => {
  for (const c of candidates) {
    assert(isSkillName(c.name), `"${c.name}" violates the DSH skill-name grammar`);
  }
});

await check('every candidate has a description, invocation policy and rank', () => {
  for (const c of candidates) {
    assert(typeof c.description === 'string' && c.description.length > 0, `"${c.name}" has no description`);
    assert(c.invocation && typeof c.invocation.modelInvocable === 'boolean', `"${c.name}" has no invocation policy`);
    assert(typeof c.rank === 'number', `"${c.name}" has no rank`);
    assert(typeof c.provider === 'string', `"${c.name}" has no provider label`);
  }
});

await check('every candidate points at a readable path and carries a locator', () => {
  for (const c of candidates) {
    assert(existsSync(c.path), `"${c.name}" path does not exist: ${c.path}`);
    assert(typeof c.locator === 'string', `"${c.name}" has no locator for get()`);
  }
});

await check('get() returns the body without frontmatter', async () => {
  const tdd = candidates.find((c) => c.name === 'tdd-workflow');
  const loaded = await provider.get(tdd, {});
  assert(loaded, 'get() returned nothing for tdd-workflow');
  assert(typeof loaded.content === 'string' && loaded.content.length > 0, 'empty body');
  assert(!loaded.content.startsWith('---'), 'body still carries frontmatter');
  assert(loaded.content.includes('Test-Driven'), 'body does not look like the tdd-workflow text');
});

await check('get() returns undefined for a locator that no longer exists', async () => {
  const loaded = await provider.get({ ...candidates[0], locator: join(packageRoot, 'skills', 'nope', 'SKILL.md') }, {});
  assert(loaded === undefined, 'a missing file must resolve to undefined, not a stale body');
});

// --- the staleness regression: an edit must be visible on the next get() ---
await check('a body edit is visible on the next get() (no reload needed)', async () => {
  const source = join(packageRoot, 'skills', 'tdd-workflow', 'SKILL.md');
  const backup = `${source}.test-backup`;
  copyFileSync(source, backup);
  try {
    const candidate = candidates.find((c) => c.name === 'tdd-workflow');
    const before = await provider.get(candidate, {});
    assert(!before.content.includes('STALENESS-PROBE'), 'probe text was already present');

    const original = readFileSync(source, 'utf8');
    writeFileSync(source, `${original}\n\nSTALENESS-PROBE\n`, 'utf8');

    const after = await provider.get(candidate, {});
    assert(
      after.content.includes('STALENESS-PROBE'),
      'the edit did not appear —this provider is caching bodies',
    );
  } finally {
    copyFileSync(backup, source);
    unlinkSync(backup);
  }
});

await check('the restored file is byte-identical after the probe', () => {
  const text = readFileSync(join(packageRoot, 'skills', 'tdd-workflow', 'SKILL.md'), 'utf8');
  assert(!text.includes('STALENESS-PROBE'), 'probe text was left behind');
});

// Results: the async checks settle above, so a mixed list is fine here.
const settled = results;

for (const r of settled) {
  const suffix = r.note ? `  (${r.note})` : '';
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${suffix}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = settled.filter((r) => !r.ok);
console.log(`\n${settled.length - failed.length}/${settled.length} skill-provider checks passed`);
console.log(`(name grammar source: ${dshSkill ? 'installed @deepseek-ai/dsh-skill' : 'local fallback regex'})`);
process.exit(failed.length === 0 ? 0 : 1);
