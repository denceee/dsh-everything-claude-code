#!/usr/bin/env node
/**
 * Exercise every adapted ECC hook against the real DSH hook contract.
 *
 * The DSH bridge decodes a hook process as:
 *   exit 0 + JSON/stdout -> structured outcome (hookSpecificOutput, plain context)
 *   exit 2 + stderr      -> blocking decision, stderr is the reason
 *   other exit           -> non-blocking error, run continues
 *
 * This harness runs each hook exactly as the bridge does (JSON payload on stdin)
 * and asserts the decoded outcome, so a hook cannot silently stop working.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const config = JSON.parse(readFileSync(join(packageRoot, 'hooks', 'hooks.json'), 'utf8'));

/**
 * Apply the same substitution the DSH bridge performs at config-parse time.
 * Without this the raw `${CLAUDE_PLUGIN_ROOT}` reaches node and nothing runs.
 */
function substitute(command) {
  return command
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', packageRoot)
    .replaceAll('${CLAUDE_PROJECT_DIR}', packageRoot);
}

/** Select the matcher group that applies to `subject`, mirroring the bridge. */
function groupFor(event, subject) {
  const group = (config.hooks[event] ?? []).find((g) => {
    const m = g.matcher;
    if (m === undefined || m === '' || m === '*') return true;
    // Claude dialect: a bare word-and-pipe pattern is literal alternation.
    if (/^[A-Za-z0-9_|]+$/.test(m)) return m.split('|').includes(subject);
    return new RegExp(m).test(subject);
  });
  if (!group) throw new Error(`no ${event} hook matches "${subject}"`);
  return group;
}

/** The first command of the matching group, with plugin-root substitution applied. */
function pick(event, subject) {
  return substitute(groupFor(event, subject).hooks[0].command);
}

/** Every command of the matching group, substituted. */
function pickAll(event, subject) {
  return groupFor(event, subject).hooks.map((hook) => substitute(hook.command));
}

/** Run one hook command the way the bridge does. */
function runHook(command, payload) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: packageRoot, CLAUDE_PLUGIN_ROOT: packageRoot };
  const result = spawnSync(command, {
    input: JSON.stringify(payload),
    shell: true,
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
  return { code: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true, detail: '' });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// --- PreToolUse: dev server must block --------------------------------------
// Blocking is asserted on the channel the DSH bridge actually honors
// (`permissionDecision: 'deny'` on stdout, exit 0). Asserting exit 2 here was a
// wrong test: it passed while the real bridge recorded exit 2 as a non-blocking
// error and let the command run.
check('PreToolUse/pwsh blocks a dev server', () => {
  const [devServer] = pickAll('PreToolUse', 'pwsh');
  const r = runHook(devServer, { tool_name: 'pwsh', tool_input: { command: 'npm run dev' } });
  assert(r.code === 0, `expected clean exit 0 so the bridge reads stdout, got ${r.code}`);
  const decision = JSON.parse(r.stdout || '{}')?.hookSpecificOutput;
  assert(decision?.permissionDecision === 'deny', `expected deny, got: ${r.stdout}`);
  assert(decision?.hookEventName === 'PreToolUse', 'hookEventName must name the firing event');
  assert(/dev server/i.test(decision?.permissionDecisionReason ?? ''), 'expected a reason naming the dev server');
});

check('PreToolUse/pwsh allows an ordinary command', () => {
  const [devServer] = pickAll('PreToolUse', 'pwsh');
  const r = runHook(devServer, { tool_name: 'pwsh', tool_input: { command: 'git status' } });
  assert(r.code === 0, `expected exit 0, got ${r.code}; stderr=${r.stderr}`);
});

check('PreToolUse/pwsh reminds about a long-running command', () => {
  const [, longRunning] = pickAll('PreToolUse', 'pwsh');
  const r = runHook(longRunning, { tool_name: 'pwsh', tool_input: { command: 'npm test' } });
  assert(r.code === 0, `expected a non-blocking exit 0, got ${r.code}`);
  assert(/background/i.test(r.stderr), `expected a background-job reminder, got: ${r.stderr}`);
});

check('PreToolUse/pwsh asks before git push', () => {
  const [, , gitPush] = pickAll('PreToolUse', 'pwsh');
  const r = runHook(gitPush, { tool_name: 'pwsh', tool_input: { command: 'git push origin main' } });
  assert(r.code === 0, `expected exit 0, got ${r.code}; stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout || '{}');
  assert(
    parsed?.hookSpecificOutput?.permissionDecision === 'ask',
    `expected permissionDecision=ask, got ${r.stdout}`,
  );
});

check('PreToolUse/pwsh git-push hook stays clean on other commands', () => {
  const [, , gitPush] = pickAll('PreToolUse', 'pwsh');
  const r = runHook(gitPush, { tool_name: 'pwsh', tool_input: { command: 'git commit -m x' } });
  assert(r.code === 0, `expected exit 0, got ${r.code}; stderr=${r.stderr}`);
  assert(JSON.parse(r.stdout || '{}')?.hookSpecificOutput === undefined, 'expected no decision');
});

// --- PreToolUse: stray markdown must block ----------------------------------
check('PreToolUse/write blocks a stray .md file', () => {
  const cmd = pick('PreToolUse', 'write');
  const r = runHook(cmd, { tool_name: 'write', tool_input: { file_path: 'notes.md' } });
  assert(r.code === 0, `expected clean exit 0 so the bridge reads stdout, got ${r.code}`);
  const decision = JSON.parse(r.stdout || '{}')?.hookSpecificOutput;
  assert(decision?.permissionDecision === 'deny', `expected deny, got: ${r.stdout}`);
  assert(/stray/i.test(decision?.permissionDecisionReason ?? ''), 'expected a reason naming the stray file');
});

check('PreToolUse/write never uses the exit-code channel it cannot rely on', () => {
  const cmd = pick('PreToolUse', 'write');
  const r = runHook(cmd, { tool_name: 'write', tool_input: { file_path: 'notes.md' } });
  assert(r.code !== 2, 'exit 2 is recorded as a non-blocking error by this bridge');
});

check('PreToolUse/write allows README.md', () => {
  const cmd = pick('PreToolUse', 'write');
  const r = runHook(cmd, { tool_name: 'write', tool_input: { file_path: 'README.md' } });
  assert(r.code === 0, `expected exit 0, got ${r.code}; stderr=${r.stderr}`);
});

check('PreToolUse/write allows a docs/ path', () => {
  const cmd = pick('PreToolUse', 'write');
  const r = runHook(cmd, { tool_name: 'write', tool_input: { file_path: 'docs/guide.md' } });
  assert(r.code === 0, `expected exit 0, got ${r.code}; stderr=${r.stderr}`);
});

// A published repository needs these. Blocking them pushed this very project
// into a false positive while writing README.zh.md, so the allowance is pinned.
for (const allowed of ['README.zh.md', 'README.zh-CN.md', 'NOTICE', 'CHANGELOG.md', 'LICENSE']) {
  check(`PreToolUse/write allows ${allowed}`, () => {
    const cmd = pick('PreToolUse', 'write');
    const r = runHook(cmd, { tool_name: 'write', tool_input: { file_path: allowed } });
    assert(r.code === 0, `expected exit 0 for ${allowed}, got ${r.code}; stderr=${r.stderr}`);
  });
}

// --- PreToolUse/SessionStart sanity ----------------------------------------
check('PreToolUse/edit|write matcher selects the edit tool', () => {
  const cmd = pick('PreToolUse', 'edit');
  assert(typeof cmd === 'string' && cmd.length > 0, 'no command resolved for matcher edit|write');
});

check('SessionStart attaches context', () => {
  const cmd = pick('SessionStart', 'startup');
  const r = runHook(cmd, { hook_event_name: 'SessionStart', source: 'startup' });
  assert(r.code === 0, `expected exit 0, got ${r.code}`);
  const parsed = JSON.parse(r.stdout || '{}');
  const text = parsed?.hookSpecificOutput?.additionalContext ?? '';
  assert(text.length > 0, 'expected non-empty additionalContext');
  assert(/resources\/rules\//.test(text), `expected the ECC rules in context, got: ${text.slice(0, 300)}`);
  assert(/security|testing|coding-style/i.test(text), 'expected real rule content, not just headings');
});

check('SessionStart context names the published skills', () => {
  const cmd = pick('SessionStart', 'startup');
  const r = runHook(cmd, { hook_event_name: 'SessionStart', source: 'startup' });
  const text = JSON.parse(r.stdout || '{}')?.hookSpecificOutput?.additionalContext ?? '';
  assert(/tdd-workflow/.test(text), `expected skill names in context, got: ${text.slice(0, 300)}`);
});

check('SessionStart does not leak a stray non-JSON line', () => {
  const cmd = pick('SessionStart', 'startup');
  const r = runHook(cmd, { hook_event_name: 'SessionStart', source: 'startup' });
  JSON.parse(r.stdout);
});

// --- PostToolUse ------------------------------------------------------------
check('PostToolUse/pwsh reports a created PR', () => {
  const cmd = pick('PostToolUse', 'pwsh');
  const r = runHook(cmd, {
    tool_name: 'pwsh',
    tool_input: { command: 'gh pr create --fill' },
    tool_response: 'https://github.com/affaan-m/everything-claude-code/pull/42',
  });
  assert(r.code === 0, `expected exit 0, got ${r.code}`);
  assert(/pull\/42/.test(r.stderr), `expected the PR URL in stderr, got: ${r.stderr}`);
});

check('PostToolUse/pwsh stays silent for other commands', () => {
  const cmd = pick('PostToolUse', 'pwsh');
  const r = runHook(cmd, { tool_name: 'pwsh', tool_input: { command: 'ls' }, tool_response: 'ok' });
  assert(r.code === 0, `expected exit 0, got ${r.code}`);
  assert(r.stderr === '', `expected no stderr, got: ${r.stderr}`);
});

// --- Stop -------------------------------------------------------------------
check('Stop passes through outside a git repository', () => {
  const cmd = pick('Stop', 'stop');
  const r = runHook(cmd, { hook_event_name: 'Stop' });
  assert(r.code === 0, `expected exit 0, got ${r.code}; stderr=${r.stderr}`);
});

// --- config validity --------------------------------------------------------
check('every hook command is a non-empty string', () => {
  for (const [event, groups] of Object.entries(config.hooks)) {
    for (const group of groups) {
      assert(Array.isArray(group.hooks) && group.hooks.length > 0, `${event}: empty hooks array`);
      for (const hook of group.hooks) {
        assert(hook.type === 'command', `${event}: unsupported hook type ${hook.type}`);
        assert(typeof hook.command === 'string' && hook.command.length > 0, `${event}: empty command`);
      }
    }
  }
});

check('every matcher is valid for the Claude dialect', () => {
  const supported = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']);
  for (const [event, groups] of Object.entries(config.hooks)) {
    assert(supported.has(event), `unsupported event "${event}" would be silently ignored`);
    for (const group of groups) {
      const m = group.matcher;
      if (m === undefined || m === '' || m === '*') continue;
      if (/^[A-Za-z0-9_|]+$/.test(m)) continue;
      new RegExp(m); // throws on an invalid regex, which the bridge would reject
    }
  }
});

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} hook checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
