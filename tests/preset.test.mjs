#!/usr/bin/env node
/**
 * Validate the ECC agent preset patch.
 *
 * An invalid preset row fails declaration loading and the preset silently never
 * appears in the picker, so the shape is asserted here rather than discovered in
 * the UI. Checks mirror the `@deepseek-ai/dsh-agent-preset` config schema:
 * required `id` and `plugins`, plus the child-row rules the Loader enforces.
 *
 * Usage: node tests/preset.test.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const presetPath = join(packageRoot, 'presets', 'everything-claude-code.patch.yml');

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

const source = readFileSync(presetPath, 'utf8');

// --- a tiny reader for the subset of YAML this file uses --------------------
// The patch is a list-of-inserts with nested `config` maps and string lists.
// Parsing the whole YAML spec is unnecessary; these helpers read structure.
/** Strip comments and blank lines, keeping indentation. */
function significantLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
}

const lines = significantLines(source);

/**
 * Collect every `- id:` row that belongs to the preset's `plugins` tree.
 *
 * Indentation alone is unreliable here: the tree nests `cordis:group` rows that
 * hold their own children, so a fixed indent threshold either misses shallow
 * rows or pulls in unrelated ones. Instead, start after the `plugins:` key and
 * stop at the next top-level key, then read every `- id:` in that span.
 */
function childIdsOfPreset() {
  const start = lines.findIndex((l) => l.text === 'plugins:');
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.indent === 0);
  const span = end === -1 ? rest : rest.slice(0, end);
  return span
    .map((l) => /^- id:\s*(.+)$/.exec(l.text))
    .filter(Boolean)
    .map((m) => m[1].trim());
}

check('the preset patch exists and is non-empty', () => {
  assert(existsSync(presetPath), `missing ${presetPath}`);
  assert(source.trim().length > 0, 'preset patch is empty');
});

check('declares exactly one inserted preset row', () => {
  const presetRows = lines.filter((l) => l.text === '- id: preset-everything-claude-code');
  assert(presetRows.length === 1, `expected 1 preset insert, found ${presetRows.length}`);
});

check('uses the agent-preset plugin', () => {
  assert(
    /name:\s*'@deepseek-ai\/dsh-agent-preset'/.test(source),
    'the row must mount @deepseek-ai/dsh-agent-preset',
  );
});

check('sets the required config.id and a display name', () => {
  assert(/^\s*id:\s*everything-claude-code\s*$/m.test(source), 'config.id must be "everything-claude-code"');
  assert(/^\s*name:\s*Everything Claude Code\s*$/m.test(source), 'config.name must be set');
});

check('provides a non-empty plugins list', () => {
  const childIds = childIdsOfPreset();
  assert(childIds.length > 0, 'plugins list is empty; a preset with no plugins mounts nothing');
});

check('order places it after the shipped presets', () => {
  const order = /^\s*order:\s*(\d+)\s*$/m.exec(source);
  assert(order !== null, 'order must be set so the roster position is deterministic');
  assert(Number(order[1]) >= 4, `order ${order[1]} collides with the shipped standard(1)/ptc(2)/minimal(3)`);
});

check('mounts the persona row with a prefix', () => {
  assert(/id:\s*persona\b/.test(source), 'a persona row is what makes this an agent mode');
  assert(/^\s*prefix:\s*\|/m.test(source), 'persona.prefix must be a block scalar with content');
});

check('states the ECC working agreement, not a generic persona', () => {
  for (const [needle, why] of [
    ['test-driven', 'TDD is the core ECC practice'],
    ['Verify before claiming done', 'verification-before-claiming is the ECC gate'],
    ['hardcode a secret', 'the security rule is part of the agreement'],
  ]) {
    assert(source.toLowerCase().includes(needle.toLowerCase()), `persona does not mention: ${why}`);
  }
});

check('names the skills the model should load', () => {
  for (const skill of ['tdd-workflow', 'verification-loop', 'security-review']) {
    assert(source.includes(skill), `persona should point at the skill "${skill}"`);
  }
});

check('includes the core agent plane rows', () => {
  const childIds = childIdsOfPreset();
  for (const required of ['tool-fs', 'tool-fs-search', 'skill-filesystem', 'tool-skill', 'tool-todo']) {
    assert(childIds.includes(required), `missing required child row "${required}"`);
  }
});

check('uses platform guards on the shell rows', () => {
  // Both shells are declared, each disabled on the other platform, so the
  // preset works on Windows and POSIX without a second definition.
  assert(/id:\s*tool-pwsh\b/.test(source), 'tool-pwsh row is required on Windows');
  assert(/id:\s*tool-bash\b/.test(source), 'tool-bash row is required on POSIX');
  assert(/process\.platform === 'win32'/.test(source), 'tool-bash needs a win32 guard');
  assert(/process\.platform !== 'win32'/.test(source), 'tool-pwsh needs a non-win32 guard');
});

check('every child id is unique (duplicate ids fail declaration loading)', () => {
  const childIds = childIdsOfPreset();
  const seen = new Set();
  for (const id of childIds) {
    assert(!seen.has(id), `duplicate child id "${id}"`);
    seen.add(id);
  }
});

check('every referenced package name is well formed', () => {
  const names = [...source.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
  assert(names.length > 0, 'no package names found');
  for (const name of names) {
    assert(
      name.startsWith('@deepseek-ai/') || name.startsWith('cordis:') || /^[a-z0-9@/.-]+$/.test(name),
      `suspicious package name: ${name}`,
    );
  }
});

check('the bundle declares the preset patch', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const patch = manifest.dsh?.bundle?.patch;
  const list = Array.isArray(patch) ? patch : [patch];
  assert(
    list.includes('./presets/everything-claude-code.patch.yml'),
    'package.json dsh.bundle.patch must include the preset patch, or it never loads',
  );
});

check('the adapters did not leave the preset referencing missing files', () => {
  assert(!/\.\.\//.test(source), 'the preset must not reference paths outside the package');
});

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} preset checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
