'use strict';
const { Storage } = require('@google-cloud/storage');
const { hash, same } = require('./crypto');
const conflict = error => [404, 409, 412].includes(Number(error.code));
class GcsStore {
  constructor(bucket, storage = new Storage({ retryOptions: { totalTimeout: 10 } })) { this.bucket = storage.bucket(bucket); }
  async put(name, data, generation) {
    await this.bucket.file(name).save(JSON.stringify(data), {
      resumable: false, validation: 'crc32c',
      metadata: { contentType: 'application/json', cacheControl: 'no-store' },
      ...(generation !== undefined ? { preconditionOpts: { ifGenerationMatch: generation } } : {})
    });
  }
  async read(name) {
    try {
      const [metadata] = await this.bucket.file(name).getMetadata();
      // Pin the read to the observed generation to avoid racing a replacement.
      const [data] = await this.bucket.file(name, { generation: metadata.generation }).download();
      return { data: JSON.parse(data.toString('utf8')), generation: metadata.generation };
    } catch (error) { if (Number(error.code) === 404) return null; throw error; }
  }
  async createState(state, binding, now) {
    await this.put('oauth-state/' + hash(state), { binding: hash(binding), expires: now + 600000 }, 0);
  }
  async consumeState(state, binding, now) {
    const name = 'oauth-state/' + hash(state);
    const found = await this.read(name);
    if (!found || found.data.expires <= now || !same(found.data.binding, hash(binding))) return false;
    try {
      // Exactly one instance can delete this generation and proceed to the exchange.
      await this.bucket.file(name, { preconditionOpts: { ifGenerationMatch: found.generation } }).delete();
      return true;
    } catch (error) { if (conflict(error)) return false; throw error; }
  }
  async allowStart(id, now) {
    // Shared limit, including across cold starts; creates are atomic.
    const prefix = `rate-limit/${Math.floor(now / 3600000)}/${id}/`;
    for (let slot = 0; slot < 20; slot++) {
      try { await this.put(prefix + slot, { expires: now + 3600000 }, 0); return true; }
      catch (error) { if (![409, 412].includes(Number(error.code))) throw error; }
    }
    return false;
  }
  async saveToken(id, envelope, generation) { await this.put('tokens/' + id, envelope, generation); }
  async readToken(id) { return this.read('tokens/' + id); }
}
module.exports = { GcsStore };
