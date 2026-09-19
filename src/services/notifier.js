// src/services/notifier.js — Notificaciones salientes por WhatsApp (Twilio REST API)
//
// WhatsApp solo permite texto libre dentro de las 24 h posteriores al último
// mensaje del cliente; fuera de esa ventana exige una plantilla aprobada
// (Twilio Content Template). Si se define TWILIO_CONTENT_SID_CASO_CREADO /
// TWILIO_CONTENT_SID_CASO_AVANCE se envía la plantilla con variables
// {{1}} nombre, {{2}} n° caso, {{3}} ticket, {{4}} estado; si no, texto libre.
const twilio = require('twilio');
const { queryOne } = require('../data/database');
const { logMessage } = require('./sessionManager');
const { labelEstadoCaso } = require('./estados');
const { trackEvent, trackException } = require('../config/azure');

const SITE_URL = 'https://recuperotusdatos.com';

let client = null;
function getClient() {
  if (!client) client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client;
}

// Convierte lo guardado en un caso/ticket a una dirección de WhatsApp válida:
// "whatsapp:+51…" y "whatsapp:PE.123…" (BSUID) se respetan; "+51987654321" y
// "987654321" se completan. Devuelve null si no es utilizable.
function destinoWhatsApp(valor) {
  const raw = String(valor || '').trim();
  if (/^whatsapp:[A-Z]{2}\.[A-Za-z0-9]+$/.test(raw)) return raw;   // BSUID: conservar el punto
  const v = raw.replace(/[\s\-().]/g, '');
  if (/^whatsapp:\+\d{8,15}$/.test(v)) return v;
  if (/^\+\d{8,15}$/.test(v)) return `whatsapp:${v}`;
  if (/^9\d{8}$/.test(v)) return `whatsapp:+51${v}`;
  return null;
}

// El destino es la conversación de WhatsApp del ticket (siempre es el remitente
// real, aunque el número esté oculto); si el caso no tiene ticket, su teléfono.
async function resolverDestino(caso) {
  if (caso.ticket_number) {
    const t = await queryOne('SELECT phone FROM tickets WHERE ticket_number = $1', [caso.ticket_number]);
    const d = destinoWhatsApp(t?.phone);
    if (d) return d;
  }
  return destinoWhatsApp(caso.phone);
}

function mensajeCasoCreado(caso, estado) {
  const name = caso.name || 'cliente';
  return (
    `🔧 *Recupero 24/7 — Caso registrado*\n\n` +
    `Estimado/a *${name}*, hemos registrado su caso de recuperación de datos.\n\n` +
    (caso.ticket_number ? `🎫 Ticket: ${caso.ticket_number}\n` : '') +
    `🔢 N° caso: *${caso.caso_number}*\n` +
    (caso.device ? `📱 Dispositivo: ${caso.device}\n` : '') +
    `📊 Estado: *${estado}*\n\n` +
    `Le notificaremos por este medio cada avance. Escriba *${caso.caso_number}* en cualquier momento para consultar el estado.\n_${SITE_URL}_`
  );
}

function mensajeAvance(caso, estado) {
  const name = caso.name || 'cliente';
  return (
    `📊 *Recupero 24/7 — Avance de su caso*\n\n` +
    `Estimado/a *${name}*, su caso *${caso.caso_number}*` +
    (caso.ticket_number ? ` (ticket ${caso.ticket_number})` : '') + ` ha pasado a:\n\n` +
    `*${estado}*\n` +
    (caso.technician && caso.technician !== 'Sin asignar' ? `🔧 Técnico: ${caso.technician}\n` : '') +
    `\n_Escriba *${caso.caso_number}* para ver el detalle completo._\n_${SITE_URL}_`
  );
}

async function enviarWhatsApp(to, body, contentSid, variables) {
  const from = process.env.TWILIO_WHATSAPP_NUMBER;
  if (!from) return { ok: false, error: 'TWILIO_WHATSAPP_NUMBER no configurado' };

  // Modo simulación (desarrollo/pruebas): registra el mensaje sin llamar a Twilio
  if (process.env.NOTIFICACIONES_DRY_RUN === '1') {
    console.log(`[NOTIF] (simulado) → ${to}: ${body.substring(0, 80)}`);
    await logMessage(to, 'out', body);
    return { ok: true, sid: 'dry-run', to };
  }

  const params = { from, to };
  if (contentSid) { params.contentSid = contentSid; params.contentVariables = JSON.stringify(variables || {}); }
  else params.body = body;

  const msg = await getClient().messages.create(params);
  await logMessage(to, 'out', body);
  console.log(`[NOTIF] → ${to} (${msg.sid})`);
  return { ok: true, sid: msg.sid, to };
}

// tipo: 'creado' | 'avance'. Devuelve { ok, to, sid?, error? }; nunca lanza.
async function notificarCaso(casoNumber, tipo) {
  if (process.env.NOTIFICAR_AVANCES === '0') return { ok: false, skipped: true, error: 'Notificaciones desactivadas (NOTIFICAR_AVANCES=0)' };
  try {
    const caso = await queryOne('SELECT * FROM casos WHERE caso_number = $1', [casoNumber]);
    if (!caso) return { ok: false, error: 'Caso no encontrado' };

    const to = await resolverDestino(caso);
    if (!to) return { ok: false, error: 'El caso no tiene un WhatsApp de contacto válido (ticket o teléfono)' };

    const estado     = await labelEstadoCaso(caso.status) || caso.status || '—';
    const body       = tipo === 'creado' ? mensajeCasoCreado(caso, estado) : mensajeAvance(caso, estado);
    const contentSid = tipo === 'creado' ? process.env.TWILIO_CONTENT_SID_CASO_CREADO : process.env.TWILIO_CONTENT_SID_CASO_AVANCE;
    const variables  = { 1: caso.name || 'cliente', 2: caso.caso_number, 3: caso.ticket_number || '—', 4: estado };

    const r = await enviarWhatsApp(to, body, contentSid || null, variables);
    trackEvent('NotificacionCaso', { caso: casoNumber, tipo, to, ok: String(r.ok) });
    return r;
  } catch (err) {
    trackException(err, { service: 'notifier', caso: casoNumber, tipo });
    console.error('[NOTIF] Error:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { notificarCaso, enviarWhatsApp, destinoWhatsApp };
