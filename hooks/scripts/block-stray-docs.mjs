#!/usr/bin/env node
/**
 * PreToolUse (write): block stray documentation files.
 *
 * ECC's rule is that docs stay consolidated. The original hook blocked every
 * `.md` except a few root files, which is too aggressive for DSH: a plugin or
 * a docs tree legitimately writes markdown. This version blocks only the
 * genuinely stray case — a loose `.md`/`.txt` at an arbitrary location — and
 * allows well-known root documents and established documentation directories.
 */
import { readPayload, filePathOf, toPosixPath, block, pass } from './lib.mjs';

/**
 * Root documents that are always welcome.
 *
 * The locale-suffixed forms are included on purpose: `README.zh.md`,
 * `README.zh-CN.md`, and `NOTICE` are standard in a published repository, and a
 * rule that blocks them pushes authors toward workarounds. The rule exists to
 * stop *stray* notes, not to stop conventional public documents.
 */
const ALLOWED_ROOT =
  /(^|\/)(README(\.[A-Za-z-]{2,10})?|CLAUDE|AGENTS|CONTRIBUTING|CHANGELOG|LICENSE|NOTICE|SECURITY|CODE_OF_CONDUCT)(\.md)?$/i;

/** Directories where markdown is a first-class artifact, not a stray file. */
const ALLOWED_DIR = /(^|\/)(docs?|skills|commands|rules|contexts|agents|resources|templates|\.github|node_modules)\//i;

const path = toPosixPath(filePathOf(await readPayload()));

if (!/\.(md|txt)$/i.test(path)) {
  pass();
} else if (ALLOWED_ROOT.test(path) || ALLOWED_DIR.test(path)) {
  pass();
} else {
  block(
    `[ECC hook] BLOCKED: stray documentation file ${path}\n` +
      '[ECC hook] Keep docs consolidated: use README.md, a locale-suffixed README, ' +
      'NOTICE, or an existing docs location.',
  );
}
