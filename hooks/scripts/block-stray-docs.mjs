#!/usr/bin/env node
/**
 * PreToolUse (write): block stray documentation files *in the session workspace*.
 *
 * ECC's rule is that docs stay consolidated. The original hook blocked every
 * `.md` except a few root files, which is too aggressive for DSH: a plugin or
 * a docs tree legitimately writes markdown. This version blocks only the
 * genuinely stray case — a loose `.md`/`.txt` at an arbitrary location — and
 * allows well-known root documents and established documentation directories.
 *
 * The workspace scope is not a detail. Without it the rule also policed scratch
 * files anywhere on the machine: writing a commit message to the system temp
 * directory was denied as a "stray documentation file", and so was any note
 * outside the repository. Documentation consolidation is a claim about *this
 * project*, so the rule now only applies inside the project.
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

/** Scratch locations: temp files are not project documentation. */
const SCRATCH_DIR = /(^|\/)(AppData\/Local\/Temp|AppData\/Roaming\/Temp|\/tmp|\/var\/tmp|\/private\/var\/folders)\//i;

const payload = await readPayload();
const path = toPosixPath(filePathOf(payload));

/** The session workspace, so the rule can tell "this project" from "elsewhere". */
function workspaceOf(payload) {
  const candidate =
    payload?.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.env.DSH_WORKSPACE ?? '';
  return toPosixPath(candidate).replace(/\/+$/, '').toLowerCase();
}

const workspace = workspaceOf(payload);
const lower = path.toLowerCase();

// A relative path is relative to the workspace, so it is inside by definition.
// Only an ABSOLUTE path can be outside. Testing `startsWith` alone got this
// backwards and let every relative path through as "outside the project" —
// which would have silently disabled the rule for the ordinary case.
const isAbsolute = /^(?:[a-z]:\/|\/)/i.test(lower);
const outsideWorkspace =
  isAbsolute && workspace.length > 0 && !lower.startsWith(`${workspace}/`) && lower !== workspace;

if (!/\.(md|txt)$/i.test(path)) {
  pass();
} else if (outsideWorkspace || SCRATCH_DIR.test(path)) {
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
