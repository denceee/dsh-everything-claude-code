#!/usr/bin/env node
/**
 * PostToolUse (pwsh): surface the review command after a PR is created.
 * Non-blocking; writes the advice to stderr so the model sees it.
 */
import { readPayload, commandOf, warn, pass } from './lib.mjs';

const PR_URL = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;

const payload = await readPayload();
if (!/gh pr create/.test(commandOf(payload))) {
  pass();
} else {
  const response =
    typeof payload.tool_response === 'string'
      ? payload.tool_response
      : JSON.stringify(payload.tool_response ?? '');
  const match = PR_URL.exec(response);
  if (match) {
    const [, owner, repo, pr] = match;
    warn(
      `[ECC hook] PR created: ${match[0]}\n` +
        `[ECC hook] To review: gh pr review ${pr} --repo ${owner}/${repo}`,
    );
  } else {
    pass();
  }
}
