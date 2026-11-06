'use strict';
const { random, cipher } = require('./crypto');
const COOKIE = '__Host-luna_tiktok';
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
function config(env) {
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid PUBLIC_ORIGIN');
  const clientKey = env.TIKTOK_CLIENT_KEY?.trim();
  const clientSecret = env.TIKTOK_CLIENT_SECRET?.trim();
  if (!clientKey || !clientSecret || !env.OAUTH_BUCKET) throw new Error('Missing server configuration');
  return { origin: origin.origin, redirectUri: origin.origin + '/auth/tiktok/callback', clientKey, clientSecret, bucket: env.OAUTH_BUCKET, encryptionKey: env.TOKEN_ENCRYPTION_KEY?.trim(), scopes: 'user.info.basic' };
}
function createApp({ cfg, store, tiktok, clock = Date.now, log = event => console.log(JSON.stringify(event)) }) {
  const crypto = cipher(cfg.encryptionKey);
  const cookie = (value, age) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
  return async function handler(req, res) {
    const requestId = random();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (status, result) => { res.statusCode = status; res.end(JSON.stringify(result)); };
    try {
      if (!req.url || req.url.length > 8192 || !req.url.startsWith('/') || req.url.startsWith('//')) return send(400, { error: 'invalid_request' });
      const url = new URL(req.url, cfg.origin);
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(405, { error: 'method_not_allowed' }); }
      if (url.pathname === '/health') return send(200, { status: 'ok', service: 'luna-ventas-tiktok-auth' });
      if (url.pathname === '/') return send(200, { service: 'luna-ventas-tiktok-auth' });
      if (url.pathname === '/auth/tiktok/start') {
        // No dynamic return URLs, scopes, account IDs or redirect overrides accepted.
        if (url.search) return send(400, { error: 'invalid_request' });
        // Platform-specific forwarding headers are untrusted for authorization.
        // A global hourly budget bounds storage/exchange abuse without trusting IP headers.
        if (!await store.allowStart(crypto.id('start-global'), clock())) return send(429, { error: 'rate_limited' });
        const state = random(); const binding = random();
        await store.createState(state, binding, clock());
        const target = new URL('https://www.tiktok.com/v2/auth/authorize/');
        target.search = new URLSearchParams({ client_key: cfg.clientKey, response_type: 'code', scope: cfg.scopes, redirect_uri: cfg.redirectUri, state }).toString();
        res.setHeader('Set-Cookie', cookie(binding, 600));
        res.setHeader('Location', target.href); res.statusCode = 302; return res.end();
      }
      if (url.pathname === '/auth/tiktok/callback') {
        const params = url.searchParams;
        const allowed = new Set(['code', 'state', 'scopes', 'error', 'error_description']);
        if ([...params.keys()].some(k => !allowed.has(k) || params.getAll(k).length !== 1)) return send(400, { error: 'invalid_callback' });
        const state = params.get('state');
        const bindings = (req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(COOKIE + '='));
        const binding = bindings.length === 1 ? bindings[0].slice(COOKIE.length + 1) : '';
        if (!OPAQUE.test(state || '') || !OPAQUE.test(binding)) return send(400, { error: 'invalid_state' });
        if (!await store.consumeState(state, binding, clock())) return send(400, { error: 'invalid_state' });
        res.setHeader('Set-Cookie', cookie('', 0));
        if (params.has('error')) return send(400, { error: 'authorization_denied' });
        const code = params.get('code');
        // URLSearchParams already decodes once. Do not decode authorization codes twice.
        if (!code || code.length > 2048 || /[\x00-\x20\x7f]/.test(code)) return send(400, { error: 'invalid_callback' });
        let token;
        try { token = await tiktok.exchange(code); }
        catch { log({ severity: 'WARNING', event: 'tiktok_exchange_failed', requestId }); return send(502, { error: 'authorization_failed' }); }
        const id = crypto.id('tiktok:' + token.open_id);
        await store.saveToken(id, crypto.encrypt({ ...token, obtained_at: clock(), access_expires_at: clock() + token.expires_in * 1000, refresh_expires_at: clock() + token.refresh_expires_in * 1000 }, id));
        log({ severity: 'INFO', event: 'tiktok_authorization_stored', requestId });
        return send(200, { status: 'connected', message: 'Autorización de TikTok guardada de forma segura. Puedes cerrar esta ventana.' });
      }
      return send(404, { error: 'not_found' });
    } catch {
      log({ severity: 'ERROR', event: 'oauth_request_failed', requestId });
      return send(503, { error: 'service_unavailable' });
    }
  };
}
module.exports = { config, createApp };
