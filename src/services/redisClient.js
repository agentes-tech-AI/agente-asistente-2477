// src/services/redisClient.js — Upstash Redis con TLS (puerto 6379)
const Redis = require('ioredis');

let client = null;

function getRedis() {
  if (!client) {
    const host = (process.env.REDIS_URL || '')
      .replace('rediss://default:', '')
      .replace(/:.+@/, '@')
      .split('@')[1]?.split(':')[0]
      || 'localhost';

    client = new Redis({
      host,
      port:     parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      tls:      { rejectUnauthorized: false }, // Upstash usa puerto 6379 con TLS
      retryStrategy: (t) => t > 4 ? null : t * 300,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    client.on('connect', () => console.log('[Redis] Conectado a Upstash ✓'));
    // AggregateError (varios intentos IPv4/IPv6) llega sin message: usar el primer error interno
    client.on('error',   (e) => console.warn('[Redis] Error:', e.message || e.errors?.[0]?.message || e.code || String(e)));
  }
  return client;
}

module.exports = { getRedis };
