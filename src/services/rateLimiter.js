// src/services/rateLimiter.js — Anti-ban con Redis
const { getRedis } = require('./redisClient');

const MAX_MIN = parseInt(process.env.MAX_MSGS_PER_MINUTE || '4');
const MAX_DAY = parseInt(process.env.MAX_MSGS_PER_DAY   || '40');
const DELAY   = parseInt(process.env.TYPING_DELAY_MS    || '800');

async function checkLimit(phone) {
  try {
    const redis  = getRedis();
    const now    = new Date();
    const keyMin = `rl:m:${phone}:${now.toISOString().substring(0,16)}`;
    const keyDay = `rl:d:${phone}:${now.toISOString().substring(0,10)}`;

    const [cMin, cDay] = await Promise.all([redis.incr(keyMin), redis.incr(keyDay)]);
    if (cMin === 1) await redis.expire(keyMin, 60);
    if (cDay === 1) await redis.expire(keyDay, 86400);

    if (cMin > MAX_MIN) return { allowed: false, reason: 'min' };
    if (cDay > MAX_DAY) return { allowed: false, reason: 'day' };
    return { allowed: true };
  } catch (_) {
    return { allowed: true }; // si Redis falla, no bloqueamos
  }
}

function typingDelay(extra = 0) {
  const ms = DELAY + Math.floor(Math.random() * 400) + extra;
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { checkLimit, typingDelay };
