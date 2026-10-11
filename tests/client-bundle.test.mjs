#!/usr/bin/env node
/**
 * Execute the client half the way the browser module table does.
 *
 * The bundle is a `window.__ModuleLoader__.load({ id, factory })` call whose
 * factory returns `{ inject, apply }`. A syntax error, a wrong export shape, or
 * a `require` of a package the host does not provide blanks the slot silently
 * (console: `slot entry crashed in '<slot>'`). This test mocks the loader and
 * React, runs `apply`, and asserts the registration the page needs.
 *
 * Usage: node tests/client-bundle.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const source = readFileSync(join(packageRoot, 'client.js'), 'utf8');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// --- a minimal React, enough to build elements and run hooks ----------------
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  useRef: (value) => ({ current: value }),
};

const loaded = [];
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (entry) => loaded.push(entry),
    },
  },
  console,
  fetch: () => Promise.reject(new Error('fetch is not exercised in this test')),
  AbortController,
  setTimeout,
  clearTimeout,
};
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
new vm.Script(source, { filename: 'client.js' }).runInContext(context);

// --- what the loader received ----------------------------------------------
check('registers exactly one lazy factory', () => {
  assert(loaded.length === 1, `expected 1 load() call, got ${loaded.length}`);
});

check('the factory id equals the package name', () => {
  assert(loaded[0]?.id === packageJson.name, `expected id "${packageJson.name}", got "${loaded[0]?.id}"`);
});

check('the factory is a function', () => {
  assert(typeof loaded[0]?.factory === 'function', 'factory is not a function');
});

// --- what the factory returns ----------------------------------------------
let module;
check('factory runs without throwing', () => {
  const require = (specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected require("${specifier}") — only react is provided by the host`);
  };
  module = loaded[0].factory(require);
  assert(module !== undefined && module !== null, 'factory returned nothing');
});

check('exports the inject list including slots', () => {
  assert(Array.isArray(module.inject), 'inject is not an array');
  assert(module.inject.includes('slots'), `inject must include "slots", got ${JSON.stringify(module.inject)}`);
});

check('exports an apply function', () => {
  assert(typeof module.apply === 'function', 'apply is not a function');
});

// --- what apply registers ---------------------------------------------------
const registrations = [];
const injections = [];
const fakeCtx = {
  slots: {
    inject: (owner, callback) => {
      injections.push(owner);
      callback();
    },
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
  get: () => undefined,
  effect: () => () => {},
};

check('apply registers one page without throwing', () => {
  module.apply(fakeCtx);
  assert(registrations.length === 1, `expected 1 registration, got ${registrations.length}`);
});

check('registers into settings.section as a top-level page', () => {
  const { options } = registrations[0];
  assert(options.name === 'settings.section', `wrong slot: ${options.name}`);
  assert(injections.includes('settings.section'), 'did not inject the owning slot first');
});

check('is not filed under the read-only Built-in plugins inventory', () => {
  const { options } = registrations[0];
  assert(
    options.name !== 'settings.plugins.tab',
    'settings.plugins.tab is the read-only inventory of shipped plugins; a third-party page belongs in settings.section',
  );
});

check('uses a unique id so a shipped section is not replaced', () => {
  const { options } = registrations[0];
  assert(typeof options.id === 'string' && options.id.length > 0, 'id must be a non-empty string');
  for (const shipped of ['general', 'account', 'models', 'plugins', 'about']) {
    assert(options.id !== shipped, `id "${shipped}" would replace the shipped section`);
  }
});

check('provides a label (string or thunk)', () => {
  const { options } = registrations[0];
  const label = typeof options.label === 'function' ? options.label() : options.label;
  assert(typeof label === 'string' && label.length > 0, 'label must resolve to non-empty text');
});

check('registers a renderable component', () => {
  const { component } = registrations[0];
  assert(typeof component === 'function', 'component is not a function');
});

check('the page renders without throwing', () => {
  const element = registrations[0].component({ locale: 'zh' });
  assert(element && typeof element === 'object', 'component did not return an element');
  assert(element.type === 'div', `expected a div root, got ${String(element.type)}`);
});

check('the page renders in English too', () => {
  const element = registrations[0].component({ locale: 'en' });
  assert(element && typeof element === 'object', 'component did not return an element');
});

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} client-bundle checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
