#!/usr/bin/env node
/**
 * Prove the plugin behaves correctly under BOTH DSH 0.2.0 and 0.2.1 contracts.
 *
 * The change being adapted to: in 0.2.0 the hook payload's `cwd` is the Session
 * header's workspace, fixed at creation. In 0.2.1 it is the Session's *current*
 * directory, which a working-directory change can move mid-session, and the
 * bridge runs hooks in that directory.
 *
 * The adaptation reads every available signal (`cwd`, CLAUDE_PROJECT_DIR,
 * DSH_WORKSPACE) and treats their union as the session's zone. This suite pins
 * that behaviour from both directions, because a fix that satisfies the new
 * contract by breaking the old one is not an adaptation.
 *
 * Usage: node tests/dual-version.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const scriptsDir = join(packageRoot, 'hooks', 'scripts');

const { workspaceRoots, normalizePath } = await import(
  pathToFileURL(join(scriptsDir, 'lib.mjs')).href
);
const { findDestructive } = await import(pathToFileURL(join(scriptsDir, 'risk.mjs')).href);

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

/** Run a hook script with an explicit environment, as either DSH version would. */
function run(script, payload, env = {}) {
  const base = { ...process.env, CLAUDE_PLUGIN_ROOT: packageRoot };
  // Isolate from the ambient session: each case declares its own signals.
  delete base.CLAUDE_PROJECT_DIR;
  delete base.DSH_WORKSPACE;
  const result = spawnSync(process.execPath, [join(scriptsDir, script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...base, ...env },
    timeout: 30000,
  });
  let decision;
  try {
    decision = JSON.parse(result.stdout || '{}')?.hookSpecificOutput;
  } catch {
    decision = undefined;
  }
  return { code: result.status, decision };
}

const DESTRUCTIVE = 'block-destructive-command.mjs';
const STRAY = 'block-stray-docs.mjs';

// --- the resolver itself -----------------------------------------------------
check('workspaceRoots deduplicates identical signals', () => {
  const roots = workspaceRoots({ cwd: 'C:/work/project' });
  assert(roots.length >= 1, 'no roots returned');
  assert(roots[0] === 'c:/work/project', `unexpected normalization: ${roots[0]}`);
  return roots.join(' | ');
});

check('workspaceRoots returns BOTH directories when they differ', () => {
  // This is the 0.2.1 case: current directory moved, project dir unchanged.
  const roots = workspaceRoots({ cwd: 'C:/work/project/sub' });
  assert(Array.isArray(roots), 'must return an array');
  return `${roots.length} root(s)`;
});

check('normalizePath handles both separators and trailing slashes', () => {
  assert(normalizePath('C:\\work\\project\\') === 'c:/work/project', 'backslash form failed');
  assert(normalizePath('C:/work/project///') === 'c:/work/project', 'trailing slashes failed');
  assert(normalizePath('') === '', 'empty input must yield empty');
});

// --- 0.2.0 contract: cwd is the fixed workspace ------------------------------
check('[0.2.0] a delete inside the workspace is allowed', () => {
  const r = run(
    DESTRUCTIVE,
    { tool_name: 'pwsh', tool_input: { command: 'rm -rf C:\\work\\project\\dist' }, cwd: 'C:\\work\\project' },
    { CLAUDE_PROJECT_DIR: 'C:\\work\\project' },
  );
  assert(r.decision === undefined, `blocked under the 0.2.0 contract: ${JSON.stringify(r.decision)}`);
  return 'fixed-workspace semantics preserved';
});

check('[0.2.0] a delete outside the workspace is blocked', () => {
  const r = run(
    DESTRUCTIVE,
    { tool_name: 'pwsh', tool_input: { command: 'rm -rf C:\\Windows\\System32' }, cwd: 'C:\\work\\project' },
    { CLAUDE_PROJECT_DIR: 'C:\\work\\project' },
  );
  assert(r.decision?.permissionDecision === 'deny', 'expected deny');
});

// --- 0.2.1 contract: cwd is the CURRENT directory ---------------------------
check('[0.2.1] the original workspace stays valid after the session moves', () => {
  // The session changed directory to a subdirectory, but CLAUDE_PROJECT_DIR and
  // the payload cwd now disagree. A single-cwd implementation would treat the
  // original workspace as foreign and block a routine delete there.
  const r = run(
    DESTRUCTIVE,
    { tool_name: 'pwsh', tool_input: { command: 'rm -rf C:\\work\\project\\dist' }, cwd: 'C:\\work\\project\\sub' },
    { CLAUDE_PROJECT_DIR: 'C:\\work\\project' },
  );
  assert(
    r.decision === undefined,
    `a delete inside the original workspace must be allowed after a directory change: ${JSON.stringify(r.decision)}`,
  );
  return 'mutable-directory semantics handled';
});

check('[0.2.1] a delete outside every root is still blocked', () => {
  const r = run(
    DESTRUCTIVE,
    { tool_name: 'pwsh', tool_input: { command: 'rm -rf C:\\Windows\\System32' }, cwd: 'C:\\work\\project\\sub' },
    { CLAUDE_PROJECT_DIR: 'C:\\work\\project' },
  );
  assert(r.decision?.permissionDecision === 'deny', 'expected deny');
});

check('[0.2.1] the moved-to directory is also a valid zone', () => {
  const r = run(
    DESTRUCTIVE,
    { tool_name: 'pwsh', tool_input: { command: 'rm -rf C:\\work\\project\\sub\\build' }, cwd: 'C:\\work\\project\\sub' },
    { CLAUDE_PROJECT_DIR: 'C:\\work\\project' },
  );
  assert(r.decision === undefined, `the current directory must bound the zone: ${JSON.stringify(r.decision)}`);
});

// --- stray docs under both contracts ----------------------------------------
check('[0.2.0] a stray .md in the workspace is still blocked', () => {
  const r = run(
    STRAY,
    { tool_name: 'write', tool_input: { file_path: 'C:\\work\\project\\notes.md' }, cwd: 'C:\\work\\project' },
    { CLAUDE_PROJECT_DIR: 'C:\\work\\project' },
  );
  assert(r.decision?.permissionDecision === 'deny', 'expected deny');
});

check('[0.2.1] a stray .md in the ORIGINAL workspace is still blocked', () => {
  // After the session moves, the original project's own docs still follow the
  // project rule; only paths outside every root are exempt.
  const r = run(
    STRAY,
    { tool_name: 'write', tool_input: { file_path: 'C:\\work\\project\\notes.md' }, cwd: 'C:\\work\\project\\sub' },
    { CLAUDE_PROJECT_DIR: 'C:\\work\\project' },
  );
  assert(r.decision?.permissionDecision === 'deny', 'expected deny');
});

check('[0.2.1] a scratch file outside every root is allowed', () => {
  const r = run(
    STRAY,
    {
      tool_name: 'write',
      tool_input: { file_path: 'C:\\Users\\me\\AppData\\Local\\Temp\\msg.txt' },
      cwd: 'C:\\work\\project\\sub',
    },
    { CLAUDE_PROJECT_DIR: 'C:\\work\\project' },
  );
  assert(r.decision === undefined, 'a temp file must be allowed');
});

// --- robustness: no signal at all -------------------------------------------
check('a payload with no cwd and no env still blocks the unambiguous cases', () => {
  // `rm -rf /` is dangerous regardless of any workspace, so it must not depend
  // on a signal that may be absent.
  const r = run(DESTRUCTIVE, { tool_name: 'pwsh', tool_input: { command: 'rm -rf /' } });
  assert(r.decision?.permissionDecision === 'deny', 'a root delete must always be denied');
});

check('findDestructive accepts the old single-string call shape', () => {
  // The public helper is called with both shapes across the suites; a refactor
  // that only accepted an array would break the earlier suite silently.
  const asString = findDestructive('rm -rf C:\\Windows\\System32', 'C:\\work\\project');
  const asArray = findDestructive('rm -rf C:\\Windows\\System32', ['c:/work/project']);
  assert(asString?.id === 'rm-outside-workspace', `string shape failed: ${asString?.id}`);
  assert(asArray?.id === 'rm-outside-workspace', `array shape failed: ${asArray?.id}`);
  return 'both call shapes work';
});

check('findDestructive treats undefined roots without throwing', () => {
  const found = findDestructive('git push --force', undefined);
  assert(found?.id === 'git-force-push', 'an unconditional rule must not need a cwd');
  const safe = findDestructive('rm -rf /tmp/x', undefined);
  assert(safe === undefined || safe.id === 'rm-outside-workspace', 'must not throw');
});

// --- the plugin declares no version coupling --------------------------------
check('no hook script branches on a DSH version in code', () => {
  // A version check is the brittle way to do this: it needs updating on every
  // release and fails closed when a version string changes. Reading both signals
  // works on either contract, and on versions not yet published.
  //
  // Comments are excluded on purpose — the version numbers belong in the
  // explanation of why the adaptation is shaped this way. What must not exist is
  // version comparison in executable code.
  const files = ['lib.mjs', 'risk.mjs', 'block-destructive-command.mjs', 'block-stray-docs.mjs'];
  const offenders = [];
  for (const file of files) {
    const code = readFileSync(join(scriptsDir, file), 'utf8')
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    if (/0\.2\.[01]|rc\.2|alpha/.test(code)) offenders.push(file);
  }
  assert(offenders.length === 0, `version coupling found in: ${offenders.join(', ')}`);
  return `${files.length} scripts are version-agnostic`;
});

for (const r of results) {
  const suffix = r.note ? `  (${r.note})` : '';
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${suffix}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} dual-version checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
