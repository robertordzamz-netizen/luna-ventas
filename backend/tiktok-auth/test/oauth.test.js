'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, config } = require('../src/app');
const { cipher, hash } = require('../src/crypto');
const { createTikTok, TOKEN_URL } = require('../src/tiktok');
const { GcsStore } = require('../src/store');
const { getAccessToken } = require('../src/refresh');
const key = Buffer.alloc(32, 7).toString('base64');
const cfg = { origin: 'https://auth.example.test', redirectUri: 'https://auth.example.test/auth/tiktok/callback', clientKey: 'test-key', encryptionKey: key, scopes: 'user.info.basic' };
const validToken = { open_id: 'test-open-id', access_token: 'secret-access', refresh_token: 'secret-refresh', token_type: 'Bearer', scope: 'user.info.basic', expires_in: 86400, refresh_expires_in: 31536000 };

// Generation-aware storage fake exercises the actual GcsStore adapter, not a second state implementation.
function fakeStorage() {
  const objects = new Map(); let generation = 0;
  const fail = code => { const e = new Error('simulated storage error'); e.code = code; throw e; };
  return { objects, bucket: () => ({ file: (name, options = {}) => ({
    async save(body, opts) {
      const expected = opts?.preconditionOpts?.ifGenerationMatch;
      if (expected !== undefined && String(expected) !== String(objects.get(name)?.generation || 0)) fail(412);
      objects.set(name, { body, generation: String(++generation) });
    },
    async getMetadata() { const found = objects.get(name); if (!found) fail(404); return [{ generation: found.generation }]; },
    async download() { const found = objects.get(name); if (!found || (options.generation && options.generation !== found.generation)) fail(404); return [Buffer.from(found.body)]; },
    async delete(opts) {
      const found = objects.get(name); if (!found) fail(404);
      if (options.preconditionOpts?.ifGenerationMatch !== found.generation) fail(412); objects.delete(name);
    }
  }) }) };
}
async function fixture(t, overrides = {}) {
  const storage = fakeStorage(); const store = new GcsStore('test-bucket', storage);
  const logs = []; const calls = []; let now = 1700000000000;
  const handler = createApp({ cfg, store, clock: () => now, log: value => logs.push(value), tiktok: { exchange: async code => { calls.push(code); return validToken; } }, ...overrides });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init) => fetch(base + path, { redirect: 'manual', ...init });
  const start = async () => {
    const response = await request('/auth/tiktok/start');
    const target = new URL(response.headers.get('location'));
    return { response, target, state: target.searchParams.get('state'), cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  return { storage, store, logs, calls, request, start, advance: ms => { now += ms; } };
}
test('Web flow uses exact HTTPS redirect, secure browser binding, encrypted persistence', async t => {
  const f = await fixture(t); const s = await f.start();
  assert.equal(s.response.status, 302);
  assert.equal(s.target.origin, 'https://www.tiktok.com');
  assert.equal(s.target.pathname, '/v2/auth/authorize/');
  assert.equal(s.target.searchParams.get('redirect_uri'), cfg.redirectUri);
  assert.equal(s.target.searchParams.get('scope'), 'user.info.basic');
  assert.equal(s.target.searchParams.has('code_challenge'), false);
  assert.match(s.response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
  const result = await f.request(`/auth/tiktok/callback?state=${s.state}&code=a%2Bb%252F`, { headers: { cookie: s.cookie } });
  assert.equal(result.status, 200); assert.deepEqual(f.calls, ['a+b%2F']);
  const publicBody = await result.text();
  assert.ok(!publicBody.includes('secret-access') && !publicBody.includes('test-open-id'));
  const id = cipher(key).id('tiktok:' + validToken.open_id);
  const record = await f.store.readToken(id);
  assert.equal(cipher(key).decrypt(record.data, id).access_token, 'secret-access');
  assert.ok(!JSON.stringify([...f.storage.objects]).includes('secret-refresh'));
  assert.ok(!JSON.stringify(f.logs).includes(s.state));
  assert.equal((await f.request(`/auth/tiktok/callback?state=${s.state}&code=retry`, { headers: { cookie: s.cookie } })).status, 400);
  assert.equal(f.calls.length, 1);
});
test('missing, forged, duplicated, mismatched, expired states never exchange', async t => {
  const f = await fixture(t); const s = await f.start();
  for (const path of [
    '/auth/tiktok/callback?code=secret',
    `/auth/tiktok/callback?state=${'x'.repeat(43)}&code=secret`,
    `/auth/tiktok/callback?state=${s.state}&state=${s.state}&code=secret`,
    `/auth/tiktok/callback?state=${s.state}&code=secret&return_to=https://evil.test`
  ]) assert.equal((await f.request(path, { headers: { cookie: s.cookie } })).status, 400);
  assert.equal((await f.request(`/auth/tiktok/callback?state=${s.state}&code=secret`)).status, 400);
  assert.equal((await f.request(`/auth/tiktok/callback?state=${s.state}&code=secret`, { headers: { cookie: '__Host-luna_tiktok=' + 'z'.repeat(43) } })).status, 400);
  f.advance(600001);
  assert.equal((await f.request(`/auth/tiktok/callback?state=${s.state}&code=secret`, { headers: { cookie: s.cookie } })).status, 400);
  assert.equal(f.calls.length, 0);
});
test('state consumption is atomic across instances', async () => {
  const storage = fakeStorage(); const a = new GcsStore('test', storage); const b = new GcsStore('test', storage);
  await a.createState('state', 'binding', 100);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).consumeState('state', 'binding', 101)));
  assert.equal(results.filter(Boolean).length, 1);
});
test('denial consumes state and never reflects provider text', async t => {
  const f = await fixture(t); const s = await f.start();
  const result = await f.request(`/auth/tiktok/callback?state=${s.state}&error=denied&error_description=secret-provider-message`, { headers: { cookie: s.cookie } });
  assert.equal(result.status, 400); assert.equal((await result.json()).error, 'authorization_denied'); assert.equal(f.calls.length, 0);
  assert.equal(await f.store.consumeState(s.state, s.cookie.split('=')[1], Date.now()), false);
});
test('exchange failure is generic, state spent, logs sanitized', async t => {
  const f = await fixture(t, { tiktok: { exchange: async () => { throw new Error('secret-code secret-refresh'); } } });
  const s = await f.start(); const r = await f.request(`/auth/tiktok/callback?state=${s.state}&code=secret-code`, { headers: { cookie: s.cookie } });
  assert.equal(r.status, 502); assert.ok(!JSON.stringify(f.logs).includes('secret-code')); assert.ok(!(await r.text()).includes('secret'));
});
test('persistence failure does not report connected', async t => {
  const f = await fixture(t); const s = await f.start(); f.store.saveToken = async () => { throw new Error('storage unavailable'); };
  const r = await f.request(`/auth/tiktok/callback?state=${s.state}&code=test`, { headers: { cookie: s.cookie } });
  assert.equal(r.status, 503); assert.equal((await r.json()).error, 'service_unavailable');
});
test('redirect overrides rejected; methods, routes, headers and shared budget', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/auth/tiktok/start?redirect_uri=https://evil.test')).status, 400);
  assert.equal((await f.request('/auth/tiktok/start', { method: 'POST' })).status, 405);
  assert.equal((await f.request('/not-found')).status, 404);
  const health = await f.request('/healthz'); assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store'); assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
  for (let i = 0; i < 20; i++) assert.equal((await f.request('/auth/tiktok/start')).status, 302);
  assert.equal((await f.request('/auth/tiktok/start')).status, 429);
  f.advance(3600000); assert.equal((await f.request('/auth/tiktok/start')).status, 302);
});
test('AEAD rejects ciphertext substitution and tampering', () => {
  const c = cipher(key); const encrypted = c.encrypt(validToken, 'id-a');
  assert.throws(() => c.decrypt(encrypted, 'id-b'));
  assert.throws(() => c.decrypt({ ...encrypted, tag: Buffer.alloc(16).toString('base64') }, 'id-a'));
  assert.throws(() => cipher('bad'));
  assert.equal(hash('a').length, 64);
});
test('configuration accepts only a static HTTPS origin and requires secrets', () => {
  const env = { PUBLIC_ORIGIN: cfg.origin, TIKTOK_CLIENT_KEY: 'test', TIKTOK_CLIENT_SECRET: 'test', TOKEN_ENCRYPTION_KEY: key, OAUTH_BUCKET: 'test' };
  assert.equal(config(env).redirectUri, cfg.redirectUri);
  for (const origin of ['http://localhost', 'https://example.test/callback', 'https://example.test?x=1', 'https://user:pass@example.test', 'https://example.test:444']) assert.throws(() => config({ ...env, PUBLIC_ORIGIN: origin }));
  assert.throws(() => config({ ...env, TIKTOK_CLIENT_SECRET: '' }));
});
test('token exchange and refresh use official endpoint, form encoding, server secret', async () => {
  const calls = []; const api = createTikTok({ clientKey: 'key', clientSecret: 'secret', redirectUri: cfg.redirectUri, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(validToken); } });
  assert.deepEqual(await api.exchange('a+b%2F'), validToken);
  assert.equal(calls[0].url, TOKEN_URL); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.body.get('code'), 'a+b%2F');
  assert.equal(calls[0].init.body.get('client_secret'), 'secret');
  assert.equal(calls[0].init.body.has('code_verifier'), false);
  await api.refresh('refresh'); assert.equal(calls[1].init.body.get('grant_type'), 'refresh_token');
});
test('upstream malformed, denied, huge and network responses fail closed', async () => {
  for (const mock of [
    async () => Response.json({ error: 'invalid_grant', error_description: 'secret' }, { status: 400 }),
    async () => new Response('not json'),
    async () => Response.json({ ...validToken, expires_in: -1 }),
    async () => new Response('x'.repeat(33000)),
    async () => { throw new Error('timeout'); }
  ]) await assert.rejects(createTikTok({ clientKey: 'key', clientSecret: 'secret', redirectUri: cfg.redirectUri, fetchImpl: mock }).exchange('code'));
});
test('internal refresh retains rotated credentials, uses CAS, and returns cached tokens', async () => {
  const crypto = cipher(key); const storage = fakeStorage(); const store = new GcsStore('test', storage);
  const id = crypto.id('tiktok:' + validToken.open_id); const now = 1700000000000;
  await store.saveToken(id, crypto.encrypt({ ...validToken, access_expires_at: now + 100, refresh_expires_at: now + 10000000 }, id));
  let calls = 0;
  const tiktok = { refresh: async old => { calls++; assert.equal(old, validToken.refresh_token); return { ...validToken, refresh_token: 'rotated-refresh', access_token: 'new-access' }; } };
  assert.equal(await getAccessToken({ id, crypto, store, tiktok, now }), 'new-access');
  assert.equal(crypto.decrypt((await store.readToken(id)).data, id).refresh_token, 'rotated-refresh');
  assert.equal(await getAccessToken({ id, crypto, store, tiktok, now }), 'new-access'); assert.equal(calls, 1);
});
test('internal refresh serializes workers and keeps lock on ambiguous provider failure', async () => {
  const crypto = cipher(key); const storage = fakeStorage(); const store = new GcsStore('test', storage);
  const id = crypto.id('tiktok:' + validToken.open_id); const now = 1700000000000;
  await store.saveToken(id, crypto.encrypt({ ...validToken, access_expires_at: now, refresh_expires_at: now + 1000000 }, id));
  let calls = 0; const tiktok = { refresh: async () => { calls++; throw new Error('provider uncertain'); } };
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => getAccessToken({ id, crypto, store, tiktok, now })));
  assert.equal(results.filter(x => x.status === 'rejected').length, 5); assert.equal(calls, 1);
  assert.ok(await store.read('refresh-lock/' + id));
});
