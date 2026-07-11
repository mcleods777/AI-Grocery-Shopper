// AI-powered price refresh (Vercel serverless function).
//
// POST {productId} — Claude researches current prices for that cut at every
// store (web search, localized to West Des Moines / 50265) and writes what it
// finds into the shared database with price history, source 'ai'.
//
// GET — reports availability: {available, reason?}. With ?cron=1 (used by the
// vercel.json daily schedule) it instead refreshes the two stalest products.
//
// Requires env vars: ANTHROPIC_API_KEY (console.anthropic.com) and the Blob
// store from the /api/db setup. Honors EDIT_PIN like saves do. Optional
// CRON_SECRET guards the cron path.

const Anthropic = require('@anthropic-ai/sdk');
const store = require('./_store.js');

module.exports.config = { maxDuration: 300 };

const RESULTS_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          storeId: { type: 'string' },
          pricePerLb: { type: 'number' },
          note: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          source: { type: 'string' },
        },
        required: ['storeId', 'pricePerLb', 'note', 'confidence', 'source'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

async function researchProduct(db, product) {
  const client = new Anthropic();
  const storeList = db.stores
    .map((s) => `- id "${s.id}": ${s.name}${s.notes ? ` (${s.notes})` : ''}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    tools: [
      {
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: 8,
        user_location: {
          type: 'approximate',
          city: 'West Des Moines',
          region: 'Iowa',
          country: 'US',
          timezone: 'America/Chicago',
        },
      },
    ],
    output_config: {
      format: { type: 'json_schema', schema: RESULTS_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content:
          `Research the current retail price per pound of "${product.name}" (category: ${product.category}) ` +
          `at grocery stores in the West Des Moines, Iowa (zip 50265) area, as of today.\n\n` +
          `Stores to check:\n${storeList}\n\n` +
          `Rules:\n` +
          `- Report prices as USD per pound. Convert package prices to per-lb when the package weight is known.\n` +
          `- Prefer the store's own website, weekly ad, or delivery listing for that store's price. ` +
          `Delivery-service prices (Instacart-style) are often 15-20% above shelf price — note that and lower confidence.\n` +
          `- If a store does not carry the item or you cannot find a credible current price, OMIT that store from results. Never guess.\n` +
          `- confidence: "high" = the store's own current listing; "medium" = recent secondary source or delivery price; ` +
          `"low" = older or indirect source.\n` +
          `- note: one short phrase (e.g. "88/12 is closest Costco carries, ~6 lb tray").\n` +
          `- source: the domain the price came from (e.g. "aldi.us").`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('price research request was declined');
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text).results;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function applyResults(db, product, results) {
  const updated = [];
  const skipped = [];
  for (const r of results) {
    const storeExists = db.stores.some((s) => s.id === r.storeId);
    if (!storeExists || !(r.pricePerLb > 0) || r.confidence === 'low') {
      skipped.push({ storeId: r.storeId, reason: !storeExists ? 'unknown store' : 'low confidence' });
      continue;
    }
    const price = Math.round(r.pricePerLb * 100) / 100;
    let rec = db.prices.find((x) => x.productId === product.id && x.storeId === r.storeId);
    if (rec) {
      // Don't clobber a price the user set by hand more recently than a week ago.
      if (rec.source === 'user' && (Date.now() - new Date(rec.updated).getTime()) < 7 * 86400000) {
        skipped.push({ storeId: r.storeId, reason: 'recent user edit' });
        continue;
      }
      const prevEff = rec.salePricePerLb != null ? rec.salePricePerLb : rec.pricePerLb;
      if (Math.abs(prevEff - price) > 0.004) {
        rec.history = rec.history || [];
        rec.history.push({ price: prevEff, date: rec.updated });
        if (rec.history.length > 200) rec.history.shift();
      }
      rec.pricePerLb = price;
      rec.salePricePerLb = null;
    } else {
      rec = { productId: product.id, storeId: r.storeId, pricePerLb: price, salePricePerLb: null, history: [] };
      db.prices.push(rec);
    }
    rec.note = `${r.note} [${r.source}]`.slice(0, 120);
    rec.updated = today();
    rec.source = 'ai';
    updated.push({ storeId: r.storeId, pricePerLb: price, confidence: r.confidence });
  }
  return { updated, skipped };
}

async function refreshOne(db, product) {
  const results = await researchProduct(db, product);
  return applyResults(db, product, results);
}

// The products whose prices have gone longest without an update.
function stalestProducts(db, n) {
  const oldest = (p) => Math.min(
    ...db.prices.filter((x) => x.productId === p.id).map((x) => new Date(x.updated).getTime()),
    Infinity
  );
  return [...db.products].sort((a, b) => oldest(a) - oldest(b)).slice(0, n);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const aiReady = !!process.env.ANTHROPIC_API_KEY;
  const storageReady = store.isConfigured();

  if (req.method === 'GET' && !('cron' in (req.query || {}))) {
    return res.status(200).json({
      available: aiReady && storageReady,
      reason: !aiReady ? 'ANTHROPIC_API_KEY not set' : !storageReady ? 'Blob storage not connected' : null,
    });
  }

  if (!aiReady || !storageReady) {
    return res.status(503).json({
      error: !aiReady
        ? 'AI price check not set up yet (add ANTHROPIC_API_KEY in Vercel env vars)'
        : 'Cloud storage not set up yet (connect a Blob store in Vercel)',
    });
  }

  try {
    if (req.method === 'GET') {
      // Cron path: refresh the two stalest products.
      if (process.env.CRON_SECRET && req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      const { db } = await store.readDb();
      const summary = [];
      for (const product of stalestProducts(db, 2)) {
        const result = await refreshOne(db, product);
        summary.push({ product: product.name, ...result });
      }
      await store.writeDb(db);
      return res.status(200).json({ ok: true, cron: true, summary });
    }

    if (req.method === 'POST') {
      if (!store.pinOk(req)) return res.status(401).json({ error: 'PIN required' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const { db } = await store.readDb();
      const product = db.products.find((p) => p.id === body.productId);
      if (!product) return res.status(400).json({ error: 'unknown productId' });
      const result = await refreshOne(db, product);
      if (result.updated.length > 0) await store.writeDb(db);
      return res.status(200).json({ ok: true, product: product.name, ...result });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
