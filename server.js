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

// ── Scraper de URL ──────────────────────────────────────────────
async function scrapeProduct(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Vendly/1.0)' }
    });
    const $ = cheerio.load(data);

    // Tiendanube / general
    const name =
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      $('title').text().trim() ||
      '';

    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      $('p').first().text().trim() ||
      '';

    const price =
      $('[class*="price"]').first().text().trim() ||
      $('[itemprop="price"]').attr('content') ||
      '';

    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('img').first().attr('src') ||
      '';

    return { name, description, price, image, url };
  } catch (e) {
    throw new Error('No se pudo leer la URL. Verificá que sea publica y accesible.');
  }
}

// ── Generador de copies con IA ─────────────────────────────────
async function generateCopies(product, country, tone) {
  const toneMap = {
    'profesional': 'profesional y confiable',
    'casual': 'casual y cercano',
    'divertido': 'divertido y energico',
    'urgente': 'urgente y persuasivo'
  };

  const countryMap = {
    'argentina': 'Argentina (usar voseo: vos, tenes, podes)',
    'mexico': 'Mexico (usar tuteo: tu, tienes, puedes)',
    'colombia': 'Colombia (usar tuteo formal)',
    'espana': 'Espana (usar tuteo de Espana)',
    'general': 'Latinoamerica en general (espanol neutro)'
  };

  const toneLabel = toneMap[tone] || 'profesional y confiable';
  const countryLabel = countryMap[country] || 'Latinoamerica en general';

  const prompt = `Sos un experto en copywriting para e-commerce y publicidad digital en ${countryLabel}.

Producto: ${product.name}
Descripcion: ${product.description || 'No disponible'}
Precio: ${product.price || 'No disponible'}
URL: ${product.url || 'No disponible'}

Tono: ${toneLabel}

Genera el siguiente contenido en JSON valido (sin markdown, sin backticks, solo JSON puro):

{
  "meta_ads": {
    "headline_1": "titulo principal del anuncio (maximo 40 caracteres)",
    "headline_2": "segundo titulo (maximo 40 caracteres)",
    "headline_3": "tercer titulo (maximo 40 caracteres)",
    "primary_text": "texto principal del anuncio (150-200 palabras, engancha con el dolor del cliente, presenta la solucion, incluye CTA claro)",
    "description": "descripcion corta del anuncio (maximo 90 caracteres)"
  },
  "ficha_producto": {
    "titulo": "titulo SEO optimizado del producto (60-80 caracteres)",
    "descripcion_corta": "descripcion de 1-2 oraciones para el listado (maximo 160 caracteres)",
    "descripcion_larga": "descripcion completa del producto (300-400 palabras, incluye beneficios, caracteristicas, para quien es ideal, y por que comprarlo)",
    "bullet_points": ["beneficio 1", "beneficio 2", "beneficio 3", "beneficio 4", "beneficio 5"]
  },
  "instagram": {
    "caption_post": "caption completo para post de Instagram (150-200 palabras, tono conversacional, incluye CTA y hasta 15 hashtags al final)",
    "caption_story": "texto corto para story de Instagram (maximo 50 palabras, directo y con CTA)",
    "hooks": ["gancho 1 para reel o carrusel", "gancho 2 para reel o carrusel", "gancho 3 para reel o carrusel"]
  }
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 2000
  });

  const raw = completion.choices[0].message.content.trim();
  return JSON.parse(raw);
}

// ── RUTAS API ──────────────────────────────────────────────────

// Scrape URL
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

// Generar copies
app.post('/api/generate', async (req, res) => {
  const { product, country, tone } = req.body;
  if (!product || !product.name) {
    return res.status(400).json({ error: 'Datos del producto requeridos' });
  }
  try {
    const copies = await generateCopies(product, country || 'general', tone || 'profesional');
    res.json({ success: true, copies });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando copies. Verificá tu API key de OpenAI.' });
  }
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Servir frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vendly corriendo en puerto ${PORT}`));
