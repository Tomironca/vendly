require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const fs = require('fs');
const { Resend } = require('resend');
const Stripe = require('stripe');

const app = express();
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public', { index: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');
const JWT_SECRET = process.env.JWT_SECRET || 'vendly_secret_change_me';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_STARTER_PRICE = process.env.STRIPE_STARTER_PRICE_ID || '';
const STRIPE_PRO_PRICE = process.env.STRIPE_PRO_PRICE_ID || '';
const APP_URL = process.env.APP_URL || 'https://vendly-production-e0f2.up.railway.app';
const DB_PATH = './vendly.db';

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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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
  `);
  // Migration: add stripe_customer_id if missing (existing DBs)
  try { db.run('ALTER TABLE users ADD COLUMN stripe_customer_id TEXT'); } catch(e) {}
  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Auto-save every 30 seconds
setInterval(saveDb, 30000);

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
  saveDb();
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
async function scrape(url) {
  const { data } = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Vendly/6.0)' } });
  const $ = cheerio.load(data);
  return {
    name: $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || '',
    description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '',
    price: $('[class*="price"]').first().text().trim() || '',
    image: $('meta[property="og:image"]').attr('content') || '',
    url,
    bodyText: $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2000)
  };
}

// ── AUDIT ─────────────────────────────────────────────────────
async function generateAudit(product, country, tone, comp) {
  const cm = { argentina: 'Argentina (voseo)', mexico: 'México', colombia: 'Colombia', espana: 'España', general: 'Latinoamérica' };
  const tm = { profesional: 'profesional y confiable', casual: 'casual y cercano', divertido: 'divertido y energético', urgente: 'urgente y persuasivo' };
  const cs = comp ? `COMPETIDOR: ${comp.name}, ${comp.description}, ${comp.price}` : '';
  const cj = comp ? `"analisis_competidor":{"ventajas_vs_competidor":["v1","v2","v3"],"desventajas_vs_competidor":["d1","d2"],"oportunidades":["o1","o2","o3"],"conclusion":"2-3 oraciones"},` : '"analisis_competidor":null,';

  const prompt = `Sos consultor senior e-commerce para ${cm[country] || 'Latinoamérica'}.
PRODUCTO: ${product.name}, ${product.description}, ${product.price}, ${product.url}
TEXTO: ${(product.bodyText || '').slice(0, 800)}
${cs}
TONO: ${tm[tone] || 'profesional'}
Solo JSON puro sin markdown:
{"resumen_ejecutivo":"3-4 oraciones","scores":{"conversion":72,"confianza":65,"seo":58,"conversion_explicacion":"2 oraciones","confianza_explicacion":"2 oraciones","seo_explicacion":"2 oraciones"},${cj}"fortalezas":["f1","f2","f3","f4"],"debilidades":["d1","d2","d3","d4"],"mejoras_recomendadas":[{"titulo":"titulo","descripcion":"descripcion","impacto":"ALTO"},{"titulo":"titulo","descripcion":"descripcion","impacto":"ALTO"},{"titulo":"titulo","descripcion":"descripcion","impacto":"MEDIO"},{"titulo":"titulo","descripcion":"descripcion","impacto":"MEDIO"},{"titulo":"titulo","descripcion":"descripcion","impacto":"BAJO"}],"descripcion_optimizada":{"titulo_seo":"60-80 chars","descripcion_corta":"160 chars max","descripcion_larga":"300-400 palabras completas","bullet_points":["b1","b2","b3","b4","b5"]},"meta_ads":[{"nombre":"Ad 1 Beneficio","headline":"max 40 chars","texto_principal":"150-200 palabras","descripcion":"max 90 chars","objetivo":"Conversión"},{"nombre":"Ad 2 Problema","headline":"titular","texto_principal":"texto","descripcion":"desc","objetivo":"Conversión"},{"nombre":"Ad 3 Social","headline":"titular","texto_principal":"texto","descripcion":"desc","objetivo":"Reconocimiento"},{"nombre":"Ad 4 Urgencia","headline":"titular","texto_principal":"texto","descripcion":"desc","objetivo":"Conversión"},{"nombre":"Ad 5 Retargeting","headline":"titular","texto_principal":"texto","descripcion":"desc","objetivo":"Retargeting"}],"instagram_posts":[{"tipo":"Post educativo","caption":"150-200 palabras con hashtags","hook":"primera linea gancho"},{"tipo":"Post producto","caption":"caption completo","hook":"gancho"},{"tipo":"Historia exito","caption":"caption completo","hook":"gancho"}],"plan_accion":[{"prioridad":1,"plazo":"Esta semana","accion":"accion concreta","impacto_esperado":"resultado"},{"prioridad":2,"plazo":"Esta semana","accion":"accion","impacto_esperado":"resultado"},{"prioridad":3,"plazo":"Proximas 2 semanas","accion":"accion","impacto_esperado":"resultado"},{"prioridad":4,"plazo":"Proximas 2 semanas","accion":"accion","impacto_esperado":"resultado"},{"prioridad":5,"plazo":"Proximo mes","accion":"accion","impacto_esperado":"resultado"}],"preguntas_frecuentes":[{"pregunta":"pregunta 1","respuesta":"respuesta 1"},{"pregunta":"pregunta 2","respuesta":"respuesta 2"},{"pregunta":"pregunta 3","respuesta":"respuesta 3"},{"pregunta":"pregunta 4","respuesta":"respuesta 4"}],"estrategia_precio":"2-3 oraciones sobre precio","keywords_seo":["k1","k2","k3","k4","k5","k6","k7","k8"]}`;

  const r = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 5000 });
  return JSON.parse(r.choices[0].message.content.trim().replace(/```json|```/g, '').trim());
}

// ── EMAIL ─────────────────────────────────────────────────────
async function sendMagicLink(email, token) {
  const link = `${APP_URL}/api/auth/verify?token=${token}`;
  await resend.emails.send({
    from: 'Vendly <onboarding@resend.dev>',
    to: email,
    subject: 'Tu link de acceso a Vendly',
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#07070E;color:#F0EEF8;border-radius:16px;">
      <div style="font-size:22px;font-weight:800;margin-bottom:8px;">Vend<span style="color:#A688FA">ly</span></div>
      <h2 style="font-size:20px;margin-bottom:12px;color:#F0EEF8;">Tu link de acceso</h2>
      <p style="color:#8B89A0;margin-bottom:24px;line-height:1.6;">Hacé click para ingresar. Expira en 10 minutos.</p>
      <a href="${link}" style="display:inline-block;background:#7C5CFC;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:500;">Ingresar a Vendly →</a>
      <p style="color:#555;font-size:11px;margin-top:20px;">O copiá: ${link}</p>
    </div>`
  });
}

// ── ROUTES ────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/informe/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Auth
app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email inválido' });
  try {
    dbRun('DELETE FROM magic_tokens WHERE expires_at < datetime("now")');
    const existing = dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!existing) {
      // Rate limit: max 3 cuentas nuevas por IP
      const regIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      const ipCount = dbGet('SELECT count FROM ip_usage WHERE ip = ?', [regIp]);
      if (ipCount && ipCount.count >= 3) {
        return res.status(429).json({ error: 'Límite de registros por dispositivo alcanzado.' });
      }
      dbRun('INSERT INTO users (email) VALUES (?)', [email.toLowerCase()]);
      dbRun('INSERT INTO ip_usage (ip, count) VALUES (?, 1) ON CONFLICT(ip) DO UPDATE SET count = count + 1', [regIp]);
    }
    const token = crypto.randomBytes(32).toString('hex');
    const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    dbRun('INSERT INTO magic_tokens (email, token, expires_at) VALUES (?, ?, ?)', [email.toLowerCase(), token, exp]);
    await sendMagicLink(email.toLowerCase(), token);
    res.json({ success: true, message: 'Link enviado. Revisá tu email.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error enviando el email. Intentá de nuevo.' });
  }
});

app.get('/api/auth/verify', (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/app?error=invalid');
  const rec = dbGet('SELECT * FROM magic_tokens WHERE token = ? AND used = 0 AND expires_at > datetime("now")', [token]);
  if (!rec) return res.redirect('/app?error=expired');
  dbRun('UPDATE magic_tokens SET used = 1 WHERE token = ?', [token]);
  const user = dbGet('SELECT * FROM users WHERE email = ?', [rec.email]);
  if (!user) return res.redirect('/app?error=notfound');
  const session = makeJWT(user.id, user.email, user.plan);
  res.redirect(`/app?session=${session}`);
});

app.get('/api/session', optAuth, (req, res) => {
  if (!req.user) return res.json({ authenticated: false });
  res.json({ authenticated: true, email: req.user.email, plan: req.user.plan, status: req.user.status, auditsUsed: req.user.audits_used, auditsLimit: req.user.audits_limit });
});

// Scrape
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requerida' });
  try { res.json({ success: true, product: await scrape(url) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Audit
app.post('/api/audit', optAuth, async (req, res) => {
  const { product, country, tone, competitorProduct } = req.body;
  if (!product || !product.name) return res.status(400).json({ error: 'Datos requeridos' });

  if (req.user) {
    const u = req.user;
    if (u.status !== 'active') return res.status(403).json({ error: 'Suscripción inactiva', upgrade: true });
    if (u.plan !== 'pro' && u.plan !== 'agency' && u.audits_used >= u.audits_limit)
      return res.status(403).json({ error: 'Límite alcanzado', upgrade: true });
    try {
      const a = await generateAudit(product, country || 'general', tone || 'profesional', competitorProduct || null);
      dbRun('UPDATE users SET audits_used = audits_used + 1, updated_at = datetime("now") WHERE id = ?', [u.id]);
      dbRun('INSERT INTO audits (user_id, product_name, product_url, score_conversion, score_confianza, score_seo, audit_data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [u.id, product.name || product.url, product.url || '', a.scores.conversion, a.scores.confianza, a.scores.seo, JSON.stringify(a)]);
      const updated = dbGet('SELECT * FROM users WHERE id = ?', [u.id]);
      res.json({ success: true, audit: a, plan: u.plan, auditsUsed: updated.audits_used, auditsLimit: updated.audits_limit });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error generando auditoría.' }); }
  } else {
    // Sin cuenta — pedir que se registren
    return res.status(403).json({
      error: 'Necesitás crear una cuenta gratuita para usar Vendly. Es rápido y sin tarjeta.',
      requireAuth: true
    });
  }
});

// Audit history
app.get('/api/audits', requireAuth, (req, res) => {
  const audits = dbAll('SELECT id, product_name, product_url, score_conversion, score_confianza, score_seo, created_at FROM audits WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ success: true, audits });
});

app.get('/api/audits/:id', requireAuth, (req, res) => {
  const a = dbGet('SELECT * FROM audits WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!a) return res.status(404).json({ error: 'No encontrado' });
  res.json({ success: true, audit: { ...a, audit_data: JSON.parse(a.audit_data) } });
});

// Payments — Stripe
app.post('/api/checkout', optAuth, async (req, res) => {
  const { plan } = req.body;
  const email = req.user?.email || req.body.email;
  const priceId = plan === 'pro' ? STRIPE_PRO_PRICE : STRIPE_STARTER_PRICE;
  if (!priceId) return res.status(500).json({ error: 'Pagos no configurados aún.' });
  try {
    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/app?subscribed=true`,
      cancel_url: `${APP_URL}/app?cancelled=true`,
      metadata: { plan: plan || 'basic', email: email || '' }
    };
    if (email) sessionParams.customer_email = email;
    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e.message);
    res.status(500).json({ error: 'Error creando sesión de pago.' });
  }
});

// Stripe Customer Portal
app.get('/api/portal', requireAuth, async (req, res) => {
  const user = req.user;
  if (!user.stripe_customer_id) return res.status(400).json({ error: 'No tenés suscripción activa.' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${APP_URL}/app`
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe portal error:', e.message);
    res.status(500).json({ error: 'Error abriendo portal.' });
  }
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

// Stripe Webhook
app.post('/api/webhook', async (req, res) => {
  let event;
  try {
    event = STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body.toString());
  } catch (e) {
    console.error('Webhook signature error:', e.message);
    return res.status(400).send(`Webhook error: ${e.message}`);
  }

  const { type, data } = event;
  console.log('Stripe event:', type);

  try {
    if (type === 'checkout.session.completed') {
      const session = data.object;
      const email = (session.customer_details?.email || session.metadata?.email || '').toLowerCase();
      const plan = session.metadata?.plan || 'basic';
      const customerId = session.customer;
      const subscriptionId = session.subscription;
      if (email) {
        const limit = plan === 'pro' ? 999999 : 30;
        const existing = dbGet('SELECT id FROM users WHERE email = ?', [email]);
        if (!existing) dbRun('INSERT INTO users (email) VALUES (?)', [email]);
        dbRun('UPDATE users SET plan=?, status=?, audits_limit=?, subscription_id=?, stripe_customer_id=?, updated_at=datetime("now") WHERE email=?',
          [plan, 'active', limit, subscriptionId, customerId, email]);
        console.log(`Activated ${plan} for ${email}`);
      }
    } else if (type === 'customer.subscription.updated') {
      const sub = data.object;
      const customerId = sub.customer;
      const status = sub.status;
      if (['active', 'trialing'].includes(status)) {
        dbRun('UPDATE users SET status=?, updated_at=datetime("now") WHERE stripe_customer_id=?', ['active', customerId]);
      } else if (['canceled', 'unpaid', 'past_due'].includes(status)) {
        dbRun('UPDATE users SET status=?, plan=?, audits_limit=1, updated_at=datetime("now") WHERE stripe_customer_id=?', ['cancelled', 'free', customerId]);
      }
    } else if (type === 'customer.subscription.deleted') {
      const sub = data.object;
      dbRun('UPDATE users SET status=?, plan=?, audits_limit=1, updated_at=datetime("now") WHERE stripe_customer_id=?',
        ['cancelled', 'free', sub.customer]);
    }
  } catch (e) {
    console.error('Webhook processing error:', e.message);
  }

  res.json({ received: true });
});

// Share
const shared = new Map();
app.post('/api/share', (req, res) => {
  const { audit, product } = req.body;
  if (!audit) return res.status(400).json({ error: 'Datos requeridos' });
  const token = crypto.randomBytes(16).toString('hex');
  shared.set(token, { audit, product, createdAt: new Date() });
  for (const [k, v] of shared) { if (Date.now() - new Date(v.createdAt) > 7 * 24 * 60 * 60 * 1000) shared.delete(k); }
  res.json({ success: true, token, url: `/informe/${token}` });
});

app.get('/api/report/:token', (req, res) => {
  const r = shared.get(req.params.token);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  res.json({ success: true, ...r });
});

app.get('/api/stats', (req, res) => {
  const total = dbGet('SELECT COUNT(*) as total FROM audits');
  res.json({ totalAudits: total ? total.total : 0 });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '6.0.0' }));

// Start
initDb().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Vendly v6 en puerto ${PORT}`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
