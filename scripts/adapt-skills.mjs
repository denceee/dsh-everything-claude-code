#!/usr/bin/env node
/**
 * Adapt everything-claude-code skills to the DSH skill contract.
 *
 * Two transformations only:
 *  1. Frontmatter: guarantee kebab-case `name` + non-empty `description`
 *     (`dsh-skill-filesystem` drops a skill that lacks either).
 *  2. Body: rewrite *tool references* to their DSH equivalents.
 *
 * Tool rewriting is deliberately narrow. A blind word replacement corrupts
 * ordinary prose ("Harness Skill" -> "skill", "Read the file" -> "read the
 * file"), so only two unambiguous shapes are rewritten:
 *   a. a backticked bare tool name:  `Read`  ->  `read`
 *   b. a frontmatter-style tool list: "tools: Read, Grep, Glob" -> DSH names
 * Everything else is left byte-identical, because a prose sentence that names
 * a tool without backticks reads correctly either way.
 *
 * Idempotent: re-running over already-adapted files changes nothing.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const skillsDir = process.argv[2];
if (!skillsDir || !existsSync(skillsDir)) {
  console.error('usage: node adapt-skills.mjs <skills-dir>');
  process.exit(1);
}

/** Claude Code tool -> DSH tool name. */
const TOOL_MAP = new Map([
  ['Read', 'read'],
  ['Write', 'write'],
  ['Edit', 'edit'],
  ['MultiEdit', 'edit'],
  ['NotebookEdit', 'edit'],
  ['Glob', 'glob'],
  ['Grep', 'grep'],
  ['LS', 'glob'],
  ['Bash', 'pwsh'],
  ['BashOutput', 'job_output'],
  ['KillShell', 'job_kill'],
  ['Task', 'subagent'],
  ['TodoWrite', 'todo_write'],
  ['TaskCreate', 'todo_write'],
  ['TaskUpdate', 'todo_write'],
  ['WebFetch', 'web_fetch'],
  ['WebSearch', 'web_search'],
  ['AskUserQuestion', 'ask_user_question'],
  ['SlashCommand', 'slash-command'],
  ['Skill', 'skill'],
]);

/** Frontmatter fields accepted by dsh-skill-filesystem; everything else is dropped. */
const KEEP_FRONTMATTER = new Set(['whenToUse', 'user-invocable', 'disable-model-invocation']);

/**
 * Rewrite only backticked bare tool names, and tool names inside a
 * comma-separated `tools:`-style list. A backticked name may carry a
 * parenthetical, e.g. `Bash(git:*)` — the head is mapped, the suffix kept.
 */
function mapToolReferences(text) {
  // (a) `Tool` or `Tool(suffix)`
  let out = text.replace(/`([A-Za-z_][A-Za-z0-9_]*)(\([^`]*\))?`/g, (whole, head, suffix = '') => {
    const mapped = TOOL_MAP.get(head);
    return mapped ? `\`${mapped}${suffix}\`` : whole;
  });
  // (b) a line that is exactly a tool list: "Read, Grep, Glob" or "(Read, Grep)"
  out = out.replace(
    /^(\s*(?:[-*]\s*)?(?:tools?|allowed-tools)\s*:\s*)([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*$/gm,
    (whole, prefix, list) => {
      const parts = list.split(/\s*,\s*/);
      if (!parts.every((p) => TOOL_MAP.has(p))) return whole;
      return prefix + parts.map((p) => TOOL_MAP.get(p)).join(', ');
    },
  );
  return out;
}

/** Parse `---\n...\n---` frontmatter; returns null when absent. */
function splitFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return null;
  return { raw: match[1], body: source.slice(match[0].length) };
}

/** Extract `key: value` pairs from raw frontmatter (flat scalars only). */
function parseScalars(raw) {
  const entries = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) entries.set(kv[1], kv[2].trim().replace(/^["']|["']$/g, ''));
  }
  return entries;
}

/** First H1, used as a fallback description. */
function deriveDescription(body) {
  for (const line of body.split(/\r?\n/)) {
    const heading = /^#\s+(.+)$/.exec(line.trim());
    if (heading) return heading[1].trim().slice(0, 300);
  }
  return 'Adapted from everything-claude-code.';
}

const report = [];
for (const entry of readdirSync(skillsDir)) {
  const dir = join(skillsDir, entry);
  if (!statSync(dir).isDirectory()) continue;
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) continue;

  const source = readFileSync(file, 'utf8');
  const split = splitFrontmatter(source);
  const scalars = split ? parseScalars(split.raw) : new Map();
  const body = split ? split.body : source;

  const name = scalars.get('name') || entry;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`${entry}: name "${name}" is not kebab-case`);
  }
  const description = scalars.get('description') || deriveDescription(body);

  const lines = ['---', `name: ${name}`, `description: ${description}`];
  for (const [key, value] of scalars) {
    if (KEEP_FRONTMATTER.has(key)) lines.push(`${key}: ${value}`);
  }
  lines.push('---', '');

  const adapted = `${lines.join('\n')}${mapToolReferences(body).replace(/^\s+/, '')}`;
  const changed = adapted !== source;
  if (changed) writeFileSync(file, adapted, 'utf8');
  report.push(`${changed ? 'adapted' : 'ok     '}  ${name}`);
}

console.log(report.join('\n'));
console.log(
  `\n${report.filter((r) => r.startsWith('adapted')).length} adapted, ${report.filter((r) => r.startsWith('ok')).length} already valid`,
);
