// Shared database storage for the serverless API (underscore prefix keeps
// this file from being exposed as an endpoint). Persists to Vercel Blob.

const { put, list } = require('@vercel/blob');
const seed = require('../data/db.json');

const BLOB_PATH = 'grocery-price-scout/db.json';

// Two ways a connected store authenticates:
//  - legacy: a <PREFIX>_READ_WRITE_TOKEN env var (prefix chosen at connect time)
//  - current: OIDC — the store sets BLOB_STORE_ID and the Vercel runtime
//    supplies the identity token; the SDK resolves it when no token is passed.
function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const key = Object.keys(process.env).find((k) => k.endsWith('_READ_WRITE_TOKEN'));
  return key ? process.env[key] : null;
}

function authOpts() {
  const token = blobToken();
  return token ? { token } : {};
}

function isConfigured() {
  return !!(blobToken() || process.env.BLOB_STORE_ID);
}

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

// Returns the current database: the stored blob (merged with any newer seed)
// or the bundled seed if nothing has been stored yet.
async function readDb() {
  if (!isConfigured()) return { db: seed, stored: false };
  const { blobs } = await list({ prefix: BLOB_PATH, limit: 1, ...authOpts() });
  if (blobs.length === 0) return { db: seed, stored: false };
  // Cache-bust with uploadedAt so we never read a stale CDN copy.
  const url = `${blobs[0].url}?v=${new Date(blobs[0].uploadedAt).getTime()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`blob fetch failed: ${res.status}`);
  return { db: mergeSeed(await res.json()), stored: true };
}

async function writeDb(db) {
  await put(BLOB_PATH, JSON.stringify(db), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    ...authOpts(),
  });
}

function pinOk(req) {
  return !process.env.EDIT_PIN || req.headers['x-edit-pin'] === process.env.EDIT_PIN;
}

module.exports = { seed, isConfigured, validateDb, mergeSeed, readDb, writeDb, pinOk };
