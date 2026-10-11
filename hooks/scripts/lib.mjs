#!/usr/bin/env node
/**
 * Shared stdin/stdout helpers for the adapted everything-claude-code hooks.
 *
 * The DSH hook bridge writes one JSON payload to stdin and decodes the process
 * as: exit 0 + stdout JSON => structured outcome; exit 2 + stderr => blocking
 * decision; any other exit => non-blocking error.
 *
 * IMPORTANT — blocking goes through stdout JSON, not exit code 2.
 * The bridge is documented to treat exit 2 as a block, but in DSH 0.2.0-rc.2 it
 * recorded an exit-2 hook as `exitCode: 1, decision: 'pass'` and let the tool
 * run. The session log kept the hook's stderr block message while the call was
 * not stopped, so the exit-code channel is unreliable here. The
 * `hookSpecificOutput.permissionDecision` channel is verified working in the
 * same bridge, so every blocking decision uses it and exits 0.
 *
 * Hooks are separate files rather than `node -e "..."` one-liners on purpose:
 * a one-liner has to survive JSON-string escaping *and* a shell round-trip,
 * which silently eats backslashes and breaks every regex. A file has neither
 * problem.
 */
import process from 'node:process';

/** Read all of stdin and parse it as JSON. A malformed payload yields `{}`. */
export async function readPayload() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** The command string of a shell tool call, for the `pwsh` hooks. */
export function commandOf(payload) {
  return payload?.tool_input?.command ?? '';
}

/** Normalize a path for comparison: forward slashes, no trailing slash, lowercase on Windows. */
export function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * The directories that bound a session's allowed zone, newest contract first.
 *
 * DSH changed what `cwd` means between 0.2.0 and 0.2.1, and this function is the
 * whole adaptation:
 *
 *   0.2.0-rc.2  the payload `cwd` is the Session header's workspace, fixed at
 *               session creation, and `CLAUDE_PROJECT_DIR` matches it.
 *   0.2.1-alpha the payload `cwd` is the Session's *current* directory, which a
 *               working-directory change can move mid-session. The bridge also
 *               introduced `ctx.workingDirectory` and a
 *               `working-directory/change` event; `CLAUDE_PROJECT_DIR` follows
 *               the current directory unless the config pins `projectDir`.
 *
 * Rather than branch on a version, the hooks read both signals and treat their
 * union as the allowed zone. That is correct under either contract: on 0.2.0 the
 * two are the same directory, and on 0.2.1 they still describe where the session
 * is legitimately working. A rule written this way needs no version detection and
 * cannot silently pick the wrong one.
 *
 * @returns absolute-looking directories, deduplicated, in priority order.
 */
export function workspaceRoots(payload) {
  const candidates = [
    payload?.cwd,
    process.env.CLAUDE_PROJECT_DIR,
    process.env.DSH_WORKSPACE,
  ];
  const roots = [];
  for (const candidate of candidates) {
    const normalized = normalizePath(candidate);
    if (normalized.length > 0 && !roots.includes(normalized)) roots.push(normalized);
  }
  return roots;
}

/** The target path of a file tool call, for the `write`/`edit` hooks. */
export function filePathOf(payload) {
  const input = payload?.tool_input ?? {};
  return input.file_path ?? input.path ?? '';
}

/** Normalize separators so a Windows path can be matched by a forward-slash pattern. */
export function toPosixPath(value) {
  return String(value).replaceAll('\\', '/');
}

/**
 * Emit a structured hook outcome on stdout and exit 0.
 * `process.exitCode` is used instead of `process.exit()` so the write can flush.
 */
export function respond(outcome = {}) {
  process.stdout.write(JSON.stringify(outcome));
  process.exitCode = 0;
}

/** Attach extra model-visible context and exit 0. */
export function attachContext(event, text) {
  respond({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/**
 * Block a tool call, with `reason` shown to the model.
 *
 * Uses `permissionDecision: 'deny'` on stdout with exit 0 — the channel this
 * bridge actually honors. See the module header for why the documented exit-2
 * channel is not used.
 */
export function block(reason) {
  respond({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/**
 * Block via exit code 2 and stderr, the Claude Code reference channel.
 *
 * Not used by the DSH hooks: this bridge drops structured stdout on a non-zero
 * exit and recorded exit 2 as a non-blocking error. Kept so a host that reads
 * exit codes (real Claude Code) can be served by the same scripts.
 */
export function blockByExitCode(reason) {
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
}

/** Request confirmation before the tool runs. Exit 0 with an `ask` decision. */
export function ask(reason) {
  respond({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  });
}

/** Report a non-blocking warning and continue. */
export function warn(text) {
  process.stderr.write(`${text}\n`);
  process.exitCode = 0;
}

/** Continue without any outcome. */
export function pass() {
  process.exitCode = 0;
}
