const Redis = require('ioredis');
const env = require('./env');

function createClient(label, extraOptions = {}) {
  const client = new Redis(env.redisUrl, extraOptions);
  client.on('error', (err) => console.error(`[redis:${label}] error:`, err.message));
  client.on('reconnecting', () => console.warn(`[redis:${label}] reconnecting...`));
  client.on('ready', () => console.log(`[redis:${label}] ready`));
  return client;
}

const redis = createClient('main');
const adapterPubClient = createClient('adapter-pub', { maxRetriesPerRequest: null });
const adapterSubClient = createClient('adapter-sub', { maxRetriesPerRequest: null });
const presencePubClient = createClient('presence-pub');
const presenceSubClient = createClient('presence-sub');

module.exports = { redis, adapterPubClient, adapterSubClient, presencePubClient, presenceSubClient };
