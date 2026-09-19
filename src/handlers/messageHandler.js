// src/handlers/messageHandler.js — Asistente Recupero 24/7 v6
const { query, execute, queryOne, nextTicketNumber } = require('../data/database');
const { getSession, updateSession, logMessage, getHistory } = require('../services/sessionManager');
const { askAI }          = require('../services/aiService');
const { checkLimit, typingDelay } = require('../services/rateLimiter');
const { trackEvent }     = require('../config/azure');
const { labelEstadoCaso, labelEstadoPago } = require('../services/estados');

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
  const { profileName, externalUserId } = meta;
  const limit = await checkLimit(phone);
  if (!limit.allowed) { console.log(`[RATE-LIMIT] ${phone}`); return null; }

  const text    = (incomingText || '').trim();
  const textLow = text.toLowerCase().trim();
  const session = await getSession(phone);

  await logMessage(phone, 'in', text);

  // Con "nombres de usuario" de WhatsApp el remitente llega como BSUID (whatsapp:PE.123…)
  // y no como teléfono; en ese caso el celular de contacto se pide en el registro.
  session.sender_phone = telefonoDeWhatsApp(phone);
  const silent = {};
  if (externalUserId && session.external_user_id !== externalUserId) silent.external_user_id = externalUserId;
  if (!session.contact_phone && session.sender_phone) {
    silent.contact_phone = session.contact_phone = session.sender_phone;
    await execute('UPDATE tickets SET contact_phone=$1 WHERE phone=$2 AND contact_phone IS NULL', [session.sender_phone, phone]).catch(() => {});
  }
  if (Object.keys(silent).length) await updateSession(phone, silent);

  const isMenu  = MENU_WORDS.includes(textLow);
  const isHello = HELLO_WORDS.some(g => textLow === g || textLow.startsWith(g + ' '));

  // Saludo con sesión activa → menú (si el número está oculto y aún no tenemos celular, pedirlo una vez)
  if ((isMenu || isHello) && session.name && session.email) {
    if (!session.contact_phone && !session.context?.skip_phone && session.state !== 'ask_phone') return pedirCelularRegistrado(phone, session);
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
    case 'welcome_phone':   return handleWelcomePhone(phone, text, session);
    case 'welcome_confirm': return handleWelcomeConfirm(phone, textLow, session);
    case 'welcome_fix':     return handleWelcomeFix(phone, textLow, session);
    case 'ask_phone':       return handleAskPhone(phone, text, session);
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

// ── Teléfono ───────────────────────────────────────────────
// "whatsapp:+51987654321" → "+51987654321"; un BSUID ("whatsapp:PE.123…") → null
function telefonoDeWhatsApp(from) {
  const m = /^whatsapp:(\+\d{8,15})$/.exec(from || '');
  return m ? m[1] : null;
}

// Normaliza un celular escrito por el cliente a E.164. Acepta "987 654 321",
// "+51 987-654-321", "51987654321", "0051…". Devuelve null si no es válido.
function normalizarCelular(text) {
  let t = (text || '').replace(/[\s\-().]/g, '');
  if (/^00\d+$/.test(t)) t = '+' + t.slice(2);
  if (/^9\d{8}$/.test(t)) t = '+51' + t;              // celular peruano sin código de país
  else if (/^\d{8,15}$/.test(t)) t = '+' + t;          // ya incluye código de país
  return /^\+\d{8,15}$/.test(t) ? t : null;
}

const PEDIR_CELULAR =
  `Su número de WhatsApp está oculto por su configuración de privacidad. ` +
  `Para poder comunicarnos con usted, ¿podría indicarnos su *número de celular* de contacto?\n` +
  `_(Ejemplo: 987 654 321)_`;

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
    return logAndReturn(phone, mensajeConfirmacion(name, pendingEmail, celularPendiente(session)));
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
  const context = { ...(session.context || {}), pending_email: email };

  // Número de WhatsApp oculto y sin celular aún → pedirlo antes de confirmar
  if (!celularPendiente(session)) {
    await updateSession(phone, { state: 'welcome_phone', context });
    await typingDelay(300);
    return logAndReturn(phone, PEDIR_CELULAR);
  }

  await updateSession(phone, { state: 'welcome_confirm', context });
  await typingDelay(300);
  return logAndReturn(phone, mensajeConfirmacion(session.name, email, celularPendiente(session)));
}

// Celular que se mostrará/guardará: el escrito por el cliente, el ya guardado o el del remitente
function celularPendiente(session) {
  return session.context?.pending_phone || session.contact_phone || session.sender_phone || null;
}

// ── Paso 2b: Capturar celular de contacto (solo si WhatsApp oculta el número) ──
async function handleWelcomePhone(phone, text, session) {
  const cel = normalizarCelular(text);
  if (!cel) {
    return logAndReturn(phone, `Por favor, ingrese un número de celular válido.\n_(Ejemplo: 987 654 321)_`);
  }
  const context = { ...(session.context || {}), pending_phone: cel };
  await updateSession(phone, { state: 'welcome_confirm', context });
  await typingDelay(300);
  return logAndReturn(phone, mensajeConfirmacion(session.name, context.pending_email, cel));
}

function mensajeConfirmacion(name, email, celular) {
  return (
    `📋 *Confirmación de datos*\n\n` +
    `Para confirmar, los datos de usted como nuevo cliente son:\n\n` +
    `👤 Nombre: *${name}*\n` +
    `📧 Correo: ${email}\n` +
    (celular ? `📱 Celular: ${celular}\n` : '') +
    `\n¿Es correcto? Escriba *OK* para confirmar o *NO* para corregir.`
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
  if (CONFIRM_WORDS.includes(resp)) return completarRegistro(phone, session, email, celularPendiente(session));

  if (REJECT_WORDS.includes(resp)) {
    await typingDelay(200);
    const opcCelular = session.context?.pending_phone ? `3️⃣  Celular\n` : '';
    return enviar(phone,
      `Sin problema. ¿Qué dato desea corregir?\n\n1️⃣  Nombre\n2️⃣  Correo electrónico\n${opcCelular}\n_Responda con el número de la opción_`,
      'welcome_fix'
    );
  }

  await typingDelay(200);
  return logAndReturn(phone, mensajeConfirmacion(session.name, email, celularPendiente(session)));
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
  if (session.context?.pending_phone && (resp === '3' || resp === 'celular' || resp === 'telefono')) {
    return enviar(phone, `Por favor, indíquenos su *número de celular*.\n_(Ejemplo: 987 654 321)_`, 'welcome_phone');
  }
  const opc3 = session.context?.pending_phone ? ' o *3* para corregir el celular' : '';
  return logAndReturn(phone, `Responda *1* para corregir el nombre, *2* para corregir el correo${opc3}.`);
}

// ── Paso 4: Registro confirmado → ticket + menú ────────────
async function completarRegistro(phone, session, email, contactPhone) {
  const name = session.name;
  const ticketNumber = await nextTicketNumber();

  // Guardar ticket con nombre + email + celular de contacto
  await execute(
    `INSERT INTO tickets (ticket_number, phone, name, email, contact_phone, summary, status)
     VALUES ($1,$2,$3,$4,$5,$6,'abierto') ON CONFLICT DO NOTHING`,
    [ticketNumber, phone, name, email, contactPhone || null, `Consulta de ${name} — WhatsApp`]
  );

  // Guardar sesión completa (el correo pendiente pasa a ser definitivo)
  await updateSession(phone, {
    name,
    state:         'menu',
    context:       { ticket: ticketNumber, email },
    ticket_number: ticketNumber,
    email,
    contact_phone: contactPhone || null,
  });

  trackEvent('NuevoCliente', { phone, name, ticketNumber });
  await typingDelay(500);

  const msg =
    `✅ *Registro completado exitosamente*\n\n` +
    `👤 Nombre: *${name}*\n` +
    `📧 Correo: ${email}\n` +
    (contactPhone ? `📱 Celular: ${contactPhone}\n` : '') +
    `🎫 *Número de ticket: ${ticketNumber}*\n` +
    `_Conserve este número para futuras referencias._\n\n` +
    menuPrincipal(name, ticketNumber);

  await logMessage(phone, 'out', msg);
  return msg;
}

// ── Cliente ya registrado con número oculto: pedir celular una vez ──
async function pedirCelularRegistrado(phone, session) {
  await typingDelay(200);
  return enviar(phone,
    `Estimado/a *${session.name}*, ${PEDIR_CELULAR}\n\n_Escriba *omitir* para continuar sin indicarlo._`,
    'ask_phone'
  );
}

async function handleAskPhone(phone, text, session) {
  const ticket = session.ticket_number || session.context?.ticket;
  if (normalizar(text.toLowerCase()) === 'omitir') {
    // Se recuerda la decisión para no volver a preguntar en cada saludo
    return enviar(phone, menuPrincipal(session.name, ticket), 'menu', { ...(session.context || {}), skip_phone: true });
  }
  const cel = normalizarCelular(text);
  if (!cel) {
    return logAndReturn(phone, `Por favor, ingrese un número de celular válido _(ejemplo: 987 654 321)_ o escriba *omitir*.`);
  }
  await updateSession(phone, { contact_phone: cel, state: 'menu' });
  await execute('UPDATE tickets SET contact_phone=$1 WHERE phone=$2 AND contact_phone IS NULL', [cel, phone]).catch(() => {});
  await typingDelay(200);
  return logAndReturn(phone, `✅ Celular registrado: *${cel}*\n\n` + menuPrincipal(session.name, ticket));
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

  const estado = await labelEstadoCaso(caso.status);
  const pago   = await labelEstadoPago(caso.pago);
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
