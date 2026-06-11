require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── In-memory stores ──────────────────────────────────────────
const sharedReports = new Map(); // token -> { audit, product, createdAt }
const usageMap = new Map();      // ip -> count (free tier: 3 audits)

// ── Scraper ───────────────────────────────────────────────────
async function scrapeProduct(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Vendly/3.0)' }
    });
    const $ = cheerio.load(data);
    const name =
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      $('title').text().trim() || '';
    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      $('[class*="description"]').first().text().trim().slice(0, 800) ||
      $('p').first().text().trim() || '';
    const price =
      $('[class*="price"]').first().text().trim() ||
      $('[itemprop="price"]').attr('content') || '';
    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('img').first().attr('src') || '';
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2000);
    return { name, description, price, image, url, bodyText };
  } catch (e) {
    throw new Error('No se pudo leer la URL. Verificá que sea pública y accesible.');
  }
}

// ── Audit generator ───────────────────────────────────────────
async function generateAudit(product, country, tone, competitorProduct) {
  const countryMap = {
    argentina: 'Argentina (voseo: vos, tenés, podés)',
    mexico: 'México (tuteo: tú, tienes, puedes)',
    colombia: 'Colombia (tuteo formal)',
    espana: 'España (tuteo de España)',
    general: 'Latinoamérica (español neutro)'
  };
  const toneMap = {
    profesional: 'profesional y confiable',
    casual: 'casual y cercano',
    divertido: 'divertido y energético',
    urgente: 'urgente y persuasivo'
  };

  const competitorSection = competitorProduct ? `
COMPETIDOR ANALIZADO:
Nombre: ${competitorProduct.name || 'No disponible'}
Descripción: ${competitorProduct.description || 'No disponible'}
Precio: ${competitorProduct.price || 'No disponible'}
URL: ${competitorProduct.url || 'No disponible'}
` : '';

  const competitorJson = competitorProduct ? `
  "analisis_competidor": {
    "ventajas_vs_competidor": ["ventaja 1 de tu producto vs el competidor", "ventaja 2", "ventaja 3"],
    "desventajas_vs_competidor": ["desventaja 1 vs el competidor", "desventaja 2"],
    "oportunidades": ["oportunidad de diferenciación 1", "oportunidad 2", "oportunidad 3"],
    "score_competidor": {
      "conversion": 65,
      "confianza": 70,
      "seo": 55
    },
    "conclusion": "párrafo de 2-3 oraciones sobre cómo posicionarse vs el competidor"
  },` : '"analisis_competidor": null,';

  const prompt = `Sos un consultor senior de e-commerce y conversión para el mercado de ${countryMap[country] || 'Latinoamérica'}.

Analizá este producto y generá una auditoría profesional completa.

PRODUCTO:
Nombre: ${product.name || 'No disponible'}
Descripción: ${product.description || 'No disponible'}
Precio: ${product.price || 'No disponible'}
URL: ${product.url || 'No disponible'}
Texto de la página: ${product.bodyText ? product.bodyText.slice(0, 1000) : 'No disponible'}
${competitorSection}
TONO PARA COPIES: ${toneMap[tone] || 'profesional'}

Respondé SOLO con JSON puro válido, sin markdown ni backticks:

{
  "resumen_ejecutivo": "diagnóstico general del producto en 3-4 oraciones con potencial de ventas",
  "scores": {
    "conversion": 72,
    "confianza": 65,
    "seo": 58,
    "conversion_explicacion": "explicación de 2 oraciones",
    "confianza_explicacion": "explicación de 2 oraciones",
    "seo_explicacion": "explicación de 2 oraciones"
  },
  ${competitorJson}
  "fortalezas": ["fortaleza 1","fortaleza 2","fortaleza 3","fortaleza 4"],
  "debilidades": ["debilidad 1","debilidad 2","debilidad 3","debilidad 4"],
  "mejoras_recomendadas": [
    {"titulo":"título","descripcion":"descripción detallada de qué hacer","impacto":"ALTO"},
    {"titulo":"título","descripcion":"descripción","impacto":"ALTO"},
    {"titulo":"título","descripcion":"descripción","impacto":"MEDIO"},
    {"titulo":"título","descripcion":"descripción","impacto":"MEDIO"},
    {"titulo":"título","descripcion":"descripción","impacto":"BAJO"}
  ],
  "descripcion_optimizada": {
    "titulo_seo": "título SEO optimizado (60-80 caracteres)",
    "descripcion_corta": "descripción de 1-2 oraciones para listado (máximo 160 caracteres)",
    "descripcion_larga": "descripción completa optimizada de 300-400 palabras",
    "bullet_points": ["beneficio 1","beneficio 2","beneficio 3","beneficio 4","beneficio 5"]
  },
  "meta_ads": [
    {"nombre":"Ad 1 — Beneficio principal","headline":"titular (máx 40 chars)","texto_principal":"texto 150-200 palabras con gancho, valor y CTA","descripcion":"descripción corta (máx 90 chars)","objetivo":"Conversión"},
    {"nombre":"Ad 2 — Problema/Solución","headline":"titular","texto_principal":"texto","descripcion":"descripción","objetivo":"Conversión"},
    {"nombre":"Ad 3 — Prueba social","headline":"titular","texto_principal":"texto","descripcion":"descripción","objetivo":"Reconocimiento"},
    {"nombre":"Ad 4 — Urgencia","headline":"titular","texto_principal":"texto","descripcion":"descripción","objetivo":"Conversión"},
    {"nombre":"Ad 5 — Retargeting","headline":"titular","texto_principal":"texto","descripcion":"descripción","objetivo":"Retargeting"}
  ],
  "instagram_posts": [
    {"tipo":"Post educativo","caption":"caption completo 150-200 palabras con CTA y hashtags","hook":"primera línea gancho"},
    {"tipo":"Post de producto","caption":"caption completo","hook":"primera línea gancho"},
    {"tipo":"Historia de éxito","caption":"caption completo","hook":"primera línea gancho"}
  ],
  "plan_accion": [
    {"prioridad":1,"plazo":"Esta semana","accion":"acción concreta específica","impacto_esperado":"resultado esperado"},
    {"prioridad":2,"plazo":"Esta semana","accion":"acción","impacto_esperado":"resultado"},
    {"prioridad":3,"plazo":"Próximas 2 semanas","accion":"acción","impacto_esperado":"resultado"},
    {"prioridad":4,"plazo":"Próximas 2 semanas","accion":"acción","impacto_esperado":"resultado"},
    {"prioridad":5,"plazo":"Próximo mes","accion":"acción","impacto_esperado":"resultado"}
  ],
  "preguntas_frecuentes": [
    {"pregunta":"pregunta frecuente que haría un comprador 1","respuesta":"respuesta optimizada para conversión"},
    {"pregunta":"pregunta 2","respuesta":"respuesta"},
    {"pregunta":"pregunta 3","respuesta":"respuesta"},
    {"pregunta":"pregunta 4","respuesta":"respuesta"}
  ],
  "estrategia_precio": "análisis de 2-3 oraciones sobre si el precio es competitivo y qué estrategia de precio recomendar",
  "keywords_seo": ["keyword 1","keyword 2","keyword 3","keyword 4","keyword 5","keyword 6","keyword 7","keyword 8"]
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 5000
  });

  const raw = completion.choices[0].message.content.trim();
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ── ROUTES ────────────────────────────────────────────────────

// Scrape
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requerida' });
  try {
    const product = await scrapeProduct(url);
    res.json({ success: true, product });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Audit
app.post('/api/audit', async (req, res) => {
  const { product, country, tone, competitorProduct } = req.body;
  if (!product || !product.name) {
    return res.status(400).json({ error: 'Datos del producto requeridos' });
  }

  // Free tier check
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const usage = usageMap.get(ip) || 0;
  if (usage >= 3) {
    return res.status(403).json({
      error: 'Agotaste tus 3 auditorías gratuitas. Suscribite para continuar.',
      upgrade: true,
      remaining: 0
    });
  }

  try {
    const audit = await generateAudit(product, country || 'general', tone || 'profesional', competitorProduct || null);
    usageMap.set(ip, usage + 1);
    const remaining = 2 - usage;
    res.json({ success: true, audit, remaining });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando la auditoría. Verificá tu API key de OpenAI.' });
  }
});

// Share report
app.post('/api/share', async (req, res) => {
  const { audit, product } = req.body;
  if (!audit) return res.status(400).json({ error: 'Datos requeridos' });
  const token = crypto.randomBytes(16).toString('hex');
  sharedReports.set(token, { audit, product, createdAt: new Date() });
  // Clean up reports older than 7 days
  for (const [k, v] of sharedReports) {
    if (Date.now() - new Date(v.createdAt) > 7 * 24 * 60 * 60 * 1000) {
      sharedReports.delete(k);
    }
  }
  res.json({ success: true, token, url: `/informe/${token}` });
});

// Get shared report
app.get('/api/report/:token', (req, res) => {
  const report = sharedReports.get(req.params.token);
  if (!report) return res.status(404).json({ error: 'Informe no encontrado o expirado' });
  res.json({ success: true, ...report });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '3.0.0' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vendly v3 corriendo en puerto ${PORT}`));
