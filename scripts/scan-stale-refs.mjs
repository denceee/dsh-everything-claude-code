#!/usr/bin/env node
/**
 * Scan every adapted artifact for Claude Code references that do not exist in DSH.
 *
 * A ported skill that tells the model to write to `~/.claude/skills/learned/`,
 * run `/verify`, or call the `Edit` tool is giving instructions the harness
 * cannot satisfy. Those references are invisible to a load test — the skill
 * loads fine and reads fine — so they need their own check.
 *
 * Usage: node scripts/scan-stale-refs.mjs [--json]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Patterns that cannot work in DSH, each with why.
 *
 * Ordered so a specific rule wins over a general one — a `~/.claude/skills/learned/`
 * path should be reported as the Claude-home rule, not swallowed by a broader
 * `~/.claude/` rule.
 */
const RULES = [
  {
    id: 'claude-home',
    pattern: /~/g,
    // refined below
    test: (line) => /~\/\.claude\//.test(line),
    why: 'writes to the Claude Code home; DSH uses $DSH_HOME',
  },
  {
    id: 'claude-dir',
    pattern: /\.claude\//g,
    test: (line) => /(?<![~\w])\.claude\//.test(line) && !/~\/\.claude\//.test(line),
    why: 'a `.claude/` project path; DSH uses `.dsh/`',
  },
  {
    id: 'claude-plugin-root',
    pattern: /\$\{CLAUDE_[A-Z_]+\}/g,
    test: (line) => /\$\{CLAUDE_[A-Z_]+\}/.test(line),
    why: 'a Claude Code template variable; the DSH bridge substitutes only inside hooks.json',
  },
  {
    id: 'cc-tool-name',
    pattern: /\b(Read|Write|Edit|MultiEdit|Bash|Grep|Glob|TodoWrite|WebFetch|WebSearch|NotebookEdit|KillShell|BashOutput)\b/g,
    // Only flag a tool *usage*, not ordinary English. Backticked, or in a
    // tool-list/matcher/heading shape.
    test: (line) =>
      /`(Read|Write|Edit|MultiEdit|Bash|Grep|Glob|TodoWrite|WebFetch|WebSearch|NotebookEdit)`/.test(line) ||
      /tool\s*==\s*"(Read|Write|Edit|Bash|Grep|Glob)"/.test(line) ||
      /PreToolUse\s*\((Read|Write|Edit|Bash|Grep|Glob|MultiEdit)/.test(line) ||
      /PostToolUse\s*\((Read|Write|Edit|Bash|Grep|Glob|MultiEdit)/.test(line) ||
      /^(Read|Write|Edit|Bash|Grep|Glob)\s*$/.test(line.trim()) ||
      /\b(uses?|use|call|calls|invoke|invokes)\s+`?(Read|Write|Edit|Bash|Grep|Glob)`?\b/.test(line),
    why: 'names a Claude Code tool; DSH tools are lowercase (read/write/edit/pwsh/grep/glob)',
  },
  {
    id: 'cc-slash-command',
    pattern: /(^|[\s(`])\/(tdd|plan|e2e|code-review|build-fix|refactor-clean|learn|checkpoint|verify|eval|setup-pm|update-docs|update-codemaps|test-coverage|orchestrate)\b/g,
    // `/compact` is deliberately absent: DSH ships it as dsh-command-compact,
    // so naming it is correct, not stale. Flagging it would be a false positive.
    test: (line) =>
      /(^|[\s(`])\/(tdd|plan|e2e|code-review|build-fix|refactor-clean|learn|checkpoint|verify|eval|setup-pm|update-docs|update-codemaps|test-coverage|orchestrate)\b/.test(
        line,
      ),
    why: 'a Claude Code slash command; DSH commands are human-facing and never reach the model',
  },
  {
    id: 'cc-agent',
    pattern: /\b(tdd-guide|security-reviewer|e2e-runner|build-error-resolver|refactor-cleaner|code-reviewer|doc-updater|architect|planner|general-purpose)\b/g,
    test: (line) =>
      /\b(tdd-guide|security-reviewer|e2e-runner|build-error-resolver|refactor-cleaner|code-reviewer|doc-updater|planner|general-purpose)\b/i.test(
        line,
      ) && !/^\s*#\s/.test(line) && !/resources\/(agents|commands|rules)/.test(line),
    why: 'names a Claude Code subagent type; DSH registers no per-file agents',
  },
];

/** Files worth scanning: what the model can actually reach. */
function collectTargets() {
  const targets = [];
  const skillsDir = join(packageRoot, 'skills');
  for (const name of readdirSync(skillsDir)) {
    const file = join(skillsDir, name, 'SKILL.md');
    if (existsSync(file)) targets.push({ kind: 'skill', name, file });
  }
  // The rules that SessionStart injects are model-visible every session.
  for (const rule of ['security.md', 'coding-style.md', 'testing.md']) {
    const file = join(packageRoot, 'resources', 'rules', rule);
    if (existsSync(file)) targets.push({ kind: 'injected-rule', name: `rules/${rule}`, file });
  }
  return targets;
}

const findings = [];
for (const target of collectTargets()) {
  const lines = readFileSync(target.file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.test(line)) {
        findings.push({
          file: relative(packageRoot, target.file).replaceAll('\\', '/'),
          kind: target.kind,
          name: target.name,
          line: index + 1,
          rule: rule.id,
          why: rule.why,
          text: line.trim().slice(0, 160),
        });
      }
    }
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(findings, null, 2));
  process.exit(findings.length === 0 ? 0 : 1);
}

const byFile = new Map();
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push(f);
}

console.log(`scanned ${collectTargets().length} model-reachable file(s)`);
console.log(`stale reference(s): ${findings.length}\n`);

for (const [file, hits] of byFile) {
  console.log(`${file}  (${hits.length})`);
  for (const h of hits) {
    console.log(`  L${h.line} [${h.rule}] ${h.text}`);
  }
  console.log('');
}

const rules = new Map();
for (const f of findings) rules.set(f.rule, (rules.get(f.rule) ?? 0) + 1);
console.log('--- by rule ---');
for (const [rule, n] of [...rules].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${rule}`);

process.exit(findings.length === 0 ? 0 : 1);
