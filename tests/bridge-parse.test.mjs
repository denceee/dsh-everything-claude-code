#!/usr/bin/env node
/**
 * Validate `hooks/hooks.json` the way the DSH bridge consumes it.
 *
 * The bridge's internal parser (`parseClaudeCodeConfig`) is not exported, so
 * this cannot import it. Instead it re-implements the two rules that decide
 * whether a hook registers at all — the supported-event filter and the matcher
 * dialect — and states that limitation in its output rather than pretending to
 * be the real parser.
 *
 * Why this matters: an unsupported event or an invalid matcher is dropped
 * SILENTLY. A hooks.json can look right and register nothing, which is exactly
 * the failure mode a plain JSON-schema check misses.
 *
 * Usage: node tests/bridge-parse.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hooksPath = join(here, '..', 'hooks', 'hooks.json');
const raw = JSON.parse(readFileSync(hooksPath, 'utf8'));

/** Events the DSH Claude Code bridge supports (its README: 7 of Claude Code's 30). */
const SUPPORTED_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
]);

/**
 * Claude-dialect matcher validity, mirroring `matcherDiagnostic`.
 * A word-and-pipe pattern is literal alternation; anything else is a regex.
 */
function matcherDiagnostic(matcher) {
  if (matcher === undefined || matcher === '' || matcher === '*') return undefined;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) {
    const parts = matcher.split('|');
    return parts.every((p) => /^[A-Za-z0-9_]+$/.test(p)) ? undefined : `invalid literal alternative: ${matcher}`;
  }
  try {
    new RegExp(matcher);
    return undefined;
  } catch (error) {
    return `invalid regex: ${error.message}`;
  }
}

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

const events = Object.entries(raw.hooks ?? {});

check('hooks.json is a JSON object with a hooks key', () => {
  assert(raw && typeof raw === 'object', 'not an object');
  assert(raw.hooks && typeof raw.hooks === 'object', 'no hooks key');
});

check('every declared event is one the bridge supports', () => {
  for (const [event] of events) {
    assert(SUPPORTED_EVENTS.has(event), `"${event}" is unsupported and would be ignored silently`);
  }
});

check('at least one event is declared', () => {
  assert(events.length > 0, 'no events declared');
});

check('every matcher is valid in the Claude dialect', () => {
  for (const [event, groups] of events) {
    for (const group of groups) {
      const diagnostic = matcherDiagnostic(group.matcher);
      assert(diagnostic === undefined, `${event}: ${diagnostic}`);
    }
  }
});

check('every hook is a command handler (other types are skipped)', () => {
  for (const [event, groups] of events) {
    for (const group of groups) {
      assert(Array.isArray(group.hooks) && group.hooks.length > 0, `${event}: empty hooks array`);
      for (const hook of group.hooks) {
        assert(hook.type === 'command', `${event}: type "${hook.type}" would be skipped`);
        assert(typeof hook.command === 'string' && hook.command.trim().length > 0, `${event}: empty command`);
      }
    }
  }
});

check('every command is anchored on ${CLAUDE_PLUGIN_ROOT}', () => {
  for (const [event, groups] of events) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert(
          hook.command.includes('${CLAUDE_PLUGIN_ROOT}'),
          `${event}: command is not anchored on the plugin root: ${hook.command}`,
        );
      }
    }
  }
});

check('matchers name DSH tools, not Claude Code tools', () => {
  const claudeOnly = ['Bash', 'Write', 'Edit', 'Glob', 'Grep', 'Read', 'Task'];
  for (const [event, groups] of events) {
    for (const group of groups) {
      for (const tool of claudeOnly) {
        assert(
          !new RegExp(`(^|\\|)${tool}($|\\|)`).test(group.matcher ?? ''),
          `${event}: matcher "${group.matcher}" names the Claude Code tool "${tool}" and would never fire`,
        );
      }
    }
  }
});

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} config checks passed`);
console.log('(re-implements the bridge rules; parseClaudeCodeConfig is not exported)');
process.exit(failed.length === 0 ? 0 : 1);
