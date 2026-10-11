#!/usr/bin/env node
/**
 * Adapt the ECC resource files (rules, commands, agents, contexts) for DSH.
 *
 * These are reference material, not live registrations: DSH's command registry
 * is human-facing only and its tool never reaches the model, so an ECC "slash
 * command" becomes a *prompt* the user or the model can apply. Each file keeps
 * its original body and gains a header that states how to use it here.
 *
 * Idempotent: a file that already carries the header is left alone.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const resourcesDir = process.argv[2];
if (!resourcesDir || !existsSync(resourcesDir)) {
  console.error('usage: node adapt-resources.mjs <resources-dir>');
  process.exit(1);
}

const HEADER_MARKER = '<!-- dsh-adaptation -->';

const KINDS = {
  commands: {
    title: 'Prompt',
    note:
      'In Claude Code this file was a slash command. DSH resolves `/name` through the ' +
      'human-command registry, which never reaches the model, so this is a prompt instead: ' +
      'paste it, or reference the file with @, and the agent follows it as instructions. ' +
      'Its tool names have been mapped to DSH tools.',
  },
  agents: {
    title: 'Persona',
    note:
      'In Claude Code this file defined a subagent type. DSH has no per-file agent registry, so ' +
      'this is a persona prompt: pass its body to `subagent` (or `spawn_teammate`) as the initial ' +
      'instruction, or paste it to adopt the role inline. Its tool list has been mapped to DSH tools.',
  },
  rules: {
    title: 'Rule',
    note:
      'An always-follow guideline. Copy the rules you want into the project `AGENTS.md`, or load ' +
      'this file with @ when the task touches its subject.',
  },
  contexts: {
    title: 'Context',
    note: 'A system-prompt context. Paste it, or reference this file with @, when the session mode matches.',
  },
};

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

/** Rewrite only genuine tool references, never ordinary prose. */
function mapToolReferences(text) {
  let out = text.replace(/`([A-Za-z_][A-Za-z0-9_]*)(\([^`]*\))?`/g, (whole, head, suffix = '') => {
    const mapped = TOOL_MAP.get(head);
    return mapped ? `\`${mapped}${suffix}\`` : whole;
  });
  out = out.replace(
    /^((?:tools|allowed-tools)\s*:\s*)([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*$/gm,
    (whole, prefix, list) => {
      const parts = list.split(/\s*,\s*/);
      if (!parts.every((p) => TOOL_MAP.has(p))) return whole;
      return prefix + parts.map((p) => TOOL_MAP.get(p)).join(', ');
    },
  );
  return out;
}

const report = [];
for (const [kind, meta] of Object.entries(KINDS)) {
  const dir = join(resourcesDir, kind);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    if (!statSync(file).isFile() || !entry.endsWith('.md')) continue;
    const source = readFileSync(file, 'utf8');
    if (source.includes(HEADER_MARKER)) {
      report.push(`ok       ${kind}/${entry}`);
      continue;
    }
    const header = `${HEADER_MARKER}\n> **DSH ${meta.title}** — ${meta.note}\n\n`;
    writeFileSync(file, header + mapToolReferences(source), 'utf8');
    report.push(`adapted  ${kind}/${entry}`);
  }
}

console.log(report.join('\n'));
console.log(`\n${report.filter((r) => r.startsWith('adapted')).length} adapted, ${report.filter((r) => r.startsWith('ok')).length} already adapted`);
