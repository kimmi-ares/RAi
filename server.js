// ResilienceAI — minimal backend for Frontend.html
// Zero dependencies. Node 18+ (uses built-in fetch). Tested on Node 24.
//
// Responsibilities:
//   1. Serve Frontend.html at /  (so the page and API share an origin)
//   2. POST /api/damage-assessment  — runs a real Claude vision analysis on the
//      uploaded photos, keeping the API key server-side.
//
// Start:  ANTHROPIC_API_KEY=sk-ant-... node server.js
//   (or put the key in a .env file next to this script — see .env.example)

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const MODEL = 'claude-opus-4-8';
const MAX_IMAGES = 6;            // cap images sent to the model
const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32MB request cap (base64 photos are large)

// ── Tiny .env loader (no dependency) ──────────────────────────────
(function loadDotEnv() {
  try {
    const envPath = path.join(ROOT, '.env');
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* no .env file — that's fine */ }
})();

const API_KEY = process.env.ANTHROPIC_API_KEY;

// JSON shape we force the model to return (structured outputs).
const ASSESSMENT_SCHEMA = {
  type: 'object',
  properties: {
    total: { type: 'integer', description: 'Total estimated loss in USD' },
    breakdown: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Emoji + short item name, e.g. "🌊 Flooded Fields"' },
          amount: { type: 'integer', description: 'USD estimate for this item' },
        },
        required: ['name', 'amount'],
        additionalProperties: false,
      },
    },
    severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
    affectedArea: { type: 'string', description: 'e.g. "2.4 km²"' },
    confidence: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Detection confidence percentages, one per breakdown item',
    },
    summary: { type: 'string', description: 'Two-sentence professional summary + recommended immediate actions' },
  },
  required: ['total', 'breakdown', 'severity', 'affectedArea', 'confidence', 'summary'],
  additionalProperties: false,
};

// Convert a browser data URL ("data:image/jpeg;base64,...") into an Anthropic image block.
function dataUrlToImageBlock(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return null;
  const mediaType = m[1];
  if (!/^image\/(jpeg|png|gif|webp)$/.test(mediaType)) return null; // model-supported types only
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: m[2] } };
}

async function runDamageAssessment({ location, category, images }) {
  if (!API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY is not set on the server');
    err.code = 'NO_KEY';
    throw err;
  }

  const imageBlocks = (Array.isArray(images) ? images : [])
    .map(dataUrlToImageBlock)
    .filter(Boolean)
    .slice(0, MAX_IMAGES);

  const instructions =
    `You are ResilienceAI, an AI disaster-response system supporting Caribbean farmers. ` +
    `Assess the agricultural/infrastructure damage shown` +
    (imageBlocks.length ? ` in the ${imageBlocks.length} attached photo(s)` : ` for a reported "${category}" event`) +
    ` at "${location || 'Jamaica'}", Jamaica. The reported damage category is "${category}". ` +
    `Produce a realistic damage assessment. Base your findings on what is actually visible in the images when provided. ` +
    `Provide 3–4 breakdown line items whose amounts sum to the total (USD, typically 5,000–50,000), ` +
    `a confidence percentage for each breakdown item, an estimated affected area, an overall severity, ` +
    `and a concise two-sentence summary with recommended immediate actions.`;

  const content = [...imageBlocks, { type: 'text', text: instructions }];

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      output_config: { format: { type: 'json_schema', schema: ASSESSMENT_SCHEMA } },
      messages: [{ role: 'user', content }],
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    const err = new Error(`Anthropic API ${resp.status}: ${detail.slice(0, 500)}`);
    err.code = 'API_ERROR';
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  if (data.stop_reason === 'refusal') {
    const err = new Error('Model declined the request');
    err.code = 'REFUSAL';
    throw err;
  }
  const text = (data.content || []).map((b) => b.text || '').join('').trim();
  return JSON.parse(text); // output_config.format guarantees valid JSON
}

// ── HTTP server ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Serve the frontend
  if (req.method === 'GET' && (req.url === '/' || req.url === '/Frontend.html')) {
    fs.readFile(path.join(ROOT, 'Frontend.html'), (e, buf) => {
      if (e) { res.writeHead(500); res.end('Could not read Frontend.html'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }

  // Health/config probe — lets the frontend know if a real key is configured
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ai: Boolean(API_KEY), model: MODEL }));
    return;
  }

  // Damage assessment endpoint
  if (req.method === 'POST' && req.url === '/api/damage-assessment') {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { res.writeHead(413); res.end('{"error":"payload too large"}'); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid JSON"}'); return; }

      try {
        const result = await runDamageAssessment(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const status = err.code === 'NO_KEY' ? 503 : (err.status || 502);
        console.error('[damage-assessment]', err.code || '', err.message);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, code: err.code || 'ERROR' }));
      }
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

server.listen(PORT, () => {
  console.log(`\n  ResilienceAI running →  http://localhost:${PORT}\n`);
  console.log(API_KEY
    ? `  Claude vision analysis: ENABLED (${MODEL})\n`
    : `  Claude vision analysis: DISABLED — set ANTHROPIC_API_KEY to turn it on.\n  The app still works using built-in demo data.\n`);
});
