// src/handlers/messageHandler.js — Asistente Recupero 24/7 v6
const { query, execute, queryOne, nextTicketNumber } = require('../data/database');
const { getSession, updateSession, logMessage, getHistory } = require('../services/sessionManager');
const { askAI }          = require('../services/aiService');
const { checkLimit, typingDelay } = require('../services/rateLimiter');
const { trackEvent }     = require('../config/azure');

const SITE_URL = 'https://recuperotusdatos.com';

const MENU_WORDS  = ['menu','menú','inicio','start','0','volver','regresar','opciones'];
const HELLO_WORDS = ['hola','buenas','buenos dias','buenos días','hi','hey','buenas tardes','buenas noches','saludos','buen dia','buen día'];

const menuPrincipal = (name, ticket) => {
  const ticketLine = ticket ? `🎫 *Ticket activo: ${ticket}*\n\n` : '';
  return `Estimado/a *${name}*, ¿en qué le podemos ayudar hoy?\n\n${ticketLine}` +
    `1️⃣  Ver servicios y precios\n` +
    `2️⃣  Consultar disponibilidad\n` +
    `3️⃣  Realizar una consulta técnica\n` +
    `4️⃣  Solicitar cotización\n` +
    `5️⃣  Hablar con un especialista\n` +
    `6️⃣  Consultar estado de mi caso\n\n` +
    `_Responda con el número de la opción deseada_\n_${SITE_URL}_`;
};

async function buildMenuServicios() {
  const svcs = await query('SELECT * FROM services WHERE available=true ORDER BY price_soles');
  let txt = `📋 *Servicios de recuperación de datos:*\n\n`;
  svcs.forEach((s, i) => {
    const p = s.price_soles == 0 ? '🎁 Sin costo' : `S/ ${s.price_soles}`;
    txt += `*${i + 1}. ${s.name}*\n   💰 ${p}  ⏱ ${s.turnaround}\n\n`;
  });
  txt += `_Ingrese el número para ver detalles o escriba *menú* para volver_`;
  return txt;
}

// ── Enrutador principal ─────────────────────────────────────
async function handleMessage(phone, incomingText, meta = {}) {
  const { profileName } = meta;
  const limit = await checkLimit(phone);
  if (!limit.allowed) { console.log(`[RATE-LIMIT] ${phone}`); return null; }

  const text    = (incomingText || '').trim();
  const textLow = text.toLowerCase().trim();
  const session = await getSession(phone);

  await logMessage(phone, 'in', text);

  const isMenu  = MENU_WORDS.includes(textLow);
  const isHello = HELLO_WORDS.some(g => textLow === g || textLow.startsWith(g + ' '));

  // Saludo con sesión activa → menú
  if ((isMenu || isHello) && session.name && session.email) {
    await typingDelay(200);
    const ticket = session.ticket_number || session.context?.ticket;
    return enviar(phone, menuPrincipal(session.name, ticket), 'menu');
  }

  // Sin nombre → bienvenida
  if ((isMenu || isHello) && !session.name) {
    return iniciarBienvenida(phone, profileName);
  }

  // Consulta de caso global: si escribe CASO-XXXX o RTD-XXXX desde cualquier estado, se consulta directo
  if (/^(caso|rtd)-\d+$/.test(textLow)) {
    return handleQueryCasoInput(phone, text, session);
  }

  switch (session.state) {
    case 'welcome':         return handleWelcome(phone, text, session);
    case 'welcome_email':   return handleWelcomeEmail(phone, text, session);
    case 'welcome_confirm': return handleWelcomeConfirm(phone, textLow, session);
    case 'welcome_fix':     return handleWelcomeFix(phone, textLow, session);
    case 'menu':          return handleMenu(phone, textLow, session);
    case 'services':      return handleServices(phone, textLow, session);
    case 'service_detail':return handleServiceDetail(phone, textLow, session);
    case 'qa':            return handleQA(phone, text, session);
    case 'contact':       return handleContact(phone, text, session);
    case 'query_caso':    return handleQueryCasoInput(phone, text, session);
    case 'waiting': {
      const name   = session.name || 'cliente';
      const ticket = session.ticket_number || session.context?.ticket || '—';
      await typingDelay(300);
      return logAndReturn(phone,
        `Estimado/a *${name}*, su solicitud (ticket *${ticket}*) está siendo atendida.\n\n` +
        `Un especialista de *Recupero 24/7* se comunicará con usted a la brevedad.\n\n` +
        `Escriba *menú* para realizar otra consulta.\n_${SITE_URL}_`
      );
    }
    default:
      if (!session.name) return iniciarBienvenida(phone, profileName);
      const ticket = session.ticket_number || session.context?.ticket;
      return enviar(phone, menuPrincipal(session.name, ticket), 'menu');
  }
}

// ── Paso 1: Bienvenida — pedir nombre ──────────────────────
// El nombre de perfil de WhatsApp puede venir vacío o con basura ("." , emojis):
// solo se usa si tiene al menos 2 letras y un largo razonable.
function nombrePerfil(profileName) {
  const n = (profileName || '').trim();
  return (n.length <= 40 && /\p{L}{2,}/u.test(n)) ? n : null;
}

async function iniciarBienvenida(phone, profileName) {
  await typingDelay(300);
  const perfil = nombrePerfil(profileName);
  const saludo = perfil ? `¡Hola, *${perfil}*! 👋 ` : '¡Bienvenido/a! 🔗 ';
  const msg =
    `${saludo}Gracias por escribir a *Recupero 24/7*\n${SITE_URL}\n\n` +
    `Somos especialistas en recuperación de información digital en Lima, Perú.\n\n` +
    `Para registrar su consulta y brindarle una atención personalizada, ¿podría indicarnos su *nombre completo*?`;
  return enviar(phone, msg, 'welcome');
}

async function handleWelcome(phone, text, session) {
  // Ya tiene nombre y email → menú directo
  if (session.name && session.email) {
    const ticket = session.ticket_number || session.context?.ticket;
    return enviar(phone, menuPrincipal(session.name, ticket), 'menu');
  }

  // Ya tiene nombre pero no email → pedir email
  if (session.name && !session.email) {
    return enviar(phone,
      `Para completar su registro, ¿podría indicarnos su *correo electrónico*?`,
      'welcome_email'
    );
  }

  if (text.length < 2 || /^\d+$/.test(text)) {
    return logAndReturn(phone, 'Por favor, indíquenos su *nombre completo* para continuar.');
  }

  const name = text.trim().split(' ')
    .filter(w => w.length > 0)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  // Si venía de corregir solo el nombre, ya hay un correo pendiente → volver a la confirmación
  const pendingEmail = session.context?.pending_email;
  if (pendingEmail) {
    await updateSession(phone, { name, state: 'welcome_confirm' });
    await typingDelay(300);
    return logAndReturn(phone, mensajeConfirmacion(name, pendingEmail));
  }

  await updateSession(phone, { name, state: 'welcome_email' });
  await typingDelay(300);
  return logAndReturn(phone,
    `Muchas gracias, *${name}*.\n\n` +
    `Para completar su registro, ¿podría indicarnos su *correo electrónico*?\n` +
    `_(Ejemplo: nombre@correo.com)_`
  );
}

// ── Paso 2: Capturar correo electrónico → pedir confirmación ──
async function handleWelcomeEmail(phone, text, session) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const email = text.trim().toLowerCase();

  if (!emailRegex.test(email)) {
    return logAndReturn(phone,
      `Por favor, ingrese un correo electrónico válido.\n_(Ejemplo: nombre@correo.com)_`
    );
  }

  // El correo queda pendiente en el contexto (no en la sesión) hasta que el cliente confirme
  await updateSession(phone, { state: 'welcome_confirm', context: { ...(session.context || {}), pending_email: email } });
  await typingDelay(300);
  return logAndReturn(phone, mensajeConfirmacion(session.name, email));
}

function mensajeConfirmacion(name, email) {
  return (
    `📋 *Confirmación de datos*\n\n` +
    `Para confirmar, los datos de usted como nuevo cliente son:\n\n` +
    `👤 Nombre: *${name}*\n` +
    `📧 Correo: ${email}\n\n` +
    `¿Es correcto? Escriba *OK* para confirmar o *NO* para corregir.`
  );
}

// Normaliza la respuesta: minúsculas, sin tildes ni signos ("Sí.", "OK!" → "si", "ok")
const normalizar = t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
const CONFIRM_WORDS = ['ok', 'okey', 'okay', 'si', 'yes', 'correcto', 'confirmar', 'confirmo', 'confirmado', 'exacto', 'afirmativo'];
const REJECT_WORDS  = ['no', 'corregir', 'cambiar', 'editar', 'incorrecto', 'error', 'mal'];

// ── Paso 3: Confirmar nombre + correo ──────────────────────
async function handleWelcomeConfirm(phone, textLow, session) {
  const email = session.context?.pending_email;
  // Sin correo pendiente (contexto perdido) → volver a pedirlo
  if (!email) {
    return enviar(phone, `Para completar su registro, ¿podría indicarnos su *correo electrónico*?`, 'welcome_email');
  }

  const resp = normalizar(textLow);
  if (CONFIRM_WORDS.includes(resp)) return completarRegistro(phone, session, email);

  if (REJECT_WORDS.includes(resp)) {
    await typingDelay(200);
    return enviar(phone,
      `Sin problema. ¿Qué dato desea corregir?\n\n1️⃣  Nombre\n2️⃣  Correo electrónico\n\n_Responda con el número de la opción_`,
      'welcome_fix'
    );
  }

  await typingDelay(200);
  return logAndReturn(phone, mensajeConfirmacion(session.name, email));
}

// ── Paso 3b: Elegir qué dato corregir ──────────────────────
async function handleWelcomeFix(phone, textLow, session) {
  const resp = normalizar(textLow);
  if (resp === '1' || resp === 'nombre') {
    await updateSession(phone, { name: null, state: 'welcome' });
    return logAndReturn(phone, `Por favor, indíquenos su *nombre completo*.`);
  }
  if (resp === '2' || resp === 'correo' || resp === 'email') {
    return enviar(phone, `Por favor, indíquenos su *correo electrónico*.\n_(Ejemplo: nombre@correo.com)_`, 'welcome_email');
  }
  return logAndReturn(phone, `Responda *1* para corregir el nombre o *2* para corregir el correo.`);
}

// ── Paso 4: Registro confirmado → ticket + menú ────────────
async function completarRegistro(phone, session, email) {
  const name = session.name;
  const ticketNumber = await nextTicketNumber();

  // Guardar ticket con nombre + email
  await execute(
    `INSERT INTO tickets (ticket_number, phone, name, email, summary, status)
     VALUES ($1,$2,$3,$4,$5,'abierto') ON CONFLICT DO NOTHING`,
    [ticketNumber, phone, name, email, `Consulta de ${name} — WhatsApp`]
  );

  // Guardar sesión completa (el correo pendiente pasa a ser definitivo)
  await updateSession(phone, {
    name,
    state:         'menu',
    context:       { ticket: ticketNumber, email },
    ticket_number: ticketNumber,
    email,
  });

  trackEvent('NuevoCliente', { phone, name, ticketNumber });
  await typingDelay(500);

  const msg =
    `✅ *Registro completado exitosamente*\n\n` +
    `👤 Nombre: *${name}*\n` +
    `📧 Correo: ${email}\n` +
    `🎫 *Número de ticket: ${ticketNumber}*\n` +
    `_Conserve este número para futuras referencias._\n\n` +
    menuPrincipal(name, ticketNumber);

  await logMessage(phone, 'out', msg);
  return msg;
}

// ── Menú ────────────────────────────────────────────────────
async function handleMenu(phone, text, session) {
  const name   = session.name || 'cliente';
  const ticket = session.ticket_number || session.context?.ticket;

  switch (text) {
    case '1':
      await typingDelay(300);
      return enviar(phone, await buildMenuServicios(), 'services');

    case '2': {
      const svcs = await query('SELECT * FROM services ORDER BY category, price_soles');
      const cats = [...new Set(svcs.map(s => s.category || 'otros'))];
      let msg = `📦 *Disponibilidad de servicios:*\n\n`;
      for (const cat of cats) {
        msg += `*${cat.toUpperCase()}*\n`;
        svcs.filter(s => (s.category || 'otros') === cat).forEach(s => {
          msg += `${s.available ? '🟢' : '🔴'} ${s.name}\n`;
        });
        msg += '\n';
      }
      msg += `_Escriba *menú* para volver._\n_${SITE_URL}_`;
      await typingDelay(200);
      return enviar(phone, msg, 'menu');
    }

    case '3':
      await typingDelay();
      return enviar(phone,
        `🤖 *Consulta técnica*\n\nPor favor, describa su consulta con el mayor detalle posible.\n\n_Escriba *menú* para volver_`,
        'qa'
      );

    case '4':
      await typingDelay();
      return enviar(phone,
        `📝 *Solicitud de cotización*\n\n¿Qué tipo de dispositivo requiere recuperación?\n\n• Disco duro HDD\n• Unidad SSD / NVMe\n• USB / MicroSD\n• Servidor / RAID\n• Celular / Tablet\n• Otro\n\n_Por favor, descríbalo:_`,
        'contact', { step: 'device', ticket }
      );

    case '5':
      await typingDelay();
      trackEvent('SolicitudEspecialista', { phone });
      return enviar(phone,
        `👨‍💻 *Atención por especialista*\n\nEstimado/a *${name}*, un especialista de *Recupero 24/7* se comunicará con usted a la brevedad.\n\n🎫 Ticket: *${ticket || '—'}*\n⏰ Horario: Lun–Vie 9am–7pm | Sáb 9am–2pm\n\nMás información en:\n${SITE_URL}`,
        'waiting'
      );

    case '6':
      await typingDelay();
      return enviar(phone,
        `🔍 *Consulta de estado de caso*\n\nPor favor, ingrese su *número de caso* (formato CASO-XXXX) o su *número de ticket* (RTD-XXXX):`,
        'query_caso'
      );

    default:
      await typingDelay();
      return logAndReturn(phone,
        `Estimado/a *${name}*, seleccione una opción del 1 al 6 o escriba *menú*.`
      );
  }
}

// ── Consulta de caso ────────────────────────────────────────
// Emojis por clave de estado; la etiqueta visible sale de las tablas
// administrables estados_caso / estados_pago (con fallback a la clave).
const ESTADO_EMOJI = {
  no_iniciado:'⏳', en_revision:'🔍', espera_repuestos:'🔧', espera_usuario:'💬',
  listo_recoger:'✅', por_cancelar:'⚠️', cancelado:'❌',
};
const PAGO_EMOJI = { pendiente:'⏳', pagado:'✅', por_cancelar:'⚠️', cancelado:'❌' };

async function labelDesdeTabla(tabla, clave, emojis) {
  if (!clave) return null;
  let label = clave;
  try {
    const row = await queryOne(`SELECT label FROM ${tabla} WHERE nombre = $1`, [clave]);
    if (row?.label) label = row.label;
  } catch (_) {}
  return `${emojis[clave] || '📌'} ${label}`;
}

async function handleQueryCasoInput(phone, text, session) {
  const name      = session.name || 'cliente';
  const casoNum   = text.toUpperCase().replace(/\s+/g, '');
  // Si aún no completó el registro, al terminar vuelve a la bienvenida en lugar del menú
  const nextState = (session.name && session.email) ? 'menu' : 'welcome';

  // Acepta número de caso (CASO-XXXX) o de ticket (RTD-XXXX); toma el caso más reciente
  const caso = await queryOne(
    `SELECT * FROM casos
     WHERE UPPER(caso_number) = $1 OR UPPER(ticket_number) = $1 OR caso_number ILIKE $2
     ORDER BY created_at DESC LIMIT 1`,
    [casoNum, `%${casoNum}%`]
  );

  await typingDelay(300);

  if (!caso) {
    return enviar(phone,
      `Estimado/a *${name}*, no se encontró ningún caso asociado a *${casoNum}*.\n\n` +
      `Verifique el número e inténtelo nuevamente.\nEscriba *menú* para volver.`,
      nextState
    );
  }

  const estado = await labelDesdeTabla('estados_caso', caso.status, ESTADO_EMOJI);
  const pago   = await labelDesdeTabla('estados_pago', caso.pago,   PAGO_EMOJI);
  const msg =
    `📋 *Estado de su caso*\n\n` +
    `🔢 N° caso: *${caso.caso_number}*\n` +
    (caso.ticket_number ? `🎫 Ticket: ${caso.ticket_number}\n` : '') +
    `👤 Solicitante: *${caso.name || '—'}*\n` +
    `📱 Dispositivo: ${caso.device || '—'}\n` +
    (caso.resumen ? `🩺 Diagnóstico: ${caso.resumen}\n` : '') +
    `🔧 Técnico: ${caso.technician || 'Sin asignar'}\n` +
    `📊 Estado: *${estado || '—'}*\n` +
    (pago ? `💳 Pago: ${pago}\n` : '') +
    (caso.description ? `📝 Detalle: ${caso.description}\n` : '') +
    `\n_Para más información: ${SITE_URL}_\n_Escriba *menú* para volver._`;

  return enviar(phone, msg, nextState);
}

// ── Servicios ────────────────────────────────────────────────
async function handleServices(phone, text, session) {
  const svcs = await query('SELECT * FROM services WHERE available=true ORDER BY price_soles');
  const idx  = parseInt(text) - 1;
  if (!isNaN(idx) && svcs[idx]) {
    const s = svcs[idx];
    const p = s.price_soles == 0 ? '🎁 Sin costo' : `S/ ${s.price_soles}`;
    const msg =
      `*${s.name}*\n\n📄 ${s.description}\n💰 Precio desde: ${p}\n⏱ Tiempo: ${s.turnaround}\n\n` +
      `1️⃣ Solicitar cotización\n2️⃣ Ver otros servicios\n3️⃣ Volver al menú`;
    await typingDelay(200);
    return enviar(phone, msg, 'service_detail', { service_code: s.code, ticket: session.ticket_number || session.context?.ticket });
  }
  return logAndReturn(phone, `Seleccione una opción del 1 al ${svcs.length} o escriba *menú*.`);
}

async function handleServiceDetail(phone, text, session) {
  const ticket = session.context?.ticket || session.ticket_number;
  if (text === '1') return enviar(phone, `Describa el síntoma o problema de su dispositivo.`, 'contact', { step: 'device', preselect: session.context?.service_code, ticket });
  if (text === '2') return enviar(phone, await buildMenuServicios(), 'services');
  if (text === '3') return enviar(phone, menuPrincipal(session.name||'cliente', ticket), 'menu');
  return logAndReturn(phone, `Seleccione 1, 2 o 3.`);
}

// ── Q&A con IA ───────────────────────────────────────────────
async function handleQA(phone, text, session) {
  await typingDelay(500);
  let history = await getHistory(phone, 9);
  const last  = history[history.length - 1];
  if (last && last.direction === 'in' && last.body === text) history = history.slice(0, -1);
  const answer = await askAI(text, history);
  trackEvent('QARespondido', { phone });
  await logMessage(phone, 'out', answer);
  return answer;
}

// ── Cotización ───────────────────────────────────────────────
async function handleContact(phone, text, session) {
  const ctx    = session.context || {};
  const name   = session.name   || 'cliente';
  const ticket = ctx.ticket || session.ticket_number || '—';
  const email  = session.email || session.context?.email || '';

  if (ctx.step === 'device') {
    await updateSession(phone, { context: { ...ctx, device: text, step: 'symptom' }, state: 'contact' });
    await typingDelay();
    return logAndReturn(phone, `Entendido. Describa el síntoma o problema que presenta el dispositivo.`);
  }

  if (ctx.step === 'symptom') {
    await updateSession(phone, { context: { ...ctx, symptom: text, step: 'urgency' }, state: 'contact' });
    await typingDelay();
    return logAndReturn(phone, `¿Cuál es el nivel de urgencia?\n1️⃣ Urgente (mismo día)\n2️⃣ Normal (2–3 días hábiles)\n3️⃣ Sin urgencia`);
  }

  if (ctx.step === 'urgency') {
    const urg = { '1': '🔴 Urgente', '2': '🟡 Normal', '3': '🟢 Sin urgencia' }[text] || text;

    if (ticket !== '—') {
      await execute(
        `UPDATE tickets SET summary=$1, email=$2, updated_at=NOW() WHERE ticket_number=$3`,
        [`Dispositivo: ${ctx.device} | Problema: ${ctx.symptom} | Urgencia: ${urg}`, email, ticket]
      );
    }

    await updateSession(phone, {
      state:   'waiting',
      context: { ...ctx, urgency: urg, step: 'done' },
    });

    trackEvent('NuevaCotizacion', { phone, device: ctx.device, urgency: urg });
    await typingDelay(400);

    return logAndReturn(phone,
      `✅ *Solicitud registrada exitosamente*\n\n` +
      `👤 Solicitante: *${name}*\n` +
      `📧 Correo: ${email || '—'}\n` +
      `🎫 Ticket: *${ticket}*\n` +
      `📱 Dispositivo: ${ctx.device}\n` +
      `🔧 Problema: ${ctx.symptom}\n` +
      `⚡ Urgencia: ${urg}\n\n` +
      `Un especialista de *Recupero 24/7* se comunicará con usted a la brevedad.\n\n` +
      `⏰ Horario: Lun–Vie 9am–7pm | Sáb 9am–2pm\n🌐 ${SITE_URL}`
    );
  }

  // Paso desconocido (contexto perdido) → volver al menú en lugar de no responder
  await typingDelay(200);
  return enviar(phone, menuPrincipal(name, ticket !== '—' ? ticket : null), 'menu');
}

// ── Helpers ──────────────────────────────────────────────────
async function enviar(phone, text, newState, newContext) {
  const updates = {};
  if (newState   !== undefined) updates.state   = newState;
  if (newContext !== undefined) updates.context = newContext;
  if (Object.keys(updates).length) await updateSession(phone, updates);
  await logMessage(phone, 'out', text);
  return text;
}

async function logAndReturn(phone, text) {
  await logMessage(phone, 'out', text);
  return text;
}

module.exports = { handleMessage };
