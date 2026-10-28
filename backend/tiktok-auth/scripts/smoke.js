'use strict';
const assert = require('node:assert/strict');
const origin = 'https://luna-ventas-tiktok-auth-852600734493.us-central1.run.app';
async function request(path, options) {
  return fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(30000), ...options });
}
async function main() {
  const health = await request('/healthz'); assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'luna-ventas-tiktok-auth');
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
  const noState = await request('/auth/tiktok/callback?code=smoke-invalid-code');
  assert.equal(noState.status, 400); assert.equal((await noState.json()).error, 'invalid_state');
  const redirectOverride = await request('/auth/tiktok/start?redirect_uri=https://example.invalid');
  assert.equal(redirectOverride.status, 400);
  const start = await request('/auth/tiktok/start'); assert.equal(start.status, 302);
  const location = new URL(start.headers.get('location'));
  assert.equal(location.origin, 'https://www.tiktok.com');
  assert.equal(location.searchParams.get('redirect_uri'), origin + '/auth/tiktok/callback');
  assert.equal(location.searchParams.get('scope'), 'user.info.basic');
  const state = location.searchParams.get('state'); assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  const cookie = start.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
  const headers = { cookie: cookie.split(';')[0] };
  const mismatch = await request('/auth/tiktok/callback?state=' + state + '&error=access_denied');
  assert.equal(mismatch.status, 400); assert.equal((await mismatch.json()).error, 'invalid_state');
  const denialPath = '/auth/tiktok/callback?state=' + state + '&error=access_denied';
  const denial = await request(denialPath, { headers });
  assert.equal(denial.status, 400); assert.equal((await denial.json()).error, 'authorization_denied');
  const replay = await request(denialPath, { headers });
  assert.equal(replay.status, 400); assert.equal((await replay.json()).error, 'invalid_state');
  console.log(JSON.stringify({ origin, health: 200, missing_state: 400, redirect_override: 400, start: 302, missing_cookie: 400, valid_state_denial: 400, replay: 400, checked_at: new Date().toISOString() }, null, 2));
}
main().catch(() => { console.error('Public smoke test failed; do not register callback as ready.'); process.exitCode = 1; });
