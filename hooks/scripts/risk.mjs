#!/usr/bin/env node
/**
 * Shared detection logic for the risk-blocking hooks.
 *
 * These rules deny a tool call, so a false positive costs more than a missed
 * one: a check that fires on ordinary work gets disabled, and then it protects
 * nothing. Two consequences shape everything here.
 *
 * 1. Secrets are matched by *credential shape*, never by variable name.
 *    `const apiKey = "sk-proj-xxxxx"` appears nine times in this very bundle —
 *    in the ported security guidance, as the example of what NOT to do. A rule
 *    keyed on `apiKey = "…"` would block edits to the plugin's own docs. What
 *    is matched instead is a known issuer prefix with a real body, or a
 *    high-entropy string assigned to a secret-looking name.
 *
 * 2. Placeholders and documented values are excluded explicitly.
 *    `xxxxx`, `<your-key>`, `changeme`, `example`, `${VAR}`, `process.env.*`
 *    and repeated-character runs are how real code writes a placeholder, so
 *    they are the exact shapes a naive pattern flags.
 *
 * Every check returns a reason string to deny, or `undefined` to allow.
 */

/** Placeholder bodies that look like a secret but are not one. */
const PLACEHOLDER = /^(?:x{3,}|X{3,}|\*{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|%[A-Z_]+%|your[-_ ]?[a-z]*|my[-_ ]?[a-z]*|test|dummy|sample|example|placeholder|changeme|change[-_ ]?me|redacted|todo|none|null|undefined|abc123|123456|password|secret|token|apikey|api[-_]?key)$/i;

/** A body that is only one repeated character, e.g. `aaaa…` or `0000…`. */
function isRepeated(body) {
  return body.length > 0 && new Set(body).size <= 2;
}

/**
 * Entropy proxy for an opaque token, deliberately stricter than "looks long".
 *
 * A real API key is a wide-alphabet run with no word structure.
 * `correcthorsebatterystaple` is 25 characters and passes a naive length check
 * while being a passphrase, not a key — and a rule that flags it also flags
 * every long identifier a developer writes. So a token must additionally carry
 * mixed case AND a digit, and must not read as a lowercase word sequence.
 */
function looksRandom(body) {
  if (body.length < 20) return false;
  if (new Set(body).size < 12) return false;
  const hasLower = /[a-z]/.test(body);
  const hasUpper = /[A-Z]/.test(body);
  const hasDigit = /\d/.test(body);
  // Mixed case plus a digit is the shape no English word sequence has.
  if (!((hasUpper && hasLower) || (hasDigit && (hasUpper || hasLower)))) return false;
  // Reject a run of lowercase dictionary-ish words: no digits, no case shift.
  if (hasLower && !hasUpper && !hasDigit) return false;
  return true;
}

/**
 * Known credential prefixes, with the minimum body length each issuer uses.
 *
 * Prefix-anchored because that is what a real credential has and a placeholder
 * does not: a false `sk-proj-` is far less likely than a false `apiKey`.
 */
const ISSUERS = [
  { name: 'OpenAI', pattern: /^sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}$/ },
  { name: 'Anthropic', pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/ },
  { name: 'GitHub', pattern: /^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}$/ },
  { name: 'GitHub fine-grained', pattern: /^github_pat_[A-Za-z0-9_]{30,}$/ },
  { name: 'AWS access key', pattern: /^(?:AKIA|ASIA)[A-Z0-9]{16}$/ },
  { name: 'Google API', pattern: /^AIza[A-Za-z0-9_-]{35}$/ },
  { name: 'Slack', pattern: /^xox[abprs]-[A-Za-z0-9-]{10,}$/ },
  { name: 'Stripe', pattern: /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}$/ },
  { name: 'npm', pattern: /^npm_[A-Za-z0-9]{36}$/ },
  { name: 'PyPI', pattern: /^pypi-[A-Za-z0-9_-]{50,}$/ },
  { name: 'GitLab', pattern: /^glpat-[A-Za-z0-9_-]{20}$/ },
  { name: 'Hugging Face', pattern: /^hf_[A-Za-z0-9]{30,}$/ },
  // PEM private keys are unambiguous: no placeholder carries the header.
  { name: 'private key', pattern: /^-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  // A JWT: three base64url segments, the first decoding to a JSON header.
  { name: 'JWT', pattern: /^eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/ },
];

/**
 * Classify one candidate string.
 *
 * @returns the issuer name when the value is a real credential, else undefined.
 */
export function classifySecret(raw) {
  const value = String(raw).trim().replace(/^["'`]|["'`,;]+$/g, '');
  if (value.length === 0) return undefined;
  if (PLACEHOLDER.test(value)) return undefined;
  if (isRepeated(value)) return undefined;

  for (const issuer of ISSUERS) {
    if (issuer.pattern.test(value)) return issuer.name;
  }
  return undefined;
}

/**
 * Find likely credentials in file content.
 *
 * Also catches the generic case a prefix list cannot: a high-entropy literal
 * assigned to a secret-looking name. That check is deliberately narrow —
 * name AND randomness AND a quoted literal — because it is the one place a
 * variable name is consulted at all.
 *
 * @returns one entry per finding, with the line number and a redacted excerpt.
 */
export function findSecrets(content) {
  const findings = [];
  const lines = String(content).split(/\r?\n/);

  // A secret-shaped name on the left, a quoted literal on the right.
  const assignment =
    /(?:^|[\s{,;(])(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)\s*[:=]\s*(?:\r?\n\s*)?["'`]([^"'`\r\n]{16,})["'`]/g;
  const secretName =
    /(?:secret|token|passwd|password|passphrase|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|auth[-_]?token|bearer|credential)/i;

  lines.forEach((line, index) => {
    // Skip comment lines: prose about secrets is not a secret.
    const trimmed = line.trim();
    if (/^(?:\/\/|#|\*|<!--)/.test(trimmed)) return;

    for (const match of line.matchAll(assignment)) {
      const [, name, value] = match;
      if (!secretName.test(name)) continue;
      // An indirection is not a literal: the value is computed, not embedded.
      if (/^(?:process\.env|import\.meta\.env|Deno\.env|os\.environ|\$\{)/.test(value)) continue;
      if (!looksRandom(value)) continue;
      findings.push({
        line: index + 1,
        issuer: 'high-entropy literal',
        name,
        excerpt: `${name} = "${value.slice(0, 4)}…${value.slice(-2)}" (${value.length} chars)`,
      });
    }
  });

  // Prefix-anchored scan, for credentials not assigned to a telling name.
  const token = /["'`]([^"'`\r\n]{16,})["'`]/g;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^(?:\/\/|#|\*|<!--)/.test(trimmed)) return;
    for (const match of line.matchAll(token)) {
      const issuer = classifySecret(match[1]);
      if (issuer === undefined) continue;
      if (findings.some((f) => f.line === index + 1)) continue;
      findings.push({
        line: index + 1,
        issuer,
        name: '',
        excerpt: `${match[1].slice(0, 4)}…${match[1].slice(-2)} (${match[1].length} chars)`,
      });
    }
  });

  return findings;
}

/**
 * Destructive shell commands, each with why it is unrecoverable.
 *
 * Anchored on the flags that make a command destructive, not on the command
 * name: `git push` is ordinary work and only `--force` makes it dangerous, and
 * `rm` is routine until it targets a root or an absolute path outside the tree.
 */
const DESTRUCTIVE = [
  {
    id: 'git-force-push',
    pattern: /\bgit\s+push\b[^\n|;&]*(?:--force(?:-with-lease)?\b|(?:^|\s)-f(?:\s|$))/,
    why: 'a force push rewrites published history; other clones cannot recover their work',
  },
  {
    id: 'git-reset-hard',
    pattern: /\bgit\s+reset\s+--hard\b/,
    why: 'git reset --hard discards uncommitted work with no reflog entry to restore it from',
  },
  {
    id: 'git-clean-force',
    pattern: /\bgit\s+clean\s+(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b/,
    why: 'git clean -f deletes untracked files permanently; they are not in git at all',
  },
  {
    id: 'git-checkout-discard',
    pattern: /\bgit\s+checkout\s+(?:--\s+)?(?:\.|\*)\s*(?:$|[|;&])/,
    why: 'checking out over the whole tree discards every uncommitted change',
  },
  {
    id: 'git-branch-force-delete',
    pattern: /\bgit\s+branch\s+(?:-[a-zA-Z]*D[a-zA-Z]*|--delete\s+--force)\b/,
    why: 'a forced branch delete drops commits that no other ref points at',
  },
  {
    id: 'git-push-delete',
    pattern: /\bgit\s+push\b[^\n|;&]*--delete\b/,
    why: 'deleting a remote branch removes the only copy another clone may have',
  },
  {
    id: 'rm-root-home',
    pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*(?:\/|\/\*|~|~\/|\$HOME|\$env:USERPROFILE|%USERPROFILE%)(?:\s|$|\/)/,
    why: 'a recursive delete aimed at the filesystem root or the home directory is not recoverable',
  },
  {
    // `rm -rf` alone is routine — `rm -rf ./node_modules` is normal work, and so
    // is `rm -rf C:\work\project\dist`. What is dangerous is a recursive delete
    // of a path that is NOT scoped to the project: a bare name, a drive root, or
    // an absolute path. Absolute paths are therefore NOT matched here — they go
    // to the workspace comparison below, which knows the real cwd and can tell
    // `C:\work\project\dist` (routine) from `C:\Windows` (catastrophic).
    id: 'rm-unscoped-recursive',
    pattern:
      /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*(?:rf|fr)[a-zA-Z]*\s+(?:\.\s*$|\.\s|["']?\$HOME|["']?~)/,
    why: 'a recursive delete aimed at an unscoped path cannot be undone; use a path inside the project',
  },
];

/**
 * Detect a destructive command.
 *
 * @param command - the shell command about to run.
 * @param roots - every directory that bounds the session, newest contract first.
 *   A list rather than a single cwd, because DSH 0.2.1 made the session directory
 *   mutable: with one value, a legitimate delete of the ORIGINAL workspace would
 *   read as an escape once the session changed directory.
 * @returns a match with its reason, or undefined.
 */
export function findDestructive(command, roots) {
  const text = String(command);
  const bases = (Array.isArray(roots) ? roots : [roots])
    .map((r) => String(r ?? '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase())
    .filter((r) => r.length > 0);

  // A dry run mutates nothing; `--dry-run` and `-n` are respected.
  const dryRun = /--dry-run\b|\s-n\b/.test(text);

  for (const rule of DESTRUCTIVE) {
    if (!rule.pattern.test(text)) continue;
    if (dryRun && rule.id !== 'rm-unscoped-recursive') continue;
    return { id: rule.id, why: rule.why };
  }

  // A recursive delete of an absolute path outside every session directory.
  if (bases.length > 0 && /\brm\s+(-[a-zA-Z]+\s+)*-?[a-zA-Z]*(?:rf|fr)[a-zA-Z]*\s+["']?(?:[A-Za-z]:[\\/]|\/)/.test(text)) {
    const absolute = [...text.matchAll(/["']?((?:[A-Za-z]:[\\/]|\/)[^"'\s)|;&]*)/g)].map((m) => m[1]);
    const escapes = absolute.filter((p) => {
      const normalized = p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
      // Inside ANY known session directory is fine, including the original
      // workspace after the session has moved elsewhere.
      return !bases.some((base) => normalized === base || normalized.startsWith(`${base}/`));
    });
    if (escapes.length > 0) {
      return {
        id: 'rm-outside-workspace',
        why: `the delete targets a path outside the session workspace (${escapes[0]})`,
      };
    }
  }

  return undefined;
}
