require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const fs = require('fs');
const { Resend } = require('resend');
const app = express();

// Trust Railway's reverse proxy so req.ip contains the real client IP
app.set('trust proxy', 1);

app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public', { index: false }));

// ── RATE LIMITING ─────────────────────────────────────────────
// General: protects all API routes from flood attacks
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Esperá unos minutos e intentá de nuevo.' },
  skip: (req) => req.path === '/api/webhook',
});

// Auth: prevents brute-force on login/register
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Esperá 15 minutos antes de volver a intentar.' },
});

// Audit: most important — each call costs real money (Claude API)
// Key: hashed session token if authenticated, IP otherwise
const auditLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite de auditorías por hora alcanzado. Volvé en un rato o considerá un plan superior.' },
  keyGenerator: (req) => {
    const token = req.headers['x-session-token'];
    if (token) return crypto.createHash('sha256').update(token).digest('hex').slice(0, 20);
    return req.ip;
  },
});

// Scrape: protects against URL crawling abuse
const scrapeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados análisis de URL. Esperá unos minutos.' },
});

app.use('/api/', apiLimiter);

const bcrypt = require('bcryptjs');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'vendly_secret_change_me';
const LS_API_KEY = process.env.LEMONSQUEEZY_API_KEY || '';
const LS_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';
const LS_STARTER_VARIANT = process.env.LEMONSQUEEZY_BASIC_VARIANT_ID || '';
const LS_PRO_VARIANT = process.env.LEMONSQUEEZY_PRO_VARIANT_ID || '';
const LS_STORE_URL = (process.env.LEMONSQUEEZY_STORE_URL || '').replace(/\/$/, '');
const APP_URL = process.env.APP_URL || 'https://vendly-production-e0f2.up.railway.app';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'hola@vend-ly.store';
const DB_PATH = process.env.DB_PATH || '/app/data/vendly.db';

// ── DATABASE ──────────────────────────────────────────────────
let db;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      plan TEXT DEFAULT 'free',
      status TEXT DEFAULT 'active',
      audits_used INTEGER DEFAULT 0,
      audits_limit INTEGER DEFAULT 1,
      subscription_id TEXT,
      stripe_customer_id TEXT,
      audits_reset_at TEXT,
      welcomed INTEGER DEFAULT 0,
      ref_code TEXT,
      referred_by INTEGER,
      followup_day3 INTEGER DEFAULT 0,
      followup_day7 INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER NOT NULL,
      referred_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS magic_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_name TEXT,
      product_url TEXT,
      score_conversion INTEGER,
      score_confianza INTEGER,
      score_seo INTEGER,
      audit_data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ip_usage (
      ip TEXT PRIMARY KEY,
      count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS shared_reports (
      token TEXT PRIMARY KEY,
      audit_data TEXT NOT NULL,
      product_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      user_id INTEGER,
      props TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // Migrations for existing DBs
  try { db.run('ALTER TABLE users ADD COLUMN stripe_customer_id TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN audits_reset_at TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN welcomed INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN ref_code TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN referred_by INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN followup_day3 INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN followup_day7 INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN audit_limit_email_sent INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN followup_day14 INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN password_hash TEXT'); } catch(e) {}

  // Generar ref_code para usuarios que no tienen uno
  const usersWithoutCode = dbAll('SELECT id FROM users WHERE ref_code IS NULL');
  for (const u of usersWithoutCode) {
    const code = crypto.createHash('sha256').update(`${u.id}-${JWT_SECRET}`).digest('hex').slice(0, 8);
    db.run('UPDATE users SET ref_code = ? WHERE id = ?', [code, u.id]);
  }
  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Debounced save: batches rapid writes into one disk flush (max 500ms delay)
let _saveTimer = null;
function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    saveDb();
  }, 500);
}

// Guaranteed flush every 30s and on graceful shutdown
setInterval(saveDb, 30000);
process.on('SIGTERM', () => { saveDb(); process.exit(0); });
process.on('SIGINT',  () => { saveDb(); process.exit(0); });

// Auto follow-up emails cada 6 horas
setInterval(async () => {
  try {
    const day3Users = dbAll(`
      SELECT u.id, u.email, u.ref_code FROM users u
      WHERE u.followup_day3 = 0 AND u.welcomed = 1
      AND julianday('now') - julianday(u.created_at) >= 3
      AND EXISTS (SELECT 1 FROM audits a WHERE a.user_id = u.id)
    `);
    for (const u of day3Users) {
      try { await sendDay3Email(u.email, u.ref_code || ''); dbRun('UPDATE users SET followup_day3 = 1 WHERE id = ?', [u.id]); }
      catch(e) { console.error('Day3 email error:', u.email, e.message); }
    }
    const day7Users = dbAll(`
      SELECT u.id, u.email FROM users u
      WHERE u.followup_day7 = 0 AND u.welcomed = 1 AND u.plan = 'free'
      AND julianday('now') - julianday(u.created_at) >= 7
    `);
    for (const u of day7Users) {
      try { await sendDay7Email(u.email); dbRun('UPDATE users SET followup_day7 = 1 WHERE id = ?', [u.id]); }
      catch(e) { console.error('Day7 email error:', u.email, e.message); }
    }
    const day14Users = dbAll(`
      SELECT u.id, u.email FROM users u
      WHERE u.followup_day14 = 0 AND u.welcomed = 1 AND u.plan = 'free'
      AND julianday('now') - julianday(u.created_at) >= 14
    `);
    for (const u of day14Users) {
      try { await sendDay14Email(u.email); dbRun('UPDATE users SET followup_day14 = 1 WHERE id = ?', [u.id]); }
      catch(e) { console.error('Day14 email error:', u.email, e.message); }
    }
  } catch(e) { console.error('Follow-up cron error:', e.message); }
}, 6 * 60 * 60 * 1000);

// DB helpers
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAll(sql, params = []) {
  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  scheduleSave();
}

// ── INPUT SANITIZATION ────────────────────────────────────────
function sanitizeUrl(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('URL requerida');
  const trimmed = raw.trim();
  let parsed;
  try { parsed = new URL(trimmed); } catch { throw new Error('URL inválida — asegurate de incluir https://'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Solo se aceptan URLs http/https');
  if (parsed.hostname.length < 3) throw new Error('Dominio inválido');
  return parsed.href; // normalized
}

function sanitizeText(raw, maxLen = 200) {
  if (!raw || typeof raw !== 'string') return '';
  // Strip control characters and collapse whitespace; trim to maxLen
  return raw.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// ── AUTH ──────────────────────────────────────────────────────
function makeJWT(userId, email, plan) {
  return jwt.sign({ userId, email, plan }, JWT_SECRET, { expiresIn: '30d' });
}
function checkJWT(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
function requireAuth(req, res, next) {
  const p = checkJWT(req.headers['x-session-token']);
  if (!p) return res.status(401).json({ error: 'No autenticado' });
  req.user = dbGet('SELECT * FROM users WHERE email = ?', [p.email]);
  if (!req.user) return res.status(401).json({ error: 'Usuario no encontrado' });
  next();
}
function optAuth(req, res, next) {
  const p = checkJWT(req.headers['x-session-token']);
  if (p) req.user = dbGet('SELECT * FROM users WHERE email = ?', [p.email]);
  next();
}

// ── SCRAPER ───────────────────────────────────────────────────
async function scrape(rawUrl) {
  // Auto-add https:// if missing
  let url = rawUrl.trim();
  if (url && !url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;

  let data;
  try {
    const resp = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'es-AR,es;q=0.9' } });
    data = resp.data;
  } catch (e) {
    if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') throw new Error('La tienda tardó demasiado en responder. Intentá de nuevo o usá el modo manual.');
    if (e.response?.status === 403) throw new Error('La tienda bloqueó el acceso automático. Usá el modo manual (✏️) para ingresar los datos del producto.');
    if (e.response?.status === 404) throw new Error('No encontramos esa URL. Verificá que sea el link directo al producto (no a la tienda en general).');
    if (e.response?.status === 401 || e.response?.status === 403) throw new Error('La tienda requiere contraseña o está en modo privado. Usá el modo manual.');
    if (e.code === 'ENOTFOUND') throw new Error('No pudimos encontrar esa URL. Verificá que esté bien escrita y que la tienda esté activa.');
    throw new Error('Error al leer la URL. Si el problema persiste, usá el modo manual (✏️).');
  }
  const $ = cheerio.load(data);

  // Extraer precio de múltiples patrones comunes (Tiendanube, Shopify, MercadoShops)
  const priceSelectors = [
    '[class*="price"]', '[class*="precio"]', '[itemprop="price"]',
    '[class*="Price"]', '.product-price', '.price-item', '.js-price',
    '[data-price]', '.money'
  ];
  let price = '';
  for (const sel of priceSelectors) {
    const p = $(sel).first().text().trim();
    if (p && p.length < 30) { price = p; break; }
  }

  // Extraer descripción del producto (no solo meta)
  const descSelectors = [
    '[class*="description"]', '[class*="descripcion"]', '[itemprop="description"]',
    '.product-description', '.product__description', '#product-description'
  ];
  let productDesc = '';
  for (const sel of descSelectors) {
    const d = $(sel).first().text().replace(/\s+/g, ' ').trim();
    if (d && d.length > 50) { productDesc = d.slice(0, 800); break; }
  }

  // Detectar si tiene reseñas visibles
  const hasReviews = $('[class*="review"], [class*="rating"], [class*="stars"], [itemprop="ratingValue"]').length > 0;
  // Detectar imágenes del producto
  const imgCount = $('[class*="product"] img, [class*="gallery"] img').length;

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2500);

  return {
    name: $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || '',
    description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || productDesc || '',
    productDescription: productDesc,
    price,
    image: $('meta[property="og:image"]').attr('content') || '',
    hasReviews,
    imageCount: imgCount,
    url,
    bodyText
  };
}

// ── AUDIT PROMPT MODULES ──────────────────────────────────────
// Defined once at module level — not recreated on every audit call

const COUNTRY_CTX = {
  argentina: {
    name: 'Argentina',
    buyerInsights: 'Los compradores argentinos buscan: precio en cuotas sin interés, envío gratis como factor decisivo, logo de MercadoPago/Visa visible, WhatsApp de atención al cliente, descuento por transferencia bancaria. Desconfían de tiendas sin reseñas ni información de contacto. El voseo genera cercanía y confianza.',
    copyNote: 'Usá voseo (vos, podés, tenés). Tono directo. Frases cortas. Mencioná cuotas y envío gratis cuando corresponda.'
  },
  mexico: {
    name: 'México',
    buyerInsights: 'Los compradores mexicanos valoran: envío a todo el país, pago en OXXO o SPEI, garantía de devolución clara, precio en mensualidades. Muy sensibles al precio, buscan valor por su dinero. Las reseñas en español son clave para la decisión de compra.',
    copyNote: 'Tuteo amigable. Incluir urgencia real. Mencionar opciones de pago accesibles y cobertura de envío nacional.'
  },
  colombia: {
    name: 'Colombia',
    buyerInsights: 'Los compradores colombianos valoran: contraentrega disponible, envío gratis, precio competitivo. Alta desconfianza al pago online. Prefieren opciones de pago conocidas y marcas que transmitan seguridad y respaldo.',
    copyNote: 'Tuteo profesional. Enfatizar seguridad, garantías y facilidad de devolución. Mencionar contraentrega si aplica.'
  },
  espana: {
    name: 'España',
    buyerInsights: 'Los compradores españoles valoran: envío en 24-48h, política de devolución de 14 días (derecho legal), precio con IVA incluido, atención al cliente accesible, reseñas verificadas.',
    copyNote: 'Tuteo o usted según el segmento. Tono profesional. Mencionar envío rápido, IVA incluido y cumplimiento normativo.'
  },
  general: {
    name: 'Latinoamérica',
    buyerInsights: 'Los compradores latinoamericanos valoran: precio competitivo, envío confiable, medios de pago locales, atención en español, políticas de devolución claras, prueba social visible.',
    copyNote: 'Español neutro sin regionalismos. Tono cercano y profesional. Enfatizar confianza y conveniencia.'
  }
};

const TONE_MAP = {
  profesional: 'profesional, confiable y experto — como una marca consolidada',
  casual: 'casual, cercano y amigable — como hablarle a un amigo de confianza',
  divertido: 'divertido, energético y con personalidad — marca joven y moderna',
  urgente: 'urgente y persuasivo — cada palabra impulsa a la acción inmediata'
};

const SCORING_RUBRIC = `CRITERIOS DE SCORING (sé específico y realista, no inflés los números):
- Conversión 90-100: beneficio principal clarísimo, urgencia real, prueba social visible, precio contextualizado, CTA múltiple, garantía explícita
- Conversión 70-89: tiene varios elementos pero falta alguno clave
- Conversión 50-69: descripción básica, falta prueba social o urgencia
- Conversión 0-49: descripción pobre, sin beneficios claros, sin elementos de conversión

- Confianza 90-100: reseñas visibles, devolución clara, medios de pago reconocibles, contacto visible, imágenes profesionales múltiples
- Confianza 70-89: varios elementos presentes pero faltan algunos
- Confianza 50-69: pocos elementos de confianza
- Confianza 0-49: sin reseñas, sin política de devolución, sin contacto

- SEO 90-100: keyword principal en título, URL optimizada, meta descripción con keyword, estructura H1/H2, keywords secundarias en descripción
- SEO 70-89: bien optimizado pero incompleto
- SEO 50-69: optimización básica
- SEO 0-49: sin optimización real`;

// ── AUDIT ─────────────────────────────────────────────────────
async function generateAudit(product, country, tone, comp) {
  const ctx = COUNTRY_CTX[country] || COUNTRY_CTX.general;
  const toneDesc = TONE_MAP[tone] || TONE_MAP.profesional;

  const compBlock = comp ? `
COMPETIDOR A COMPARAR:
- Nombre: ${comp.name || 'Sin nombre'}
- Descripción: ${comp.description || 'Sin descripción'}
- Precio: ${comp.price || 'No especificado'}
` : '';

  const compJson = comp
    ? `"analisis_competidor":{"ventajas_vs_competidor":["ventaja concreta 1","ventaja concreta 2","ventaja concreta 3"],"desventajas_vs_competidor":["desventaja concreta 1","desventaja concreta 2"],"oportunidades":["oportunidad de diferenciación 1","oportunidad 2","oportunidad 3"],"conclusion":"2-3 oraciones sobre cómo posicionarse estratégicamente frente al competidor"},`
    : `"analisis_competidor":null,`;

  // Plan de acción — 5 pasos priorizados con plazo estimado
  const planAccionSchema = `"plan_accion":[{"prioridad":1,"accion":"primera acción concreta y específica con el mayor ROI — qué hacer exactamente, no un consejo genérico","impacto_esperado":"resultado medible esperado en ventas, conversión o confianza","plazo":"Inmediato (hoy)"},{"prioridad":2,"accion":"segunda acción de alto impacto, implementable sin desarrollador","impacto_esperado":"resultado específico esperado","plazo":"Esta semana"},{"prioridad":3,"accion":"tercera acción de impacto medio, puede requerir algo de tiempo","impacto_esperado":"resultado esperado a mediano plazo","plazo":"Próximas 2 semanas"},{"prioridad":4,"accion":"cuarta acción de optimización continua","impacto_esperado":"mejora incremental esperada","plazo":"Este mes"},{"prioridad":5,"accion":"quinta acción estratégica de más largo plazo","impacto_esperado":"impacto esperado a largo plazo","plazo":"Próximo mes"}]`;

  const prompt = `Sos un consultor senior de e-commerce con 10 años de experiencia en ${ctx.name}, especializado en optimización de conversión. Has auditado más de 500 tiendas y sabés exactamente qué hace que los compradores de la región compren o abandonen.

PRODUCTO A AUDITAR:
- Nombre: ${product.name || 'Sin nombre detectado'}
- Descripción meta: ${product.description || 'Sin descripción'}
- Descripción en página: ${product.productDescription || 'No detectada'}
- Precio: ${product.price || 'No especificado'}
- URL: ${product.url || 'No disponible'}
- Reseñas visibles: ${product.hasReviews ? 'Sí' : 'No detectadas'}
- Cantidad de imágenes del producto: ${product.imageCount || 0}
- Contenido de la página: ${(product.bodyText || '').slice(0, 1800)}
${compBlock}
MERCADO: ${ctx.name}
COMPORTAMIENTO DEL COMPRADOR: ${ctx.buyerInsights}
TONO DE COMUNICACIÓN: ${toneDesc}
NOTA DE REDACCIÓN: ${ctx.copyNote}

${SCORING_RUBRIC}

Respondé SOLO con JSON puro sin markdown ni texto adicional. IMPORTANTE: todos los textos deben estar completamente redactados, nunca uses placeholders ni instrucciones dentro del valor:
{"diagnostico_critico":"UNA sola oración brutal y específica que nombre el problema más grave de este producto que está costando ventas HOY — sé directo, no genérico. Ejemplo real: 'La descripción no menciona ni un solo beneficio concreto y el precio aparece sin contexto, esto solo está ahuyentando al 60% de los visitantes antes de que lleguen al botón de compra.'","ganancias_rapidas":[{"accion":"primera acción que puede hacer HOY en menos de 30 minutos sin diseñador ni desarrollador — sé 100% específico, decí exactamente qué escribir o cambiar","impacto_estimado":"+X% conversión estimada","tiempo":"15 min"},{"accion":"segunda acción rápida igual de específica","impacto_estimado":"+X% estimado","tiempo":"20 min"},{"accion":"tercera acción rápida con instrucción exacta","impacto_estimado":"+X% estimado","tiempo":"30 min"}],"resumen_ejecutivo":"3-4 oraciones específicas sobre ESTE producto: su mayor fortaleza, su mayor problema de conversión y la oportunidad más importante para vender más en ${ctx.name}.","scores":{"conversion":<número real 0-100>,"confianza":<número real 0-100>,"seo":<número real 0-100>,"benchmark_conversion":74,"benchmark_confianza":68,"benchmark_seo":61,"conversion_explicacion":"2 oraciones concretas sobre qué sube y qué baja el score de conversión de ESTE producto específico","confianza_explicacion":"2 oraciones específicas sobre qué elementos de confianza tiene y cuáles le faltan","seo_explicacion":"2 oraciones sobre el estado real del SEO con keywords detectadas o ausentes"},${compJson}"fortalezas":["fortaleza concreta y específica de ESTE producto 1","fortaleza 2","fortaleza 3","fortaleza 4"],"debilidades":["debilidad específica con impacto directo en ventas 1","debilidad 2","debilidad 3","debilidad 4"],"mejoras_recomendadas":[{"titulo":"acción concreta y accionable","descripcion":"cómo implementarlo exactamente, paso a paso, en el contexto de ${ctx.name}","impacto":"ALTO","impacto_estimado":"+15-25% conversión"},{"titulo":"segunda mejora ALTO impacto","descripcion":"instrucciones específicas de implementación","impacto":"ALTO","impacto_estimado":"+10-20% confianza"},{"titulo":"mejora MEDIO impacto","descripcion":"instrucciones específicas","impacto":"MEDIO","impacto_estimado":"+8-12% tráfico orgánico"},{"titulo":"segunda mejora MEDIO impacto","descripcion":"instrucciones específicas","impacto":"MEDIO","impacto_estimado":"+5-10% conversión"},{"titulo":"mejora BAJO impacto pero rápida","descripcion":"instrucciones específicas","impacto":"BAJO","impacto_estimado":"+3-5% engagement"}],"descripcion_optimizada":{"titulo_seo":"título entre 60-80 caracteres con keyword principal pensada para compradores de ${ctx.name}","descripcion_corta":"máximo 160 caracteres con keyword principal y beneficio clave más importante","descripcion_larga":"ESCRIBÍ 300-400 palabras COMPLETAS en tono ${toneDesc}. Estructura: gancho que enganche en la primera línea + problema que resuelve + características principales + beneficios concretos para el comprador + prueba social implícita + llamado a la acción. NO uses placeholders, redactá el texto real y completo.","bullet_points":["beneficio concreto 1 con resultado específico y medible","beneficio 2 que responde a una objeción común","beneficio 3 diferenciador vs competencia","beneficio 4 de conveniencia o facilidad","beneficio 5 de garantía o confianza"]},"meta_ads":[{"nombre":"Ad 1 — Beneficio Principal","headline":"máx 40 chars, gancho directo al beneficio más fuerte del producto","texto_principal":"ESCRIBÍ 180-220 palabras COMPLETAS sobre ESTE producto específico. Hook que detenga el scroll en las primeras 2 líneas mencionando el producto por nombre + el problema que resuelve + 3 beneficios concretos con detalles reales + CTA claro con urgencia. CERO texto genérico.","descripcion":"máx 90 chars complementando el headline con razón adicional para hacer clic","objetivo":"Conversión"},{"nombre":"Ad 2 — Problema/Dolor","headline":"headline que toca el dolor o frustración exacta del cliente potencial de este producto","texto_principal":"180-220 palabras reales sobre ESTE producto. Empieza nombrando el dolor específico del cliente. Agítalo con una pregunta. Presenta el producto como la solución concreta. 3 beneficios. CTA.","descripcion":"descripción que refuerza la solución al problema específico","objetivo":"Conversión"},{"nombre":"Ad 3 — Prueba Social","headline":"headline con número concreto, resultado real o validación específica de este tipo de producto","texto_principal":"180-220 palabras reales. Abre con un resultado o testimonio hipotético realista y específico para este producto. Desarrolla la historia. Beneficios. CTA.","descripcion":"descripción que refuerza la prueba social con detalle específico","objetivo":"Reconocimiento"},{"nombre":"Ad 4 — Urgencia/Escasez","headline":"headline con urgencia genuina y creíble para este producto","texto_principal":"180-220 palabras reales. Urgencia real (stock, precio, temporada). Beneficio principal del producto. Qué pierde si no compra ahora. CTA con deadline.","descripcion":"descripción con la limitación o deadline específico","objetivo":"Conversión"},{"nombre":"Ad 5 — Retargeting","headline":"headline para quien ya vio este producto pero no compró — supera la objeción principal","texto_principal":"180-220 palabras reales. Identifica y supera las 2-3 objeciones más comunes para ESTE tipo de producto. Ofrece garantía o facilidad. Reduce el riesgo percibido. CTA directo.","descripcion":"descripción con garantía o facilidad de compra específica","objetivo":"Retargeting"}],"instagram_posts":[{"tipo":"Post educativo","hook":"primera línea que detiene el scroll y genera curiosidad real sobre el problema que resuelve este producto","caption":"ESCRIBÍ 160-200 palabras completas en tono ${toneDesc}. Empieza con el hook. Da 3-4 consejos de valor concretos relacionados al producto. Cierra con CTA. 10-12 hashtags reales y relevantes para ${ctx.name}."},{"tipo":"Post de producto","hook":"hook enfocado en el resultado o transformación concreta que da este producto","caption":"160-200 palabras completas. Situación de uso real del producto. Antes/después implícito. Beneficio principal. CTA. Hashtags."},{"tipo":"Historia de éxito","hook":"hook con resultado concreto y número real para este tipo de producto","caption":"160-200 palabras completas. Historia antes/después creíble para este producto. Específico. CTA. Hashtags."}],"preguntas_frecuentes":[{"pregunta":"la pregunta más importante que hace un comprador antes de comprar ESTE producto específico","respuesta":"respuesta completa, específica y que elimina la duda principal de este producto"},{"pregunta":"pregunta sobre envío, devolución o garantía más relevante para ${ctx.name}","respuesta":"respuesta clara, tranquilizadora y específica para este mercado"},{"pregunta":"pregunta técnica específica de ESTE producto sobre características, compatibilidad o uso","respuesta":"respuesta técnica útil que demuestra expertise en este producto"},{"pregunta":"pregunta sobre precio, cuotas o forma de pago relevante para ${ctx.name}","respuesta":"respuesta que justifica el precio de este producto y facilita la decisión"}],"estrategia_precio":"2-3 oraciones muy concretas sobre ESTE precio específico: si está bien posicionado para ${ctx.name}, cómo comunicarlo mejor (cuotas, precio de referencia tachado, anclaje de valor), y el cambio concreto de mayor impacto en conversión.","keywords_seo":["keyword principal con mayor volumen para este producto","keyword secundaria 1 específica","keyword secundaria 2","keyword long-tail con intención de compra para este producto","keyword long-tail 2 específica","keyword regional o local para ${ctx.name}","keyword de categoría del producto","keyword del problema que resuelve"],"audiencia_ideal":{"descripcion":"2-3 oraciones concretas sobre el perfil exacto del comprador ideal de ESTE producto: quién es, en qué situación de vida está, qué lo llevó a buscar esta solución en ${ctx.name}","intereses":["interés o comportamiento concreto 1 para targeting en Meta Ads — específico para compradores de este producto","interés 2 para segmentación","interés 3","interés 4"],"pain_point_principal":"el problema o frustración ESPECÍFICA que tiene el comprador de este tipo de producto antes de encontrar la solución — lo que lo hace buscar activamente"},"objeciones_principales":[{"objecion":"la objeción número 1 que frena la compra de ESTE producto — específica, no genérica","respuesta":"texto persuasivo listo para poner en la página del producto que elimina esta objeción. Redactado en ${toneDesc}. 2-3 oraciones. Listo para copiar y pegar."},{"objecion":"segunda objeción más frecuente específica para este tipo de producto","respuesta":"respuesta persuasiva lista para usar, 2-3 oraciones concretas que dan seguridad"},{"objecion":"tercera objeción sobre precio, envío o garantía más relevante para compradores en ${ctx.name}","respuesta":"respuesta que elimina el miedo, justifica el valor y empuja a tomar acción"}],"impacto_revenue":{"estimacion":"sé muy específico con números: calculá que con el score de conversión actual se está convirtiendo aproximadamente a X% cuando el benchmark del rubro es 2.1%. Con tráfico estimado de 500 visitas/mes y el precio real del producto, calculá cuántas ventas/mes se pierden y cuánto en pesos/dólares representa eso. Ejemplo: 'Con 500 visitas/mes y conversión estimada en 0.8% vs benchmark 2.1%, estás perdiendo ~6-7 ventas/mes. A $X el producto, son ~$X en ingresos mensuales que no capturás.'","oportunidad":"si implementa las 3 primeras ganancias rápidas en los próximos 7 días, qué mejora concreta podría lograr — sé específico con número de ventas adicionales o % de mejora en conversión esperada"},"emails_carrito_abandonado":[{"momento":"1 hora después del abandono","asunto":"asunto corto y directo para este producto exacto — max 60 chars, genera apertura por curiosidad o urgencia blanda, no suena spam","cuerpo":"email completo de 150-200 palabras redactado para este producto específico sin placeholder de ningún tipo. Abre recordando el producto por nombre con su beneficio principal. Agrega urgencia suave. CTA claro. Tono: ${toneDesc}."},{"momento":"24 horas después","asunto":"segundo asunto diferente — ángulo de objeción resuelta o prueba social específica para este producto","cuerpo":"segundo email completo de 150-200 palabras. Nuevo ángulo: responde la objeción más común de este producto o agrega prueba social creíble. Listo para copiar en Klaviyo o Doppler."},{"momento":"72 horas — último intento","asunto":"tercer asunto más directo, puede incluir incentivo o cierre definitivo específico para este producto","cuerpo":"tercer email 150-200 palabras. Último intento, tono más urgente pero no agresivo. Menciona garantía o resuelve el miedo principal. Listo para usar."}],"template_whatsapp":"mensaje completo de 120-150 palabras para cuando alguien escribe por WhatsApp preguntando por este producto. Sin placeholders. Tono ${toneDesc}. Incluye: saludo cálido + presentar el producto por nombre con su beneficio más importante + responder la objeción más frecuente de este tipo de producto + CTA claro para que compre o deje sus datos. Listo para copiar y enviar.",${planAccionSchema}}"`;

  const r = await anthropic.messages.create(
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }]
    },
    { headers: { 'anthropic-beta': 'output-128k-2025-02-19' } }
  );
  if (r.stop_reason === 'max_tokens') console.warn('generateAudit: output truncado en max_tokens — considerar reducir prompt');
  const raw = r.content[0].text.trim().replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();
  try {
    return JSON.parse(raw);
  } catch(e) {
    // Intenta cerrar JSON truncado buscando la última coma/clave válida
    const lastBrace = raw.lastIndexOf('}');
    if (lastBrace > 100) {
      try { return JSON.parse(raw.slice(0, lastBrace + 1)); } catch {}
    }
    const lastComma = raw.lastIndexOf(',"');
    if (lastComma > 100) {
      try { return JSON.parse(raw.slice(0, lastComma) + '}'); } catch {}
    }
    console.error('generateAudit JSON parse failed. stop_reason:', r.stop_reason, '| chars:', raw.length);
    throw new Error('Error procesando la respuesta de IA. Intentá de nuevo.');
  }
}

// ── EMAIL ─────────────────────────────────────────────────────
async function sendMagicLink(email, token) {
  const link = `${APP_URL}/api/auth/verify?token=${token}`;
  await resend.emails.send({
    from: 'Vendly <hola@vend-ly.store>',
    to: email,
    subject: 'Tu link de acceso a Vendly',
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#07070E;color:#F0EEF8;border-radius:16px;">
      <div style="font-size:22px;font-weight:800;margin-bottom:8px;">Vend<span style="color:#A688FA">ly</span></div>
      <h2 style="font-size:20px;margin-bottom:12px;color:#F0EEF8;">Tu link de acceso</h2>
      <p style="color:#8B89A0;margin-bottom:24px;line-height:1.6;">Hacé click para ingresar. Expira en 30 minutos.</p>
      <a href="${link}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#7C5CFC;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:500;">Ingresar a Vendly →</a>
      <p style="color:#8B89A0;font-size:12px;margin-top:20px;line-height:1.6;">Si el botón no funciona, copiá y pegá este link en Chrome o Safari:<br><a href="${link}" target="_blank" style="color:#A688FA;word-break:break-all;">${link}</a></p>
    </div>`
  });
}

async function sendWelcomeEmail(email) {
  const appUrl = APP_URL;
  await resend.emails.send({
    from: 'Vendly <hola@vend-ly.store>',
    to: email,
    subject: '¡Bienvenido a Vendly! Así sacás el máximo provecho 🚀',
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#07070E;color:#F0EEF8;border-radius:16px;">
      <div style="font-size:22px;font-weight:800;margin-bottom:20px;">Vend<span style="color:#A688FA">ly</span></div>
      <h2 style="font-size:20px;margin-bottom:8px;color:#F0EEF8;">¡Tu cuenta está lista! 🎉</h2>
      <p style="color:#8B89A0;margin-bottom:24px;line-height:1.6;">Estas son las 3 cosas que más resultados dan con Vendly:</p>
      <div style="background:#0F0F1A;border-radius:12px;padding:16px;margin-bottom:12px;border-left:3px solid #7C5CFC">
        <div style="font-weight:600;margin-bottom:4px;">1. Auditá tu producto más importante primero</div>
        <div style="font-size:13px;color:#8B89A0;">Pegá la URL del producto que más vendés o del que querés potenciar. En 30 segundos tenés el análisis completo.</div>
      </div>
      <div style="background:#0F0F1A;border-radius:12px;padding:16px;margin-bottom:12px;border-left:3px solid #34D399">
        <div style="font-weight:600;margin-bottom:4px;">2. Implementá las mejoras de impacto ALTO primero</div>
        <div style="font-size:13px;color:#8B89A0;">El informe tiene un plan de acción priorizado. Empezá por las 2 mejoras marcadas como ALTO — son las que más mueven el número.</div>
      </div>
      <div style="background:#0F0F1A;border-radius:12px;padding:16px;margin-bottom:24px;border-left:3px solid #F5C842">
        <div style="font-weight:600;margin-bottom:4px;">3. Copiá los anuncios de Meta Ads directo</div>
        <div style="font-size:13px;color:#8B89A0;">Los 5 copies de Meta Ads están listos para usar. Probá el Ad 1 (Beneficio) y el Ad 4 (Urgencia) — suelen ser los de mayor conversión.</div>
      </div>
      <a href="${appUrl}/app" style="display:inline-block;background:#7C5CFC;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:500;margin-bottom:20px;">Ir a Vendly →</a>
      <p style="color:#555;font-size:12px;margin-top:8px;">Si tenés alguna pregunta, respondé este email.</p>
    </div>`
  });
}

// ── FOLLOW-UP EMAILS ──────────────────────────────────────────
async function sendDay3Email(email, refCode) {
  const refLink = `${APP_URL}/app?ref=${refCode}`;
  await resend.emails.send({
    from: 'Tomás de Vendly <hola@vend-ly.store>',
    to: email,
    subject: '¿Implementaste las mejoras de tu auditoría?',
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#07070E;color:#F0EEF8;border-radius:16px;">
      <div style="font-size:22px;font-weight:800;margin-bottom:20px;">Vend<span style="color:#A688FA">ly</span></div>
      <p style="color:#F0EEF8;font-size:16px;font-weight:600;margin-bottom:12px;">Hola 👋</p>
      <p style="color:#8B89A0;line-height:1.7;margin-bottom:16px;">Hace 3 días generaste tu primera auditoría con Vendly. Quería preguntarte: <strong style="color:#F0EEF8;">¿ya implementaste alguna mejora?</strong></p>
      <p style="color:#8B89A0;line-height:1.7;margin-bottom:16px;">Los vendedores que implementan las mejoras de impacto ALTO en los primeros 3 días ven resultados en menos de una semana. Empezá por el título SEO y la descripción — son los cambios más rápidos y con más retorno.</p>
      <div style="background:#0F0F1A;border-radius:12px;padding:16px;margin-bottom:20px;border-left:3px solid #7C5CFC">
        <div style="font-size:13px;color:#C4B5FD;font-weight:600;margin-bottom:6px;">💡 Tip rápido</div>
        <div style="font-size:13px;color:#8B89A0;line-height:1.6;">Copiá la descripción larga que generó Vendly y reemplazá la que tenés en tu tienda. Es el cambio más simple y uno de los que más impacto tiene en conversión.</div>
      </div>
      <p style="color:#8B89A0;line-height:1.7;margin-bottom:20px;">Si querés analizar otro producto, acordate que podés <strong style="color:#F0EEF8;">ganar auditorías gratis</strong> compartiendo Vendly con otros vendedores:</p>
      <a href="${refLink}" style="display:inline-block;background:#16161F;color:#A688FA;padding:10px 20px;border-radius:10px;text-decoration:none;font-size:13px;border:1px solid rgba(124,92,252,0.3);margin-bottom:20px;">Tu link de referido → ${refLink}</a>
      <p style="color:#555;font-size:12px;">Por cada amigo que se registre con tu link, te damos 5 auditorías gratis.</p>
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid #1C1C28">
        <a href="${APP_URL}/app" style="display:inline-block;background:#7C5CFC;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:500;">Ir a Vendly →</a>
      </div>
    </div>`
  });
}

async function sendDay7Email(email) {
  await resend.emails.send({
    from: 'Tomás de Vendly <hola@vend-ly.store>',
    to: email,
    subject: 'Lo que están haciendo los vendedores que más venden en LATAM',
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#07070E;color:#F0EEF8;border-radius:16px;">
      <div style="font-size:22px;font-weight:800;margin-bottom:20px;">Vend<span style="color:#A688FA">ly</span></div>
      <p style="color:#F0EEF8;font-size:16px;font-weight:600;margin-bottom:12px;">Un patrón que encontramos en las tiendas que más venden 📊</p>
      <p style="color:#8B89A0;line-height:1.7;margin-bottom:16px;">Analizamos cientos de tiendas en Argentina, México y Colombia. Las que más convierten tienen 3 cosas en común:</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
        <div style="background:#0F0F1A;border-radius:10px;padding:14px;border-left:3px solid #34D399">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px;">1. Auditan sus productos regularmente</div>
          <div style="font-size:12px;color:#8B89A0;">No una vez — cada vez que cambian precio, fotos o descripción, vuelven a auditar para ver el impacto.</div>
        </div>
        <div style="background:#0F0F1A;border-radius:10px;padding:14px;border-left:3px solid #A688FA">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px;">2. Usan los copies de Meta Ads directamente</div>
          <div style="font-size:12px;color:#8B89A0;">Los 5 anuncios de Vendly son el punto de partida — no los reescriben, los prueban tal cual y optimizan el que mejor funciona.</div>
        </div>
        <div style="background:#0F0F1A;border-radius:10px;padding:14px;border-left:3px solid #F5C842">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px;">3. Priorizan por impacto, no por facilidad</div>
          <div style="font-size:12px;color:#8B89A0;">Hacen primero lo que más mueve el número. Vendly ya tiene ese orden — el Plan de Acción está ordenado de mayor a menor impacto.</div>
        </div>
      </div>
      <p style="color:#8B89A0;line-height:1.7;margin-bottom:20px;">Con el plan Starter (USD 9/mes) podés auditar hasta 30 productos por mes y hacer seguimiento de cómo evolucionan tus scores con el tiempo.</p>
      <a href="${APP_URL}/app" style="display:inline-block;background:#7C5CFC;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:500;">Ver planes →</a>
      <p style="color:#555;font-size:12px;margin-top:20px;">Respondé este email si tenés alguna pregunta. Leo todo personalmente.</p>
    </div>`
  });
}

async function sendDay14Email(email) {
  await resend.emails.send({
    from: 'Tomás de Vendly <hola@vend-ly.store>',
    to: email,
    subject: 'El plan Starter ahora tiene 7 días de prueba gratis',
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#07070E;color:#F0EEF8;border-radius:16px;">
      <div style="font-size:22px;font-weight:800;margin-bottom:20px;">Vend<span style="color:#A688FA">ly</span></div>
      <p style="color:#F0EEF8;font-size:16px;font-weight:600;margin-bottom:12px;">Hola 👋 — última vez que te escribo.</p>
      <p style="color:#8B89A0;line-height:1.7;margin-bottom:16px;">Hace dos semanas probaste Vendly. Quería contarte algo antes de dejar de escribirte:</p>
      <div style="background:rgba(124,92,252,0.1);border:1px solid rgba(124,92,252,0.3);border-radius:14px;padding:20px;margin-bottom:20px;">
        <div style="font-size:15px;font-weight:700;color:#C4B5FD;margin-bottom:8px;">¿Cuánto te cuesta NO optimizar tus productos?</div>
        <div style="font-size:13px;color:#8B89A0;line-height:1.7;">Si tenés 500 visitas/mes por producto y convertís al 1% cuando el promedio de e-commerce en LATAM es 2.1%, estás dejando 5-6 ventas por mes sobre la mesa. A $15.000 ARS por venta, son $75.000-$90.000 ARS mensuales que no capturás — por producto.</div>
      </div>
      <p style="color:#8B89A0;line-height:1.7;margin-bottom:20px;">El plan Starter son <strong style="color:#F0EEF8;">USD 9/mes</strong> — 30 auditorías completas, emails de carrito abandonado listos para copiar, template de WhatsApp. Si optimizás un solo producto y vendés 2 unidades extra por mes, ya se pagó solo.</p>
      <a href="${APP_URL}/app" style="display:inline-block;background:#7C5CFC;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:600;font-size:15px;">Ver el plan Starter →</a>
      <p style="color:#555;font-size:12px;margin-top:20px;">Si no es para vos, no hay drama. Que te vaya bien con la tienda. — Tomás</p>
    </div>`
  });
}

async function sendFounderNotification(event, data) {
  const subjects = {
    signup: `🆕 Nuevo usuario: ${data.email}`,
    subscription: `💰 Nueva suscripción ${data.plan?.toUpperCase()}: ${data.email}`,
    audit_done: `📊 Auditoría completada: ${data.email}`
  };
  const bodies = {
    signup: `<p>Nuevo registro en Vendly:</p><ul><li><b>Email:</b> ${data.email}</li><li><b>Hora:</b> ${new Date().toLocaleString('es-AR', {timeZone:'America/Argentina/Buenos_Aires'})}</li></ul><p><a href="${APP_URL}/api/admin/stats?secret=${process.env.ADMIN_SECRET||'vendly_admin_2024'}">Ver estadísticas →</a></p>`,
    subscription: `<p>¡Nueva suscripción!</p><ul><li><b>Email:</b> ${data.email}</li><li><b>Plan:</b> ${data.plan}</li><li><b>Hora:</b> ${new Date().toLocaleString('es-AR', {timeZone:'America/Argentina/Buenos_Aires'})}</li></ul>`,
    audit_done: `<p>${data.email} completó una auditoría de: <b>${data.product||'producto desconocido'}</b></p>`
  };
  try {
    await resend.emails.send({
      from: 'Vendly Notifs <hola@vend-ly.store>',
      to: NOTIFY_EMAIL,
      subject: subjects[event] || `Vendly: ${event}`,
      html: `<div style="font-family:sans-serif;padding:20px">${bodies[event]||JSON.stringify(data)}</div>`
    });
  } catch(e) { console.error('Founder notification error:', e.message); }
}

async function sendAuditLimitEmail(email) {
  await resend.emails.send({
    from: 'Tomás de Vendly <hola@vend-ly.store>',
    to: email,
    subject: 'Usaste tu auditoría gratuita — mirá lo que se desbloquea',
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#07070E;color:#F0EEF8;border-radius:16px;">
      <div style="font-size:22px;font-weight:800;margin-bottom:20px;">Vend<span style="color:#A688FA">ly</span></div>
      <h2 style="font-size:20px;margin-bottom:8px;color:#F0EEF8;">Terminaste tu auditoría gratuita 🎉</h2>
      <p style="color:#8B89A0;line-height:1.7;margin-bottom:20px;">Ahora que ya viste el potencial de Vendly, acá está lo que todavía no pudiste ver en tu informe:</p>
      <div style="background:#0F0F1A;border-radius:14px;padding:18px;margin-bottom:20px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#A688FA;font-weight:700;margin-bottom:12px">Secciones bloqueadas en tu auditoría</div>
        <div style="display:grid;gap:8px;">
          <div style="color:#F0EEF8;font-size:13px">✦ 5 anuncios de Meta Ads listos para lanzar</div>
          <div style="color:#F0EEF8;font-size:13px">✦ 3 posts para Instagram ya escritos</div>
          <div style="color:#F0EEF8;font-size:13px">✦ 3 emails de carrito abandonado (copiar y pegar en Klaviyo)</div>
          <div style="color:#F0EEF8;font-size:13px">✦ Template de WhatsApp listo para enviar</div>
          <div style="color:#F0EEF8;font-size:13px">✦ Keywords SEO para posicionar en Google</div>
          <div style="color:#F0EEF8;font-size:13px">✦ Estrategia de precio + FAQ que convierte</div>
        </div>
      </div>
      <p style="color:#8B89A0;line-height:1.7;margin-bottom:20px;">El plan Starter es <strong style="color:#F0EEF8;">USD 9/mes</strong> — menos que un café por semana — y te da 30 auditorías completas.</p>
      <a href="${APP_URL}/app" style="display:inline-block;background:#7C5CFC;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:600;font-size:15px;">Desbloquear informe completo →</a>
      <p style="color:#555;font-size:12px;margin-top:20px;">30 días de garantía de devolución. Sin preguntas.</p>
    </div>`
  });
}

async function sendSubscriberWelcomeEmail(email, plan) {
  const planName = plan === 'pro' ? 'Pro' : 'Starter';
  const planLimit = plan === 'pro' ? 'ilimitadas' : '30 por mes';
  await resend.emails.send({
    from: 'Tomás de Vendly <hola@vend-ly.store>',
    to: email,
    subject: `¡Bienvenido al plan ${planName}! Esto es lo que desbloqueaste`,
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#07070E;color:#F0EEF8;border-radius:16px;">
      <div style="font-size:22px;font-weight:800;margin-bottom:20px;">Vend<span style="color:#A688FA">ly</span></div>
      <div style="background:rgba(124,92,252,0.1);border:1px solid rgba(124,92,252,0.3);border-radius:12px;padding:14px 18px;margin-bottom:20px;font-size:13px;color:#C4B5FD;">
        ✦ Plan ${planName} activado — ${planLimit} auditorías
      </div>
      <h2 style="font-size:20px;margin-bottom:8px;color:#F0EEF8;">Todo desbloqueado. Así empezás fuerte:</h2>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:24px;">
        <div style="background:#0F0F1A;border-radius:10px;padding:14px;border-left:3px solid #7C5CFC">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px;">1. Auditá tu catálogo completo</div>
          <div style="font-size:12px;color:#8B89A0;">Con ${planLimit} auditorías podés analizar todos tus productos y priorizar cuáles optimizar primero por score de conversión.</div>
        </div>
        <div style="background:#0F0F1A;border-radius:10px;padding:14px;border-left:3px solid #34D399">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px;">2. Copiá los emails de carrito abandonado</div>
          <div style="font-size:12px;color:#8B89A0;">Cada auditoría genera 3 emails listos para pegar en Klaviyo, Doppler o Mailchimp. Configurá la secuencia de 1h, 24h y 72h.</div>
        </div>
        <div style="background:#0F0F1A;border-radius:10px;padding:14px;border-left:3px solid #F5C842">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px;">3. Lanzá Meta Ads esta semana</div>
          <div style="font-size:12px;color:#8B89A0;">Los 5 copies de anuncios están listos. Probá el Ad 1 (Beneficio principal) con USD 5/día — es el punto de partida ideal.</div>
        </div>
      </div>
      <a href="${APP_URL}/app" style="display:inline-block;background:#7C5CFC;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:600;font-size:15px;">Ir a Vendly →</a>
      <p style="color:#555;font-size:12px;margin-top:20px;">Respondé este email si necesitás ayuda. Leo todo personalmente. — Tomás</p>
    </div>`
  });
}

// ── ROUTES ────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/informe/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/legal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal.html')));
app.get('/terminos', (req, res) => res.redirect('/legal'));
app.get('/privacidad', (req, res) => res.redirect('/legal'));

// Auth
function createUserIfNeeded(emailLower, passwordHash, ref, ip) {
  let referredBy = null, bonusAudits = 1;
  if (ref) {
    const referrer = dbGet('SELECT id FROM users WHERE ref_code = ?', [ref]);
    if (referrer) { referredBy = referrer.id; bonusAudits = 3; }
  }
  dbRun('INSERT INTO users (email, password_hash, referred_by, audits_limit) VALUES (?, ?, ?, ?)',
    [emailLower, passwordHash, referredBy, bonusAudits]);
  const newUser = dbGet('SELECT * FROM users WHERE email = ?', [emailLower]);
  const code = crypto.createHash('sha256').update(`${newUser.id}-${JWT_SECRET}`).digest('hex').slice(0, 8);
  dbRun('UPDATE users SET ref_code = ? WHERE id = ?', [code, newUser.id]);
  if (ip) dbRun('INSERT INTO ip_usage (ip, count) VALUES (?, 1) ON CONFLICT(ip) DO UPDATE SET count = count + 1', [ip]);
  if (referredBy) {
    dbRun('UPDATE users SET audits_limit = audits_limit + 5 WHERE id = ? AND plan = "free"', [referredBy]);
    dbRun('INSERT INTO referrals (referrer_id, referred_id) VALUES (?, ?)', [referredBy, newUser.id]);
  }
  return dbGet('SELECT * FROM users WHERE email = ?', [emailLower]);
}

// Registro con email + contraseña
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password, ref } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email inválido' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  const emailLower = email.toLowerCase();
  try {
    const existing = dbGet('SELECT id, password_hash FROM users WHERE email = ?', [emailLower]);
    if (existing?.password_hash) return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Iniciá sesión.' });
    const regIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ipCount = dbGet('SELECT count FROM ip_usage WHERE ip = ?', [regIp]);
    if (ipCount && ipCount.count >= 5) return res.status(429).json({ error: 'Límite de registros por dispositivo alcanzado.' });
    const hash = await bcrypt.hash(password, 10);
    let user;
    if (existing) {
      // Usuario ya existía via magic link — le agrega contraseña
      dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [hash, existing.id]);
      user = dbGet('SELECT * FROM users WHERE id = ?', [existing.id]);
    } else {
      user = createUserIfNeeded(emailLower, hash, ref, regIp);
      sendWelcomeEmail(emailLower).catch(e => console.error('Welcome email error:', e.message));
      sendFounderNotification('signup', { email: emailLower }).catch(() => {});
      dbRun('UPDATE users SET welcomed = 1 WHERE id = ?', [user.id]);
    }
    res.json({ success: true, session: makeJWT(user.id, user.email, user.plan) });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Error al crear la cuenta.' }); }
});

// Login con email + contraseña
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email inválido' });
  if (!password) return res.status(400).json({ error: 'Contraseña requerida' });
  const emailLower = email.toLowerCase();
  try {
    const user = dbGet('SELECT * FROM users WHERE email = ?', [emailLower]);
    if (!user) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    if (!user.password_hash) return res.status(401).json({ error: 'Esta cuenta usa acceso por link. Usá "Olvidé mi contraseña" para configurar una.', needsMagicLink: true });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    res.json({ success: true, session: makeJWT(user.id, user.email, user.plan) });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Error al iniciar sesión.' }); }
});

// Olvidé mi contraseña — envía magic link
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email inválido' });
  const emailLower = email.toLowerCase();
  try {
    const user = dbGet('SELECT id FROM users WHERE email = ?', [emailLower]);
    if (user) {
      const token = jwt.sign({ email: emailLower, purpose: 'magic_link' }, JWT_SECRET, { expiresIn: '30m' });
      await sendMagicLink(emailLower, token).catch(() => {});
    }
    res.json({ success: true, message: 'Si existe una cuenta con ese email, te enviamos un link de acceso.' });
  } catch(e) { res.status(500).json({ error: 'Error enviando el email.' }); }
});

app.get('/api/auth/verify', (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/app?error=invalid');
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch { return res.redirect('/app?error=expired'); }
  if (payload.purpose !== 'magic_link') return res.redirect('/app?error=invalid');
  const email = payload.email;
  let user = dbGet('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    dbRun('INSERT INTO users (email) VALUES (?)', [email]);
    const newUser = dbGet('SELECT id FROM users WHERE email = ?', [email]);
    const newCode = crypto.createHash('sha256').update(`${newUser.id}-${JWT_SECRET}`).digest('hex').slice(0, 8);
    dbRun('UPDATE users SET ref_code = ? WHERE id = ?', [newCode, newUser.id]);
    user = dbGet('SELECT * FROM users WHERE email = ?', [email]);
  }
  if (!user.welcomed) {
    sendWelcomeEmail(user.email).catch(e => console.error('Welcome email error:', e.message));
    sendFounderNotification('signup', { email: user.email }).catch(() => {});
    dbRun('UPDATE users SET welcomed = 1 WHERE id = ?', [user.id]);
  }
  const session = makeJWT(user.id, user.email, user.plan);
  res.redirect(`/app?session=${session}`);
});

app.get('/api/session', optAuth, (req, res) => {
  if (!req.user) return res.json({ authenticated: false });
  res.json({ authenticated: true, email: req.user.email, plan: req.user.plan, status: req.user.status, auditsUsed: req.user.audits_used, auditsLimit: req.user.audits_limit, auditsResetAt: req.user.audits_reset_at, refCode: req.user.ref_code });
});

// Scrape
app.post('/api/scrape', scrapeLimiter, async (req, res) => {
  let cleanUrl;
  try { cleanUrl = sanitizeUrl(req.body?.url); } catch (e) { return res.status(400).json({ error: e.message }); }
  try { res.json({ success: true, product: await scrape(cleanUrl) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Audit
app.post('/api/audit', auditLimiter, optAuth, async (req, res) => {
  const { product, country, tone, competitorProduct } = req.body;
  if (!product || !product.name) return res.status(400).json({ error: 'Datos requeridos' });

  // Sanitize all user-controlled fields that reach the AI prompt
  try { product.url = sanitizeUrl(product.url); } catch { product.url = ''; }
  product.name        = sanitizeText(product.name, 200);
  product.description = sanitizeText(product.description, 500);
  product.productDescription = sanitizeText(product.productDescription, 1000);
  product.price       = sanitizeText(product.price, 50);
  product.bodyText    = sanitizeText(product.bodyText, 3000);

  if (req.user) {
    let u = req.user;
    // Reset mensual para plan basic
    if (u.plan === 'basic' && u.audits_reset_at) {
      const msDiff = Date.now() - new Date(u.audits_reset_at).getTime();
      if (msDiff >= 30 * 24 * 60 * 60 * 1000) {
        dbRun('UPDATE users SET audits_used = 0, audits_reset_at = datetime("now"), updated_at = datetime("now") WHERE id = ?', [u.id]);
        u = dbGet('SELECT * FROM users WHERE id = ?', [u.id]);
      }
    }
    if (u.plan !== 'free' && u.status !== 'active') return res.status(403).json({ error: 'Suscripción inactiva', upgrade: true });
    if (u.plan !== 'pro' && u.plan !== 'agency' && u.audits_used >= u.audits_limit) {
      if (!u.audit_limit_email_sent) {
        sendAuditLimitEmail(u.email).catch(e => console.error('Audit limit email error:', e.message));
        dbRun('UPDATE users SET audit_limit_email_sent = 1 WHERE id = ?', [u.id]);
      }
      return res.status(403).json({ error: 'Límite alcanzado', upgrade: true });
    }
    try {
      const a = await generateAudit(product, country || 'general', tone || 'profesional', competitorProduct || null);
      dbRun('UPDATE users SET audits_used = audits_used + 1, updated_at = datetime("now") WHERE id = ?', [u.id]);
      dbRun('INSERT INTO audits (user_id, product_name, product_url, score_conversion, score_confianza, score_seo, audit_data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [u.id, product.name || product.url, product.url || '', a.scores.conversion, a.scores.confianza, a.scores.seo, JSON.stringify(a)]);
      const updated = dbGet('SELECT * FROM users WHERE id = ?', [u.id]);
      res.json({ success: true, audit: a, plan: u.plan, auditsUsed: updated.audits_used, auditsLimit: updated.audits_limit });
    } catch (e) { console.error('Audit error:', e?.message || e); res.status(500).json({ error: e?.message || 'Error generando auditoría.' }); }
  } else {
    // Sin cuenta — pedir que se registren
    return res.status(403).json({
      error: 'Necesitás crear una cuenta gratuita para usar Vendly. Es rápido y sin tarjeta.',
      requireAuth: true
    });
  }
});

// Audit history + aggregate stats
app.get('/api/audits', requireAuth, (req, res) => {
  const audits = dbAll('SELECT id, product_name, product_url, score_conversion, score_confianza, score_seo, created_at FROM audits WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  const stats = audits.length > 0 ? {
    total: audits.length,
    avg_conversion: Math.round(audits.reduce((s, a) => s + (a.score_conversion || 0), 0) / audits.length),
    avg_seo: Math.round(audits.reduce((s, a) => s + (a.score_seo || 0), 0) / audits.length),
    best: audits.reduce((best, a) => (!best || (a.score_conversion || 0) > (best.score_conversion || 0)) ? a : best, null)
  } : null;
  res.json({ success: true, audits, stats });
});

app.get('/api/audits/:id', requireAuth, (req, res) => {
  const a = dbGet('SELECT * FROM audits WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!a) return res.status(404).json({ error: 'No encontrado' });
  res.json({ success: true, audit: { ...a, audit_data: JSON.parse(a.audit_data) } });
});

// Payments — Lemon Squeezy
app.post('/api/checkout', optAuth, async (req, res) => {
  const { plan } = req.body;
  const email = req.user?.email || req.body.email || '';
  const variantId = plan === 'pro' ? LS_PRO_VARIANT : LS_STARTER_VARIANT;
  if (!variantId || !LS_STORE_URL) return res.status(500).json({ error: 'Pagos no configurados aún.' });
  // Construir URL de checkout de Lemon Squeezy con email prefill y metadata del plan
  const params = new URLSearchParams({
    'checkout[email]': email,
    'checkout[custom][plan]': plan || 'basic',
    'checkout[custom][app_url]': APP_URL,
  });
  const url = `${LS_STORE_URL}/checkout/buy/${variantId}?${params.toString()}`;
  res.json({ url });
});

// Lemon Squeezy Customer Portal (redirige al portal de gestión de LS)
app.get('/api/portal', requireAuth, async (req, res) => {
  const user = req.user;
  if (!user.subscription_id) return res.status(400).json({ error: 'No tenés suscripción activa.' });
  // Intentar obtener URL del portal vía API de LS si hay customer_id
  if (user.stripe_customer_id && LS_API_KEY) {
    try {
      const r = await axios.get(`https://api.lemonsqueezy.com/v1/customers/${user.stripe_customer_id}`, {
        headers: { Authorization: `Bearer ${LS_API_KEY}`, Accept: 'application/vnd.api+json' }
      });
      const portalUrl = r.data?.data?.attributes?.urls?.customer_portal;
      if (portalUrl) return res.json({ url: portalUrl });
    } catch (e) {
      console.error('LS portal API error:', e.message);
    }
  }
  // Fallback: portal genérico de Lemon Squeezy
  res.json({ url: 'https://app.lemonsqueezy.com/my-orders' });
});

// Verificación manual (fallback: chequea la DB por si el webhook ya se procesó)
app.post('/api/verify-subscription', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  const user = dbGet('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  if (!user || user.plan === 'free' || user.status !== 'active') {
    return res.status(404).json({ error: 'No encontramos suscripción activa. Si acabás de pagar, esperá un momento y volvé a intentar.' });
  }
  res.json({ success: true, sessionToken: makeJWT(user.id, user.email, user.plan), plan: user.plan, auditsLimit: user.audits_limit });
});

// Lemon Squeezy Webhook
app.post('/api/webhook', async (req, res) => {
  // Verificar firma HMAC-SHA256
  if (LS_WEBHOOK_SECRET) {
    const sig = req.headers['x-signature'] || '';
    const hmac = crypto.createHmac('sha256', LS_WEBHOOK_SECRET).update(req.body).digest('hex');
    if (hmac !== sig) {
      console.error('Webhook signature mismatch');
      return res.status(400).send('Invalid signature');
    }
  }

  let event;
  try { event = JSON.parse(req.body.toString()); }
  catch (e) { return res.status(400).send('Invalid JSON'); }

  const eventName = event.meta?.event_name || '';
  const attrs = event.data?.attributes || {};
  console.log('LS webhook event:', eventName);

  try {
    // subscription_created / subscription_updated
    if (eventName === 'subscription_created' || eventName === 'subscription_updated') {
      const email = (attrs.user_email || '').toLowerCase();
      const status = attrs.status; // active, cancelled, expired, past_due, unpaid, paused
      const variantId = String(attrs.variant_id || '');
      const subscriptionId = String(event.data?.id || '');
      const customerId = String(attrs.customer_id || '');

      if (!email) { console.error('LS webhook: no email'); return res.json({ received: true }); }

      if (status === 'active') {
        const plan = variantId === String(LS_PRO_VARIANT) ? 'pro' : 'basic';
        const limit = plan === 'pro' ? 999999 : 30;
        const existing = dbGet('SELECT id FROM users WHERE email = ?', [email]);
        if (!existing) dbRun('INSERT INTO users (email) VALUES (?)', [email]);
        const wasAlreadyPaid = dbGet('SELECT plan FROM users WHERE email = ?', [email])?.plan;
        dbRun('UPDATE users SET plan=?, status=?, audits_limit=?, subscription_id=?, stripe_customer_id=?, audits_reset_at=datetime("now"), updated_at=datetime("now") WHERE email=?',
          [plan, 'active', limit, subscriptionId, customerId, email]);
        console.log(`Activated ${plan} for ${email}`);
        if (!wasAlreadyPaid || wasAlreadyPaid === 'free') {
          sendSubscriberWelcomeEmail(email, plan).catch(e => console.error('Subscriber welcome error:', e.message));
          sendFounderNotification('subscription', { email, plan }).catch(() => {});
        }
      } else if (['cancelled', 'expired', 'past_due', 'unpaid', 'paused'].includes(status)) {
        dbRun('UPDATE users SET status=?, plan=?, audits_limit=1, updated_at=datetime("now") WHERE subscription_id=?',
          ['active', 'free', subscriptionId]);
        console.log(`Deactivated subscription ${subscriptionId} (${status})`);
      }
    }

    // subscription_cancelled (evento explícito de cancelación)
    if (eventName === 'subscription_cancelled') {
      const subscriptionId = String(event.data?.id || '');
      dbRun('UPDATE users SET status=?, plan=?, audits_limit=1, updated_at=datetime("now") WHERE subscription_id=?',
        ['active', 'free', subscriptionId]);
    }

    // subscription_expired
    if (eventName === 'subscription_expired') {
      const subscriptionId = String(event.data?.id || '');
      dbRun('UPDATE users SET status=?, plan=?, audits_limit=1, updated_at=datetime("now") WHERE subscription_id=?',
        ['cancelled', 'free', subscriptionId]);
    }
  } catch (e) {
    console.error('Webhook processing error:', e.message);
  }

  res.json({ received: true });
});

// Analytics
app.post('/api/analytics/event', optAuth, (req, res) => {
  const { event, props } = req.body;
  if (!event || typeof event !== 'string' || event.length > 64) return res.status(400).json({ error: 'Evento inválido' });
  const userId = req.user?.id || null;
  const safeProps = props && typeof props === 'object' ? JSON.stringify(props).slice(0, 500) : null;
  dbRun('INSERT INTO events (event, user_id, props) VALUES (?, ?, ?)', [event, userId, safeProps]);
  console.log(`[event] ${event}${userId ? ` uid=${userId}` : ''} ${safeProps || ''}`);
  res.json({ ok: true });
});

// Share
app.post('/api/share', (req, res) => {
  const { audit, product } = req.body;
  if (!audit) return res.status(400).json({ error: 'Datos requeridos' });
  const token = crypto.randomBytes(16).toString('hex');
  dbRun('INSERT INTO shared_reports (token, audit_data, product_name) VALUES (?, ?, ?)',
    [token, JSON.stringify(audit), product?.name || '']);
  dbRun('DELETE FROM shared_reports WHERE created_at < datetime("now", "-30 days")');
  res.json({ success: true, token, url: `/informe/${token}` });
});

app.get('/api/report/:token', (req, res) => {
  const r = dbGet('SELECT * FROM shared_reports WHERE token = ?', [req.params.token]);
  if (!r) return res.status(404).json({ error: 'No encontrado o expirado' });
  res.json({ success: true, audit: JSON.parse(r.audit_data), product: { name: r.product_name } });
});

// Referral info del usuario
app.get('/api/referral', requireAuth, (req, res) => {
  const user = req.user;
  if (!user.ref_code) {
    const code = crypto.createHash('sha256').update(`${user.id}-${JWT_SECRET}`).digest('hex').slice(0, 8);
    dbRun('UPDATE users SET ref_code = ? WHERE id = ?', [code, user.id]);
    user.ref_code = code;
  }
  const referrals = dbAll('SELECT COUNT(*) as total FROM referrals WHERE referrer_id = ?', [user.id]);
  res.json({
    success: true,
    refCode: user.ref_code,
    refUrl: `${APP_URL}/app?ref=${user.ref_code}`,
    referralCount: referrals[0]?.total || 0,
    bonusEarned: (referrals[0]?.total || 0) * 5
  });
});

// Admin: enviar follow-ups a usuarios que corresponda
app.post('/api/admin/followups', async (req, res) => {
  const { secret } = req.body;
  if (secret !== (process.env.ADMIN_SECRET || 'vendly_admin_2024')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Día 3: usuarios con al menos 1 auditoría, sin follow-up día 3
  const day3Users = dbAll(`
    SELECT u.id, u.email, u.ref_code FROM users u
    WHERE u.followup_day3 = 0
    AND u.welcomed = 1
    AND julianday('now') - julianday(u.created_at) >= 3
    AND EXISTS (SELECT 1 FROM audits a WHERE a.user_id = u.id)
  `);
  // Día 7: usuarios sin follow-up día 7
  const day7Users = dbAll(`
    SELECT u.id, u.email FROM users u
    WHERE u.followup_day7 = 0
    AND u.welcomed = 1
    AND u.plan = 'free'
    AND julianday('now') - julianday(u.created_at) >= 7
  `);
  const day14Users = dbAll(`
    SELECT u.id, u.email FROM users u
    WHERE u.followup_day14 = 0 AND u.welcomed = 1 AND u.plan = 'free'
    AND julianday('now') - julianday(u.created_at) >= 14
  `);
  let sent3 = 0, sent7 = 0, sent14 = 0;
  for (const u of day3Users) {
    try {
      await sendDay3Email(u.email, u.ref_code || '');
      dbRun('UPDATE users SET followup_day3 = 1 WHERE id = ?', [u.id]);
      sent3++;
    } catch(e) { console.error('Day3 email error:', u.email, e.message); }
  }
  for (const u of day7Users) {
    try {
      await sendDay7Email(u.email);
      dbRun('UPDATE users SET followup_day7 = 1 WHERE id = ?', [u.id]);
      sent7++;
    } catch(e) { console.error('Day7 email error:', u.email, e.message); }
  }
  for (const u of day14Users) {
    try {
      await sendDay14Email(u.email);
      dbRun('UPDATE users SET followup_day14 = 1 WHERE id = ?', [u.id]);
      sent14++;
    } catch(e) { console.error('Day14 email error:', u.email, e.message); }
  }
  res.json({ success: true, sent3, sent7, sent14 });
});

// Content generator (admin)
app.get('/admin/content', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-content.html')));

app.post('/api/admin/generate-content', async (req, res) => {
  const { secret, type, context } = req.body;
  if (secret !== (process.env.ADMIN_SECRET || 'vendly_admin_2024')) return res.status(403).json({ error: 'Forbidden' });
  const prompts = {
    tiktok: `Generá un script de TikTok de 45-60 segundos para promocionar Vendly, una herramienta de auditoría de e-commerce con IA para vendedores de LATAM (Argentina principalmente). Contexto adicional: ${context||'mostrar el score de conversión de un producto y el diagnóstico crítico'}. El script debe: empezar con un hook que detenga el scroll en los primeros 3 segundos, mostrar el "problema" del vendedor, la "revelación" del score de Vendly, 2-3 hallazgos impactantes, y CTA a vend-ly.store. Tono: directo, no vendedor, como si fuera un vendedor mostrando su experiencia. Formato: HOOK: / PROBLEMA: / REVELACIÓN: / HALLAZGOS: / CTA:`,
    facebook: `Escribí 3 variantes de post para grupos de Facebook de dropshipping y e-commerce argentinos que promuevan Vendly (vend-ly.store). Cada variante debe tener un ángulo diferente: 1) mostrar un score real de auditoría, 2) contar un antes/después de mejoras implementadas, 3) hacer una pregunta que genere debate. Tono auténtico, no publicitario. Context: ${context||''}. Formato: POST 1: / POST 2: / POST 3:`,
    instagram: `Creá 3 captions de Instagram para promover Vendly (vend-ly.store) a vendedores de e-commerce LATAM. Cada uno debe tener: hook en la primera línea, valor concreto, CTA, y 10 hashtags relevantes. Ángulos: 1) educativo sobre errores de conversión, 2) antes/después de una auditoría, 3) urgencia/beneficio directo. Context: ${context||''}`,
    whatsapp: `Escribí 5 mensajes de WhatsApp personalizados para enviar a vendedores online de Argentina que podrían beneficiarse de Vendly (vend-ly.store). Cada mensaje debe ser breve (max 3 líneas), no sonar como spam, y mencionar algo específico del contexto: ${context||'que venden en Tiendanube o Shopify'}. CTA: probar gratis. Formato: MENSAJE 1: / MENSAJE 2: / etc.`,
    email_cold: `Escribí 3 subject lines + email de frío (max 150 palabras) para contactar a vendedores de e-commerce argentinos y ofrecerles Vendly (vend-ly.store). Enfocate en el dolor de no saber qué está fallando en la tienda. Tono: de igual a igual, no vendedor. Context: ${context||''}`
  };
  const prompt = prompts[type] || prompts.tiktok;
  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ success: true, content: r.content[0].text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', (req, res) => {
  const { secret } = req.query;
  if (secret !== (process.env.ADMIN_SECRET || 'vendly_admin_2024')) return res.status(403).json({ error: 'Forbidden' });
  const totalUsers = dbGet('SELECT COUNT(*) as n FROM users')?.n || 0;
  const paidUsers = dbGet('SELECT COUNT(*) as n FROM users WHERE plan != "free" AND status = "active"')?.n || 0;
  const basicUsers = dbGet('SELECT COUNT(*) as n FROM users WHERE plan = "basic" AND status = "active"')?.n || 0;
  const proUsers = dbGet('SELECT COUNT(*) as n FROM users WHERE plan = "pro" AND status = "active"')?.n || 0;
  const agencyUsers = dbGet('SELECT COUNT(*) as n FROM users WHERE plan = "agency" AND status = "active"')?.n || 0;
  const mrr = (basicUsers * 9) + (proUsers * 19) + (agencyUsers * 49);
  const totalAudits = dbGet('SELECT COUNT(*) as n FROM audits')?.n || 0;
  const todayAudits = dbGet('SELECT COUNT(*) as n FROM audits WHERE date(created_at) = date("now")')?.n || 0;
  const todaySignups = dbGet('SELECT COUNT(*) as n FROM users WHERE date(created_at) = date("now")')?.n || 0;
  const recentUsers = dbAll('SELECT email, plan, audits_used, created_at FROM users ORDER BY created_at DESC LIMIT 10');
  res.json({ totalUsers, paidUsers, totalAudits, todayAudits, todaySignups, recentUsers, mrr, breakdown: { basic: basicUsers, pro: proUsers, agency: agencyUsers } });
});

app.get('/api/stats', (req, res) => {
  const total = dbGet('SELECT COUNT(*) as total FROM audits');
  const users = dbGet('SELECT COUNT(*) as total FROM users');
  res.json({ totalAudits: total ? total.total : 0, totalUsers: users ? users.total : 0 });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '6.0.0' }));

// Start
initDb().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Vendly v6 en puerto ${PORT}`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
