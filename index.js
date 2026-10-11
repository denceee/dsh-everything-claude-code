/**
 * Host half of the everything-claude-code bundle for DeepSeek Harness.
 *
 * Everything Claude Code (ECC) ships Claude Code "skills" as `skills/<name>/SKILL.md`
 * bundles. DSH's filesystem provider only scans fixed roots (`.dsh/skills`,
 * `.agents/skills`, `$DSH_HOME/skills`, ...), so a plugin's own directory is never
 * discovered by copying files alone. This plugin bridges the two: it reads the
 * adapted SKILL.md bundles from its own package directory and publishes them into
 * the DSH skill registry through the runtime provider.
 *
 * Design notes:
 *  - Registration is `ctx.effect`-scoped, so unloading the bundle withdraws every
 *    skill it published.
 *  - A malformed bundle is logged and skipped, never thrown: one bad file must not
 *    take down skill discovery for the whole session.
 *  - Edits to a SKILL.md body are picked up on the next load because the registry
 *    re-reads the body on every `get()`; only frontmatter changes need a reload.
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'everything-claude-code';

/** The skill registry is the only service this half needs. */
export const inject = ['skills'];

const PACKAGE_ROOT = fileURLToPath(new URL('.', import.meta.url));
const SKILLS_DIR = join(PACKAGE_ROOT, 'skills');

/** Provider name registered on `ctx.skills`. */
const PROVIDER_NAME = 'everything-claude-code';

/** Packaged-bundle precedence, matching `BUNDLED_SKILL_RANK` in dsh-skill. */
const BUNDLED_SKILL_RANK = 600;

/** Frontmatter keys DSH understands; other ECC keys are kept as metadata. */
const INVOCATION_KEYS = new Set(['user-invocable', 'disable-model-invocation']);

/**
 * Parse a `---`-delimited YAML frontmatter block with flat scalar values.
 * Only the shapes ECC actually uses are supported: `key: value` lines and the
 * strict boolean spellings DSH accepts. Anything richer is treated as metadata.
 */
function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { attributes: {}, body: source };
  const attributes = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    attributes[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { attributes, body: source.slice(match[0].length) };
}

/**
 * Resolve a strict boolean the way `dsh-skill-filesystem` does. A rejected
 * spelling returns `undefined` so the caller drops the skill with a warning
 * instead of silently permitting a surface.
 */
function strictBoolean(value) {
  if (value === undefined) return undefined;
  const normalized = String(value).toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
  if (['false', 'no', 'off', '0'].includes(normalized)) return false;
  return undefined;
}

/**
 * Read every `skills/<name>/SKILL.md` bundle as a catalog *candidate*.
 *
 * Only metadata is parsed here. The body is deliberately NOT read: a candidate
 * is cached by the registry, so capturing the body would freeze it at plugin
 * load and an edit to a SKILL.md would never reach the model. The body is
 * loaded on demand in `get()` below.
 */
function readSkillCandidates(log) {
  if (!existsSync(SKILLS_DIR)) return [];
  const candidates = [];
  for (const entry of readdirSync(SKILLS_DIR)) {
    const dir = join(SKILLS_DIR, entry);
    if (!statSync(dir).isDirectory()) continue;
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) continue;
    try {
      const { attributes } = parseFrontmatter(readFileSync(file, 'utf8'));
      const skillName = attributes.name ?? entry;
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) {
        log(`skipping "${entry}": name "${skillName}" is not kebab-case`);
        continue;
      }
      const description = attributes.description;
      if (!description) {
        log(`skipping "${entry}": description is required`);
        continue;
      }
      const modelInvocable = strictBoolean(attributes['disable-model-invocation']) === true ? false : true;
      const userInvocable = strictBoolean(attributes['user-invocable']) === false ? false : true;
      const metadata = {};
      for (const [key, value] of Object.entries(attributes)) {
        if (INVOCATION_KEYS.has(key)) continue;
        metadata[key] = value;
      }
      candidates.push({
        name: skillName,
        description,
        ...(attributes.whenToUse ? { whenToUse: attributes.whenToUse } : {}),
        path: file,
        source: 'bundled',
        provider: PROVIDER_NAME,
        // The filesystem rank: this provider is a packaged bundle, so it loses
        // to a project-local skill of the same name, as a bundled root does.
        rank: BUNDLED_SKILL_RANK,
        invocation: { modelInvocable, userInvocable },
        metadata,
        // The provider-owned handle `get()` receives back. It is the absolute
        // path, so a renamed directory surfaces as "no longer loadable" rather
        // than a stale body.
        locator: file,
      });
    } catch (error) {
      log(`skipping "${entry}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return candidates;
}

/**
 * Describe this bundle for its Settings page.
 *
 * Everything is read from the package directory itself, so the page always
 * reflects what is actually installed rather than a hard-coded summary that
 * drifts after an edit.
 */
function describeBundle(skills, log) {
  const countFiles = (dir) => {
    const full = join(PACKAGE_ROOT, dir);
    if (!existsSync(full)) return 0;
    try {
      return readdirSync(full).filter((entry) => statSync(join(full, entry)).isFile()).length;
    } catch {
      return 0;
    }
  };

  // The hook points this bundle is wired to, read from the adapted config so a
  // hand-edited hooks.json shows up here instead of being misreported.
  let hooks = [];
  try {
    const config = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'hooks', 'hooks.json'), 'utf8'));
    hooks = Object.entries(config.hooks ?? {}).flatMap(([event, groups]) =>
      (groups ?? []).map((group) => ({
        event,
        matcher: group.matcher ?? '*',
        // SessionStart and Stop route through the bridge; the tool events are
        // proven live in this bridge (see README).
        active: true,
        note: `${(group.hooks ?? []).length} command hook(s)`,
      })),
    );
  } catch (error) {
    log(`could not read hooks.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    description:
      'Adapts WorldFlowAI/everything-claude-code to DeepSeek Harness: skills registered ' +
      'through the runtime skill registry, and Claude Code hooks running through the ' +
      'dsh-hooks-claude-code bridge.',
    repository: 'https://github.com/WorldFlowAI/everything-claude-code',
    skills: skills.map((skill) => skill.name).sort(),
    hooks,
    counts: {
      rules: countFiles('resources/rules'),
      prompts: countFiles('resources/commands'),
      personas: countFiles('resources/agents'),
      resources: countFiles('resources/rules') + countFiles('resources/commands') +
        countFiles('resources/agents') + countFiles('resources/contexts'),
    },
    notes: [
      'Claude Code slash commands are prompts here: the DSH command registry is human-facing and never reaches the model.',
      'Claude Code agent definitions are personas here: DSH has no per-file subagent registry.',
      'PreCompact and SessionEnd hooks are not ported: the bridge does not support those events.',
      'Blocking uses permissionDecision on stdout with exit 0; exit code 2 is not honored by this bridge.',
    ],
  };
}

/**
 * Memory persistence: the two ECC hooks the Claude Code bridge cannot run.
 *
 * ECC ships `PreCompact` and `SessionEnd` command hooks under
 * `hooks/memory-persistence/`. The DSH bridge supports seven events and those
 * two are not among them, so they were simply absent from this port — the README
 * listed that as a known gap.
 *
 * A bridge cannot be extended from outside it, so a bridge limitation is not a
 * dead end: DSH exposes the same moments as native host events, which a plugin
 * *can* listen to. That is what these listeners are:
 *
 *   ECC PreCompact -> `session/event` carrying `compaction/start`
 *   ECC SessionEnd -> `agent/disposed`
 *
 * The behaviour follows ECC's scripts, with one deliberate change: ECC wrote to
 * `~/.claude/sessions/` and mutated a `*.tmp` file with `sed`. Both are Claude
 * Code shapes that do not exist here, so the notes go to `$DSH_HOME/` instead,
 * as append-only Markdown. Nothing is mutated in place, and a failure to write
 * never breaks the session — a memory hook must not be able to do that.
 */

/** Where the session notes live, under the DSH home. */
function sessionNotesDir() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh');
  return join(home, 'sessions', 'memory');
}

/** Append one timestamped line, creating the directory if needed. */
function appendNote(file, line, log) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`, 'utf8');
    return true;
  } catch (error) {
    // A memory hook that throws would break the session it is trying to record.
    log(`could not write ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** `YYYY-MM-DD HH:MM` in local time, matching ECC's `date` format. */
function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** `YYYY-MM-DD`, for the daily file name. */
function dayStamp(date = new Date()) {
  return stamp(date).slice(0, 10);
}

/**
 * ECC's PreCompact: note that compaction is about to replace history.
 *
 * Listens for the durable `compaction/start` marker rather than a bespoke hook,
 * because that event exists only when a compaction is genuinely beginning, and
 * it is recorded before summarization — exactly the "before" moment ECC wanted.
 */
function installPreCompactNote(ctx, log, note) {
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'compaction/start') return;
    const file = join(sessionNotesDir(), `${dayStamp()}-compaction.md`);
    const written = appendNote(
      file,
      `- ${stamp()} — context compaction started (session ${session?.id ?? 'unknown'})`,
      log,
    );
    if (written) note(`PreCompact equivalent: noted compaction in ${file}`);
  });
}

/**
 * ECC's SessionEnd: record that a session finished.
 *
 * `agent/disposed` fires after driver quiescence and before session detachment,
 * which is the closest native equivalent to a session ending. The session id is
 * still readable at that point, so the note can name it.
 */
function installSessionEndNote(ctx, log, note) {
  ctx.on('agent/disposed', (payload) => {
    // A memory hook must never break the session it records, so the payload is
    // read defensively: a missing or malformed payload still produces a note.
    const agent = payload?.agent;
    const file = join(sessionNotesDir(), `${dayStamp()}-sessions.md`);
    const written = appendNote(
      file,
      `- ${stamp()} — session ${agent?.id ?? 'unknown'} ended`,
      log,
    );
    if (written) note(`SessionEnd equivalent: noted the end of ${agent?.id ?? 'unknown'}`);
  });
}

export function apply(ctx, config = {}) {
  const log = (message) => {
    ctx.logger?.warn?.(`[everything-claude-code] ${message}`);
  };
  /** Success narration, kept off the warning channel so warnings stay meaningful. */
  const note = (message) => {
    ctx.logger?.info?.(`[everything-claude-code] ${message}`);
  };

  // Register a PROVIDER, not one registration per skill.
  //
  // The registry caches candidates, so a `ctx.skills.register()` call carries its
  // `content` string with it and freezes that body at plugin load. Editing a
  // SKILL.md then has no effect until reload — observed directly: the tool
  // returned pre-edit text while the file on disk was already fixed.
  //
  // A provider's `get()` runs on every load, so the body is always current. That
  // is the same split `dsh-skill-filesystem` uses, and it makes an edit to a
  // SKILL.md visible on the next load without a reload.
  ctx.effect(
    () =>
      ctx.skills.registerProvider((control) => ({
        name: PROVIDER_NAME,
        list: async () => readSkillCandidates(log),
        get: async (candidate) => {
          const file = typeof candidate.locator === 'string' ? candidate.locator : undefined;
          if (file === undefined || !existsSync(file)) return undefined;
          const { body } = parseFrontmatter(readFileSync(file, 'utf8'));
          return { ...candidate, content: body.replace(/^\s+/, '') };
        },
      })),
    'everything-claude-code: skill provider',
  );

  if (config.verbose) {
    ctx.logger?.info?.(
      `[everything-claude-code] skill provider registered (${readSkillCandidates(log).length} skills)`,
    );
  }

  // The two ECC hooks the Claude Code bridge cannot run, replaced by native host
  // listeners. Guarded because a host context may carry no event bus.
  if (typeof ctx.on === 'function') {
    installPreCompactNote(ctx, log, note);
    installSessionEndNote(ctx, log, note);
  }

  // The Settings page reads its values here instead of re-deriving plugin state
  // in the browser. `connection` is injected optionally: a profile without the
  // Web carrier still loads the skills half, it just has no page to serve.
  // `ctx.inject` is itself optional — a host context may not carry it — so the
  // page route is skipped rather than throwing.
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['connection'], (scoped) => {
    const connection = scoped.get('connection');
    const register = connection?.fetch?.register?.bind(connection.fetch);
    if (typeof register !== 'function') return;
    scoped.effect(
      () =>
        register({
          path: '/api/everything-claude-code/status',
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async () =>
            Response.json(
              { ok: true, value: describeBundle(readSkillCandidates(log), log) },
              { headers: { 'cache-control': 'no-store' } },
            ),
        }),
      'everything-claude-code: status route',
    );
  });
}
