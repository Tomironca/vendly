require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { Resend } = require('resend');

const app = express();
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const LS_API_KEY = process.env.LEMONSQUEEZY_API_KEY;
const LS_BASIC_VARIANT = process.env.LEMONSQUEEZY_BASIC_VARIANT_ID || '1776746';
const LS_PRO_VARIANT = process.env.LEMONSQUEEZY_PRO_VARIANT_ID || '1776774';
const LS_STORE_URL = process.env.LEMONSQUEEZY_STORE_URL || 'https://vendly-app.lemonsqueezy.com';
const WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';
const APP_URL = process.env.APP_URL || 'https://vendly-production-e0f2.up.railway.app';

// DB
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
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS ip_usage (
    ip TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const stmts = {
  getUser: db.prepare('SELECT * FROM users WHERE email = ?'),
  createUser: db.prepare('INSERT OR IGNORE INTO users (email) VALUES (?)'),
  updatePlan: db.prepare('UPDATE users SET plan=?,status=?,audits_limit=?,subscription_id=?,updated_at=CURRENT_TIMESTAMP WHERE email=?'),
  incrAudits: db.prepare('UPDATE users SET audits_used=audits_used+1,updated_at=CURRENT_TIMESTAMP WHERE id=?'),
  createToken: db.prepare('INSERT INTO magic_tokens (email,token,expires_at) VALUES (?,?,?)'),
  getToken: db.prepare('SELECT * FROM magic_tokens WHERE token=? AND used=0 AND expires_at>CURRENT_TIMESTAMP'),
  useToken: db.prepare('UPDATE magic_tokens SET used=1 WHERE token=?'),
  cleanTokens: db.prepare('DELETE FROM magic_tokens WHERE expires_at<CURRENT_TIMESTAMP'),
  saveAudit: db.prepare('INSERT INTO audits (user_id,product_name,product_url,score_conversion,score_confianza,score_seo,audit_data) VALUES (?,?,?,?,?,?,?)'),
  getAudits: db.prepare('SELECT id,product_name,product_url,score_conversion,score_confianza,score_seo,created_at FROM audits WHERE user_id=? ORDER BY created_at DESC LIMIT 50'),
  getAudit: db.prepare('SELECT * FROM audits WHERE id=? AND user_id=?'),
  countAudits: db.prepare('SELECT COUNT(*) as total FROM audits'),
  getIp: db.prepare('SELECT count FROM ip_usage WHERE ip=?'),
  upsertIp: db.prepare('INSERT INTO ip_usage (ip,count) VALUES (?,1) ON CONFLICT(ip) DO UPDATE SET count=count+1,updated_at=CURRENT_TIMESTAMP'),
};

function makeJWT(userId, email, plan) {
  return jwt.sign({ userId, email, plan }, JWT_SECRET, { expiresIn: '30d' });
}
function checkJWT(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
function requireAuth(req, res, next) {
  const p = checkJWT(req.headers['x-session-token']);
  if (!p) return res.status(401).json({ error: 'No autenticado' });
  req.user = stmts.getUser.get(p.email);
  if (!req.user) return res.status(401).json({ error: 'Usuario no encontrado' });
  next();
}
function optAuth(req, res, next) {
  const p = checkJWT(req.headers['x-session-token']);
  if (p) req.user = stmts.getUser.get(p.email);
  next();
}

async function scrape(url) {
  const { data } = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Vendly/6.0)' } });
  const $ = cheerio.load(data);
  return {
    name: $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || '',
    description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '',
    price: $('[class*="price"]').first().text().trim() || '',
    image: $('meta[property="og:image"]').attr('content') || '',
    url,
    bodyText: $('body').text().replace(/\s+/g,' ').trim().slice(0,2000)
  };
}

async function audit(product, country, tone, comp) {
  const cm = {argentina:'Argentina (voseo)',mexico:'México',colombia:'Colombia',espana:'España',general:'Latinoamérica'};
  const tm = {profesional:'profesional y confiable',casual:'casual y cercano',divertido:'divertido y energético',urgente:'urgente y persuasivo'};
  const cs = comp ? `COMPETIDOR: ${comp.name}, ${comp.description}, ${comp.price}` : '';
  const cj = comp ? `"analisis_competidor":{"ventajas_vs_competidor":["v1","v2","v3"],"desventajas_vs_competidor":["d1","d2"],"oportunidades":["o1","o2","o3"],"conclusion":"2-3 oraciones"},` : '"analisis_competidor":null,';
  const prompt = `Sos consultor senior e-commerce para ${cm[country]||'Latinoamérica'}.
PRODUCTO: ${product.name}, ${product.description}, ${product.price}, ${product.url}
TEXTO: ${(product.bodyText||'').slice(0,800)}
${cs}
TONO: ${tm[tone]||'profesional'}
Solo JSON puro:
{"resumen_ejecutivo":"3-4 oraciones","scores":{"conversion":72,"confianza":65,"seo":58,"conversion_explicacion":"","confianza_explicacion":"","seo_explicacion":""},${cj}"fortalezas":["f1","f2","f3","f4"],"debilidades":["d1","d2","d3","d4"],"mejoras_recomendadas":[{"titulo":"t","descripcion":"d","impacto":"ALTO"},{"titulo":"t","descripcion":"d","impacto":"ALTO"},{"titulo":"t","descripcion":"d","impacto":"MEDIO"},{"titulo":"t","descripcion":"d","impacto":"MEDIO"},{"titulo":"t","descripcion":"d","impacto":"BAJO"}],"descripcion_optimizada":{"titulo_seo":"","descripcion_corta":"","descripcion_larga":"","bullet_points":["b1","b2","b3","b4","b5"]},"meta_ads":[{"nombre":"Ad 1","headline":"","texto_principal":"","descripcion":"","objetivo":"Conversión"},{"nombre":"Ad 2","headline":"","texto_principal":"","descripcion":"","objetivo":"Conversión"},{"nombre":"Ad 3","headline":"","texto_principal":"","descripcion":"","objetivo":"Reconocimiento"},{"nombre":"Ad 4","headline":"","texto_principal":"","descripcion":"","objetivo":"Conversión"},{"nombre":"Ad 5","headline":"","texto_principal":"","descripcion":"","objetivo":"Retargeting"}],"instagram_posts":[{"tipo":"Post educativo","caption":"","hook":""},{"tipo":"Post producto","caption":"","hook":""},{"tipo":"Historia éxito","caption":"","hook":""}],"plan_accion":[{"prioridad":1,"plazo":"Esta semana","accion":"","impacto_esperado":""},{"prioridad":2,"plazo":"Esta semana","accion":"","impacto_esperado":""},{"prioridad":3,"plazo":"Próximas 2 semanas","accion":"","impacto_esperado":""},{"prioridad":4,"plazo":"Próximas 2 semanas","accion":"","impacto_esperado":""},{"prioridad":5,"plazo":"Próximo mes","accion":"","impacto_esperado":""}],"preguntas_frecuentes":[{"pregunta":"","respuesta":""},{"pregunta":"","respuesta":""},{"pregunta":"","respuesta":""},{"pregunta":"","respuesta":""}],"estrategia_precio":"","keywords_seo":["k1","k2","k3","k4","k5","k6","k7","k8"]}`;
  const r = await openai.chat.completions.create({ model:'gpt-4o', messages:[{role:'user',content:prompt}], temperature:0.7, max_tokens:5000 });
  return JSON.parse(r.choices[0].message.content.trim().replace(/```json|```/g,'').trim());
}

async function sendMagicLink(email, token) {
  const link = `${APP_URL}/api/auth/verify?token=${token}`;
  await resend.emails.send({
    from: 'Vendly <onboarding@resend.dev>',
    to: email,
    subject: 'Tu link de acceso a Vendly',
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#07070E;color:#F0EEF8;border-radius:16px;">
      <div style="font-size:22px;font-weight:800;margin-bottom:8px;">Vend<span style="color:#A688FA">ly</span></div>
      <h2 style="font-size:20px;margin-bottom:12px;">Tu link de acceso</h2>
      <p style="color:#8B89A0;margin-bottom:24px;line-height:1.6;">Hacé click para ingresar. Este link expira en 10 minutos.</p>
      <a href="${link}" style="display:inline-block;background:#7C5CFC;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:500;">Ingresar a Vendly →</a>
      <p style="color:#555;font-size:11px;margin-top:20px;">${link}</p>
    </div>`
  });
}

// ROUTES
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','landing.html')));
app.get('/app', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/app/*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/informe/:token', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// Auth
app.post('/api/auth/login', async (req,res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error:'Email inválido' });
  try {
    stmts.cleanTokens.run();
    stmts.createUser.run(email.toLowerCase());
    const token = crypto.randomBytes(32).toString('hex');
    const exp = new Date(Date.now()+10*60*1000).toISOString();
    stmts.createToken.run(email.toLowerCase(), token, exp);
    await sendMagicLink(email.toLowerCase(), token);
    res.json({ success:true, message:'Link enviado. Revisá tu email.' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error:'Error enviando el email.' });
  }
});

app.get('/api/auth/verify', (req,res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/app?error=invalid');
  const rec = stmts.getToken.get(token);
  if (!rec) return res.redirect('/app?error=expired');
  stmts.useToken.run(token);
  const user = stmts.getUser.get(rec.email);
  if (!user) return res.redirect('/app?error=notfound');
  const session = makeJWT(user.id, user.email, user.plan);
  res.redirect(`/app?session=${session}`);
});

app.get('/api/session', optAuth, (req,res) => {
  if (!req.user) return res.json({ authenticated:false });
  res.json({ authenticated:true, email:req.user.email, plan:req.user.plan, status:req.user.status, auditsUsed:req.user.audits_used, auditsLimit:req.user.audits_limit });
});

// Scrape
app.post('/api/scrape', async (req,res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error:'URL requerida' });
  try { res.json({ success:true, product: await scrape(url) }); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

// Audit
app.post('/api/audit', optAuth, async (req,res) => {
  const { product, country, tone, competitorProduct } = req.body;
  if (!product||!product.name) return res.status(400).json({ error:'Datos requeridos' });
  if (req.user) {
    const u = req.user;
    if (u.status !== 'active') return res.status(403).json({ error:'Suscripción inactiva', upgrade:true });
    if (u.plan !== 'pro' && u.plan !== 'agency' && u.audits_used >= u.audits_limit)
      return res.status(403).json({ error:'Límite alcanzado', upgrade:true });
    try {
      const a = await audit(product, country||'general', tone||'profesional', competitorProduct||null);
      stmts.incrAudits.run(u.id);
      stmts.saveAudit.run(u.id, product.name||product.url, product.url||'', a.scores.conversion, a.scores.confianza, a.scores.seo, JSON.stringify(a));
      const updated = stmts.getUser.get(u.email);
      res.json({ success:true, audit:a, plan:u.plan, auditsUsed:updated.audits_used, auditsLimit:updated.audits_limit });
    } catch(e) { console.error(e); res.status(500).json({ error:'Error generando auditoría.' }); }
  } else {
    const ip = req.headers['x-forwarded-for']||req.socket.remoteAddress;
    const usage = stmts.getIp.get(ip);
    if (usage && usage.count >= 1) return res.status(403).json({ error:'Agotaste tu auditoría gratuita. Creá una cuenta para continuar.', upgrade:true, remaining:0 });
    try {
      const a = await audit(product, country||'general', tone||'profesional', competitorProduct||null);
      stmts.upsertIp.run(ip);
      res.json({ success:true, audit:a, remaining:0, plan:'free' });
    } catch(e) { res.status(500).json({ error:'Error generando auditoría.' }); }
  }
});

// History
app.get('/api/audits', requireAuth, (req,res) => {
  res.json({ success:true, audits: stmts.getAudits.all(req.user.id) });
});
app.get('/api/audits/:id', requireAuth, (req,res) => {
  const a = stmts.getAudit.get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error:'No encontrado' });
  res.json({ success:true, audit:{ ...a, audit_data:JSON.parse(a.audit_data) } });
});

// Payments
app.get('/api/checkout', (req,res) => {
  const { plan, email } = req.query;
  const variantId = plan==='pro' ? LS_PRO_VARIANT : LS_BASIC_VARIANT;
  const url = `${LS_STORE_URL}/checkout/buy/${variantId}${email?`?checkout[email]=${encodeURIComponent(email)}`:''}`;
  res.json({ url });
});

app.post('/api/verify-subscription', async (req,res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error:'Email requerido' });
  try {
    const r = await axios.get('https://api.lemonsqueezy.com/v1/subscriptions', {
      headers:{ 'Authorization':`Bearer ${LS_API_KEY}`, 'Accept':'application/vnd.api+json' },
      params:{ 'filter[user_email]':email.toLowerCase() }
    });
    const active = (r.data?.data||[]).find(s=>['active','on_trial'].includes(s.attributes.status));
    if (!active) return res.status(404).json({ error:'No encontramos suscripción activa.' });
    const plan = String(active.attributes.variant_id)===String(LS_PRO_VARIANT)?'pro':'basic';
    const limit = plan==='pro'?999999:30;
    stmts.createUser.run(email.toLowerCase());
    stmts.updatePlan.run(plan,'active',limit,active.id,email.toLowerCase());
    const user = stmts.getUser.get(email.toLowerCase());
    res.json({ success:true, sessionToken:makeJWT(user.id,user.email,plan), plan, auditsLimit:limit });
  } catch(e) { res.status(500).json({ error:'Error verificando.' }); }
});

app.post('/api/webhook', (req,res) => {
  try {
    if (WEBHOOK_SECRET) {
      const hmac = crypto.createHmac('sha256',WEBHOOK_SECRET);
      hmac.update(req.body);
      if (hmac.digest('hex')!==req.headers['x-signature']) return res.status(401).send('Invalid');
    }
    const ev = JSON.parse(req.body.toString());
    const name = ev.meta?.event_name;
    const attrs = ev.data?.attributes;
    const email = attrs?.user_email?.toLowerCase();
    if (!email) return res.status(200).json({ received:true });
    const plan = String(attrs?.variant_id)===String(LS_PRO_VARIANT)?'pro':'basic';
    const limit = plan==='pro'?999999:30;
    if (['subscription_created','subscription_resumed'].includes(name)) {
      stmts.createUser.run(email);
      stmts.updatePlan.run(plan,'active',limit,ev.data?.id,email);
    } else if (['subscription_cancelled','subscription_expired'].includes(name)) {
      const u = stmts.getUser.get(email);
      if (u) stmts.updatePlan.run(u.plan,'cancelled',u.audits_limit,u.subscription_id,email);
    }
    res.status(200).json({ received:true });
  } catch(e) { res.status(200).json({ received:true }); }
});

// Share
const shared = new Map();
app.post('/api/share', (req,res) => {
  const { audit, product } = req.body;
  if (!audit) return res.status(400).json({ error:'Datos requeridos' });
  const token = crypto.randomBytes(16).toString('hex');
  shared.set(token, { audit, product, createdAt: new Date() });
  for (const [k,v] of shared) { if (Date.now()-new Date(v.createdAt)>7*24*60*60*1000) shared.delete(k); }
  res.json({ success:true, token, url:`/informe/${token}` });
});
app.get('/api/report/:token', (req,res) => {
  const r = shared.get(req.params.token);
  if (!r) return res.status(404).json({ error:'No encontrado' });
  res.json({ success:true, ...r });
});

app.get('/api/stats', (req,res) => res.json({ totalAudits: stmts.countAudits.get().total }));
app.get('/api/health', (req,res) => res.json({ status:'ok', version:'6.0.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vendly v6 en puerto ${PORT}`));
