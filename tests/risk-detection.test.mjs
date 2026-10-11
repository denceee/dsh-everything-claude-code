#!/usr/bin/env node
/**
 * Verify the detection logic before any hook depends on it.
 *
 * A false positive is the expensive failure here: a rule that fires on ordinary
 * work gets switched off, and then it protects nothing. So the negative cases
 * matter as much as the positive ones — in particular the nine secret-shaped
 * examples this bundle ships in its own ported security guidance, which a
 * name-keyed rule would block.
 *
 * Usage: node tests/risk-detection.test.mjs
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const { classifySecret, findSecrets, findDestructive } = await import(
  pathToFileURL(join(packageRoot, 'hooks', 'scripts', 'risk.mjs')).href
);

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

// --- secret shape: real credentials are caught ------------------------------
const REAL_SECRETS = [
  ['OpenAI', `sk-proj-${'A1b2C3d4E5f6G7h8I9j0K1l2'}`],
  ['Anthropic', `sk-ant-api03-${'x9Y8z7W6v5U4t3S2r1Q0p'}abc`],
  ['GitHub', `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`],
  ['GitHub fine-grained', `github_pat_${'11AAAAAAA0BBBBBBBBBB_'.repeat(2)}${'c'.repeat(20)}`],
  ['AWS access key', `AKIA${'IOSFODNN7EXAMPLE'.slice(0, 16)}`],
  ['Google API', `AIza${'SyD9x8Y7w6V5u4T3s2R1q0P9o8N7m6L5k4J'}`],
  ['Slack', `xoxb-${'123456789012-abcdefghijklmnop'}`],
  ['npm', `npm_${'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8'}`],
  ['GitLab', `glpat-${'aB3dE5gH7jK9lM1nO3qR'}`],
  ['Hugging Face', `hf_${'aB3dE5gH7jK9lM1nO3qR5sT7uV9wX1yZ'}`],
  ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
];

for (const [issuer, value] of REAL_SECRETS) {
  check(`detects a real ${issuer} credential`, () => {
    const found = classifySecret(value);
    assert(found !== undefined, `not detected: ${value.slice(0, 12)}…`);
    return found;
  });
}

check('detects a JWT', () => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${'eyJzdWIiOiIxMjM0NTY3ODkwIn0'}.${'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'}`;
  assert(classifySecret(jwt) === 'JWT', 'JWT not detected');
});

// --- the negative cases: this bundle's own documentation -------------------
check("does NOT flag this bundle's own placeholder examples", () => {
  // These nine strings ship in resources/ and skills/ as the example of what
  // NOT to do. A name-keyed rule blocks edits to the plugin's own docs.
  const shipped = [
    'const apiKey = "sk-proj-xxxxx"',
    'const password = "admin123"',
    'const token = "ghp_xxxxxxxxxxxx"',
    'const apiKey = "sk-abc123";  // ❌ Bad',
    'API_KEY=your-key-here',
    'SECRET = "changeme"',
    'password = "hunter2"',
    'apiKey: process.env.OPENAI_API_KEY',
    'const key = `${process.env.KEY}`',
  ];
  const hit = shipped.filter((line) => findSecrets(line).length > 0);
  assert(hit.length === 0, `false positives:\n      ${hit.join('\n      ')}`);
  return `${shipped.length} documented placeholders allowed`;
});

check('does NOT flag placeholder bodies whatever the variable name', () => {
  for (const body of ['xxxxxxxxxxxxxxxxxxxx', '<your-api-key>', '${MY_TOKEN}', 'CHANGEME', 'redacted-value', 'aaaaaaaaaaaaaaaaaaaa']) {
    assert(classifySecret(body) === undefined, `flagged a placeholder: ${body}`);
  }
});

check('does NOT flag a comment that mentions a secret', () => {
  const doc = [
    '// Never write: const apiKey = "sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2"',
    '# secret = "AKIAIOSFODNN7EXAMPLE"',
    ' * token: ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  ];
  const hit = doc.filter((line) => findSecrets(line).length > 0);
  assert(hit.length === 0, `flagged a comment: ${hit.join(' | ')}`);
});

check('does NOT flag an indirection or a low-entropy value', () => {
  const benign = [
    'const apiKey = process.env.OPENAI_API_KEY',
    'const token = await getTokenFromVault()',
    'password = "correcthorsebatterystaple"', // long but not random-looking by the proxy
    'apiKey: config.apiKey',
  ];
  const hit = benign.filter((line) => findSecrets(line).length > 0);
  assert(hit.length === 0, `false positives:\n      ${hit.join('\n      ')}`);
});

check('DOES flag a high-entropy literal on a secret-looking name', () => {
  const found = findSecrets('const apiKey = "aB3dE5gH7jK9lM1nO3qR5sT7"');
  assert(found.length === 1, `expected one finding, got ${found.length}`);
  assert(found[0].issuer === 'high-entropy literal', `wrong issuer: ${found[0].issuer}`);
  return `line ${found[0].line}`;
});

check('reports the line number and never the whole secret', () => {
  const content = ['line one', 'line two', 'const token = "aB3dE5gH7jK9lM1nO3qR5sT7uV9wX1yZ"'].join('\n');
  const [finding] = findSecrets(content);
  assert(finding.line === 3, `wrong line: ${finding.line}`);
  assert(!finding.excerpt.includes('aB3dE5gH7jK9lM1nO3qR5sT7uV9wX1yZ'), 'the excerpt leaked the whole secret');
  return finding.excerpt;
});

// --- destructive commands ---------------------------------------------------
const MUST_BLOCK = [
  ['git push --force', 'git-force-push'],
  ['git push origin main -f', 'git-force-push'],
  ['git push --force-with-lease', 'git-force-push'],
  ['git reset --hard HEAD~3', 'git-reset-hard'],
  ['git clean -fd', 'git-clean-force'],
  ['git checkout -- .', 'git-checkout-discard'],
  ['git branch -D feature', 'git-branch-force-delete'],
  ['git push origin --delete main', 'git-push-delete'],
  ['rm -rf /', 'rm-root-home'],
  ['rm -rf ~', 'rm-root-home'],
];

for (const [command, expected] of MUST_BLOCK) {
  check(`blocks: ${command}`, () => {
    const found = findDestructive(command, 'C:\\work\\project');
    assert(found !== undefined, 'not detected');
    assert(found.id === expected, `matched ${found.id}, expected ${expected}`);
    return found.id;
  });
}

const MUST_ALLOW = [
  'git push origin main',
  'git status',
  'git reset HEAD~1',
  'git clean -n',
  'git checkout main',
  'git branch -d feature',
  'rm -rf ./node_modules',
  'rm -rf build',
  'rm -rf C:\\work\\project\\dist',
  'git push --dry-run origin main',
  'npm run build',
];

for (const command of MUST_ALLOW) {
  check(`allows: ${command}`, () => {
    const found = findDestructive(command, 'C:\\work\\project');
    assert(found === undefined, `blocked by ${found?.id}: ${found?.why}`);
  });
}

check('blocks a recursive delete outside the workspace', () => {
  const found = findDestructive('rm -rf C:\\Windows\\System32', 'C:\\work\\project');
  assert(found !== undefined, 'not detected');
  return found.id;
});

check('does not block a recursive delete inside the workspace', () => {
  const found = findDestructive('rm -rf C:\\work\\project\\dist', 'C:\\work\\project');
  assert(found === undefined, `blocked: ${found?.id}`);
});

for (const r of results) {
  const suffix = r.note ? `  (${r.note})` : '';
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${suffix}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} risk-detection checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
