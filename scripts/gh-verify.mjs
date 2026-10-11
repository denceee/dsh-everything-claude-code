#!/usr/bin/env node
/**
 * Verify a GitHub token and report the identity behind it.
 * The token is read from the environment and never written to disk or printed.
 *
 * Usage: GH_TOKEN=<token> node scripts/gh-verify.mjs
 */
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('GH_TOKEN is not set');
  process.exit(2);
}

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-everything-claude-code',
};

try {
  const res = await fetch('https://api.github.com/user', { headers });
  console.log('status:', res.status);
  const body = await res.json();
  if (res.ok) {
    console.log('login    :', body.login);
    console.log('name     :', body.name ?? '(none)');
    console.log('id       :', body.id);
    console.log('scopes   :', res.headers.get('x-oauth-scopes') ?? '(fine-grained: no scope header)');
  } else {
    console.log('body     :', JSON.stringify(body).slice(0, 300));
  }
  process.exit(res.ok ? 0 : 1);
} catch (error) {
  console.error('network error:', error.message, '| cause:', error.cause?.code ?? error.cause?.message ?? '');
  process.exit(3);
}
