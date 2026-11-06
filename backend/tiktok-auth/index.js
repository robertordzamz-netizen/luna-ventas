'use strict';
const http = require('node:http');
const { config, createApp } = require('./src/app');
const { GcsStore } = require('./src/store');
const { createTikTok } = require('./src/tiktok');
function main() {
  const cfg = config(process.env);
  const handler = createApp({ cfg, store: new GcsStore(cfg.bucket), tiktok: createTikTok(cfg) });
  const server = http.createServer(handler);
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 50;
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
  process.on('SIGTERM', () => { server.close(); setTimeout(() => process.exit(0), 9000).unref(); });
  return server;
}
if (require.main === module) main();
module.exports = { main };
