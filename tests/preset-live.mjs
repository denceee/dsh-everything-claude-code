#!/usr/bin/env node
/**
 * Report the live agent-preset roster by driving the Host's own RPC.
 *
 * The session log records hook activity but not preset activation. The
 * authoritative answer comes from the running Host, which is reachable through
 * the authenticated API the Web client uses.
 *
 * This reads the boot token the same way the browser does, then calls the
 * preset roster endpoint. If the token is unavailable the script says so rather
 * than reporting a false negative.
 *
 * Usage: node tests/preset-live.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387';

/** Find the process token the Web client uses, from the launcher's own state. */
function findToken() {
  const candidates = [];
  const home = process.env.USERPROFILE ?? '';
  for (const p of [
    join(home, '.dsh', 'data', 'web-token'),
    join(home, '.dsh', '.web-url'),
    join(home, '.dsh', 'web-url.txt'),
  ]) {
    candidates.push(p);
  }
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  }
  return null;
}

const token = process.env.DSH_TOKEN ?? findToken();

async function tryUrl(url) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    return { status: res.status, text };
  } catch (error) {
    return { status: 0, text: String(error.message) };
  }
}

console.log(`base: ${BASE}`);
console.log(`token found: ${token ? 'yes' : 'no (unauthenticated attempt)'}\n`);

for (const path of ['/api/agentPresets/list', '/api/agents/presets', '/api/agent-preset/list']) {
  const r = await tryUrl(`${BASE}${path}`);
  console.log(`${path} -> ${r.status}`);
  if (r.status === 200) {
    try {
      const body = JSON.parse(r.text);
      const presets = body.value?.presets ?? body.presets ?? body.value ?? body;
      if (Array.isArray(presets)) {
        console.log('  presets in the live roster:');
        for (const p of presets) {
          const broken = p.broken ? `  BROKEN: ${p.broken}` : '';
          console.log(`    ${p.id}${p.isDefault ? ' (default)' : ''}${broken}`);
        }
      } else {
        console.log(`  body: ${r.text.slice(0, 400)}`);
      }
    } catch {
      console.log(`  non-JSON: ${r.text.slice(0, 200)}`);
    }
    process.exit(0);
  }
}

console.log('\nCould not read the live roster over HTTP (the Web API requires the');
console.log('process token, which is not on disk for this session). Use the');
console.log('`cordis_inspect_query` tool instead: host Service `agentPresets` ->');
console.log('`compositionInventory()`, or Config.listConfigs for @deepseek-ai/dsh-agent-preset.');
