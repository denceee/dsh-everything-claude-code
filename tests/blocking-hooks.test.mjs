#!/usr/bin/env node
/**
 * Drive the two new blocking hooks the way the bridge does.
 *
 * `risk-detection.test.mjs` proves the matching logic; this proves the *scripts*
 * honour the bridge contract — a clean exit 0 with `permissionDecision` on
 * stdout, which is the only blocking channel this bridge honours. A script that
 * gets the logic right but blocks through exit code 2 protects nothing.
 *
 * Usage: node tests/blocking-hooks.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const scriptsDir = join(packageRoot, 'hooks', 'scripts');

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push({ name, ok: true, note: typeof note === 'string' ? note : undefined });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Run one hook script the way the bridge does: JSON on stdin, read stdout. */
function run(script, payload) {
  const result = spawnSync(process.execPath, [join(scriptsDir, script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: packageRoot, CLAUDE_PROJECT_DIR: 'C:\\work\\project' },
    timeout: 30000,
  });
  let decision;
  try {
    decision = JSON.parse(result.stdout || '{}')?.hookSpecificOutput;
  } catch {
    decision = undefined;
  }
  return { code: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim(), decision };
}

const SECRET_HOOK = 'block-hardcoded-secret.mjs';
const DESTRUCTIVE_HOOK = 'block-destructive-command.mjs';

// --- secrets: the positive cases -------------------------------------------
check('blocks writing an OpenAI key into source', () => {
  const r = run(SECRET_HOOK, {
    tool_name: 'write',
    tool_input: { file_path: 'src/config.ts', content: 'const apiKey = "sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2"' },
  });
  assert(r.code === 0, `expected clean exit 0, got ${r.code}`);
  assert(r.decision?.permissionDecision === 'deny', `expected deny, got ${r.stdout}`);
  assert(/credential/i.test(r.decision?.permissionDecisionReason ?? ''), 'reason does not name the problem');
  return r.decision.permissionDecisionReason.split('\n')[0].slice(0, 60);
});

check('blocks a GitHub token in an edit replacement', () => {
  const r = run(SECRET_HOOK, {
    tool_name: 'edit',
    tool_input: {
      file_path: 'app/settings.py',
      old_string: 'TOKEN = None',
      new_string: `TOKEN = "ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}"`,
    },
  });
  assert(r.decision?.permissionDecision === 'deny', `expected deny, got ${r.stdout}`);
});

check('blocks a private key written into a source file', () => {
  const r = run(SECRET_HOOK, {
    tool_name: 'write',
    tool_input: { file_path: 'deploy/key.ts', content: 'const pem = `-----BEGIN RSA PRIVATE KEY-----`' },
  });
  assert(r.decision?.permissionDecision === 'deny', `expected deny, got ${r.stdout}`);
});

// --- secrets: the exemptions ------------------------------------------------
check('allows a real key written into .env, where it belongs', () => {
  const r = run(SECRET_HOOK, {
    tool_name: 'write',
    tool_input: { file_path: '.env', content: 'OPENAI_API_KEY=sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2' },
  });
  assert(r.code === 0, `expected exit 0, got ${r.code}`);
  assert(r.decision === undefined, `a key store must be allowed, got ${r.stdout}`);
});

check('allows a test fixture with a plausible-looking key', () => {
  const r = run(SECRET_HOOK, {
    tool_name: 'write',
    tool_input: {
      file_path: 'tests/fixtures/auth.test.ts',
      content: 'const apiKey = "sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2"',
    },
  });
  assert(r.decision === undefined, `fixtures must be allowed, got ${r.stdout}`);
});

check("allows this bundle's own documented placeholder", () => {
  const r = run(SECRET_HOOK, {
    tool_name: 'write',
    tool_input: { file_path: 'docs/security.md', content: 'const apiKey = "sk-proj-xxxxx"' },
  });
  assert(r.decision === undefined, `a placeholder must be allowed, got ${r.stdout}`);
});

check('allows an env indirection', () => {
  const r = run(SECRET_HOOK, {
    tool_name: 'write',
    tool_input: { file_path: 'src/config.ts', content: 'const apiKey = process.env.OPENAI_API_KEY' },
  });
  assert(r.decision === undefined, `indirection must be allowed, got ${r.stdout}`);
});

check('allows an ordinary write with no secret', () => {
  const r = run(SECRET_HOOK, {
    tool_name: 'write',
    tool_input: { file_path: 'src/util.ts', content: 'export const add = (a: number, b: number) => a + b;' },
  });
  assert(r.decision === undefined, `ordinary code must be allowed, got ${r.stdout}`);
});

// --- destructive commands ---------------------------------------------------
check('blocks git push --force', () => {
  const r = run(DESTRUCTIVE_HOOK, { tool_name: 'pwsh', tool_input: { command: 'git push --force origin main' } });
  assert(r.code === 0, `expected clean exit 0, got ${r.code}`);
  assert(r.decision?.permissionDecision === 'deny', `expected deny, got ${r.stdout}`);
  return r.decision.permissionDecisionReason.split('\n')[0].slice(0, 60);
});

check('blocks git reset --hard', () => {
  const r = run(DESTRUCTIVE_HOOK, { tool_name: 'pwsh', tool_input: { command: 'git reset --hard HEAD~5' } });
  assert(r.decision?.permissionDecision === 'deny', `expected deny, got ${r.stdout}`);
});

check('blocks rm -rf on an unscoped path', () => {
  const r = run(DESTRUCTIVE_HOOK, { tool_name: 'pwsh', tool_input: { command: 'rm -rf /', cwd: 'C:\\work\\project' } });
  assert(r.decision?.permissionDecision === 'deny', `expected deny, got ${r.stdout}`);
});

check('blocks a delete outside the session workspace', () => {
  const r = run(DESTRUCTIVE_HOOK, {
    tool_name: 'pwsh',
    tool_input: { command: 'rm -rf C:\\Windows\\System32', cwd: 'C:\\work\\project' },
    cwd: 'C:\\work\\project',
  });
  assert(r.decision?.permissionDecision === 'deny', `expected deny, got ${r.stdout}`);
});

check('allows an ordinary git push', () => {
  const r = run(DESTRUCTIVE_HOOK, { tool_name: 'pwsh', tool_input: { command: 'git push origin main' } });
  assert(r.decision === undefined, `routine push must be allowed, got ${r.stdout}`);
});

check('allows rm -rf of a build directory inside the workspace', () => {
  const r = run(DESTRUCTIVE_HOOK, {
    tool_name: 'pwsh',
    tool_input: { command: 'rm -rf C:\\work\\project\\dist', cwd: 'C:\\work\\project' },
    cwd: 'C:\\work\\project',
  });
  assert(r.decision === undefined, `a scoped clean must be allowed, got ${r.stdout}`);
});

check('allows git clean -n, the dry run', () => {
  const r = run(DESTRUCTIVE_HOOK, { tool_name: 'pwsh', tool_input: { command: 'git clean -n' } });
  assert(r.decision === undefined, `a dry run must be allowed, got ${r.stdout}`);
});

check('allows an unrelated command', () => {
  const r = run(DESTRUCTIVE_HOOK, { tool_name: 'pwsh', tool_input: { command: 'npm run test' } });
  assert(r.decision === undefined, `unrelated commands must be allowed, got ${r.stdout}`);
});

// --- stray-docs scoping ------------------------------------------------------
const STRAY_HOOK = 'block-stray-docs.mjs';
const WORKSPACE = 'C:\\work\\project';

check('blocks a stray .md inside the workspace', () => {
  const r = run(STRAY_HOOK, {
    tool_name: 'write',
    tool_input: { file_path: `${WORKSPACE}\\notes.md` },
    cwd: WORKSPACE,
  });
  assert(r.decision?.permissionDecision === 'deny', `expected deny, got ${r.stdout}`);
  return 'scoped rule still active where it applies';
});

check('blocks a stray .md given as a relative path', () => {
  // A relative path is relative to the workspace, so it is inside by
  // definition. An absolute-only outside-check that ignores this lets the whole
  // rule through for the ordinary case.
  const r = run(STRAY_HOOK, {
    tool_name: 'write',
    tool_input: { file_path: 'notes.md' },
    cwd: WORKSPACE,
  });
  assert(r.decision?.permissionDecision === 'deny', `expected deny, got ${r.stdout}`);
});

check('allows a scratch file outside the workspace', () => {
  // Documentation consolidation is a claim about this project. Policing temp
  // files elsewhere denied writing a commit message, which is not a stray doc.
  const r = run(STRAY_HOOK, {
    tool_name: 'write',
    tool_input: { file_path: 'C:\\Users\\me\\AppData\\Local\\Temp\\commit-msg.txt' },
    cwd: WORKSPACE,
  });
  assert(r.decision === undefined, `a temp file must be allowed, got ${r.stdout}`);
});

check('allows a note elsewhere on disk', () => {
  const r = run(STRAY_HOOK, {
    tool_name: 'write',
    tool_input: { file_path: 'D:\\other-project\\notes.md' },
    cwd: WORKSPACE,
  });
  assert(r.decision === undefined, `outside the project must be allowed, got ${r.stdout}`);
});

check('still allows the conventional root documents', () => {
  for (const name of ['README.md', 'README.zh.md', 'NOTICE', 'CHANGELOG.md', 'LICENSE']) {
    const r = run(STRAY_HOOK, {
      tool_name: 'write',
      tool_input: { file_path: `${WORKSPACE}\\${name}` },
      cwd: WORKSPACE,
    });
    assert(r.decision === undefined, `${name} must be allowed, got ${r.stdout}`);
  }
  return '5 conventional documents';
});

// --- contract ---------------------------------------------------------------
check('the new hooks never block through the exit-code channel', () => {
  // exit 2 is recorded as a non-blocking error by this bridge, so a script that
  // used it would appear to work while blocking nothing.
  for (const [script, payload] of [
    [SECRET_HOOK, { tool_name: 'write', tool_input: { file_path: 'a.ts', content: 'x = "sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2"' } }],
    [DESTRUCTIVE_HOOK, { tool_name: 'pwsh', tool_input: { command: 'git push --force' } }],
  ]) {
    const r = run(script, payload);
    assert(r.code !== 2, `${script} used exit 2, which this bridge ignores`);
  }
});

check('a malformed payload does not throw', () => {
  const bad = spawnSync(process.execPath, [join(scriptsDir, SECRET_HOOK)], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: packageRoot },
    timeout: 30000,
  });
  assert(bad.status === 0, `expected exit 0 on malformed input, got ${bad.status}: ${bad.stderr.slice(0, 200)}`);
});

check('every wired hook script exists on disk', () => {
  const config = JSON.parse(readFileSync(join(packageRoot, 'hooks', 'hooks.json'), 'utf8'));
  const missing = [];
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const m = /scripts[\\/]([a-z0-9-]+\.mjs)/.exec(hook.command);
        if (!m) continue;
        const full = join(scriptsDir, m[1]);
        try {
          readFileSync(full);
        } catch {
          missing.push(m[1]);
        }
      }
    }
  }
  assert(missing.length === 0, `missing scripts: ${missing.join(', ')}`);
  return 'all referenced scripts present';
});

for (const r of results) {
  const suffix = r.note ? `  (${r.note})` : '';
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${suffix}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} blocking-hook checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
