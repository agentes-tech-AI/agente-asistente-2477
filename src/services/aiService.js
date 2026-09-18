// src/services/aiService.js — Azure AI Foundry (GPT-4o-mini)
const { AzureOpenAI } = require('openai');
const { query } = require('../data/database');
const { trackException } = require('../config/azure');

let client = null;

function getClient() {
  if (!client) {
    client = new AzureOpenAI({
      endpoint:   process.env.AZURE_FOUNDRY_ENDPOINT,
      apiKey:     process.env.AZURE_FOUNDRY_API_KEY,
      apiVersion: process.env.AZURE_FOUNDRY_API_VERSION || '2024-12-01-preview',
    });
  }
  return client;
}

const SYSTEM_PROMPT = `Eres el Asistente Virtual de Recupero 24/7 (recuperotusdatos.com), empresa peruana especializada en recuperación de información digital, con sede en Lima.

INSTRUCCIONES DE COMUNICACIÓN:
- Utiliza siempre un lenguaje formal y profesional
- Dirige al cliente de "usted"
- Sé conciso: máximo 3 párrafos por respuesta
- Usa máximo 2 emojis por mensaje
- No inventes precios ni plazos — usa solo el catálogo oficial
- Si no puedes responder, ofrece conectar al cliente con un especialista
- Menciona recuperotusdatos.com cuando sea relevante

INFORMACIÓN DE LA EMPRESA:
- Nombre: Recupero 24/7
- Web: recuperotusdatos.com
- Sede: Lima, Perú
- Servicios: recuperación de datos de discos duros, SSD, USB, RAID y celulares
- Política: diagnóstico gratuito, cobro únicamente si se recuperan los datos
- Horario de atención: Lunes a Viernes 9am–7pm | Sábados 9am–2pm`;

// Lista de precios de respaldo si la BD no responde
const PRECIOS_FALLBACK = `PRECIOS BASE:
- USB / MicroSD: desde S/ 80 (12-24h)
- HDD lógico:  desde S/ 150 (24-48h)
- SSD / NVMe:  desde S/ 250 (2-4 días)
- HDD físico:  desde S/ 380 (3-5 días)
- RAID/Servidor: desde S/ 650 (5-10 días)
- Diagnóstico: Sin costo (mismo día)`;

// El catálogo se administra desde el panel: la IA debe citar siempre los precios vigentes
async function buildPrecios() {
  try {
    const svcs = await query('SELECT name, price_soles, turnaround FROM services WHERE available=true ORDER BY price_soles');
    if (!svcs.length) return PRECIOS_FALLBACK;
    const lines = svcs.map(s => {
      const precio = Number(s.price_soles) === 0 ? 'Sin costo' : `desde S/ ${Number(s.price_soles)}`;
      return `- ${s.name}: ${precio}${s.turnaround ? ` (${s.turnaround})` : ''}`;
    });
    return `PRECIOS BASE (catálogo vigente):\n${lines.join('\n')}`;
  } catch (_) {
    return PRECIOS_FALLBACK;
  }
}

async function askAI(userMessage, history = []) {
  try {
    const [faqCtx, precios] = await Promise.all([findFAQ(userMessage), buildPrecios()]);
    let system = `${SYSTEM_PROMPT}\n\n${precios}`;
    if (faqCtx) system += `\n\nINFORMACIÓN RELEVANTE PARA ESTA CONSULTA:\n${faqCtx}`;

    const messages = [
      { role: 'system', content: system },
      ...history.map(h => ({ role: h.direction === 'in' ? 'user' : 'assistant', content: h.body || '' })),
      { role: 'user', content: userMessage },
    ];

    const res = await getClient().chat.completions.create({
      model:       process.env.AZURE_FOUNDRY_DEPLOYMENT || 'gpt-4o-mini',
      messages,
      max_tokens:  400,
      temperature: 0.6,
    });

    return res.choices[0].message.content.trim();
  } catch (err) {
    trackException(err, { service: 'azure-foundry' });
    console.error('[AI] Error Foundry:', err.message);
    return 'Disculpe, hemos tenido un inconveniente técnico. Por favor, escriba *menú* para continuar o visítenos en recuperotusdatos.com 🙏';
  }
}

async function findFAQ(message) {
  try {
    const faqs = await query('SELECT * FROM faq');
    const low  = message.toLowerCase();
    const hits = faqs.filter(f => (f.keywords || '').split(',').some(k => low.includes(k.trim())));
    if (!hits.length) return null;
    return hits.slice(0, 2).map(f => `P: ${f.question}\nR: ${f.answer}`).join('\n\n');
  } catch (_) { return null; }
}

module.exports = { askAI };
