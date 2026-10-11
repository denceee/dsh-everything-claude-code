#!/usr/bin/env node
/**
 * Turn the ported command prompts and agent personas into real DSH skills.
 *
 * The problem this solves: `resources/commands/*.md` and `resources/agents/*.md`
 * were only *documents*. A user could read them, but nothing could invoke them —
 * while the DSH skill contract already offers exactly that: a skill with
 * `userInvocable` is callable as `/name`, and one with `modelInvocable` is
 * loadable through the `skill` tool.
 *
 * So each ported file becomes a SKILL.md:
 *   - `ecc-<command>`  — the 15 slash commands, invocable as `/ecc-tdd`, …
 *   - `ecc-<agent>`    — the 9 personas, loadable by the model and by a human
 *
 * Naming, and why the prefix is not optional: two ECC agent names (`architect`,
 * `code-reviewer`) already exist as user-level skills in this profile. User
 * skills outrank a bundled provider (rank 400 vs 600), so an unprefixed skill
 * would be silently shadowed and never appear. `ecc-` also matches the
 * ecosystem's existing convention (`dsh-*` skills, 19 of them installed).
 *
 * Idempotent: regenerates each output from its source, so re-running is safe.
 *
 * Usage: node scripts/build-ecc-skills.mjs
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commandsDir = join(packageRoot, 'resources', 'commands');
const agentsDir = join(packageRoot, 'resources', 'agents');
const skillsDir = join(packageRoot, 'skills');

/** Prefix applied to every generated skill name. */
const PREFIX = 'ecc-';

/** Marker so a generated directory is recognisable and safe to regenerate. */
const GENERATED_MARKER = 'generated-by: scripts/build-ecc-skills.mjs';

/** Parse `---` frontmatter into flat scalars plus the body. */
function splitFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { attributes: {}, body: source };
  const attributes = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) attributes[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { attributes, body: source.slice(match[0].length) };
}

/**
 * Drop the DSH adaptation note that the resource adapter prepended, and any
 * frontmatter block the source still carries.
 *
 * The resource files were produced for human reading, so they keep their own
 * `---` block (a command's frontmatter holds only a description). Left in place
 * it would appear as a stray thematic break and a dangling `description:` line
 * in the middle of a skill body.
 */
function stripAdaptationHeader(body) {
  const withoutNote = body
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.startsWith('<!-- dsh-adaptation -->') &&
        !/^> \*\*DSH (Prompt|Persona|Rule|Context)\*\*/.test(line),
    )
    .join('\n');

  // Remove a leading frontmatter block, if the caller did not already split it.
  const stripped = withoutNote.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return stripped.replace(/^\s+/, '');
}

/**
 * A concise description taken from the source's own words.
 *
 * The source is better than any generated stub: a command's frontmatter already
 * carries a description, and an agent file's opening line does. Falling back to
 * "Apply the tdd workflow ported from everything-claude-code" would tell a
 * reader nothing about what the skill does.
 */
function descriptionFrom(rawSource, base, kind) {
  const { attributes, body } = splitFrontmatter(rawSource);
  if (attributes.description) return attributes.description;

  const prose = stripAdaptationHeader(body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('>'));
  const first = prose[0] ?? '';
  const sentence = /^(.+?[.!?])(\s|$)/.exec(first)?.[1] ?? first;
  if (sentence.length > 0) return sentence.slice(0, 200);

  return kind === 'command'
    ? `Apply the ${base} workflow ported from everything-claude-code.`
    : `Adopt the ${base} persona ported from everything-claude-code.`;
}

/** Escape a description for a single-line YAML scalar. */
function yamlScalar(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  // Quote when the value contains a character YAML would interpret.
  return /: |^[>|*&!%@`{}[\]"']|#/.test(oneLine) ? `'${oneLine.replaceAll("'", "''")}'` : oneLine;
}

/**
 * Build one SKILL.md from a resource file.
 *
 * The lead line states how to invoke the skill, because that is the whole point
 * of the conversion: the source was a document nobody could call.
 */
function buildSkill({ source, kind, name, description, title }) {
  const raw = readFileSync(source, 'utf8');
  const { body } = splitFrontmatter(raw);
  // The source's own H1 duplicates the generated title.
  const withoutTitle = stripAdaptationHeader(body).replace(/^#\s+.*\r?\n+/, '');

  const lead =
    kind === 'command'
      ? `> Invoke with \`/${name}\` to apply this workflow, or load it with the \`skill\` tool.\n\n`
      : `> Load with the \`skill\` tool to adopt this persona, or invoke \`/${name}\`.\n\n`;

  return `---
name: ${name}
description: ${yamlScalar(description)}
# ${GENERATED_MARKER}
---

# ${title}

${lead}${withoutTitle}`;
}

/** Every skill to generate: `ecc-<name>` from each resource file. */
function plan() {
  const plan = [];

  for (const file of readdirSync(commandsDir).filter((f) => f.endsWith('.md'))) {
    const base = file.replace(/\.md$/, '');
    const raw = readFileSync(join(commandsDir, file), 'utf8');
    const heading = /^#\s+(.+)$/m.exec(stripAdaptationHeader(splitFrontmatter(raw).body))?.[1]?.trim();
    plan.push({
      kind: 'command',
      source: join(commandsDir, file),
      name: `${PREFIX}${base}`,
      title: heading ?? `${base} workflow`,
      description: descriptionFrom(raw, base, 'command'),
    });
  }

  for (const file of readdirSync(agentsDir).filter((f) => f.endsWith('.md'))) {
    const base = file.replace(/\.md$/, '');
    const raw = readFileSync(join(agentsDir, file), 'utf8');
    plan.push({
      kind: 'agent',
      source: join(agentsDir, file),
      name: `${PREFIX}${base}`,
      // Not "${base} persona": the lead line already says "persona", and the
      // duplication read as "persona persona".
      title: `${base} (ECC persona)`,
      description: descriptionFrom(raw, base, 'agent'),
    });
  }

  return plan;
}

const items = plan();

/** Remove previously generated directories only, never a hand-written skill. */
function cleanGenerated() {
  const removed = [];
  for (const entry of readdirSync(skillsDir)) {
    const dir = join(skillsDir, entry);
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes(GENERATED_MARKER)) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(entry);
    }
  }
  return removed;
}

const removed = cleanGenerated();

for (const item of items) {
  const dir = join(skillsDir, item.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), buildSkill(item), 'utf8');
}

console.log(`removed ${removed.length} previously generated skill(s)`);
console.log(`wrote ${items.length} skill(s):`);
for (const item of items) console.log(`  ${item.kind === 'command' ? 'cmd ' : 'agent'}  /${item.name}`);
