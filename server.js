// Grocery Price Scout — zero-dependency local server.
// Serves the web app from /public and persists the price database to data/db.json.
// Run with: node server.js   (then open http://localhost:3000)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_PATH = path.join(ROOT, 'data', 'db.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
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

function saveDb(db) {
  // Write to a temp file then rename so a crash can't corrupt the database.
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/db') {
    if (req.method === 'GET') {
      return send(res, 200, fs.readFileSync(DB_PATH));
    }
    if (req.method === 'PUT') {
      try {
        const db = JSON.parse(await readBody(req));
        const err = validateDb(db);
        if (err) return send(res, 400, JSON.stringify({ error: err }));
        saveDb(db);
        return send(res, 200, JSON.stringify({ ok: true }));
      } catch (e) {
        return send(res, 400, JSON.stringify({ error: e.message }));
      }
    }
    return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
  }

  // Static files
  if (req.method !== 'GET') return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
  let filePath = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, JSON.stringify({ error: 'forbidden' }));
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  send(res, 200, fs.readFileSync(filePath), MIME[path.extname(filePath)] || 'application/octet-stream');
});

server.listen(PORT, () => {
  console.log(`Grocery Price Scout running at http://localhost:${PORT}`);
});
