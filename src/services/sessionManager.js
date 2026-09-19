// src/services/sessionManager.js — Redis + PostgreSQL fallback
const { getRedis } = require('./redisClient');
const { execute, query, queryOne } = require('../data/database');

const TTL = 60 * 60 * 24;

async function getSession(phone) {
  const redis = getRedis();
  const key   = `sess:${phone}`;
  try {
    const cached = await redis.get(key);
    if (cached) { await redis.expire(key, TTL); return JSON.parse(cached); }
  } catch (_) {}

  let row = await queryOne('SELECT * FROM conversations WHERE phone = $1', [phone]);
  if (!row) {
    await execute(
      `INSERT INTO conversations (phone, state, context) VALUES ($1,'welcome','{}') ON CONFLICT (phone) DO NOTHING`,
      [phone]
    );
    row = await queryOne('SELECT * FROM conversations WHERE phone = $1', [phone]);
  }

  const session = {
    phone:         row.phone,
    name:          row.name,
    email:         row.email,
    state:         row.state,
    ticket_number: row.ticket_number,
    contact_phone:    row.contact_phone,
    external_user_id: row.external_user_id,
    context:       row.context || {},
  };

  try { await redis.setex(key, TTL, JSON.stringify(session)); } catch (_) {}
  return session;
}

async function updateSession(phone, updates) {
  const fields = [];
  const values = [];
  let i = 1;

  if (updates.state         !== undefined) { fields.push(`state=$${i++}`);         values.push(updates.state); }
  if (updates.name          !== undefined) { fields.push(`name=$${i++}`);          values.push(updates.name); }
  if (updates.email         !== undefined) { fields.push(`email=$${i++}`);         values.push(updates.email); }
  if (updates.ticket_number !== undefined) { fields.push(`ticket_number=$${i++}`); values.push(updates.ticket_number); }
  if (updates.contact_phone    !== undefined) { fields.push(`contact_phone=$${i++}`);    values.push(updates.contact_phone); }
  if (updates.external_user_id !== undefined) { fields.push(`external_user_id=$${i++}`); values.push(updates.external_user_id); }
  if (updates.context       !== undefined) { fields.push(`context=$${i++}`);       values.push(JSON.stringify(updates.context)); }
  fields.push(`updated_at=NOW()`);
  values.push(phone);

  if (fields.length > 1) {
    await execute(`UPDATE conversations SET ${fields.join(',')} WHERE phone=$${i}`, values);
  }
  try { await getRedis().del(`sess:${phone}`); } catch (_) {}
}

async function logMessage(phone, direction, body) {
  try {
    await execute('INSERT INTO messages (phone,direction,body) VALUES ($1,$2,$3)', [phone, direction, (body||'').substring(0,4000)]);
  } catch (e) { console.error('[DB] Error log:', e.message); }
}

async function getHistory(phone, limit = 8) {
  const rows = await query(
    `SELECT direction, body FROM messages WHERE phone=$1 ORDER BY created_at DESC LIMIT $2`,
    [phone, limit]
  );
  return rows.reverse();
}

module.exports = { getSession, updateSession, logMessage, getHistory };
