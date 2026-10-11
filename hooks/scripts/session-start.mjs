#!/usr/bin/env node
/**
 * SessionStart: attach the ECC project rules and the available skill names.
 *
 * `additionalContext` is the only SessionStart channel the DSH bridge consumes;
 * plain stdout is ignored, and `systemMessage` is logged but never shown. The
 * rules ride along as context so the model starts a session already knowing
 * the repo's security, style, and testing expectations.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachContext, pass } from './lib.mjs';

/** Rules worth paying tokens for at every session start. */
const RULE_FILES = [
  'resources/rules/security.md',
  'resources/rules/coding-style.md',
  'resources/rules/testing.md',
];

const root = process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dirname, '..', '..');
const parts = [];

for (const relative of RULE_FILES) {
  const file = join(root, relative);
  if (!existsSync(file)) continue;
  const body = readFileSync(file, 'utf8').replace(/^---[\s\S]*?---/, '').trim();
  if (body) parts.push(`## ${relative}\n${body}`);
}

const skillsDir = join(root, 'skills');
if (existsSync(skillsDir)) {
  const names = readdirSync(skillsDir).filter((entry) => existsSync(join(skillsDir, entry, 'SKILL.md')));
  if (names.length > 0) {
    parts.push(
      `## Everything Claude Code skills\n${names.map((name) => `- ${name}`).join('\n')}\n` +
        'Load one with the skill tool when the task matches it.',
    );
  }
}

if (parts.length === 0) {
  pass();
} else {
  attachContext('SessionStart', parts.join('\n\n'));
}
