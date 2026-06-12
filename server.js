require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const crypto = require('crypto');

const app = express();

app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LS_API_KEY = process.env.LEMONSQUEEZY_API_KEY;
const LS_BASIC_VARIANT = process.env.LEMONSQUEEZY_BASIC_VARIANT_ID || '1776746';
const LS_PRO_VARIANT = process.env.LEMONSQUEEZY_PRO_VARIANT_ID || '1776774';
const LS_STORE_URL = process.env.LEMONSQUEEZY_STORE_URL || 'https://vendly-app.lemonsqueezy.com';
const WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';

// ── In-memory stores ──────────────────────────────────────────
const subscribers = new Map();
const sessions = new Map();
const sharedReports = new Map();
const ipUsage = new Map();

function getSubscriber(email) { return subscribers.get(email?.toLowerCase()); }
function setSubscriber(email, data) { subscribers.set(email.toLowerCase(), data); }

function createSession(email) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { email: email.toLowerCase(), createdAt: new Date(), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (new Date() > new Date(s.expiresAt)) { sessions.delete(token); return null; }
  return s;
}

// ── Scraper ───────────────────────────────────────────────────
async function scrapeProduct(url) {
  try {
    const { data } = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Vendly/5.0)' } });
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
  const competitorJson = competitorProduct ? `"analisis_competidor":{"ventajas_vs_competidor":["v1","v2","v3"],"desventajas_vs_competidor":["d1","d2"],"oportunidades":["o1","o2","o3"],"conclusion":"conclusión 2-3 oraciones"},` : '"analisis_competidor":null,';

  const prompt = `Sos consultor senior de e-commerce para ${countryMap[country] || 'Latinoamérica'}.
PRODUCTO: Nombre: ${product.name}, Descripción: ${product.description}, Precio: ${product.price}, URL: ${product.url}
Texto página: ${(product.bodyText || '').slice(0, 800)}
${competitorSection}
TONO: ${toneMap[tone] || 'profesional'}
Respondé SOLO JSON puro sin markdown:
{"resumen_ejecutivo":"3-4 oraciones","scores":{"conversion":72,"confianza":65,"seo":58,"conversion_explicacion":"2 oraciones","confianza_explicacion":"2 oraciones","seo_explicacion":"2 oraciones"},${competitorJson}"fortalezas":["f1","f2","f3","f4"],"debilidades":["d1","d2","d3","d4"],"mejoras_recomendadas":[{"titulo":"t","descripcion":"d","impacto":"ALTO"},{"titulo":"t","descripcion":"d","impacto":"ALTO"},{"titulo":"t","descripcion":"d","impacto":"MEDIO"},{"titulo":"t","descripcion":"d","impacto":"MEDIO"},{"titulo":"t","descripcion":"d","impacto":"BAJO"}],"descripcion_optimizada":{"titulo_seo":"60-80 chars","descripcion_corta":"160 chars","descripcion_larga":"300-400 palabras","bullet_points":["b1","b2","b3","b4","b5"]},"meta_ads":[{"nombre":"Ad 1","headline":"40 chars","texto_principal":"150-200 palabras","descripcion":"90 chars","objetivo":"Conversión"},{"nombre":"Ad 2","headline":"h","texto_principal":"t","descripcion":"d","objetivo":"Conversión"},{"nombre":"Ad 3","headline":"h","texto_principal":"t","descripcion":"d","objetivo":"Reconocimiento"},{"nombre":"Ad 4","headline":"h","texto_principal":"t","descripcion":"d","objetivo":"Conversión"},{"nombre":"Ad 5","headline":"h","texto_principal":"t","descripcion":"d","objetivo":"Retargeting"}],"instagram_posts":[{"tipo":"Post educativo","caption":"150-200 palabras con hashtags","hook":"primera línea"},{"tipo":"Post producto","caption":"caption","hook":"hook"},{"tipo":"Historia éxito","caption":"caption","hook":"hook"}],"plan_accion":[{"prioridad":1,"plazo":"Esta semana","accion":"acción","impacto_esperado":"resultado"},{"prioridad":2,"plazo":"Esta semana","accion":"acción","impacto_esperado":"resultado"},{"prioridad":3,"plazo":"Próximas 2 semanas","accion":"acción","impacto_esperado":"resultado"},{"prioridad":4,"plazo":"Próximas 2 semanas","accion":"acción","impacto_esperado":"resultado"},{"prioridad":5,"plazo":"Próximo mes","accion":"acción","impacto_esperado":"resultado"}],"preguntas_frecuentes":[{"pregunta":"p1","respuesta":"r1"},{"pregunta":"p2","respuesta":"r2"},{"pregunta":"p3","respuesta":"r3"},{"pregunta":"p4","respuesta":"r4"}],"estrategia_precio":"2-3 oraciones","keywords_seo":["k1","k2","k3","k4","k5","k6","k7","k8"]}`;

  const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 5000 });
  const raw = completion.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ── ROUTES ────────────────────────────────────────────────────

// Landing page at root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));

// App at /app
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Shared reports
app.get('/informe/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requerida' });
  try { res.json({ success: true, product: await scrapeProduct(url) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/session', (req, res) => {
  const token = req.headers['x-session-token'];
  const session = getSession(token);
  if (!session) return res.json({ authenticated: false });
  const sub = getSubscriber(session.email);
  res.json({ authenticated: true, email: session.email, plan: sub?.plan || 'free', status: sub?.status || 'active', auditsUsed: sub?.auditsUsed || 0, auditsLimit: sub?.auditsLimit || 20 });
});

app.post('/api/audit', async (req, res) => {
  const { product, country, tone, competitorProduct } = req.body;
  if (!product || !product.name) return res.status(400).json({ error: 'Datos del producto requeridos' });
  const token = req.headers['x-session-token'];
  const session = getSession(token);
  if (session) {
    const sub = getSubscriber(session.email);
    if (!sub || sub.status !== 'active') return res.status(403).json({ error: 'Tu suscripción no está activa.', upgrade: true });
    if (sub.plan === 'basic' && sub.auditsUsed >= sub.auditsLimit) return res.status(403).json({ error: `Límite de ${sub.auditsLimit} auditorías alcanzado.`, upgrade: true });
    try {
      const audit = await generateAudit(product, country || 'general', tone || 'profesional', competitorProduct || null);
      sub.auditsUsed = (sub.auditsUsed || 0) + 1;
      setSubscriber(session.email, sub);
      res.json({ success: true, audit, plan: sub.plan, auditsUsed: sub.auditsUsed, auditsLimit: sub.auditsLimit });
    } catch (e) { res.status(500).json({ error: 'Error generando la auditoría.' }); }
  } else {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const usage = ipUsage.get(ip) || 0;
    if (usage >= 1) return res.status(403).json({ error: 'Agotaste tu auditoría gratuita.', upgrade: true, remaining: 0 });
    try {
      const audit = await generateAudit(product, country || 'general', tone || 'profesional', competitorProduct || null);
      ipUsage.set(ip, usage + 1);
      res.json({ success: true, audit, remaining: 0, plan: 'free' });
    } catch (e) { res.status(500).json({ error: 'Error generando la auditoría.' }); }
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
    if (!active) return res.status(404).json({ error: 'No encontramos una suscripción activa para ese email. Si acabás de pagar, esperá unos segundos e intentá de nuevo.' });
    const variantId = String(active.attributes.variant_id);
    const plan = variantId === String(LS_PRO_VARIANT) ? 'pro' : 'basic';
    const auditsLimit = plan === 'pro' ? 999999 : 30;
    const existing = getSubscriber(email);
    setSubscriber(email, { plan, status: 'active', subscriptionId: active.id, auditsUsed: existing?.auditsUsed || 0, auditsLimit });
    const sessionToken = createSession(email);
    res.json({ success: true, sessionToken, plan, auditsLimit });
  } catch (e) {
    console.error('Verify error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Error verificando la suscripción. Intentá de nuevo.' });
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
      const existing = getSubscriber(email);
      setSubscriber(email, { plan, status: 'active', subscriptionId: event.data?.id, auditsUsed: existing?.auditsUsed || 0, auditsLimit });
    } else if (eventName === 'subscription_cancelled' || eventName === 'subscription_expired') {
      const existing = getSubscriber(email);
      if (existing) setSubscriber(email, { ...existing, status: 'cancelled' });
    } else if (eventName === 'subscription_updated') {
      const existing = getSubscriber(email);
      if (existing) setSubscriber(email, { ...existing, plan, auditsLimit, status: attrs?.status === 'active' ? 'active' : existing.status });
    }
    res.status(200).json({ received: true });
  } catch (e) { res.status(200).json({ received: true }); }
});

app.post('/api/share', async (req, res) => {
  const { audit, product } = req.body;
  if (!audit) return res.status(400).json({ error: 'Datos requeridos' });
  const token = crypto.randomBytes(16).toString('hex');
  sharedReports.set(token, { audit, product, createdAt: new Date() });
  for (const [k, v] of sharedReports) {
    if (Date.now() - new Date(v.createdAt) > 7 * 24 * 60 * 60 * 1000) sharedReports.delete(k);
  }
  res.json({ success: true, token, url: `/informe/${token}` });
});

app.get('/api/report/:token', (req, res) => {
  const report = sharedReports.get(req.params.token);
  if (!report) return res.status(404).json({ error: 'Informe no encontrado o expirado' });
  res.json({ success: true, ...report });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '5.0.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vendly v5 corriendo en puerto ${PORT}`));
