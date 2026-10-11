#!/usr/bin/env node
/**
 * PreToolUse (write|edit): refuse to write a real credential into a file.
 *
 * Scope, and why it is drawn where it is: this catches a credential *body*
 * being committed to source, configuration, or documentation. It deliberately
 * does not police reads, downloads, or key handling in general — a rule that
 * fires on ordinary work gets switched off, and then it protects nothing.
 *
 * Matching is by credential shape, never by variable name. See `risk.mjs` for
 * why: this bundle ships nine secret-shaped placeholders in its own ported
 * security guidance, and a name-keyed rule would block edits to them.
 *
 * Key stores are exempt by path, because writing a real secret into `.env` is
 * the *correct* thing to do — that file is the mechanism, not the leak.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readPayload, filePathOf, toPosixPath, block, pass } from './lib.mjs';
import { findSecrets } from './risk.mjs';

/**
 * Paths whose whole purpose is to hold secrets.
 *
 * A `.env` is where a key belongs. Flagging it would train the user to bypass
 * this hook, which is worse than not having it.
 */
const KEY_STORE =
  /(^|\/)(?:\.env(?:\.[\w.-]+)?|\.envrc|\.git-credentials|\.netrc|_netrc|credentials(?:\.json|\.yaml|\.yml)?|secrets?(?:\.json|\.yaml|\.yml|\.toml)?|id_rsa|id_ed25519|id_ecdsa|[\w-]+\.(?:pem|key|p12|pfx|jks|keystore))$/i;

/** Test fixtures and example trees legitimately contain plausible-looking keys. */
const EXEMPT_DIR = /(^|\/)(?:tests?|__tests__|fixtures?|testdata|examples?|samples?|specs?|mocks?|__mocks__|node_modules|\.git)\//i;

const payload = await readPayload();
const path = toPosixPath(filePathOf(payload));

if (!/\.(?:[cm]?[jt]sx?|json|jsonc|ya?ml|toml|ini|cfg|conf|env|sh|ps1|psm1|py|rb|go|rs|java|kt|php|cs|md|mdx|txt|properties|xml|html?)$/i.test(path)) {
  pass();
} else if (KEY_STORE.test(path)) {
  pass();
} else if (EXEMPT_DIR.test(path)) {
  pass();
} else {
  // The tool's payload may carry content (write) or a replacement (edit).
  const input = payload?.tool_input ?? {};
  const candidate = [input.content, input.file_text, input.new_string, input.new_str]
    .filter((v) => typeof v === 'string')
    .join('\n');

  if (candidate.length === 0) {
    pass();
  } else {
    const findings = findSecrets(candidate);
    if (findings.length === 0) {
      pass();
    } else {
      const first = findings[0];
      const lines = findings
        .slice(0, 3)
        .map((f) => `[ECC hook]   line ${f.line}: ${f.issuer}${f.name ? ` in \`${f.name}\`` : ''} — ${f.excerpt}`)
        .join('\n');
      block(
        `[ECC hook] BLOCKED: a credential would be written into ${path}\n` +
          `${lines}\n` +
          '[ECC hook] Read it from the environment instead:\n' +
          '[ECC hook]   const apiKey = process.env.API_KEY\n' +
          '[ECC hook] If this is a placeholder or a test fixture, make it obviously fake\n' +
          '[ECC hook] (xxxxx, <your-key>, CHANGEME) or move it under tests/ or examples/.',
      );
    }
  }
}
