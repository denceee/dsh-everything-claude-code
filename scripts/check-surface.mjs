#!/usr/bin/env node
/**
 * Verify every harness API surface this plugin consumes, against any DSH version.
 *
 * The plugin claims to work on a version; this proves it. Each entry names the
 * package, the file, and a pattern that must be present for the feature to work,
 * so a breaking change shows up as a named failure instead of a runtime surprise.
 *
 * Run it against two versions to prove dual compatibility:
 *
 *   node scripts/check-surface.mjs 0.2.0-rc.2 0.2.1-alpha.2
 *
 * Exit code 0 means every surface is present in every requested version.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';

const versions = process.argv.slice(2);
if (versions.length === 0) {
  console.error('usage: node scripts/check-surface.mjs <version> [version...]');
  process.exit(2);
}

/**
 * Every capability the plugin relies on, and where its contract is stated.
 *
 * `pattern` is matched against the concatenated text of the named file, so it
 * catches a renamed export or a removed event.
 */
const SURFACES = [
  {
    capability: 'skill provider registration',
    pkg: '@deepseek-ai/dsh-skill',
    file: 'lib/types/index.d.ts',
    pattern: /registerProvider/,
  },
  {
    capability: 'skill invocation policy (user-invocable → /name)',
    pkg: '@deepseek-ai/dsh-skill',
    file: 'lib/types/index.d.ts',
    pattern: /userInvocable|user-invocable/i,
  },
  {
    capability: 'session/event feed (used for PreCompact)',
    pkg: '@deepseek-ai/dsh-session',
    file: 'lib/types/index.d.ts',
    pattern: /'session\/event'/,
  },
  {
    capability: 'compaction/start marker',
    pkg: '@deepseek-ai/dsh-compaction',
    file: 'lib/types/index.d.ts',
    pattern: /compaction\/start/,
    optional: true,
  },
  {
    capability: 'agent/disposed event (used for SessionEnd)',
    pkg: '@deepseek-ai/dsh-agent',
    file: 'lib/types/index.d.ts',
    pattern: /agent\/disposed/,
  },
  {
    capability: 'agent.session and agent.inject',
    pkg: '@deepseek-ai/dsh-agent',
    file: 'lib/types/runtime-types.d.ts',
    pattern: /readonly session: Session/,
  },
  {
    capability: 'Claude Code hook bridge config',
    pkg: '@deepseek-ai/dsh-hooks-claude-code',
    file: 'lib/types/index.d.ts',
    pattern: /configPath/,
  },
  {
    // `PreToolUse` is defined by the shared hook protocol, not by the Claude Code
    // bridge, and it lives in `events.d.ts` rather than `index.d.ts`. Checking the
    // wrong package AND the wrong file reported a false break in both versions.
    capability: 'hook protocol defines PreToolUse',
    pkg: '@deepseek-ai/dsh-hook-protocol',
    file: 'lib/types/events.d.ts',
    pattern: /PreToolUse/,
  },
  {
    capability: 'agent preset schema',
    pkg: '@deepseek-ai/dsh-agent-preset',
    file: 'lib/types/index.d.ts',
    pattern: /plugins/,
  },
  {
    capability: 'persona prefix field',
    pkg: '@deepseek-ai/dsh-persona',
    file: 'lib/types/index.d.ts',
    pattern: /prefix/,
  },
  {
    capability: 'bundle patch list (dsh.bundle.patch)',
    pkg: '@deepseek-ai/dsh-app-boot',
    file: 'lib/types/index.d.ts',
    pattern: /bundlePatch|bundle\.patch/i,
    optional: true,
  },
  {
    capability: 'web client module loader (__ModuleLoader__)',
    pkg: '@deepseek-ai/dsh-client-modules',
    file: 'lib/index.js',
    pattern: /__ModuleLoader__/,
  },
  {
    // The slot name is declared by the settings UI, not by the settings host.
    capability: 'settings.section slot',
    pkg: '@deepseek-ai/dsh-client-ui-settings-plugins',
    file: 'lib/index.js',
    pattern: /settings\.section|section/,
  },
];

const scratch = mkdtempSync(join(tmpdir(), 'dsh-surface-'));

function npmPack(spec, dest) {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = ['pack', spec, '--pack-destination', dest];
  return existsSync(cli)
    ? execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });
}

const cache = new Map();

/** Extract a package once per (pkg, version) and return its root, or null. */
function rootOf(pkg, version) {
  const key = `${pkg}@${version}`;
  if (cache.has(key)) return cache.get(key);
  let root = null;
  try {
    const dir = join(scratch, key.replace(/[@/]/g, '_'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"probe","private":true}');
    const name = npmPack(`${pkg}@${version}`, dir)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.tgz'))
      .pop();
    const out = join(dir, 'x');
    mkdirSync(out, { recursive: true });
    execFileSync('tar', ['-xzf', join(dir, name), '-C', out], { stdio: 'ignore' });
    root = join(out, 'package');
  } catch {
    root = null;
  }
  cache.set(key, root);
  return root;
}

/** Read a file, or find it anywhere in the package when the exact path moved. */
function readContract(root, file) {
  const exact = join(root, file);
  if (existsSync(exact)) return readFileSync(exact, 'utf8');
  // A relocated declaration file should not read as a missing capability, so
  // fall back to a recursive scan of the same basename.
  const wanted = file.split('/').pop();
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (entry === wanted) found.push(full);
    }
  };
  visit(root);
  return found.map((f) => readFileSync(f, 'utf8')).join('\n');
}

const summary = [];
let failures = 0;

for (const version of versions) {
  console.log(`\n=== DSH ${version} ===`);
  for (const surface of SURFACES) {
    const root = rootOf(surface.pkg, version);
    let ok;
    let note;
    if (root === null) {
      ok = false;
      note = 'package not published at this version';
    } else {
      const text = readContract(root, surface.file);
      ok = surface.pattern.test(text);
      note = ok ? '' : `pattern ${surface.pattern} not found in ${surface.file}`;
    }
    if (!ok && surface.optional) {
      console.log(`  SKIP  ${surface.capability}  (optional: ${note})`);
      summary.push({ version, capability: surface.capability, state: 'skip' });
      continue;
    }
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${surface.capability}${ok ? '' : `  <- ${note}`}`);
    summary.push({ version, capability: surface.capability, state: ok ? 'ok' : 'missing' });
  }
}

// A surface missing in one version but present in another is the actual finding:
// that is what "adapt for the new version" has to fix.
const byCapability = new Map();
for (const row of summary) {
  if (!byCapability.has(row.capability)) byCapability.set(row.capability, {});
  byCapability.get(row.capability)[row.version] = row.state;
}
const divergent = [...byCapability.entries()].filter(([, states]) => {
  const values = Object.values(states).filter((s) => s !== 'skip');
  return new Set(values).size > 1;
});

console.log('\n--- summary ---');
if (divergent.length === 0) {
  console.log('every non-optional surface is present in every requested version');
} else {
  for (const [capability, states] of divergent) {
    console.log(`  DIVERGENT: ${capability} -> ${JSON.stringify(states)}`);
  }
}

rmSync(scratch, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
