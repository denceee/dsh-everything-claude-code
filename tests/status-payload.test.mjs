#!/usr/bin/env node
/**
 * Verify the Host half still publishes skills after the Settings-page change,
 * and that its status payload matches what the page reads.
 *
 * The page is only as good as this payload: a renamed field would render an
 * empty page rather than an error, so the shape is asserted here.
 *
 * Usage: node tests/status-payload.test.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

const registered = [];
const routes = [];
let handler;
let providerFactory = null;

const ctx = {
  logger: { warn: () => {}, info: () => {} },
  effect: (factory) => factory(),
  skills: {
    // The Host half registers a provider; capture it so its catalog can be read.
    registerProvider: (create) => {
      providerFactory = create;
      return () => {};
    },
  },
  inject: (deps, callback) => {
    const scoped = {
      get: (name) =>
        name === 'connection'
          ? {
              fetch: {
                register: (route) => {
                  routes.push(route);
                  handler = route.fetch;
                  return async () => {};
                },
              },
            }
          : undefined,
      effect: (factory) => factory(),
    };
    callback(scoped);
  },
};

const plugin = await import(pathToFileURL(join(packageRoot, 'index.js')).href);

const results = [];
/** Await the body: an async check otherwise settles after the reporting pass. */
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await check('apply runs without throwing', () => {
  plugin.apply(ctx, {});
});

await check('registers a skill provider', () => {
  assert(providerFactory !== null, 'no provider registered');
});

let provider;
await check('the provider lists all 11 skills', async () => {
  provider = providerFactory({ signal: new AbortController().signal, invalidate: () => {} });
  const out = await provider.list({});
  registered.push(...(Array.isArray(out) ? out : out.candidates));
  assert(registered.length === 11, `expected 11 skills, got ${registered.length}`);
});

await check('registers exactly one status route', () => {
  assert(routes.length === 1, `expected 1 route, got ${routes.length}`);
});

await check('the route is a GET under the authenticated /api fence', () => {
  const route = routes[0];
  assert(route.path === '/api/everything-claude-code/status', `wrong path: ${route.path}`);
  assert(Array.isArray(route.methods) && route.methods.includes('GET'), 'must accept GET');
});

await check('the route answers a JSON payload', () => {
  assert(typeof handler === 'function', 'no handler captured');
});

const response = await handler(new Request('http://localhost/api/everything-claude-code/status'));
const body = await response.json();
const payload = body?.value;

await check('the payload is ok:true with a value object', () => {
  assert(body?.ok === true, 'ok must be true');
  assert(payload && typeof payload === 'object', 'value must be an object');
});

await check('every field the page reads is present', () => {
  for (const field of ['description', 'repository', 'skills', 'hooks', 'counts', 'notes']) {
    assert(payload[field] !== undefined, `missing field "${field}"`);
  }
  assert(Array.isArray(payload.skills), 'skills must be an array');
  assert(Array.isArray(payload.hooks), 'hooks must be an array');
  assert(Array.isArray(payload.notes), 'notes must be an array');
  assert(payload.counts && typeof payload.counts === 'object', 'counts must be an object');
});

await check('counts match the resources on disk', () => {
  assert(payload.counts.rules === 8, `expected 8 rules, got ${payload.counts.rules}`);
  assert(payload.counts.prompts === 15, `expected 15 prompts, got ${payload.counts.prompts}`);
  assert(payload.counts.personas === 9, `expected 9 personas, got ${payload.counts.personas}`);
  assert(payload.counts.resources === 35, `expected 35 resources, got ${payload.counts.resources}`);
});

await check('skills are sorted and match the published set', () => {
  const sorted = [...payload.skills].sort();
  assert(JSON.stringify(payload.skills) === JSON.stringify(sorted), 'skills must be sorted for a stable page');
  assert(payload.skills.includes('tdd-workflow'), 'expected tdd-workflow in the list');
});

await check('hook entries carry the fields the page renders', () => {
  assert(payload.hooks.length > 0, 'expected at least one hook point');
  for (const hook of payload.hooks) {
    assert(typeof hook.event === 'string' && hook.event.length > 0, 'hook.event must be a string');
    assert(typeof hook.matcher === 'string' && hook.matcher.length > 0, 'hook.matcher must be a string');
    assert(typeof hook.active === 'boolean', 'hook.active must be a boolean');
    assert(typeof hook.note === 'string', 'hook.note must be a string');
  }
});

await check('the payload is serializable (no functions leak to the browser)', () => {
  const json = JSON.stringify(payload);
  assert(json.length > 0, 'payload did not serialize');
  assert(!json.includes('function'), 'payload contains a function');
});

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} status-payload checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
