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

/** Marks a skill generated from resources/; see build-ecc-skills.mjs. */
const GENERATED_MARKER = 'generated-by: scripts/build-ecc-skills.mjs';

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
    /~\/\.claude\/skills\/([a-z0-9-]+)\//g,
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
  [
    // The filename form: `` `~/.claude/agents/tdd-guide.md` ``.
    //
    // `[^`\s]*` is used for the filename rather than `[a-z0-9-]+\.md`, because the
    // closing backtick sits directly after the name and a tighter pattern
    // changes which rules match first. Anchoring on the optional backticks
    // around the whole path keeps the code span balanced.
    /`?~\/\.claude\/agents\/[^`\s]*`?/g,
    (whole) => {
      // Keep the filename when there is one; fall back to the directory.
      const file = /agents\/([^`\s/]+)$/.exec(whole.replace(/`/g, ''));
      return file ? `\`resources/agents/${file[1]}\`` : 'this bundle, under `resources/agents/`';
    },
    'DSH has no per-file agent registry; the personas live in this bundle',
  ],
  [
    /`?~\/\.claude\/hooks\/`?/g,
    'the hook scripts shipped in this bundle under `hooks/scripts/`',
    'hooks ship with the bundle, not in a Claude home directory',
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

  // (a) A whole backticked span, WITH or WITHOUT arguments.
  //
  // This must consume both backticks. Handling only the bare `` `/learn` `` form
  // missed every usage line — `` `/eval define x` ``, `` `/checkpoint [name]` ``
  // — and matching just the inner `/name` inside a span leaves a dangling
  // backtick and produces nested, broken markdown.
  out = out.replace(new RegExp('`/(' + NAMES + ')\\b([^`]*)`', 'g'), (whole, name, rest) => {
    const file = COMMAND_FILE[name];
    if (file === undefined) return whole;
    const target = `\`resources/commands/${file}\``;
    const args = rest.trim();
    return args ? `follow ${target} with \`${args}\`` : target;
  });

  // (b) The plain form outside a span, keeping any arguments.
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

  // Rule 0a: the two-line shape some sources use —
  //   This command invokes the `X` agent located at:
  //   `~/.claude/agents/X.md`
  // Collapsed to one line, so the repaired reference does not restate itself.
  //
  // This runs before the path rules for a reason proven by trace rather than
  // reasoning: the second line's span is rewritten first otherwise, and the
  // result reads as "…persona (…) agent located at:\n`resources/agents/X.md`".
  // The name may be bare or backticked, hence `\`?` on both sides of it.
  out = out.replace(
    /^([^\n]*?)([a-z0-9-]+)`?\s+agent located at:\n[^\n]*~\/\.claude\/agents\/([a-z0-9-]+)\.md[^\n]*$/gm,
    (_w, lead, name, file) => `${lead}${file} persona at \`resources/agents/${file}.md\`:`
  );
  // Any surviving "…persona (…) agent located at:" loses the dangling words.
  out = out.replace(/(persona \(`resources\/agents\/[a-z0-9-]+\.md`\))\s+agent located at:/g, '$1:');

  // Rule 0: a whole backticked span naming an agent, e.g. `` `tdd-guide` ``.
  // Consuming both backticks is required: replacing only the inner name leaves
  // the source's own backticks around the new reference and nests them.
  out = out.replace(new RegExp('`(' + names + ')`', 'g'), (_w, name) => ref(name));

  // Rule 1: consume the phrase including any emphasis and the trailing "agent",
  // so no dangling word survives: "invokes the **tdd-guide** agent" must not
  // become "invokes the **tdd-guide persona (…)** agent".
  out = out.replace(new RegExp(`[Uu]se (?:the )?\\*{0,2}(${names})\\*{0,2} agent`, 'g'), (_w, name) => ref(name));
  out = out.replace(new RegExp(`\\*{0,2}(${names})\\*{0,2} agent\\b`, 'g'), (_w, name) => ref(name));

  // Rule 2: remaining bare names, never one already inside a reference or path.
  out = out.replace(new RegExp(`\\b(${names})\\b(?!\\.md)(?! persona)`, 'g'), (_w, name) => ref(name));

  // Rule 4: a leftover "persona (…) agent" reads wrong; drop the trailing noun.
  out = out.replace(/(persona \(`resources\/agents\/[a-z0-9-]+\.md`\))\s+agent\b/g, '$1');

  // Rule 5 (post-pass): join a "located at:" line with the persona path that
  // follows it, so the repaired reference does not restate itself.
  return collapseLocatedAt(out);
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

/**
 * Normalize line endings before any rewriting.
 *
 * Every resource file in this bundle uses CRLF (they come from a Windows
 * checkout), while the multi-line patterns here are written with `\n`. That
 * mismatch is silent: a pattern like `…located at:[ \t]*\n[ \t]*`…` never
 * matches because `\r` sits between, so the rule appears to work while doing
 * nothing. Several rounds of "the regex must be wrong" traced back to this.
 */
function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

/** Restore the file's original line ending so a rewrite does not reformat it. */
function restoreEol(text, hadCrlf) {
  return hadCrlf ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * Collapse a line ending in "located at:" with the persona path on the next line.
 *
 * Written as a line-by-line pass rather than a regex, after three regex attempts
 * each failed for a different incidental reason (CRLF, backticked vs bare name,
 * match ordering). A line walk has none of those failure modes: it looks at two
 * adjacent lines and joins them when the second is nothing but a path.
 */
function collapseLocatedAt(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];
    if (
      next !== undefined &&
      /located at:\s*$/.test(line) &&
      /^\s*`resources\/agents\/[a-z0-9-]+\.md`\s*$/.test(next)
    ) {
      // Join: "…invokes the X persona (…) located at:" + "`resources/agents/X.md`"
      // becomes "…invokes the X persona at `resources/agents/X.md`:"
      const merged = line
        .replace(/\s*located at:\s*$/, ` at ${next.trim()}:`)
        .replace(/(persona \(`resources\/agents\/[a-z0-9-]+\.md`\))\s+at\b/, 'persona at')
        .replace(/persona \(`resources\/agents\/([a-z0-9-]+)\.md`\)\s+at\s+`resources\/agents\/\1\.md`:/, 'persona at `resources/agents/$1.md`:');
      out.push(merged);
      i += 1; // consume the path line
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
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
 * Enumerated from disk rather than listed by hand: a hand-written list silently
 * skips a file, and a skipped file keeps telling the model to use an agent that
 * does not exist. That is not hypothetical — this function originally covered
 * only `skills/` and the three injected rules, so the defects in
 * `resources/commands/` and `resources/agents/` flowed straight into the 24
 * skills generated from them.
 */
function targets() {
  const list = [];
  const addDir = (dir, filter) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (filter(entry)) list.push(join(dir, entry));
    }
  };

  const skillsDir = join(packageRoot, 'skills');
  for (const name of readdirSync(skillsDir)) {
    const file = join(skillsDir, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    // Generated skills are rebuilt from resources/ by build-ecc-skills.mjs, so
    // editing them here would be overwritten on the next generation. Their
    // defects are fixed at the source instead.
    if (readFileSync(file, 'utf8').includes(GENERATED_MARKER)) continue;
    list.push(file);
  }

  // Rule files are injected at SessionStart; commands and agents are the
  // sources the generated `ecc-*` skills are built from, so a defect here
  // propagates into every skill generated from it.
  addDir(join(packageRoot, 'resources', 'rules'), (f) => f.endsWith('.md'));
  addDir(join(packageRoot, 'resources', 'commands'), (f) => f.endsWith('.md'));
  addDir(join(packageRoot, 'resources', 'agents'), (f) => f.endsWith('.md'));

  return list;
}

const report = [];
for (const file of targets()) {
  const original = readFileSync(file, 'utf8');
  // Normalize before adapting and restore after, so the multi-line rules match
  // and the file keeps whatever line ending it arrived with.
  const hadCrlf = original.includes('\r\n');
  const before = normalizeEol(original);
  const adapted = adapt(before);
  const after = restoreEol(adapted, hadCrlf);
  const changed = after !== original;
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
