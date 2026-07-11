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

const store = require('./_store.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      const { db } = await store.readDb();
      res.setHeader('x-db-writable', store.isConfigured() ? '1' : '0');
      return res.status(200).json(db);
    } catch (e) {
      // Storage hiccup — still serve the seed so the app works read-only.
      res.setHeader('x-db-writable', '0');
      return res.status(200).json(store.seed);
    }
  }

  if (req.method === 'PUT') {
    if (!store.isConfigured()) {
      return res.status(503).json({ error: 'Cloud storage not set up yet (connect a Blob store in Vercel)' });
    }
    if (!store.pinOk(req)) {
      return res.status(401).json({ error: 'PIN required' });
    }
    try {
      const db = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const err = store.validateDb(db);
      if (err) return res.status(400).json({ error: err });
      await store.writeDb(db);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
};
