#!/usr/bin/env node
/**
 * Rewrite Claude Code references in the adapted artifacts to their DSH equivalents.
 *
 * Portal work that only fixes frontmatter leaves the *prose* pointing at a
 * harness that is not there: a skill telling the model to write learned skills
 * into `~/.claude/skills/learned/`, run `/verify`, or call the `Edit` tool is
 * giving instructions DSH cannot satisfy. The skill still loads and still reads
 * well, so nothing surfaces the problem — it has to be fixed deliberately.
 *
 * Every replacement here maps to a target that was verified to exist:
 *   ~/.claude/skills/            -> $DSH_HOME/skills           (skill-filesystem rank 400)
 *   ~/.claude/settings.json      -> ~/.dsh/cordis.patch.yml    (exists)
 *   .claude/evals/               -> .dsh/evals/                (project-local, mirrors .dsh/)
 *   /learn /verify /eval ...     -> the prompt file under resources/commands/
 *   `Edit`/`Write` tool names    -> `edit`/`write`
 *   tdd-guide / security-reviewer -> the matching resources/agents/ persona
 *
 * Idempotent: a file with no remaining matches is left byte-identical.
 *
 * Usage: node scripts/fix-stale-refs.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes('--dry-run');

/** Slash command -> the prompt file that carries its content in this bundle. */
const COMMAND_FILE = {
  tdd: 'tdd.md',
  plan: 'plan.md',
  e2e: 'e2e.md',
  'code-review': 'code-review.md',
  'build-fix': 'build-fix.md',
  'refactor-clean': 'refactor-clean.md',
  learn: 'learn.md',
  checkpoint: 'checkpoint.md',
  verify: 'verify.md',
  eval: 'eval.md',
  compact: null, // DSH ships /compact itself
  'setup-pm': 'setup-pm.md',
  'update-docs': 'update-docs.md',
  'update-codemaps': 'update-codemaps.md',
  'test-coverage': 'test-coverage.md',
  orchestrate: 'orchestrate.md',
};

/** Claude Code agent name -> the persona file in this bundle. */
const AGENT_FILE = {
  'tdd-guide': 'tdd-guide.md',
  'security-reviewer': 'security-reviewer.md',
  'e2e-runner': 'e2e-runner.md',
  'build-error-resolver': 'build-error-resolver.md',
  'refactor-cleaner': 'refactor-cleaner.md',
  'code-reviewer': 'code-reviewer.md',
  'doc-updater': 'doc-updater.md',
  planner: 'planner.md',
};

/** Ordered rewrites; each entry is [pattern, replacement, why]. */
const REWRITES = [
  // --- Claude Code home paths -> DSH equivalents ---
  [
    /~\/\.claude\/skills\/learned\//g,
    '$DSH_HOME/skills/learned/',
    'learned skills live under the DSH home, which skill-filesystem scans at rank 400',
  ],
  [
    /~\/\.claude\/skills\/([a-z-]+)\//g,
    '$DSH_HOME/skills/$1/',
    'the DSH skill root replaces the Claude Code one',
  ],
  [
    // Consume the surrounding backticks too: matching only the path leaves the
    // source's own backticks around the replacement, which reads as
    // "Add to your `the DSH profile patch`".
    /`~\/\.claude\/settings\.json`|~\/\.claude\/settings\.json/g,
    'the DSH profile patch (`~/.dsh/cordis.patch.yml`)',
    'DSH configures plugins through the profile patch, not a settings.json',
  ],
  [
    /~\/\.claude\/sessions\//g,
    'the DSH session log (~/.dsh/sessions/)',
    'session state is the DSH session log',
  ],
  [/(?<![~\w])\.claude\/evals\//g, '.dsh/evals/', 'project-local state belongs under .dsh/'],
  // A bare directory line (`.claude/` with nothing after it, as in a tree
  // diagram) needs its own rule: the lookahead form below requires a following
  // character and would skip it.
  [/(?<![~\w/])\.claude\/(?=\s|$)/gm, '.dsh/', 'project-local DSH config directory'],
  [/(?<![~\w])\.claude\/(?=[a-zA-Z])/g, '.dsh/', 'project-local DSH config directory'],
  [
    /Claude Code sessions?/g,
    'DSH sessions',
    'the ported text should name the harness it now runs on',
  ],
  // Stale model references: the ported prose addresses "Claude" by name, which
  // is the wrong agent to instruct in this harness.
  [/\bClaude\b(?! Code)/g, 'the model', 'names a different agent than the one reading it'],
  [/\bClaude Code\b/g, 'DSH', 'the harness this bundle runs on'],
];

/**
 * Rewrite a slash-command reference into the shipped prompt file.
 *
 * Two ordered rules, because one pattern cannot handle both shapes cleanly:
 *
 *   a. The backticked bare form `` `/learn` `` is replaced whole. Matching only
 *      the inner `/learn` leaves the source's own backticks around the
 *      replacement and produces nested, broken markdown.
 *   b. The plain form `/eval check x` keeps its arguments, stopping at a
 *      backtick so it cannot swallow the closing quote of a code span.
 *
 * The replacement never reintroduces the `/name` form: this file's own re-scan
 * looks for it, and telling the model to invoke `/eval` would name a command
 * DSH does not have. The actionable form is to read the prompt file.
 */
function rewriteCommand(text) {
  const NAMES =
    'tdd|plan|e2e|code-review|build-fix|refactor-clean|learn|checkpoint|verify|eval|setup-pm|update-docs|update-codemaps|test-coverage|orchestrate';
  let out = text;

  // (a) backticked bare form
  out = out.replace(new RegExp('`/(' + NAMES + ')`', 'g'), (whole, name) => {
    const file = COMMAND_FILE[name];
    return file ? `\`resources/commands/${file}\`` : whole;
  });

  // (b) plain form, keeping any arguments
  out = out.replace(new RegExp(`(^|[\\s(])/(${NAMES})\\b([^\`\\n]*)`, 'gm'), (whole, lead, name, rest) => {
    const file = COMMAND_FILE[name];
    if (file === undefined) return whole;
    const target = `\`resources/commands/${file}\``;
    const args = rest.trim();
    return args ? `${lead}follow ${target} with \`${args}\`` : `${lead}follow ${target}`;
  });

  // "Run: follow X" reads better as "Follow X".
  out = out.replace(/\bRun: follow /g, 'Follow ');
  return out;
}

/**
 * Rewrite an agent reference into the shipped persona file.
 *
 * Written in two ordered rules, and the ordering is what makes it idempotent:
 *
 *   1. The whole phrase "Use <name> agent" / "Use **<name>** agent" is replaced
 *      in ONE match that consumes the trailing " agent", emitting prose that
 *      ends in "<name> persona (`…`)".
 *   2. A bare name — a table cell, a list entry — becomes "<name> persona (`…`)".
 *
 * Both results put the name immediately before the word "persona", and rule 2
 * refuses a name followed by " persona" or by ".md". So a second run matches
 * nothing. Earlier versions chained replacements without that guard and
 * re-matched their own output (`the the tdd-guide persona (…) persona (…)`).
 */
function rewriteAgent(text) {
  const names = Object.keys(AGENT_FILE).join('|');
  const ref = (name) => `${name} persona (\`resources/agents/${AGENT_FILE[name]}\`)`;

  let out = text;
  // Rule 1: consume the phrase including any emphasis and the trailing "agent".
  out = out.replace(new RegExp(`[Uu]se (?:the )?\\*{0,2}(${names})\\*{0,2} agent`, 'g'), (_w, name) => ref(name));
  // Rule 2: remaining bare names, never one already inside a reference or path.
  out = out.replace(new RegExp(`\\b(${names})\\b(?!\\.md)(?! persona)`, 'g'), (_w, name) => ref(name));
  return out;
}

/** Rewrite Claude Code tool names inside backticks and matcher expressions. */
function rewriteTools(text) {
  let out = text.replace(
    /`(Read|Write|Edit|MultiEdit|Bash|Grep|Glob|TodoWrite|WebFetch|WebSearch|NotebookEdit|KillShell|BashOutput)`/g,
    (whole, name) => {
      const map = {
        Read: 'read',
        Write: 'write',
        Edit: 'edit',
        MultiEdit: 'edit',
        NotebookEdit: 'edit',
        Bash: 'pwsh',
        Grep: 'grep',
        Glob: 'glob',
        TodoWrite: 'todo_write',
        WebFetch: 'web_fetch',
        WebSearch: 'web_search',
        KillShell: 'job_kill',
        BashOutput: 'job_output',
      };
      const mapped = map[name];
      return mapped ? `\`${mapped}\`` : whole;
    },
  );
  // A hook matcher written the Claude Code way. The quotes may be escaped,
  // because this text often sits inside a JSON code block: an unescaped-only
  // pattern silently misses `"matcher": "tool == \"Edit\" || ..."`. Capture the
  // escape so the replacement preserves it.
  out = out.replace(/tool == (\\?)"(Read|Write|Edit|Bash|Grep|Glob|MultiEdit)\1"/g, (_whole, esc, name) => {
    const map = { Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit', Bash: 'pwsh', Grep: 'grep', Glob: 'glob' };
    const q = `${esc}"`;
    return `tool == ${q}${map[name]}${q}`;
  });
  // PreToolUse (Edit/Write) -> PreToolUse (edit|write)
  out = out.replace(
    /(Pre|Post)ToolUse\s*\((Read|Write|Edit|Bash|Grep|Glob|MultiEdit)(\/(Read|Write|Edit|Bash|Grep|Glob|MultiEdit))?\)/g,
    (whole, phase, first, _slash, second) => {
      const map = { Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit', Bash: 'pwsh', Grep: 'grep', Glob: 'glob' };
      const parts = [map[first]];
      if (second) parts.push(map[second]);
      return `${phase}ToolUse (${parts.join('|')})`;
    },
  );
  return out;
}

/** Apply every rewrite to one string. */
function adapt(text) {
  let out = text;
  for (const [pattern, replacement] of REWRITES) out = out.replace(pattern, replacement);
  out = rewriteCommand(out);
  out = rewriteAgent(out);
  out = rewriteTools(out);
  // Fix the article the settings.json replacement leaves behind: the source
  // reads "Add to your `~/.claude/settings.json`", so a replacement that starts
  // with "the" yields "Add to your the DSH profile patch".
  out = out.replace(/\byour the DSH profile patch/g, 'your DSH profile patch');
  out = out.replace(/\bthe the DSH profile patch/g, 'the DSH profile patch');
  return out;
}

/**
 * The files whose prose the model can actually read.
 *
 * Every skill and every rule file is enumerated from disk rather than listed by
 * hand: a hand-written list silently skips a file, and a skipped rule keeps
 * telling the model to use an agent that does not exist.
 */
function targets() {
  const list = [];
  const skillsDir = join(packageRoot, 'skills');
  for (const name of readdirSync(skillsDir)) {
    const file = join(skillsDir, name, 'SKILL.md');
    if (existsSync(file)) list.push(file);
  }
  const rulesDir = join(packageRoot, 'resources', 'rules');
  for (const rule of readdirSync(rulesDir)) {
    if (rule.endsWith('.md')) list.push(join(rulesDir, rule));
  }
  return list;
}

const report = [];
for (const file of targets()) {
  const before = readFileSync(file, 'utf8');
  const after = adapt(before);
  const changed = after !== before;
  if (changed && !dryRun) writeFileSync(file, after, 'utf8');
  report.push({
    file: relative(packageRoot, file).replaceAll('\\', '/'),
    changed,
  });
}

const changed = report.filter((r) => r.changed);
for (const r of report) console.log(`${r.changed ? (dryRun ? 'would fix' : 'fixed    ') : 'ok       '}  ${r.file}`);
console.log(`\n${changed.length} file(s) ${dryRun ? 'need fixing' : 'fixed'}, ${report.length - changed.length} already clean`);

// Verify by re-scanning the same rule set the scanner uses.
if (!dryRun) {
  const remaining = [];
  for (const file of targets()) {
    const text = readFileSync(file, 'utf8');
    if (/~\/\.claude\//.test(text) || /(?<![~\w])\.claude\//.test(text)) {
      remaining.push(relative(packageRoot, file).replaceAll('\\', '/'));
    }
    if (/(^|[\s(`])\/(tdd|plan|e2e|code-review|build-fix|refactor-clean|learn|checkpoint|verify|eval)\b/.test(text)) {
      remaining.push(relative(packageRoot, file).replaceAll('\\', '/'));
    }
  }
  const unique = [...new Set(remaining)];
  console.log(unique.length === 0 ? 're-scan: clean' : `re-scan: still has stale refs in ${unique.join(', ')}`);
}
