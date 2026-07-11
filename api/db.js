// Cloud-synced database endpoint (Vercel serverless function).
// Same contract as the local server's /api/db, but persists to Vercel Blob
// so every device shares one live price list.
//
// Setup (one time, Vercel dashboard): project → Storage → Create → Blob →
// connect to this project. That adds BLOB_READ_WRITE_TOKEN automatically.
// Optionally add an EDIT_PIN env var to require a PIN for saving changes.
//
// Until Blob is connected, GET serves the bundled seed with
// x-db-writable: 0 and the frontend falls back to browser-only mode.

const { put, list } = require('@vercel/blob');
const seed = require('../data/db.json');

const BLOB_PATH = 'grocery-price-scout/db.json';

function validateDb(db) {
  if (!db || typeof db !== 'object') return 'db must be an object';
  for (const key of ['stores', 'products', 'prices']) {
    if (!Array.isArray(db[key])) return `db.${key} must be an array`;
  }
  const storeIds = new Set(db.stores.map((s) => s.id));
  const productIds = new Set(db.products.map((p) => p.id));
  for (const price of db.prices) {
    if (!storeIds.has(price.storeId)) return `price references unknown store "${price.storeId}"`;
    if (!productIds.has(price.productId)) return `price references unknown product "${price.productId}"`;
    if (typeof price.pricePerLb !== 'number' || price.pricePerLb <= 0) {
      return `invalid pricePerLb for ${price.productId} @ ${price.storeId}`;
    }
  }
  return null;
}

// Fold fixes from a newer bundled seed into the stored copy: refreshed store
// search links, and updated prices for records the user never edited.
function mergeSeed(stored) {
  const seedVer = (seed.meta && seed.meta.version) || 0;
  const storedVer = (stored.meta && stored.meta.version) || 0;
  if (seedVer <= storedVer) return stored;
  for (const s of stored.stores) {
    const fresh = seed.stores.find((x) => x.id === s.id);
    if (fresh) s.searchUrl = fresh.searchUrl;
  }
  for (const fresh of seed.prices) {
    const rec = stored.prices.find(
      (x) => x.productId === fresh.productId && x.storeId === fresh.storeId
    );
    if (rec && rec.source !== 'user') Object.assign(rec, fresh);
    else if (!rec) stored.prices.push(fresh);
  }
  stored.meta = stored.meta || {};
  stored.meta.version = seedVer;
  return stored;
}

async function readStored() {
  const { blobs } = await list({ prefix: BLOB_PATH, limit: 1 });
  if (blobs.length === 0) return null;
  // Cache-bust with uploadedAt so we never read a stale CDN copy.
  const url = `${blobs[0].url}?v=${new Date(blobs[0].uploadedAt).getTime()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`blob fetch failed: ${res.status}`);
  return res.json();
}

module.exports = async (req, res) => {
  const configured = !!process.env.BLOB_READ_WRITE_TOKEN;
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      const stored = configured ? await readStored() : null;
      res.setHeader('x-db-writable', configured ? '1' : '0');
      return res.status(200).json(stored ? mergeSeed(stored) : seed);
    } catch (e) {
      // Storage hiccup — still serve the seed so the app works read-only.
      res.setHeader('x-db-writable', '0');
      return res.status(200).json(seed);
    }
  }

  if (req.method === 'PUT') {
    if (!configured) {
      return res.status(503).json({ error: 'Cloud storage not set up yet (connect a Blob store in Vercel)' });
    }
    if (process.env.EDIT_PIN && req.headers['x-edit-pin'] !== process.env.EDIT_PIN) {
      return res.status(401).json({ error: 'PIN required' });
    }
    try {
      const db = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const err = validateDb(db);
      if (err) return res.status(400).json({ error: err });
      await put(BLOB_PATH, JSON.stringify(db), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
};
