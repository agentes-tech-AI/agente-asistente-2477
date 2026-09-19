// src/services/estados.js — Estados de caso/pago (tablas administrables) y regla de avance
const { query, queryOne } = require('../data/database');

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

const labelEstadoCaso = clave => labelDesdeTabla('estados_caso', clave, ESTADO_EMOJI);
const labelEstadoPago = clave => labelDesdeTabla('estados_pago', clave, PAGO_EMOJI);

// Primer estado activo según su orden (el estado con el que nace un caso)
async function estadoInicial() {
  const row = await queryOne('SELECT nombre FROM estados_caso WHERE activo = true ORDER BY orden ASC, id ASC LIMIT 1');
  return row?.nombre || 'no_iniciado';
}

// ── Regla de negocio ────────────────────────────────────────
// Un caso solo puede AVANZAR de estado (pasar a uno de mayor orden) si su pago
// está registrado como "pagado". Retroceder o mantener el estado no lo exige.
// Devuelve null si la transición es válida, o el mensaje de error si no lo es.
async function validarAvanceEstado(estadoActual, estadoNuevo, pago) {
  if (!estadoNuevo || estadoNuevo === estadoActual) return null;

  const rows  = await query('SELECT nombre, orden, activo FROM estados_caso');
  const orden = Object.fromEntries(rows.map(r => [r.nombre, Number(r.orden) || 0]));
  if (!(estadoNuevo in orden)) return `El estado "${estadoNuevo}" no existe.`;

  const minOrden    = rows.length ? Math.min(...rows.map(r => Number(r.orden) || 0)) : 0;
  const ordenActual = estadoActual in orden ? orden[estadoActual] : minOrden;
  const esAvance    = orden[estadoNuevo] > ordenActual;

  if (esAvance && pago !== 'pagado') {
    return 'Para avanzar el estado del caso el pago debe estar registrado como "Pagado". Registre el pago y vuelva a intentarlo.';
  }
  return null;
}

module.exports = { ESTADO_EMOJI, PAGO_EMOJI, labelDesdeTabla, labelEstadoCaso, labelEstadoPago, estadoInicial, validarAvanceEstado };
