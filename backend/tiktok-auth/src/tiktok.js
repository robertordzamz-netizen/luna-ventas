'use strict';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
function createTikTok({ clientKey, clientSecret, redirectUri, fetchImpl = fetch }) {
  async function request(parameters) {
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-store' },
      body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, ...parameters })
    });
    // Limit upstream content; never log bodies or provider errors.
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 32768) { await reader.cancel(); throw new Error('Invalid token response'); }
      chunks.push(Buffer.from(value));
    }
    let token;
    try { token = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid token response'); }
    if (!response.ok || token.error || token.token_type !== 'Bearer' ||
        !['open_id', 'access_token', 'refresh_token', 'scope'].every(k => typeof token[k] === 'string' && token[k].length > 0 && token[k].length < 8192) ||
        !['expires_in', 'refresh_expires_in'].every(k => Number.isSafeInteger(token[k]) && token[k] > 0 && token[k] <= 10 * 365 * 86400)) {
      throw new Error('Token exchange failed');
    }
    return token;
  }
  return {
    exchange: code => request({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    refresh: refreshToken => request({ grant_type: 'refresh_token', refresh_token: refreshToken })
  };
}
module.exports = { createTikTok, TOKEN_URL };
