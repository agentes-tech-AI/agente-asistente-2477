// src/routes/admin.js — API REST Panel Administración v6
const express = require('express');
const router  = express.Router();
const { query, execute, queryOne, nextCasoNumber } = require('../data/database');

// ── Ping público ──────────────────────────────────────────
router.get('/ping', function(req, res) {
  res.json({ ok:true, time:new Date().toISOString(), hasKey:!!process.env.ADMIN_API_KEY, db:!!process.env.PGHOST });
});

// ── Auth ──────────────────────────────────────────────────
function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!process.env.ADMIN_API_KEY) return res.status(503).json({ error:'ADMIN_API_KEY no configurada' });
  if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ error:'No autorizado' });
  next();
}
router.use(auth);

const wrap = fn => (req,res,next) => fn(req,res,next).catch(err=>{
  console.error('[ADMIN]',err.message);
  res.status(500).json({error:err.message});
});

// ── STATS ─────────────────────────────────────────────────
router.get('/stats', wrap(async (req, res) => {
  const [convs]  = await query('SELECT COUNT(*)::int AS n FROM conversations');
  const [msgs]   = await query('SELECT COUNT(*)::int AS n FROM messages');
  const [today]  = await query("SELECT COUNT(*)::int AS n FROM messages WHERE created_at > NOW() - INTERVAL '24h' AND direction='in'");
  const [tkts]   = await query("SELECT COUNT(*)::int AS n FROM tickets WHERE status='abierto'");
  const [casosP] = await query("SELECT COUNT(*)::int AS n FROM casos WHERE status NOT IN ('cancelado','listo_recoger','por_cancelar') AND COALESCE(pago,'') <> 'cancelado'");
  const [svcs]   = await query('SELECT COUNT(*)::int AS n FROM services WHERE available=true');
  const [faqs]   = await query('SELECT COUNT(*)::int AS n FROM faq');
  const leads    = await query("SELECT c.phone,c.context,c.name,c.updated_at,c.ticket_number FROM conversations c WHERE c.state='waiting' ORDER BY c.updated_at DESC LIMIT 20");
  res.json({
    total_conversations: convs?.n||0, total_messages:msgs?.n||0, messages_today:today?.n||0,
    open_tickets:tkts?.n||0, casos_pendientes:casosP?.n||0, active_services:svcs?.n||0,
    total_faqs:faqs?.n||0, recent_leads:leads||[]
  });
}));

// ── CASOS con DÍAS ────────────────────────────────────────
router.get('/casos', wrap(async (req, res) => {
  const rows = await query(`
    SELECT c.caso_number,c.ticket_number,c.phone,c.name,c.technician,c.status,c.description,c.device,c.resumen,c.pago,c.created_at,c.updated_at,c.evidencia_nombre,c.evidencia_tipo,
      EXTRACT(DAY FROM NOW() - c.created_at)::int AS dias_abierto
    FROM casos c ORDER BY c.created_at DESC LIMIT 500`);
  res.json(rows);
}));

router.post('/casos', wrap(async (req, res) => {
  const {ticket_number,phone,name,technician,status,description,device,resumen,pago} = req.body;
  const caso_number = await nextCasoNumber();
  await execute(
    `INSERT INTO casos (caso_number,ticket_number,phone,name,technician,status,description,device,resumen,pago)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [caso_number,ticket_number||null,phone||'',name||'',technician||'Sin asignar',status||'no_iniciado',description||'',device||'',resumen||'',pago||null]
  );
  if (ticket_number) await execute("UPDATE tickets SET status='en_proceso',updated_at=NOW() WHERE ticket_number=$1",[ticket_number]);
  res.json({ok:true,caso_number});
}));

router.put('/casos/:num', wrap(async (req, res) => {
  const {technician,status,description,device,resumen,pago,name,ticket_number} = req.body;
  await execute(
    `UPDATE casos SET technician=$1,status=$2,description=$3,device=$4,resumen=$5,pago=$6,name=$7,ticket_number=$8,updated_at=NOW() WHERE caso_number=$9`,
    [technician,status,description,device,resumen||'',pago||null,name,ticket_number,req.params.num]
  );
  res.json({ok:true});
}));

router.delete('/casos/:num', wrap(async (req, res) => {
  await execute('DELETE FROM casos WHERE caso_number=$1',[req.params.num]);
  res.json({ok:true});
}));

// ── TICKETS ───────────────────────────────────────────────
router.get('/tickets', wrap(async (req, res) => res.json(await query('SELECT id,ticket_number,phone,name,email,summary,acuerdo,status,created_at,updated_at FROM tickets ORDER BY created_at DESC LIMIT 200'))));
router.put('/tickets/:num', wrap(async (req, res) => {
  const {status,summary,email,acuerdo,name:tname} = req.body;
  // Solo se sobreescriben los campos enviados; el resumen del bot se conserva si no viene
  await execute('UPDATE tickets SET status=COALESCE($1,status),summary=COALESCE($2,summary),email=COALESCE($3,email),acuerdo=COALESCE($4,acuerdo),name=COALESCE($5,name),updated_at=NOW() WHERE ticket_number=$6',
    [status||null,summary||null,email||null,acuerdo||null,tname||null,req.params.num]);
  res.json({ok:true});
}));

// ── SERVICIOS ─────────────────────────────────────────────
router.get('/services', wrap(async (req, res) => res.json(await query('SELECT * FROM services ORDER BY price_soles'))));
router.post('/services', wrap(async (req, res) => {
  const {code,name,description,price_soles,turnaround,category} = req.body;
  if (!code||!name) return res.status(400).json({error:'code y name requeridos'});
  await execute('INSERT INTO services (code,name,description,price_soles,turnaround,category) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING',[code,name,description,price_soles||0,turnaround,category]);
  res.json({ok:true});
}));
router.put('/services/:code', wrap(async (req, res) => {
  const {name,description,price_soles,turnaround,category,available} = req.body;
  await execute('UPDATE services SET name=$1,description=$2,price_soles=$3,turnaround=$4,category=$5,available=$6 WHERE code=$7',[name,description,price_soles,turnaround,category,available,req.params.code]);
  res.json({ok:true});
}));
router.delete('/services/:code', wrap(async (req, res) => {
  await execute('DELETE FROM services WHERE code=$1',[req.params.code]);
  res.json({ok:true});
}));

// ── FAQs ──────────────────────────────────────────────────
router.get('/faq', wrap(async (req, res) => res.json(await query('SELECT * FROM faq ORDER BY id'))));
router.post('/faq', wrap(async (req, res) => {
  const {question,answer,keywords} = req.body;
  const row = await queryOne('INSERT INTO faq (question,answer,keywords) VALUES ($1,$2,$3) RETURNING id',[question,answer,keywords||'']);
  res.json({ok:true,id:row.id});
}));
router.put('/faq/:id', wrap(async (req, res) => {
  const {question,answer,keywords} = req.body;
  await execute('UPDATE faq SET question=$1,answer=$2,keywords=$3 WHERE id=$4',[question,answer,keywords,req.params.id]);
  res.json({ok:true});
}));
router.delete('/faq/:id', wrap(async (req, res) => {
  await execute('DELETE FROM faq WHERE id=$1',[req.params.id]);
  res.json({ok:true});
}));

// ── CONVERSACIONES ────────────────────────────────────────
router.get('/conversations', wrap(async (req, res) => {
  const rows = await query(`SELECT c.*,(SELECT COUNT(*) FROM messages m WHERE m.phone=c.phone)::int AS msg_count,(SELECT body FROM messages m WHERE m.phone=c.phone ORDER BY created_at DESC LIMIT 1) AS last_msg FROM conversations c ORDER BY c.updated_at DESC LIMIT 100`);
  res.json(rows);
}));
router.get('/messages/:phone', wrap(async (req, res) => {
  const rows = await query('SELECT * FROM messages WHERE phone=$1 ORDER BY created_at ASC LIMIT 100',[decodeURIComponent(req.params.phone)]);
  res.json(rows);
}));

// ── TÉCNICOS ──────────────────────────────────────────────
router.get('/tecnicos', wrap(async (req, res) => res.json(await query('SELECT * FROM tecnicos ORDER BY nombre'))));
router.post('/tecnicos', wrap(async (req, res) => {
  const {nombre,email} = req.body;
  if (!nombre) return res.status(400).json({error:'nombre requerido'});
  const row = await queryOne('INSERT INTO tecnicos (nombre,email) VALUES ($1,$2) ON CONFLICT (nombre) DO UPDATE SET email=$2 RETURNING id',[nombre,email||'']);
  res.json({ok:true,id:row.id});
}));
router.put('/tecnicos/:id', wrap(async (req, res) => {
  const {nombre,email,activo} = req.body;
  await execute('UPDATE tecnicos SET nombre=$1,email=$2,activo=$3 WHERE id=$4',[nombre,email||'',activo,req.params.id]);
  res.json({ok:true});
}));
router.delete('/tecnicos/:id', wrap(async (req, res) => {
  await execute('DELETE FROM tecnicos WHERE id=$1',[req.params.id]);
  res.json({ok:true});
}));

// ── SÍNTOMAS / RESÚMENES ──────────────────────────────────
router.get('/sintomas', wrap(async (req, res) => res.json(await query('SELECT * FROM sintomas ORDER BY nombre'))));
router.post('/sintomas', wrap(async (req, res) => {
  const {nombre} = req.body;
  const row = await queryOne('INSERT INTO sintomas (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING RETURNING id',[nombre]);
  res.json({ok:true,id:row?.id});
}));
router.put('/sintomas/:id', wrap(async (req, res) => {
  const {nombre,activo} = req.body;
  await execute('UPDATE sintomas SET nombre=$1,activo=$2 WHERE id=$3',[nombre,activo,req.params.id]);
  res.json({ok:true});
}));
router.delete('/sintomas/:id', wrap(async (req, res) => {
  await execute('DELETE FROM sintomas WHERE id=$1',[req.params.id]);
  res.json({ok:true});
}));


// ── ESTADOS DE CASO (administrables) ─────────────────────
router.get('/estados', wrap(async (req, res) => res.json(await query('SELECT * FROM estados_caso ORDER BY orden'))));
router.post('/estados', wrap(async (req, res) => {
  const {nombre,label,orden} = req.body;
  if (!nombre||!label) return res.status(400).json({error:'nombre y label requeridos'});
  await execute('INSERT INTO estados_caso (nombre,label,orden) VALUES ($1,$2,$3) ON CONFLICT (nombre) DO UPDATE SET label=$2,orden=$3',[nombre,label,parseInt(orden)||0]);
  res.json({ok:true});
}));
router.put('/estados/:id', wrap(async (req, res) => {
  const {nombre,label,activo,orden} = req.body;
  await execute('UPDATE estados_caso SET nombre=$1,label=$2,activo=$3,orden=$4 WHERE id=$5',[nombre,label,activo,parseInt(orden)||0,req.params.id]);
  res.json({ok:true});
}));
router.delete('/estados/:id', wrap(async (req, res) => {
  await execute('DELETE FROM estados_caso WHERE id=$1',[req.params.id]);
  res.json({ok:true});
}));

// ── EVIDENCIA DE PAGO ─────────────────────────────────────
router.post('/casos/:num/evidencia', wrap(async (req, res) => {
  const {base64,nombre,tipo} = req.body;
  if (!base64) return res.status(400).json({error:'base64 requerido'});
  await execute('UPDATE casos SET evidencia_pago=$1,evidencia_nombre=$2,evidencia_tipo=$3,updated_at=NOW() WHERE caso_number=$4',[base64,nombre||'evidencia',tipo||'',req.params.num]);
  res.json({ok:true});
}));

router.get('/casos/:num/evidencia', wrap(async (req, res) => {
  const row = await queryOne('SELECT evidencia_pago,evidencia_nombre,evidencia_tipo FROM casos WHERE caso_number=$1',[req.params.num]);
  if (!row||!row.evidencia_pago) return res.status(404).json({error:'Sin evidencia'});
  res.json({base64:row.evidencia_pago,nombre:row.evidencia_nombre,tipo:row.evidencia_tipo});
}));


// ── ESTADOS DE PAGO ───────────────────────────────────────
router.get('/pagos', wrap(async (req, res) => res.json(await query('SELECT * FROM estados_pago ORDER BY orden'))));
router.post('/pagos', wrap(async (req, res) => {
  const {nombre,label,color,orden,activo} = req.body;
  if (!nombre||!label) return res.status(400).json({error:'nombre y label requeridos'});
  await execute('INSERT INTO estados_pago (nombre,label,color,orden,activo) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (nombre) DO UPDATE SET label=$2,color=$3,orden=$4,activo=$5',
    [nombre,label,color||'bn',parseInt(orden)||0,activo!==false]);
  res.json({ok:true});
}));
router.put('/pagos/:id', wrap(async (req, res) => {
  const {nombre,label,color,orden,activo} = req.body;
  await execute('UPDATE estados_pago SET nombre=$1,label=$2,color=$3,orden=$4,activo=$5 WHERE id=$6',
    [nombre,label,color||'bn',parseInt(orden)||0,activo,req.params.id]);
  res.json({ok:true});
}));
router.delete('/pagos/:id', wrap(async (req, res) => {
  await execute('DELETE FROM estados_pago WHERE id=$1',[req.params.id]);
  res.json({ok:true});
}));

module.exports = router;
