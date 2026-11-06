'use strict';
const { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
function same(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function cipher(key) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key || '') || Buffer.from(key, 'base64').length !== 32) throw new Error('Invalid encryption key');
  const bytes = Buffer.from(key, 'base64');
  return {
    id: value => createHmac('sha256', bytes).update(value).digest('hex'),
    encrypt(value, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', bytes, iv);
      c.setAAD(Buffer.from(aad));
      const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
      return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    decrypt(value, aad) {
      if (value.v !== 1) throw new Error('Invalid ciphertext version');
      const c = createDecipheriv('aes-256-gcm', bytes, Buffer.from(value.iv, 'base64'));
      c.setAAD(Buffer.from(aad)); c.setAuthTag(Buffer.from(value.tag, 'base64'));
      return JSON.parse(Buffer.concat([c.update(Buffer.from(value.data, 'base64')), c.final()]).toString('utf8'));
    }
  };
}
module.exports = { hash, random, same, cipher };
