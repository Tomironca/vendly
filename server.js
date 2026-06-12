require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

const app = express();
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// ── Config ────────────────────────────────────────────────────
const LS_API_KEY = process.env.LEMONSQUEEZY_API_KEY;
const LS_BASIC_VARIANT = process.env.LEMONSQUEEZY_BASIC_VARIANT_ID || '1776746';
const LS_PRO_VARIANT = process.env.LEMONSQUEEZY_PRO_VARIANT_ID || '1776774';
const LS_STORE_URL = process.env.LEMONSQUEEZY_STORE_URL || 'https://vendly-app.lemonsqueezy.com';
const WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';
const APP_URL = process.env.APP_URL || 'https://vendly-production-e0f2.up.railway.app';

// ── SQLite Database ───────────────────────────────────────────
const db = new Database('./vendly.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    plan TEXT DEFAULT 'free',
    status TEXT DEFAULT 'active',
    audits_used INTEGER DEFAULT 0,
    audits_limit INTEGER DEFAULT 1,
    subscription_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS magic_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    token TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    product_name TEXT,
    product_url TEXT,
    score_conversion INTEGER,
    score_confianza INTEGER,
    score_seo INTEGER,
    audit_data TEXT,
    share_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS ip_usage (
    ip TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Cleanup expired tokens every hour
setInterval(() => {
  db.prepare("DELETE FROM magic_tokens WHERE expires_at < datetime('now') OR used = 1").run();
}, 60 * 60 * 1000);

// ── DB helpers ────────────────────────────────────────────────
function getUser(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
}

function upsertUser(email, data = {}) {
  const existing = getUser(email);
  if (existing) {
    const fields = Object.keys(data).map(k => `${k} = ?`).join(', ');
    if (fields) {
      db.prepare(`UPDATE users SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE email = ?`)
        .run(...Object.values(data), email.toLowerCase());
    }
    return getUser(email);
  } else {
    db.prepare(`INSERT INTO users (email, plan, status, audits_used, audits_limit) VALUES (?, ?, ?, ?, ?)`)
      .run(email.toLowerCase(), data.plan || 'free', data.status || 'active', 0, data.audits_limit || 1);
    return getUser(email);
  }
}

function createMagicToken(email) {
  const token = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM magic_tokens WHERE email = ?').run(email.toLowerCase());
  db.prepare('INSERT INTO magic_tokens (email, token, expires_at) VALUES (?, ?, ?)')
    .run(email.toLowerCase(), token, expires);
  return token;
}

function verifyMagicToken(email, token) {
  const row = db.prepare(
    "SELECT * FROM magic_tokens WHERE email = ? AND token = ? AND expires_at > datetime('now') AND used = 0"
  ).get(email.toLowerCase(), token);
  if (row) {
    db.prepare('UPDATE magic_tokens SET used = 1 WHERE id = ?').run(row.id);
    return true;
  }
  return false;
}

function createJWT(email) {
  return jwt.sign({ email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyJWT(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch (e) { return null; }
}

function saveAuditHistory(userId, productName, productUrl, audit, shareToken) {
  db.prepare(`
    INSERT INTO audit_history (user_id, product_name, product_url, score_conversion, score_confianza, score_seo, audit_data, share_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    productName || 'Producto sin nombre',
    productUrl || '',
    audit.scores?.conversion || 0,
    audit.scores?.confianza || 0,
    audit.scores?.seo || 0,
    JSON.stringify(audit),
    shareToken || null
  );
}

function getAuditHistory(userId, limit = 20) {
  return db.prepare(
    'SELECT id, product_name, product_url, score_conversion, score_confianza, score_seo, share_token, created_at FROM audit_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(userId, limit);
}

// ── Scraper ───────────────────────────────────────────────────
async function scrapeProduct(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Vendly/6.0)' }
    });
    const $ = cheerio.load(data);
    const name = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || $('title').text().trim() || '';
    const description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || $('[class*="description"]').first().text().trim().slice(0, 800) || '';
    const price = $('[class*="price"]').first().text().trim() || $('[itemprop="price"]').attr('content') || '';
    const image = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '';
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2000);
    return { name, description, price, image, url, bodyText };
  } catch (e) {
    throw new Error('No se pudo leer la URL. Verificá que sea pública y accesible.');
  }
}

// ── Audit generator ───────────────────────────────────────────
async function generateAudit(product, country, tone, competitorProduct) {
  const countryMap = { argentina: 'Argentina (voseo)', mexico: 'México', colombia: 'Colombia', espana: 'España', general: 'Latinoamérica' };
  const toneMap = { profesional: 'profesional y confiable', casual: 'casual y cercano', divertido: 'divertido y energético', urgente: 'urgente y persuasivo' };
  const competitorSection = competitorProduct ? `COMPETIDOR: Nombre: ${competitorProduct.name}, Descripción: ${competitorProduct.description}, Precio: ${competitorProduct.price}` : '';
  const competitorJson = competitorProduct
    ? `"analisis_competidor":{"ventajas_vs_competidor":["v1","v2","v3"],"desventajas_vs_competidor":["d1","d2"],"oportunidades":["o1","o2","o3"],"conclusion":"conclusión 2-3 oraciones"},`
    : '"analisis_competidor":null,';

  const prompt = `Sos consultor senior de e-commerce para ${countryMap[country] || 'Latinoamérica'}.
PRODUCTO: Nombre: ${product.name}, Descripción: ${product.description}, Precio: ${product.price}, URL: ${product.url}
Texto página: ${(product.bodyText || '').slice(0, 800)}
${competitorSection}
TONO: ${toneMap[tone] || 'profesional'}
Respondé SOLO JSON puro sin markdown:
{"resumen_ejecutivo":"3-4 oraciones","scores":{"conversion":72,"confianza":65,"seo":58,"conversion_explicacion":"2 oraciones","confianza_explicacion":"2 oraciones","seo_explicacion":"2 oraciones"},${competitorJson}"fortalezas":["f1","f2","f3","f4"],"debilidades":["d1","d2","d3","d4"],"mejoras_recomendadas":[{"titulo":"t","descripcion":"d","impacto":"ALTO"},{"titulo":"t","descripcion":"d","impacto":"ALTO"},{"titulo":"t","descripcion":"d","impacto":"MEDIO"},{"titulo":"t","descripcion":"d","impacto":"MEDIO"},{"titulo":"t","descripcion":"d","impacto":"BAJO"}],"descripcion_optimizada":{"titulo_seo":"60-80 chars","descripcion_corta":"160 chars","descripcion_larga":"300-400 palabras","bullet_points":["b1","b2","b3","b4","b5"]},"meta_ads":[{"nombre":"Ad 1","headline":"40 chars","texto_principal":"150-200 palabras","descripcion":"90 chars","objetivo":"Conversión"},{"nombre":"Ad 2","headline":"h","texto_principal":"t","descripcion":"d","objetivo":"Conversión"},{"nombre":"Ad 3","headline":"h","texto_principal":"t","descripcion":"d","objetivo":"Reconocimiento"},{"nombre":"Ad 4","headline":"h","texto_principal":"t","descripcion":"d","objetivo":"Conversión"},{"nombre":"Ad 5","headline":"h","texto_principal":"t","descripcion":"d","objetivo":"Retargeting"}],"instagram_posts":[{"tipo":"Post educativo","caption":"150-200 palabras con hashtags","hook":"primera línea"},{"tipo":"Post producto","caption":"caption","hook":"hook"},{"tipo":"Historia éxito","caption":"caption","hook":"hook"}],"plan_accion":[{"prioridad":1,"plazo":"Esta semana","accion":"acción","impacto_esperado":"resultado"},{"prioridad":2,"plazo":"Esta semana","accion":"acción","impacto_esperado":"resultado"},{"prioridad":3,"plazo":"Próximas 2 semanas","accion":"acción","impacto_esperado":"resultado"},{"prioridad":4,"plazo":"Próximas 2 semanas","accion":"acción","impacto_esperado":"resultado"},{"prioridad":5,"plazo":"Próximo mes","accion":"acción","impacto_esperado":"resultado"}],"preguntas_frecuentes":[{"pregunta":"p1","respuesta":"r1"},{"pregunta":"p2","respuesta":"r2"},{"pregunta":"p3","respuesta":"r3"},{"pregunta":"p4","respuesta":"r4"}],"estrategia_precio":"2-3 oraciones","keywords_seo":["k1","k2","k3","k4","k5","k6","k7","k8"]}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 5000
  });
  const raw = completion.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ── AUTH ROUTES ───────────────────────────────────────────────

// Send magic link
app.post('/api/auth/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email inválido' });

  try {
    const code = createMagicToken(email);
    upsertUser(email);

    await resend.emails.send({
      from: 'Vendly <onboarding@resend.dev>',
      to: email,
      subject: `${code} es tu código de acceso a Vendly`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #07070E; color: #F0EEF8; border-radius: 16px;">
          <div style="margin-bottom: 24px;">
            <span style="font-size: 20px; font-weight: 800; color: #F0EEF8;">Vend<span style="color: #A688FA;">ly</span></span>
          </div>
          <h1 style="font-size: 28px; font-weight: 800; margin-bottom: 8px; letter-spacing: -1px;">Tu código de acceso</h1>
          <p style="color: #8B89A0; margin-bottom: 28px; font-size: 15px;">Ingresá este código en Vendly para acceder a tu cuenta.</p>
          <div style="background: #16161F; border: 1px solid rgba(124,92,252,0.3); border-radius: 14px; padding: 24px; text-align: center; margin-bottom: 28px;">
            <div style="font-size: 48px; font-weight: 800; letter-spacing: 12px; color: #A688FA;">${code}</div>
            <div style="font-size: 13px; color: #8B89A0; margin-top: 8px;">Válido por 10 minutos</div>
          </div>
          <p style="color: #8B89A0; font-size: 13px;">Si no pediste este código, ignorá este email.</p>
          <div style="margin-top: 32px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.06);">
            <p style="color: #8B89A0; font-size: 12px;">Vendly — Auditorías de e-commerce con IA para LATAM</p>
          </div>
        </div>
      `
    });

    res.json({ success: true, message: 'Código enviado. Revisá tu email.' });
  } catch (e) {
    console.error('Send code error:', e);
    res.status(500).json({ error: 'Error enviando el código. Intentá de nuevo.' });
  }
});

// Verify code
app.post('/api/auth/verify-code', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email y código requeridos' });

  const valid = verifyMagicToken(email, code);
  if (!valid) return res.status(401).json({ error: 'Código inválido o expirado. Pedí uno nuevo.' });

  const user = upsertUser(email);
  const token = createJWT(email);
  res.json({ success: true, token, user: { email: user.email, plan: user.plan, auditsUsed: user.audits_used, auditsLimit: user.audits_limit } });
});

// Get session
app.get('/api/session', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.replace('Bearer ', '') || req.headers['x-session-token'];
  const payload = verifyJWT(token);
  if (!payload) return res.json({ authenticated: false });

  const user = getUser(payload.email);
  if (!user) return res.json({ authenticated: false });

  res.json({
    authenticated: true,
    email: user.email,
    plan: user.plan,
    status: user.status,
    auditsUsed: user.audits_used,
    auditsLimit: user.audits_limit
  });
});

// Logout
app.post('/api/auth/logout', (req, res) => res.json({ success: true }));

// Get audit history
app.get('/api/history', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.replace('Bearer ', '') || req.headers['x-session-token'];
  const payload = verifyJWT(token);
  if (!payload) return res.status(401).json({ error: 'No autenticado' });

  const user = getUser(payload.email);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  const history = getAuditHistory(user.id);
  res.json({ success: true, history });
});

// Get single audit from history
app.get('/api/history/:id', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.replace('Bearer ', '') || req.headers['x-session-token'];
  const payload = verifyJWT(token);
  if (!payload) return res.status(401).json({ error: 'No autenticado' });

  const user = getUser(payload.email);
  const audit = db.prepare('SELECT * FROM audit_history WHERE id = ? AND user_id = ?').get(req.params.id, user?.id);
  if (!audit) return res.status(404).json({ error: 'Auditoría no encontrada' });

  res.json({ success: true, audit: { ...audit, audit_data: JSON.parse(audit.audit_data) } });
});

// ── MAIN ROUTES ───────────────────────────────────────────────

app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requerida' });
  try { res.json({ success: true, product: await scrapeProduct(url) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/audit', async (req, res) => {
  const { product, country, tone, competitorProduct } = req.body;
  if (!product || !product.name) return res.status(400).json({ error: 'Datos del producto requeridos' });

  const authHeader = req.headers['authorization'];
  const token = authHeader?.replace('Bearer ', '') || req.headers['x-session-token'];
  const payload = verifyJWT(token);

  if (payload) {
    const user = getUser(payload.email);
    if (!user || user.status !== 'active') return res.status(403).json({ error: 'Tu cuenta no está activa.', upgrade: true });
    if (user.plan !== 'pro' && user.plan !== 'agency' && user.audits_used >= user.audits_limit) {
      return res.status(403).json({ error: `Alcanzaste el límite de auditorías de tu plan.`, upgrade: true });
    }

    try {
      const audit = await generateAudit(product, country || 'general', tone || 'profesional', competitorProduct || null);
      const shareToken = crypto.randomBytes(12).toString('hex');
      saveAuditHistory(user.id, product.name, product.url, audit, shareToken);
      db.prepare('UPDATE users SET audits_used = audits_used + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
      const updatedUser = getUser(payload.email);
      res.json({ success: true, audit, plan: user.plan, auditsUsed: updatedUser.audits_used, auditsLimit: updatedUser.audits_limit, shareToken });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Error generando la auditoría.' });
    }
  } else {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const row = db.prepare('SELECT count FROM ip_usage WHERE ip = ?').get(ip);
    const count = row?.count || 0;
    if (count >= 1) return res.status(403).json({ error: 'Creá una cuenta gratis para continuar.', upgrade: true, remaining: 0 });

    try {
      const audit = await generateAudit(product, country || 'general', tone || 'profesional', competitorProduct || null);
      db.prepare('INSERT OR REPLACE INTO ip_usage (ip, count, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(ip, count + 1);
      res.json({ success: true, audit, remaining: 0, plan: 'free' });
    } catch (e) {
      res.status(500).json({ error: 'Error generando la auditoría.' });
    }
  }
});

app.get('/api/checkout', (req, res) => {
  const { plan, email } = req.query;
  const variantId = plan === 'pro' ? LS_PRO_VARIANT : LS_BASIC_VARIANT;
  const checkoutUrl = `${LS_STORE_URL}/checkout/buy/${variantId}${email ? `?checkout[email]=${encodeURIComponent(email)}` : ''}`;
  res.json({ url: checkoutUrl });
});

app.post('/api/verify-subscription', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  try {
    const response = await axios.get('https://api.lemonsqueezy.com/v1/subscriptions', {
      headers: { 'Authorization': `Bearer ${LS_API_KEY}`, 'Accept': 'application/vnd.api+json' },
      params: { 'filter[user_email]': email.toLowerCase() }
    });
    const subscriptions = response.data?.data || [];
    const active = subscriptions.find(s => s.attributes.status === 'active' || s.attributes.status === 'on_trial');
    if (!active) return res.status(404).json({ error: 'No encontramos una suscripción activa para ese email.' });

    const variantId = String(active.attributes.variant_id);
    const plan = variantId === String(LS_PRO_VARIANT) ? 'pro' : 'basic';
    const auditsLimit = plan === 'pro' ? 999999 : 30;

    upsertUser(email, { plan, status: 'active', subscription_id: active.id, audits_limit: auditsLimit });
    const token = createJWT(email);
    res.json({ success: true, token, plan, auditsLimit });
  } catch (e) {
    console.error('Verify error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Error verificando la suscripción.' });
  }
});

app.post('/api/webhook', (req, res) => {
  try {
    const rawBody = req.body;
    const signature = req.headers['x-signature'];
    if (WEBHOOK_SECRET && signature) {
      const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
      hmac.update(rawBody);
      if (hmac.digest('hex') !== signature) return res.status(401).json({ error: 'Invalid signature' });
    }
    const event = JSON.parse(rawBody.toString());
    const eventName = event.meta?.event_name;
    const attrs = event.data?.attributes;
    const email = attrs?.user_email?.toLowerCase();
    if (!email) return res.status(200).json({ received: true });

    const variantId = String(attrs?.variant_id);
    const plan = variantId === String(LS_PRO_VARIANT) ? 'pro' : 'basic';
    const auditsLimit = plan === 'pro' ? 999999 : 30;

    if (eventName === 'subscription_created' || eventName === 'subscription_resumed') {
      upsertUser(email, { plan, status: 'active', subscription_id: event.data?.id, audits_limit: auditsLimit });
    } else if (eventName === 'subscription_cancelled' || eventName === 'subscription_expired') {
      const user = getUser(email);
      if (user) db.prepare("UPDATE users SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE email = ?").run(email);
    } else if (eventName === 'subscription_updated') {
      upsertUser(email, { plan, audits_limit: auditsLimit, status: attrs?.status === 'active' ? 'active' : 'inactive' });
    }
    res.status(200).json({ received: true });
  } catch (e) { res.status(200).json({ received: true }); }
});

app.post('/api/share', (req, res) => {
  const { audit, product, shareToken } = req.body;
  if (!audit) return res.status(400).json({ error: 'Datos requeridos' });

  const token = shareToken || crypto.randomBytes(12).toString('hex');
  const existing = db.prepare('SELECT id FROM audit_history WHERE share_token = ?').get(token);

  if (!existing) {
    db.prepare('INSERT INTO audit_history (product_name, product_url, score_conversion, score_confianza, score_seo, audit_data, share_token) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(product?.name || '', product?.url || '', audit.scores?.conversion || 0, audit.scores?.confianza || 0, audit.scores?.seo || 0, JSON.stringify(audit), token);
  }

  res.json({ success: true, token, url: `/informe/${token}` });
});

app.get('/api/report/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM audit_history WHERE share_token = ?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Informe no encontrado o expirado' });
  res.json({ success: true, audit: JSON.parse(row.audit_data), product: { name: row.product_name, url: row.product_url } });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '6.0.0', db: 'sqlite' }));

// ── PAGES ─────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/informe/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vendly v6 corriendo en puerto ${PORT}`));
