# dsh-everything-claude-code

English | [中文](README.zh.md)

Adapts [WorldFlowAI/everything-claude-code](https://github.com/WorldFlowAI/everything-claude-code)
(ECC) into a DeepSeek Harness bundle: 11 skills, 15 prompts, 9 personas, 8 rules, an
adapted Claude Code hook set, an **agent preset**, and a Chinese Settings page.

Verified against DSH `0.2.0-rc.2`, profile `desktop`.

## Blocking rules

Five `PreToolUse` rules deny a tool call outright. Two are ported from ECC; three
were added for this port.

| Rule | Denies |
|---|---|
| `block-dev-server` | starting a dev server in the foreground, where its log is unreachable |
| `block-destructive-command` | force push, `reset --hard`, `clean -f`, forced branch delete, remote branch delete, and a recursive delete of an unscoped or out-of-workspace path |
| `block-hardcoded-secret` | writing a real credential into source, config, or docs |
| `block-stray-docs` | a loose `.md`/`.txt` outside the conventional locations |
| `confirm-git-push` | not a deny — it raises an approval prompt before a push |

### What is deliberately allowed

A blocking rule that fires on ordinary work gets switched off, and then it
protects nothing. So each rule has explicit exemptions, asserted by tests:

- **`.env`, `*.pem`, `*.key`, `credentials.*`** are writable. A key store is where
  a real key belongs; flagging it would train the user to bypass the hook. The
  other half of that bargain is `.gitignore`, which covers every path the hook
  treats as a key store.
- **Secrets are matched by credential shape, never by variable name.** This
  bundle ships nine secret-shaped placeholders in its own ported security
  guidance (`const apiKey = "sk-proj-xxxxx"`), so a name-keyed rule would block
  edits to the plugin's own docs. What is matched is a known issuer prefix with a
  real body — OpenAI `sk-`, GitHub `ghp_`/`github_pat_`, AWS `AKIA`, Google
  `AIza`, Slack, Stripe, npm, PyPI, GitLab, Hugging Face, PEM headers, JWTs — or
  a mixed-case-plus-digit literal assigned to a secret-like name.
- **`tests/`, `fixtures/`, `examples/`** are exempt by path: a fixture with a
  plausible-looking key is correct, not a leak.
- **Ordinary git and ordinary deletes pass**: `git push`, `git reset HEAD~1`,
  `git branch -d`, `git clean -n`, `rm -rf ./node_modules`, and
  `rm -rf <workspace>/dist` are all allowed.
- **`--dry-run` and `-n`** are respected, so a command can be reviewed before it
  is trusted.

Every rule is one script under `hooks/scripts/`, so a rule can be removed by
deleting its entry from `hooks/hooks.json` without touching the others.

## The agent preset (the "mode")

`presets/everything-claude-code.patch.yml` declares a selectable session mode named
**Everything Claude Code**, listed in Settings → Agent presets and in the new-session
picker. Selecting it composes:

- a **persona** stating the ECC working agreement — TDD first, verify before claiming
  done, never hardcode a secret, immutable data, focused files, security review — and
  naming the skills to load;
- the standard agent plane (filesystem and search, skill loading, plan mode,
  compaction, delegation, todos, web, present);
- `agent-instructions`, so the project's `AGENTS.md` still reaches the model.

Why a preset instead of a global row: a preset is the only seat that composes a
session's persona, tools, and context. Mounting ECC globally would change every
session; a preset lets one session opt in. `order: 4` places it after the shipped
standard(1)/ptc(2)/minimal(3), so it reads as an opt-in mode, not a replacement default.

To declare an extra patch file, `dsh.bundle.patch` takes a **list** of paths.

## Settings page

Settings gains an **Everything Claude Code** entry showing what the plugin actually
publishes: the 11 registered skills, every hook point with its matcher, the resource
counts, and the migration caveats. It is Chinese by default and follows a language
switch in place.

- Registered in the `settings.section` slot — a top-level settings page. Do **not**
  file it under `settings.plugins.tab`: that is the read-only "Built-in plugins"
  inventory of what the deployment ships, so a third-party page does not belong there.
- Data comes from `GET /api/everything-claude-code/status` under the authenticated
  `/api` fence; counts are read from the package directory at request time.
- Styled only with `--dsw-alias-*` theme tokens, so light and dark both work.

**The client half needs a DSH restart the first time it appears.** The client-module
scan runs once at process start and caches each package's manifest in a write-once
`pkgMeta` map with no invalidation path (`dsh-client-modules/lib/index.js`). A package
that gains `dsh.client` while the Host is already running stays invisible until DSH
restarts. Later edits to `client.js` do hot-reload.

## Install

```powershell
# 1. Clone through the mirror (direct GitHub is unreachable on this host)
git clone --depth 1 https://gh-proxy.com/https://github.com/WorldFlowAI/everything-claude-code.git

# 2. Adapt the sources into this bundle
node scripts/adapt-skills.mjs skills
node scripts/adapt-resources.mjs resources

# 3. Install into the profile (via the plugin manager, not the CLI —
#    the desktop profile is owned by the Electron app)
```

Then install with the `plugin_manager` tool, `action: install_bundle`,
`target: <absolute path to this directory>`.

## What maps to what

| ECC | DSH | Note |
|---|---|---|
| `skills/` (11) | runtime skill registry | Needs `name` + `description` frontmatter |
| `commands/` (15) | prompt documents | DSH commands are human-facing and never reach the model |
| `agents/` (9) | persona prompts | DSH has no per-file agent registry |
| `rules/` (8) | `SessionStart` context | Three rules are injected; the rest load on demand |
| `hooks.json` | `@deepseek-ai/dsh-hooks-claude-code` | Matchers renamed to DSH tools |
| `.claude-plugin/plugin.json` | `package.json` + `dsh.bundle.patch` | Different manifest contract |

## Three bugs that a naive port hits

**1. Skill frontmatter is required, and its absence is silent.**
Three ECC skills (`eval-harness`, `project-guidelines-example`, `verification-loop`) ship
without frontmatter. `dsh-skill-filesystem` drops such a skill with a warning the model never
sees, so the skill simply is not there. `scripts/adapt-skills.mjs` adds `name` and `description`.

**2. `baseUrl` in a bundle patch is the PROFILE ROOT, not the patch's directory.**
`new URL('hooks/hooks.json', baseUrl)` resolves to `<profile>/hooks/hooks.json`, which does not
exist. The bridge then logs a warning and runs **no hooks at all** — no error surfacing to the
user. Anchor on the installed package instead:

```yaml
configPath: !!js "...new URL('node_modules/dsh-everything-claude-code/hooks/hooks.json', baseUrl)"
```

**3. Blocking through exit code 2 does not work in this bridge.**
Claude Code documents exit 2 + stderr as a block, and `dsh-hook-protocol` maps exit 2 to
`decision: 'block'`. In `0.2.0-rc.2` the bridge instead recorded it as `exitCode: 1,
decision: 'pass'` and **let the tool run**. Observed directly in a session log: the hook's block
message reached stderr while the call was not stopped.

The channel that does work is structured stdout with a clean exit:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}
```

All blocking hooks in this bundle use it and exit 0. `blockByExitCode` is kept for a real
Claude Code host.

## Tests

```powershell
node tests/run-all.mjs
```

| Suite | Checks | What it proves |
|---|---|---|
| `hooks.test.mjs` | 23 | Each hook's decision against the contract this bridge honors |
| `blocking-hooks.test.mjs` | 24 | The risk hooks deny through the channel this bridge honours |
| `risk-detection.test.mjs` | 41 | The detection logic, including the cases it must NOT flag |
| `dual-version.test.mjs` | 15 | Correct behaviour under both the 0.2.0 and 0.2.1 directory contracts |
| `preset.test.mjs` | 15 | The preset satisfies the agent-preset schema and names the ECC practices |
| `client-bundle.test.mjs` | 14 | The browser factory loads, exports, and renders the page |
| `status-payload.test.mjs` | 12 | The route answers, and every field the page reads exists |
| `memory-hooks.test.mjs` | 11 | The two bridge-unsupported events are covered by native listeners |
| `skill-catalog.test.mjs` | 11 | Every shipped skill is well formed and collides with no installed one |
| `skill-provider.test.mjs` | 11 | A body edit is visible on the next load, with no stale cache |
| `no-stale-refs.test.mjs` | 10 | No Claude Code path, command, tool or agent name survives in prose |
| `preset-mount.test.mjs` | 9 | Every preset child package resolves, so the preset can mount |
| `bridge-parse.test.mjs` | 7 | No event or matcher is silently dropped |

203 checks across 13 suites.

Diagnostic helpers, which read the authoritative session log rather than guessing:

```powershell
node tests/hook-timeline.mjs <session-dir>      # when each matcher fired, and decisions
node tests/analyze-hook-decisions.mjs <dir>     # decision and exit-code distribution
node tests/replay-hook.mjs <script.mjs> '<json>'  # raw exit code, stdout, stderr
node tests/read-session-hooks.mjs <dir>         # all hook records
```

A session log is **many concatenated Zstandard frames** (one per flush — 570 frames in one
observed log). Node's streaming decoder stops after the first frame, so these helpers advance
frame by frame.

## Environment fix

The install first failed with `ERR_PNPM_UNEXPECTED_STORE`: the profile was built by
pnpm 11.27.1 (store `v11`), while `pnpm` on `PATH` resolved through a corepack shim to 10.17.0
(store `v10`). Recording the version that built the profile repairs it:

```json
{ "packageManager": "pnpm@11.27.1" }
```

If that line makes the plugin manager report `ambiguous-install`, remove and reinstall the
bundle: that error means the resolver found no *newly changed* dependency, and a fresh install
takes the reload path instead.

## Layout

```
index.js              Host half: skills provider, status route, memory listeners
client.js             Client half: the Chinese Settings page
cordis.patch.yml      Bundle patch: the skills row and the hook-bridge row
presets/              The Everything Claude Code agent preset
locale/               Display metadata for the plugin card (en, zh)
skills/               11 ported skills + 24 generated ecc-* skills
resources/            rules, commands, agents, contexts
hooks/hooks.json      Adapted hook config (DSH tool names)
hooks/scripts/        One script per hook, plus lib.mjs
scripts/              Idempotent adapters and GitHub helpers
tests/                Test suites and session-log diagnostics
```

## Memory persistence (the two events the bridge cannot run)

The Claude Code hook bridge supports seven events, and ECC's `PreCompact` and
`SessionEnd` hooks are not among them — so at first this port had no memory
persistence at all.

A bridge cannot be extended from outside it, but that is not a dead end: DSH
exposes the same two moments as **native host events**, which this plugin
listens to directly. Both replacements live in `index.js`:

| ECC hook | Replaced by | When it fires |
|---|---|---|
| `PreCompact` | `session/event` carrying `compaction/start` | compaction is genuinely beginning, before summarization |
| `SessionEnd` | `agent/disposed` | after driver quiescence, before session detachment |

Notes are appended to `$DSH_HOME/sessions/memory/` as Markdown, one file per day:
`YYYY-MM-DD-compaction.md` and `YYYY-MM-DD-sessions.md`.

Two deliberate departures from ECC's scripts: they wrote to `~/.claude/sessions/`
and rewrote a `*.tmp` file with `sed`, both Claude Code shapes that do not exist
here. These notes are append-only, nothing is mutated in place, and a write
failure is logged and swallowed — a memory hook must never be able to break the
session it is recording.

## DSH version compatibility

Tested against `0.2.0-rc.2` (the `latest` channel) and `0.2.1-alpha.2` (the `alpha`
channel). One contract changed between them, and the adaptation is written so
that both keep working.

| Contract | 0.2.0-rc.2 | 0.2.1-alpha.2 |
|---|---|---|
| Session directory | `session.header.cwd`, fixed at session creation | `ctx.workingDirectory`, mutable mid-session |
| Where hooks run | the workspace root | the session's **current** directory |
| `dsh-skill`, `dsh-agent-preset`, `dsh-persona` | — | unchanged |

**What changed, and why it matters.** In 0.2.1 a session can change its working
directory, so the hook payload's `cwd` is no longer the project root. A hook that
trusted a single `cwd` value would treat the *original* workspace as foreign after
a directory change, and block a routine `rm -rf <project>/dist` or a legitimate
documentation edit.

**How this plugin adapts.** The hooks read every available signal — the payload
`cwd`, `CLAUDE_PROJECT_DIR`, and `DSH_WORKSPACE` — and treat their union as the
session's zone. That is correct under either contract: on 0.2.0 the signals agree,
and on 0.2.1 they both still describe where the session legitimately works.
Nothing branches on a version number, which is what makes it hold on 0.2.0, on
0.2.1, and on versions not yet published.

Verify it yourself against any two versions:

```bash
node scripts/check-surface.mjs 0.2.0-rc.2 0.2.1-alpha.2   # every consumed API surface
node tests/dual-version.test.mjs                          # behaviour under both contracts
```

`check-surface.mjs` asserts that every harness API the plugin consumes is present:
skill provider registration, `session/event`, `agent/disposed`, the hook bridge
config, the preset schema, the persona prefix, the client module loader, and the
`settings.section` slot. Run it after a harness upgrade — a breaking change then
becomes a named failure instead of a runtime surprise.

## Known limits

- `SubagentStart`/`SubagentStop` report a constant `agent_type`, and start-context only reaches
  an in-process child.
- The `Stop` hook cannot block safely: the bridge always reports `stop_hook_active: false`, so
  an unconditional block would loop. Ours only warns.
- Memory persistence records *that* compaction and session end happened, not the session's
  content, and it does not reload a previous session's context into a new one. ECC's
  `session-start` hook covers the load side and runs through the bridge.
- ECC's `project-guidelines-example` skill references a specific unrelated production project;
  it is kept only as a template.
