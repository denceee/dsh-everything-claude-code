#!/usr/bin/env node
/**
 * Verify the host half publishes skills that satisfy the DSH skill contract.
 *
 * The name grammar is imported from the installed DSH package rather than
 * re-implemented, so this test fails if DSH's own rule changes.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

/** Locate the installed DSH skill package to borrow its real name grammar. */
function loadDshSkillModule() {
  const roots = [
    process.env.DSH_SKILL_MODULE,
    ...(process.env.APPDATA
      ? readdirSafe(join(process.env.APPDATA, 'DSH', 'data', 'versions')).map((version) =>
          join(process.env.APPDATA, 'DSH', 'data', 'versions', version, 'node_modules', '@deepseek-ai', 'dsh-skill', 'lib', 'index.js'),
        )
      : []),
  ].filter(Boolean);
  for (const candidate of roots) {
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  return null;
}

/** List a directory, tolerating a missing one. */
function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const dshSkill = await loadDshSkillModule();
const isSkillName = dshSkill
  ? dshSkill.isSkillName
  : (name) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// --- collect what the plugin would register ---------------------------------
const registered = [];
const warnings = [];
const ctx = {
  logger: { warn: (m) => warnings.push(m), info: () => {} },
  effect: (factory) => factory(),
  skills: { register: (skill) => (registered.push(skill), () => {}) },
};

const plugin = await import(pathToFileURL(join(packageRoot, 'index.js')).href);
plugin.apply(ctx, {});

check('publishes every adapted skill bundle', () => {
  assert(registered.length === 11, `expected 11 skills, got ${registered.length}: ${registered.map((s) => s.name).join(', ')}`);
});

check('registers no skill with a malformed name', () => {
  for (const skill of registered) {
    assert(isSkillName(skill.name), `"${skill.name}" violates the DSH skill-name grammar`);
  }
});

check('registers no skill without a description', () => {
  for (const skill of registered) {
    assert(typeof skill.description === 'string' && skill.description.length > 0, `"${skill.name}" has no description`);
  }
});

check('gives every skill a complete invocation policy', () => {
  for (const skill of registered) {
    assert(skill.invocation !== undefined, `"${skill.name}" has no invocation policy`);
    assert(typeof skill.invocation.modelInvocable === 'boolean', `"${skill.name}" modelInvocable is not boolean`);
    assert(typeof skill.invocation.userInvocable === 'boolean', `"${skill.name}" userInvocable is not boolean`);
  }
});

check('declares a real source label and a readable path', () => {
  for (const skill of registered) {
    assert(skill.source === 'bundled', `"${skill.name}" has source "${skill.source}"`);
    assert(existsSync(skill.path), `"${skill.name}" points at a missing file: ${skill.path}`);
  }
});

check('strips frontmatter from the registered body', () => {
  for (const skill of registered) {
    assert(!skill.content.startsWith('---'), `"${skill.name}" body still starts with frontmatter`);
    assert(skill.content.trim().length > 0, `"${skill.name}" body is empty`);
  }
});

check('registers the skills from the upstream set', () => {
  const names = new Set(registered.map((s) => s.name));
  for (const expected of ['tdd-workflow', 'security-review', 'verification-loop', 'eval-harness', 'coding-standards']) {
    assert(names.has(expected), `missing expected skill "${expected}"`);
  }
});

check('reports no warnings for a well-formed bundle', () => {
  assert(warnings.length === 0, `unexpected warnings: ${warnings.join(' | ')}`);
});

check('unloads cleanly through ctx.effect', () => {
  const disposed = [];
  const isolated = [];
  const isolatedCtx = {
    logger: { warn: () => {}, info: () => {} },
    effect: (factory) => {
      const disposer = factory();
      disposed.push(disposer);
    },
    skills: { register: (skill) => (isolated.push(skill), () => {}) },
  };
  plugin.apply(isolatedCtx, {});
  assert(isolated.length === 11, `expected 11 skills on the isolated registry, got ${isolated.length}`);
  assert(disposed.length === 11, `expected one effect disposer per skill, got ${disposed.length}`);
  assert(disposed.every((d) => typeof d === 'function'), 'every effect must return a disposer');
});

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} skill checks passed`);
console.log(`(name grammar source: ${dshSkill ? 'installed @deepseek-ai/dsh-skill' : 'local fallback regex'})`);
process.exit(failed.length === 0 ? 0 : 1);
