require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Scraper (sin cambios) ──────────────────────────────────────
async function scrapeProduct(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Vendly/2.0)' }
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

    const images = [];
    $('img').each((i, el) => {
      const src = $(el).attr('src');
      if (src && src.startsWith('http') && i < 5) images.push(src);
    });

    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2000);

    return { name, description, price, image, images, url, bodyText };
  } catch (e) {
    throw new Error('No se pudo leer la URL. Verificá que sea pública y accesible.');
  }
}

// ── Auditoría con IA ──────────────────────────────────────────
async function generateAudit(product, country, tone) {
  const countryMap = {
    argentina: 'Argentina (voseo: vos, tenés, podés)',
    mexico: 'México (tuteo: tú, tienes, puedes)',
    colombia: 'Colombia (tuteo formal)',
    espana: 'España (tuteo de España)',
    general: 'Latinoamérica en general (español neutro)'
  };
  const countryLabel = countryMap[country] || 'Latinoamérica';

  const toneMap = {
    profesional: 'profesional y confiable',
    casual: 'casual y cercano',
    divertido: 'divertido y energético',
    urgente: 'urgente y persuasivo'
  };
  const toneLabel = toneMap[tone] || 'profesional y confiable';

  const prompt = `Sos un consultor experto en e-commerce y conversión para el mercado de ${countryLabel}.

Analizá este producto de e-commerce y generá una auditoría profesional completa.

DATOS DEL PRODUCTO:
Nombre: ${product.name || 'No disponible'}
Descripción: ${product.description || 'No disponible'}
Precio: ${product.price || 'No disponible'}
URL: ${product.url || 'No disponible'}
Texto adicional de la página: ${product.bodyText ? product.bodyText.slice(0, 1000) : 'No disponible'}

TONO PARA COPIES: ${toneLabel}

Respondé SOLO con un JSON válido, sin markdown, sin backticks, sin texto extra. Solo el JSON puro:

{
  "resumen_ejecutivo": "párrafo de 3-4 oraciones con el diagnóstico general del producto y su potencial de ventas",
  "scores": {
    "conversion": 72,
    "confianza": 65,
    "seo": 58,
    "conversion_explicacion": "explicación de 2 oraciones del score de conversión",
    "confianza_explicacion": "explicación de 2 oraciones del score de confianza",
    "seo_explicacion": "explicación de 2 oraciones del score SEO"
  },
  "fortalezas": [
    "fortaleza concreta 1",
    "fortaleza concreta 2",
    "fortaleza concreta 3",
    "fortaleza concreta 4"
  ],
  "debilidades": [
    "debilidad concreta 1",
    "debilidad concreta 2",
    "debilidad concreta 3",
    "debilidad concreta 4"
  ],
  "mejoras_recomendadas": [
    {
      "titulo": "título corto de la mejora",
      "descripcion": "explicación de qué hacer y por qué impacta en las ventas",
      "impacto": "ALTO"
    },
    {
      "titulo": "título corto",
      "descripcion": "explicación",
      "impacto": "ALTO"
    },
    {
      "titulo": "título corto",
      "descripcion": "explicación",
      "impacto": "MEDIO"
    },
    {
      "titulo": "título corto",
      "descripcion": "explicación",
      "impacto": "MEDIO"
    },
    {
      "titulo": "título corto",
      "descripcion": "explicación",
      "impacto": "BAJO"
    }
  ],
  "descripcion_optimizada": {
    "titulo_seo": "título optimizado para SEO del producto (60-80 caracteres)",
    "descripcion_corta": "descripción de 1-2 oraciones para el listado (máximo 160 caracteres)",
    "descripcion_larga": "descripción completa optimizada de 300-400 palabras con beneficios, características, para quién es ideal y por qué comprarlo ahora",
    "bullet_points": [
      "beneficio clave 1",
      "beneficio clave 2",
      "beneficio clave 3",
      "beneficio clave 4",
      "beneficio clave 5"
    ]
  },
  "meta_ads": [
    {
      "nombre": "Anuncio 1 — Beneficio principal",
      "headline": "titular del anuncio (máximo 40 caracteres)",
      "texto_principal": "texto principal del anuncio (150-200 palabras con gancho, propuesta de valor y CTA)",
      "descripcion": "descripción corta (máximo 90 caracteres)",
      "objetivo": "Conversión"
    },
    {
      "nombre": "Anuncio 2 — Problema/Solución",
      "headline": "titular",
      "texto_principal": "texto",
      "descripcion": "descripción",
      "objetivo": "Conversión"
    },
    {
      "nombre": "Anuncio 3 — Prueba social",
      "headline": "titular",
      "texto_principal": "texto",
      "descripcion": "descripción",
      "objetivo": "Reconocimiento"
    },
    {
      "nombre": "Anuncio 4 — Urgencia",
      "headline": "titular",
      "texto_principal": "texto",
      "descripcion": "descripción",
      "objetivo": "Conversión"
    },
    {
      "nombre": "Anuncio 5 — Retargeting",
      "headline": "titular",
      "texto_principal": "texto",
      "descripcion": "descripción",
      "objetivo": "Retargeting"
    }
  ],
  "instagram_posts": [
    {
      "tipo": "Post educativo",
      "caption": "caption completo para post de Instagram (150-200 palabras con CTA y hashtags al final)",
      "hook": "primera línea gancho del post"
    },
    {
      "tipo": "Post de producto",
      "caption": "caption completo",
      "hook": "primera línea gancho"
    },
    {
      "tipo": "Post de historia/testimonial",
      "caption": "caption completo",
      "hook": "primera línea gancho"
    }
  ],
  "plan_accion": [
    {
      "prioridad": 1,
      "plazo": "Esta semana",
      "accion": "acción concreta y específica a tomar",
      "impacto_esperado": "resultado esperado de esta acción"
    },
    {
      "prioridad": 2,
      "plazo": "Esta semana",
      "accion": "acción 2",
      "impacto_esperado": "resultado esperado"
    },
    {
      "prioridad": 3,
      "plazo": "Próximas 2 semanas",
      "accion": "acción 3",
      "impacto_esperado": "resultado esperado"
    },
    {
      "prioridad": 4,
      "plazo": "Próximas 2 semanas",
      "accion": "acción 4",
      "impacto_esperado": "resultado esperado"
    },
    {
      "prioridad": 5,
      "plazo": "Próximo mes",
      "accion": "acción 5",
      "impacto_esperado": "resultado esperado"
    }
  ]
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 4000
  });

  const raw = completion.choices[0].message.content.trim();
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ── RUTAS ─────────────────────────────────────────────────────

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

app.post('/api/audit', async (req, res) => {
  const { product, country, tone } = req.body;
  if (!product || !product.name) {
    return res.status(400).json({ error: 'Datos del producto requeridos' });
  }
  try {
    const audit = await generateAudit(product, country || 'general', tone || 'profesional');
    res.json({ success: true, audit });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando la auditoría. Verificá tu API key de OpenAI.' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '2.0.0' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vendly v2 corriendo en puerto ${PORT}`));
