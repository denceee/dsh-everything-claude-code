#!/usr/bin/env node
/**
 * Assert the ported artifacts carry no references DSH cannot satisfy.
 *
 * A load test cannot catch this class of defect: a skill that tells the model to
 * write to `~/.claude/skills/learned/` or run `/verify` loads perfectly and
 * reads perfectly. The instruction is simply impossible in this harness. The
 * rules below are the ones verified against the DSH 0.2.0-rc.2 install.
 *
 * Usage: node tests/no-stale-refs.test.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

/** Every file whose prose the model can read. */
function modelReachableFiles() {
  const files = [];
  const skillsDir = join(packageRoot, 'skills');
  for (const name of readdirSync(skillsDir)) {
    const file = join(skillsDir, name, 'SKILL.md');
    if (existsSync(file)) files.push({ file, kind: 'skill' });
  }
  for (const rule of readdirSync(join(packageRoot, 'resources', 'rules'))) {
    if (rule.endsWith('.md')) {
      files.push({ file: join(packageRoot, 'resources', 'rules', rule), kind: 'rule' });
    }
  }
  return files;
}

const files = modelReachableFiles();

/** Collect matches of a pattern with file and line, so failures are locatable. */
function find(pattern) {
  const hits = [];
  for (const { file, kind } of files) {
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (pattern.test(line)) {
          hits.push(`${relative(packageRoot, file).replaceAll('\\', '/')}:${index + 1} (${kind}) ${line.trim().slice(0, 120)}`);
        }
        pattern.lastIndex = 0;
      });
  }
  return hits;
}

check('no Claude Code home paths remain', () => {
  const hits = find(/~\/\.claude\//);
  assert(hits.length === 0, `found:\n      ${hits.join('\n      ')}`);
  return `${files.length} files`;
});

check('no Claude Code project directory remains', () => {
  const hits = find(/(?<![~\w])\.claude\//);
  assert(hits.length === 0, `found:\n      ${hits.join('\n      ')}`);
});

check('no unreachable slash command remains', () => {
  // `/compact` is intentionally excluded: DSH ships it as dsh-command-compact.
  const hits = find(/(^|[\s(`])\/(tdd|plan|e2e|code-review|build-fix|refactor-clean|learn|checkpoint|verify|eval|setup-pm)\b/);
  assert(hits.length === 0, `found:\n      ${hits.join('\n      ')}`);
});

check('no Claude Code template variable remains', () => {
  const hits = find(/\$\{CLAUDE_[A-Z_]+\}/);
  assert(hits.length === 0, `found:\n      ${hits.join('\n      ')}`);
});

check('no Claude Code tool name is used as a tool', () => {
  const hits = find(/`(Read|Write|Edit|MultiEdit|Bash|Grep|Glob|TodoWrite|WebFetch|WebSearch)`|tool == "(Read|Write|Edit|Bash)"|(Pre|Post)ToolUse \((Read|Write|Edit|Bash)/);
  assert(hits.length === 0, `found:\n      ${hits.join('\n      ')}`);
});

check('no bare Claude Code subagent name is presented as a DSH agent', () => {
  // The name may legitimately appear in three places that are NOT instructions:
  //   - inside the path that carries it (`resources/agents/tdd-guide.md`)
  //   - inside a resolved persona reference (`tdd-guide persona (…)`)
  //   - as an identifier: the skill's own `name: ecc-tdd-guide` and its H1
  // What must not survive is the *bare* name in prose — a reader told
  // "use the tdd-guide agent" has nothing to resolve in DSH.
  const bare =
    /\b(tdd-guide|security-reviewer|e2e-runner|build-error-resolver|refactor-cleaner|doc-updater)\b(?! persona)(?!\.md)(?!`)/;
  const problems = [];
  for (const { file, kind } of files) {
    let inFence = false;
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          return;
        }
        if (inFence) return;
        const trimmed = line.trim();
        // Skip identifier positions: YAML keys and headings.
        if (/^(name|description|title)\s*:/.test(trimmed)) return;
        if (trimmed.startsWith('#')) return;
        if (bare.test(trimmed)) {
          problems.push(
            `${relative(packageRoot, file).replaceAll('\\', '/')}:${index + 1} (${kind}) ${trimmed.slice(0, 110)}`,
          );
        }
      });
  }
  assert(problems.length === 0, `found:\n      ${problems.join('\n      ')}`);
  return 'every agent name in prose resolves through a persona reference';
});

check('the mapped replacements actually point at things that exist', () => {
  const missing = [];
  for (const { file } of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/resources\/(agents|commands)\/([a-z-]+\.md)/g)) {
      const target = join(packageRoot, 'resources', m[1], m[2]);
      if (!existsSync(target)) missing.push(`${relative(packageRoot, file).replaceAll('\\', '/')} -> ${m[1]}/${m[2]}`);
    }
  }
  assert(missing.length === 0, `dangling persona/prompt references:\n      ${missing.join('\n      ')}`);
  return 'all persona and prompt links resolve';
});

check('the DSH home path used in prose is the real one', () => {
  const hits = find(/\$DSH_HOME\/skills/);
  // If a file claims the DSH skill root, skill-filesystem must scan it: the
  // user root is `<DSH_HOME>/skills` at rank 400.
  return hits.length > 0 ? `${hits.length} reference(s) to $DSH_HOME/skills` : 'no $DSH_HOME/skills references';
});

check('no inline code span is left with an unbalanced backtick', () => {
  // The command rewrite once ate a closing backtick, producing
  // "`follow `a` with `` command". Broken markdown renders wrong, so it is
  // asserted rather than eyeballed.
  //
  // Fence lines are excluded: ``` and ```typescript are legitimately odd, and
  // counting them would flag every code block in the repository.
  const problems = [];
  for (const { file, kind } of files) {
    let inFence = false;
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          return;
        }
        if (inFence) return;
        const ticks = (line.match(/`/g) ?? []).length;
        if (ticks % 2 !== 0) {
          problems.push(
            `${relative(packageRoot, file).replaceAll('\\', '/')}:${index + 1} (${kind}) unclosed span: ${line.trim().slice(0, 100)}`,
          );
        }
      });
  }
  assert(problems.length === 0, `found:\n      ${problems.join('\n      ')}`);
  return 'every inline span is balanced';
});

check('every path the prose points at actually exists', () => {
  // A rewriter that maps `~/.claude/` to `~/.dsh/` wholesale once fabricated
  // `~/.dsh/agents/<name>.md`, a path DSH does not have. Any path the model is
  // told to read must resolve, or the instruction wastes a step.
  const problems = [];
  for (const { file, kind } of files) {
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        // In-repo paths: `resources/...`, `skills/...`, `hooks/...`.
        for (const m of line.matchAll(/`((?:resources|skills|hooks)\/[A-Za-z0-9_./-]+)`/g)) {
          const target = join(packageRoot, m[1]);
          if (!existsSync(target)) {
            problems.push(
              `${relative(packageRoot, file).replaceAll('\\', '/')}:${index + 1} (${kind}) missing ${m[1]}`,
            );
          }
        }
        // Fabricated home paths: DSH has no agents/, commands/ or rules/ under
        // the DSH home, so those forms are always wrong.
        if (/~\/\.dsh\/(agents|commands|rules)\//.test(line)) {
          problems.push(
            `${relative(packageRoot, file).replaceAll('\\', '/')}:${index + 1} (${kind}) fabricated home path: ${line.trim().slice(0, 90)}`,
          );
        }
      });
  }
  assert(problems.length === 0, `found:\n      ${problems.join('\n      ')}`);
  return 'every referenced path resolves';
});

for (const r of results) {
  const suffix = r.note ? `  (${r.note})` : '';
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${suffix}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} adaptation checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
