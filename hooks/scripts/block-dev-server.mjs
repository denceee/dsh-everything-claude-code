#!/usr/bin/env node
/**
 * PreToolUse (pwsh): block a dev server started in the foreground.
 *
 * A foreground dev server never returns, so its log is unreachable and the
 * turn stalls. DSH runs long processes as managed background jobs instead,
 * where `job_output` can read the log.
 */
import { readPayload, commandOf, block, pass } from './lib.mjs';

const DEV_SERVER = /\b(npm run dev|pnpm( run)? dev|yarn dev|bun run dev|next dev|vite|nodemon)\b/;

const payload = await readPayload();
if (DEV_SERVER.test(commandOf(payload))) {
  block(
    '[ECC hook] BLOCKED: a dev server must not run in the foreground.\n' +
      '[ECC hook] Its log would be unreachable and the call would not return.\n' +
      '[ECC hook] Start it as a managed background job, then read the log with job_output.',
  );
} else {
  pass();
}
