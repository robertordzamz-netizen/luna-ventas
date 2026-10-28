'use strict';
// Internal helper only. No public token-reading or refresh endpoint is exposed.
// Invoke before a future server-side API call; callers must already possess the
// internal connection ID and be authorized by Luna Ventas' own identity system.
async function getAccessToken({ id, crypto, store, tiktok, now = Date.now() }) {
  const stored = await store.readToken(id);
  if (!stored) throw new Error('Connection not found');
  const current = crypto.decrypt(stored.data, id);
  if (current.refresh_expires_at <= now) throw new Error('Reauthorization required');
  if (current.access_expires_at > now + 300000) return current.access_token;
  // Single refresh worker per connection. Expired locks are deliberately not
  // stolen: an operator must investigate an interrupted refresh before retrying.
  // This avoids unsafe concurrent refresh-token rotation.
  const lock = 'refresh-lock/' + id;
  await store.put(lock, { started_at: now }, 0);
  let result;
  try {
    // Reread after acquiring the lock to avoid acting on stale credentials.
    const latest = await store.readToken(id);
    const token = crypto.decrypt(latest.data, id);
    if (token.access_expires_at > now + 300000) result = token.access_token;
    else {
      const refreshed = await tiktok.refresh(token.refresh_token);
      if (refreshed.open_id !== token.open_id) throw new Error('Token identity mismatch');
      await store.saveToken(id, crypto.encrypt({ ...refreshed, obtained_at: now, access_expires_at: now + refreshed.expires_in * 1000, refresh_expires_at: now + refreshed.refresh_expires_in * 1000 }, id), latest.generation);
      result = refreshed.access_token;
    }
  } catch {
    // Keep the lock on uncertainty (provider may have rotated a token).
    throw new Error('Refresh requires operator review; reauthorization may be needed');
  }
  const held = await store.read(lock);
  await store.bucket.file(lock, { preconditionOpts: { ifGenerationMatch: held.generation } }).delete();
  return result;
}
module.exports = { getAccessToken };
