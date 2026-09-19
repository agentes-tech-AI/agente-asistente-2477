// src/data/database.js — Azure Database for PostgreSQL
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      host:     process.env.PGHOST,
      port:     parseInt(process.env.PGPORT || '5432'),
      database: process.env.PGDATABASE,
      user:     process.env.PGUSER,
      password: process.env.PGPASSWORD,
      // Azure exige TLS (PGSSLMODE=require); PGSSLMODE=disable solo para un Postgres local
      ssl:      process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => console.error('[DB] Error pool:', err.message));
  }
  return pool;
}

async function query(sql, params = []) {
  const result = await getPool().query(sql, params);
  return result.rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function execute(sql, params = []) {
  const result = await getPool().query(sql, params);
  return result.rowCount;
}

// ── Generador de números de ticket/caso ─────────────────
// Usa MAX(numero)+1 en lugar de COUNT(*)+1: si se elimina un registro
// intermedio, COUNT repetiría un número ya usado (violación UNIQUE).
async function nextNumber(table, column, prefix) {
  const row = await queryOne(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(${column}, '\\D', '', 'g'), '')::int), 0) AS n FROM ${table}`
  );
  const n = (row?.n || 0) + 1;
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

const nextTicketNumber = () => nextNumber('tickets', 'ticket_number', 'RTD');
const nextCasoNumber   = () => nextNumber('casos',   'caso_number',   'CASO');

// ── Esquema completo ─────────────────────────────────────
async function initSchema() {
  console.log('[DB] Verificando esquema...');

  await execute(`
    CREATE TABLE IF NOT EXISTS services (
      id          SERIAL PRIMARY KEY,
      code        TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      price_soles NUMERIC(10,2) NOT NULL DEFAULT 0,
      available   BOOLEAN DEFAULT true,
      turnaround  TEXT,
      category    TEXT
    )`);

  await execute(`
    CREATE TABLE IF NOT EXISTS faq (
      id       SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      answer   TEXT NOT NULL,
      keywords TEXT
    )`);

  await execute(`
    CREATE TABLE IF NOT EXISTS conversations (
      id            SERIAL PRIMARY KEY,
      phone         TEXT UNIQUE NOT NULL,
      name          TEXT,
      state         TEXT DEFAULT 'welcome',
      context       JSONB DEFAULT '{}',
      ticket_number TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )`);

  await execute(`CREATE INDEX IF NOT EXISTS idx_conv_phone ON conversations(phone)`);

  await execute(`
    CREATE TABLE IF NOT EXISTS tickets (
      id            SERIAL PRIMARY KEY,
      ticket_number TEXT UNIQUE NOT NULL,
      phone         TEXT NOT NULL,
      name          TEXT,
      summary       TEXT,
      status        TEXT DEFAULT 'abierto',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )`);

  await execute(`CREATE INDEX IF NOT EXISTS idx_ticket_number ON tickets(ticket_number)`);
  await execute(`CREATE INDEX IF NOT EXISTS idx_ticket_phone  ON tickets(phone)`);

  await execute(`
    CREATE TABLE IF NOT EXISTS casos (
      id            SERIAL PRIMARY KEY,
      caso_number   TEXT UNIQUE NOT NULL,
      ticket_number TEXT,
      phone         TEXT NOT NULL,
      name          TEXT,
      technician    TEXT DEFAULT 'Sin asignar',
      status        TEXT DEFAULT 'no_iniciado',
      description   TEXT,
      device        TEXT,
      symptom       TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )`);

  await execute(`CREATE INDEX IF NOT EXISTS idx_caso_number ON casos(caso_number)`);
  await execute(`CREATE INDEX IF NOT EXISTS idx_caso_ticket ON casos(ticket_number)`);

  await execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      phone      TEXT NOT NULL,
      direction  TEXT NOT NULL,
      body       TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

  await execute(`CREATE INDEX IF NOT EXISTS idx_msg_phone ON messages(phone, created_at DESC)`);

  // Columnas nuevas en tablas existentes (migracion segura)
  await execute(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ticket_number TEXT`).catch(()=>{});



  // ── Estados de Pago (administrables) ────────────────────
  await execute(`
    CREATE TABLE IF NOT EXISTS estados_pago (
      id     SERIAL PRIMARY KEY,
      nombre TEXT UNIQUE NOT NULL,
      label  TEXT NOT NULL,
      color  TEXT DEFAULT 'bn',
      activo BOOLEAN DEFAULT true,
      orden  INT DEFAULT 0
    )`);

  // Seed estados pago iniciales
  const pagosSeed = [
    {n:'pendiente',   l:'Pendiente de pago',    c:'by', o:1},
    {n:'pagado',      l:'Pagado',               c:'bg', o:2},
    {n:'por_cancelar',l:'Por cancelar',         c:'by', o:3},
    {n:'cancelado',   l:'Cancelado (sin cobro)',c:'br', o:4},
  ];
  for (const p of pagosSeed) {
    await execute("INSERT INTO estados_pago (nombre,label,color,orden) VALUES ($1,$2,$3,$4) ON CONFLICT (nombre) DO UPDATE SET label=$2,color=$3,orden=$4", [p.n,p.l,p.c,p.o]).catch(()=>{});
  }
  // ── Técnicos ─────────────────────────────────────────────
  await execute(`
    CREATE TABLE IF NOT EXISTS tecnicos (
      id     SERIAL PRIMARY KEY,
      nombre TEXT UNIQUE NOT NULL,
      email  TEXT,
      activo BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

  await execute(`
    CREATE TABLE IF NOT EXISTS sintomas (
      id     SERIAL PRIMARY KEY,
      nombre TEXT UNIQUE NOT NULL,
      activo BOOLEAN DEFAULT true
    )`);

  // Columnas nuevas en casos (migración segura)
  await execute("ALTER TABLE casos ADD COLUMN IF NOT EXISTS pago TEXT DEFAULT NULL").catch(()=>{});
  await execute("ALTER TABLE casos ADD COLUMN IF NOT EXISTS resumen TEXT DEFAULT NULL").catch(()=>{});


  // ── Estados de caso (administrables) ───────────────────
  await execute(`
    CREATE TABLE IF NOT EXISTS estados_caso (
      id     SERIAL PRIMARY KEY,
      nombre TEXT UNIQUE NOT NULL,
      label  TEXT NOT NULL,
      activo BOOLEAN DEFAULT true,
      orden  INT DEFAULT 0
    )`);

  // Seed estados iniciales (sin por_cancelar ni cancelado — esos van en pago)
  const estadosSeed = [
    {n:'no_iniciado',    l:'No iniciado',             o:1},
    {n:'en_revision',    l:'En revision',             o:2},
    {n:'espera_repuestos',l:'En espera de repuestos', o:3},
    {n:'espera_usuario', l:'En espera de respuesta',  o:4},
    {n:'listo_recoger',  l:'Listo para recoger',      o:5},
  ];
  for (const e of estadosSeed) {
    await execute("INSERT INTO estados_caso (nombre,label,orden) VALUES ($1,$2,$3) ON CONFLICT (nombre) DO UPDATE SET label=$2,orden=$3", [e.n,e.l,e.o]).catch(()=>{});
  }

  // Columnas para evidencia de pago en casos
  await execute("ALTER TABLE casos ADD COLUMN IF NOT EXISTS evidencia_pago TEXT DEFAULT NULL").catch(()=>{});
  await execute("ALTER TABLE casos ADD COLUMN IF NOT EXISTS evidencia_nombre TEXT DEFAULT NULL").catch(()=>{});
  await execute("ALTER TABLE casos ADD COLUMN IF NOT EXISTS evidencia_tipo TEXT DEFAULT NULL").catch(()=>{});
  // Seed técnicos iniciales
  await execute("INSERT INTO tecnicos (nombre) VALUES ('Sin asignar') ON CONFLICT DO NOTHING").catch(()=>{});

  // Seed síntomas iniciales
  const sintomas0 = ['No enciende','Hace ruidos','No reconocido','Borrado accidental','Formato accidental','Daño físico','Falla de cabezas','Motor quemado','Chip dañado','Corrupción de datos'];
  for (const s of sintomas0) {
    await execute("INSERT INTO sintomas (nombre) VALUES ($1) ON CONFLICT DO NOTHING", [s]).catch(()=>{});
  }

  // Migraciones seguras — email
  await execute("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS email TEXT DEFAULT NULL").catch(()=>{});
  await execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS email TEXT DEFAULT NULL").catch(()=>{});
  await execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS acuerdo TEXT DEFAULT NULL").catch(()=>{});
  // Migraciones seguras — celular de contacto (WhatsApp puede ocultar el número: usernames / BSUID)
  await execute("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS contact_phone TEXT DEFAULT NULL").catch(()=>{});
  await execute("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS external_user_id TEXT DEFAULT NULL").catch(()=>{});
  await execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS contact_phone TEXT DEFAULT NULL").catch(()=>{});
  console.log('[DB] Esquema OK ✓');
  await seedData();
}

// Cada tabla se siembra por separado: si una falla a mitad, la otra se
// reintenta en el siguiente arranque en lugar de quedar vacía para siempre.
async function seedData() {
  await seedServices();
  await seedFaqs();
}

async function seedServices() {
  const row = await queryOne('SELECT COUNT(*)::int AS n FROM services');
  if (row.n > 0) return;
  console.log('[DB] Insertando catálogo inicial de servicios...');

  const services = [
    ['DIAG-GRATIS', 'Diagnóstico gratuito',       'Evaluación sin costo ni compromiso',                        0,   'Mismo día',        'diagnostico'],
    ['USB-FLASH',   'Recuperación USB / MicroSD',  'Pendrives, memorias SD y tarjetas de cámara',               80,  '12–24 horas',      'flash'],
    ['HDD-LOGIC',   'Recuperación HDD lógica',     'Falla lógica, borrado accidental o formateo',              150,  '24–48 horas',      'disco'],
    ['SSD-NAND',    'Recuperación SSD / NVMe',     'Unidades SSD, M.2 NVMe y chips NAND Flash',               250,  '2–4 días hábiles', 'disco'],
    ['HDD-FISICA',  'Recuperación HDD física',     'Daño físico, cabezas caídas o motor quemado',             380,  '3–5 días hábiles', 'disco'],
    ['RAID-SERVER', 'Recuperación RAID / Servidor','Arrays RAID 0/1/5/6/10, NAS y servidores empresariales',  650,  '5–10 días hábiles','servidor'],
  ];

  for (const s of services) {
    await execute(
      `INSERT INTO services (code,name,description,price_soles,turnaround,category)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`, s
    );
  }
  console.log('[DB] Servicios insertados ✓');
}

async function seedFaqs() {
  const row = await queryOne('SELECT COUNT(*)::int AS n FROM faq');
  if (row.n > 0) return;
  console.log('[DB] Insertando FAQs iniciales...');

  const faqs = [
    ['¿Tienen garantía de recuperación?',
     'En Recupero Tus Datos ofrecemos diagnóstico gratuito. Solo se cobra si se logra recuperar la información. Si no recuperamos sus datos, no paga nada. 💯',
     'garantia,cobro,pago,precio,gratis,costo'],
    ['¿Cómo envío mi dispositivo?',
     'Puede traer su dispositivo a nuestras instalaciones o enviarlo por courier con embalaje seguro. Le proporcionamos las instrucciones necesarias. Visítenos en recuperotusdatos.com',
     'envio,courier,traer,oficina,llevar,como,donde'],
    ['¿Cuánto tiempo demora el proceso?',
     'El tiempo depende del tipo de daño: fallas lógicas entre 24 y 48 horas, daños físicos entre 3 y 7 días hábiles. Le mantenemos informado durante todo el proceso.',
     'tiempo,cuanto,demora,tarda,plazo,dias,rapido'],
    ['¿Recuperan fotos de celular?',
     'Sí, recuperamos fotos, videos, contactos y archivos de dispositivos Android e iOS. Cuéntenos más sobre su caso para brindarle una cotización exacta.',
     'celular,fotos,android,iphone,ios,movil,telefono'],
    ['¿Trabajan con discos de Mac?',
     'Sí, trabajamos con todos los sistemas de archivos: Mac (HFS+, APFS), Windows (NTFS, FAT32) y Linux (ext4). También con SSD propietarios de MacBook.',
     'mac,apple,macbook,hfs,apfs,imac'],
    ['¿Qué formas de pago aceptan?',
     'Aceptamos efectivo, transferencia bancaria (BCP, Interbank, BBVA), tarjeta de crédito/débito, Yape y Plin. 💳',
     'pago,tarjeta,efectivo,yape,plin,transferencia,banco'],
  ];

  for (const f of faqs) {
    await execute(`INSERT INTO faq (question,answer,keywords) VALUES ($1,$2,$3)`, f);
  }
  console.log('[DB] FAQs insertadas ✓');
}

module.exports = { getPool, query, queryOne, execute, initSchema, nextTicketNumber, nextCasoNumber };
