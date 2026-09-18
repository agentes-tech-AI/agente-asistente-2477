// src/index.js — Recupero 24/7 · Azure App Service
// dotenv primero (en local) y luego Application Insights, antes de cualquier otro import
require('dotenv').config();
const { initApplicationInsights, trackEvent, trackException } = require('./config/azure');
initApplicationInsights();

const express     = require('express');
const twilio      = require('twilio');
const path        = require('path');
const { initSchema }    = require('./data/database');
const { handleMessage } = require('./handlers/messageHandler');
const adminRoutes       = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || process.env.WEBSITES_PORT || 8080;

// Archivos estáticos - PRIMERO antes de cualquier otro middleware
app.use('/static', express.static(path.join(__dirname, 'public')));

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '10mb' })); // evidencias de pago en base64 (máx 5MB de archivo)

// ── Panel Admin ($0 extra — incluido en el App Service) ────
app.use('/api/admin', adminRoutes);
// Acepta /admin y /ADMIN (case insensitive)
app.get(['/admin', '/ADMIN', '/Admin'], (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Cliente Twilio ─────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Estado interno ────────────────────────────────────────
const appState = { dbReady: false };

// ── Validar firma Twilio ───────────────────────────────────
function validateTwilio(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  const host = process.env.WEBSITE_HOSTNAME || req.hostname;
  const url  = `https://${host}${req.originalUrl}`;
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    req.headers['x-twilio-signature'] || '',
    url,
    req.body
  );
  if (!valid) {
    console.warn('[Security] Firma Twilio inválida');
    return res.status(403).send('Forbidden');
  }
  next();
}

// ── WEBHOOK PRINCIPAL ─────────────────────────────────────
app.post('/webhook', validateTwilio, async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const phone = req.body.From || '';
  const text  = req.body.Body || '';
  const externalUserId   = req.body.ExternalUserId || null;
  const profileName      = req.body.ProfileName || null;

  try {
    console.log(`[IN]  ${phone}: ${text.substring(0, 80)}`);
    const reply = await handleMessage(phone, text, { profileName, externalUserId });
    if (reply) {
      twiml.message(reply);
      console.log(`[OUT] ${phone}: ${reply.substring(0, 80)}`);
      trackEvent('MensajeEnviado', { phone });
    }
  } catch (err) {
    trackException(err, { phone, text });
    console.error('[ERROR] webhook:', err.message);
    twiml.message('😅 Problema técnico. Escribe *menú* para continuar.');
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

// ── Health check ──────────────────────────────────────────
app.get('/', (_, res) => res.json({ status: 'ok', agent: 'Recupero 24/7' }));
app.get('/health', (_, res) => res.json({
  status:  'ok',
  db:      !!process.env.PGHOST && appState.dbReady,
  dbReady: appState.dbReady,
  redis:   !!process.env.REDIS_PASSWORD,
  ai:      !!process.env.AZURE_FOUNDRY_API_KEY,
  twilio:  !!process.env.TWILIO_ACCOUNT_SID,
}));

// ── ARRANQUE: servidor primero, BD después ────────────────
async function start() {
  app.listen(PORT, '0.0.0.0', () => {
    const host = process.env.WEBSITE_HOSTNAME;
    console.log(`\n🤖 Recupero 24/7 · Asistente WhatsApp en puerto ${PORT}`);
    console.log(`📡 Webhook: POST /webhook`);
    console.log(`🏥 Health:  GET  /health`);
    console.log(`⚙️  Admin:   GET  /admin`);
    if (host) console.log(`🌐 https://${host}/webhook\n`);
  });

  const connectDB = async () => {
    try {
      console.log('[DB] Conectando a PostgreSQL...');
      await initSchema();
      appState.dbReady = true;
      console.log('[DB] ✓ Base de datos lista');
    } catch (err) {
      trackException(err, { phase: 'db-init' });
      console.error('[DB] ✗ Error:', err.message);
      console.error('[DB] Reintentando en 30s...');
      setTimeout(connectDB, 30000);
    }
  };

  connectDB();
}

start();
