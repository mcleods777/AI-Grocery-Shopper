/* Grocery Price Scout — frontend logic (vanilla JS, no build step). */

let db = null; // { stores, products, prices }
// True when there is no writable backend (e.g. static hosting on Vercel);
// price/db edits then persist to this browser's localStorage instead.
let staticMode = false;
// True when the backend can research prices with AI (/api/refresh-prices).
let aiAvailable = false;
// Configured AI providers (e.g. ['gemini','claude']) and the user's pick.
let aiProviders = [];
function aiProvider() {
  const saved = localStorage.getItem('aiProvider');
  return aiProviders.includes(saved) ? saved : aiProviders[0];
}
const AI_LABELS = { gemini: '✨ Gemini', claude: '🤖 Claude' };
// Shopping list: { [productId]: lbs } — persisted in localStorage.
let shoppingList = JSON.parse(localStorage.getItem('shoppingList') || '{}');

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => '$' + n.toFixed(2);
const today = () => new Date().toISOString().slice(0, 10);

// ---------- data helpers ----------

function priceFor(productId, storeId) {
  return db.prices.find((p) => p.productId === productId && p.storeId === storeId) || null;
}

function effectivePrice(rec) {
  return rec.salePricePerLb != null ? rec.salePricePerLb : rec.pricePerLb;
}

// Price movement vs. the previous recorded price (rec.history holds
// {price, date} entries appended each time the price changes).
function trend(rec) {
  if (!rec.history || rec.history.length === 0) return null;
  const prev = rec.history[rec.history.length - 1];
  const diff = effectivePrice(rec) - prev.price;
  if (Math.abs(diff) < 0.005) return null;
  return { dir: diff > 0 ? 'up' : 'down', diff, prev };
}

function trendBadge(rec) {
  const t = trend(rec);
  if (!t) return '';
  const arrow = t.dir === 'up' ? '▲' : '▼';
  const sign = t.dir === 'up' ? '+' : '−';
  return `<span class="trend ${t.dir}" title="was ${fmt(t.prev.price)} on ${esc(t.prev.date)}">${arrow}${sign}${fmt(Math.abs(t.diff)).slice(1)}</span>`;
}

function slugify(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let id = base, i = 2;
  while (db.products.some((p) => p.id === id) || db.stores.some((s) => s.id === id)) id = `${base}-${i++}`;
  return id;
}

async function saveDb() {
  if (staticMode) {
    localStorage.setItem('dbLocal', JSON.stringify(db));
    return true;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { 'Content-Type': 'application/json' };
    const pin = localStorage.getItem('editPin');
    if (pin) headers['x-edit-pin'] = pin;
    const res = await fetch('/api/db', { method: 'PUT', headers, body: JSON.stringify(db) });
    if (res.ok) return true;
    if (res.status === 401 && attempt === 0) {
      // Site owner set an EDIT_PIN — ask once and remember it on this device.
      const entered = prompt('This site requires a PIN to save changes:');
      if (entered == null) return false;
      localStorage.setItem('editPin', entered.trim());
      continue;
    }
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) localStorage.removeItem('editPin');
    toast('⚠️ Save failed: ' + (err.error || res.status), true);
    return false;
  }
  return false;
}

function saveList() {
  localStorage.setItem('shoppingList', JSON.stringify(shoppingList));
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = ''), 2500);
}

// ---------- comparison engine ----------

function computeStoreTotals(items) {
  // items: [{ productId, lbs }]
  return db.stores.map((store) => {
    const lines = [];
    const missing = [];
    let total = 0;
    for (const item of items) {
      const rec = priceFor(item.productId, store.id);
      if (!rec) {
        missing.push(item.productId);
        continue;
      }
      const per = effectivePrice(rec);
      lines.push({ ...item, perLb: per, cost: per * item.lbs, onSale: rec.salePricePerLb != null });
      total += per * item.lbs;
    }
    return { store, lines, missing, total };
  });
}

function bestTwoStoreSplit(items) {
  // Try every pair of stores; each item goes to whichever of the two is cheaper.
  let best = null;
  for (let i = 0; i < db.stores.length; i++) {
    for (let j = i + 1; j < db.stores.length; j++) {
      const [a, b] = [db.stores[i], db.stores[j]];
      let total = 0, ok = true;
      const assign = { [a.id]: [], [b.id]: [] };
      for (const item of items) {
        const ra = priceFor(item.productId, a.id);
        const rb = priceFor(item.productId, b.id);
        if (!ra && !rb) { ok = false; break; }
        const pa = ra ? effectivePrice(ra) : Infinity;
        const pb = rb ? effectivePrice(rb) : Infinity;
        const pick = pa <= pb ? a : b;
        const per = Math.min(pa, pb);
        assign[pick.id].push({ ...item, perLb: per, cost: per * item.lbs });
        total += per * item.lbs;
      }
      if (ok && (!best || total < best.total)) best = { a, b, assign, total };
    }
  }
  return best;
}

// ---------- rendering: shopping list tab ----------

function renderShopList() {
  const container = $('#shop-list');
  const categories = [...new Set(db.products.map((p) => p.category))];
  container.innerHTML = categories.map((cat) => `
    <div class="category">
      <h3>${esc(cat)}</h3>
      ${db.products.filter((p) => p.category === cat).map((p) => {
        const lbs = shoppingList[p.id];
        const checked = lbs != null;
        return `
          <div class="shop-item ${checked ? 'selected' : ''}">
            <label>
              <input type="checkbox" data-product="${p.id}" ${checked ? 'checked' : ''} />
              <span>${esc(p.name)}</span>
            </label>
            <span class="lbs-input ${checked ? '' : 'hidden'}">
              <input type="number" min="0.25" step="0.25" value="${checked ? lbs : 1}" data-lbs="${p.id}" /> lb
            </span>
          </div>`;
      }).join('')}
    </div>`).join('');

  container.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.product;
      if (cb.checked) {
        const lbsInput = container.querySelector(`input[data-lbs="${id}"]`);
        shoppingList[id] = parseFloat(lbsInput.value) || 1;
      } else {
        delete shoppingList[id];
      }
      saveList();
      renderShopList();
      renderResults();
    });
  });
  container.querySelectorAll('input[data-lbs]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const id = inp.dataset.lbs;
      if (shoppingList[id] != null) {
        shoppingList[id] = parseFloat(inp.value) || 0;
        saveList();
        renderResults();
      }
    });
  });
}

function renderResults() {
  const container = $('#results');
  const items = Object.entries(shoppingList)
    .map(([productId, lbs]) => ({ productId, lbs }))
    .filter((i) => i.lbs > 0);

  if (items.length === 0) {
    container.innerHTML = '<p class="empty">Check some items on the left and the best store will show up here.</p>';
    return;
  }

  const results = computeStoreTotals(items);
  const full = results.filter((r) => r.missing.length === 0).sort((a, b) => a.total - b.total);
  const partial = results.filter((r) => r.missing.length > 0 && r.lines.length > 0)
    .sort((a, b) => a.missing.length - b.missing.length || a.total - b.total);

  let html = '';

  if (full.length > 0) {
    const winner = full[0];
    const worst = full[full.length - 1];
    const savings = worst.total - winner.total;
    html += `
      <div class="winner card">
        <div class="winner-head">🏆 Best store: <strong>${esc(winner.store.name)}</strong></div>
        <div class="winner-total">${fmt(winner.total)}</div>
        ${full.length > 1 ? `<div class="winner-savings">saves you <strong>${fmt(savings)}</strong> vs. ${esc(worst.store.name)} (${fmt(worst.total)})</div>` : ''}
        <table class="mini">
          ${winner.lines.map((l) => `<tr><td>${esc(productName(l.productId))}</td><td>${l.lbs} lb × ${fmt(l.perLb)}${l.onSale ? ' 🔥' : ''}</td><td class="r">${fmt(l.cost)}</td></tr>`).join('')}
        </table>
        ${winner.store.notes ? `<p class="hint">${esc(winner.store.notes)}</p>` : ''}
      </div>`;

    const split = bestTwoStoreSplit(items);
    if (split && split.total < winner.total - 0.005 && (split.a.id === winner.store.id || split.b.id === winner.store.id || true)) {
      const extra = winner.total - split.total;
      html += `
        <div class="card split">
          <div class="winner-head">✂️ Worth a second stop? <strong>${esc(split.a.name)} + ${esc(split.b.name)}</strong> = ${fmt(split.total)}
            <span class="save-tag">extra ${fmt(extra)} saved</span></div>
          ${[split.a, split.b].map((s) => {
            const lines = split.assign[s.id];
            if (lines.length === 0) return '';
            return `<h4>${esc(s.name)}</h4><table class="mini">${lines.map((l) =>
              `<tr><td>${esc(productName(l.productId))}</td><td>${l.lbs} lb × ${fmt(l.perLb)}</td><td class="r">${fmt(l.cost)}</td></tr>`).join('')}</table>`;
          }).join('')}
        </div>`;
    }

    if (full.length > 1) {
      html += `
        <div class="card">
          <h3>All stores compared</h3>
          <table class="mini rank">
            ${full.map((r, idx) => `
              <tr class="${idx === 0 ? 'best' : ''}">
                <td>${idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : (idx + 1) + '.'}</td>
                <td>${esc(r.store.name)}</td>
                <td class="r">${fmt(r.total)}</td>
                <td class="r muted">${idx === 0 ? '' : '+' + fmt(r.total - full[0].total)}</td>
              </tr>`).join('')}
          </table>
        </div>`;
    }
  }

  if (partial.length > 0) {
    html += `
      <div class="card partial">
        <h3>Stores missing some items</h3>
        ${partial.map((r) => `
          <div class="partial-row">
            <strong>${esc(r.store.name)}</strong> — ${fmt(r.total)} for what they carry;
            no price for: ${r.missing.map((m) => esc(productName(m))).join(', ')}
          </div>`).join('')}
      </div>`;
  }

  if (full.length === 0 && partial.length === 0) {
    html = '<p class="empty">No store has prices for these items yet — add prices in the Price Board tab.</p>';
  } else if (full.length === 0) {
    html = '<p class="empty warn">No single store carries everything on your list — see partial matches below, or use two stores.</p>' + html;
  }

  container.innerHTML = html;
}

function productName(id) {
  const p = db.products.find((p) => p.id === id);
  return p ? p.name : id;
}

// ---------- rendering: cuts & prices tab ----------

let cutsFilter = 'All';

const CATEGORY_EMOJI = { Beef: '🥩', Chicken: '🍗', Turkey: '🦃', Pork: '🥓' };

function renderCuts() {
  const categories = [...new Set(db.products.map((p) => p.category))];

  $('#cuts-filter').innerHTML = ['All', ...categories].map((c) => `
    <button class="chip ${c === cutsFilter ? 'active' : ''}" data-filter="${esc(c)}">
      ${c === 'All' ? '🍽️ All' : (CATEGORY_EMOJI[c] || '🛒') + ' ' + esc(c)}
    </button>`).join('')
    + (aiAvailable && aiProviders.length > 1 ? `
    <span class="ai-picker">AI:
      ${aiProviders.map((p) => `
        <button class="chip ${p === aiProvider() ? 'active' : ''}" data-ai-provider="${p}">${AI_LABELS[p] || p}</button>`).join('')}
    </span>` : '');
  $('#cuts-filter').querySelectorAll('.chip[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => { cutsFilter = btn.dataset.filter; renderCuts(); });
  });
  $('#cuts-filter').querySelectorAll('.chip[data-ai-provider]').forEach((btn) => {
    btn.addEventListener('click', () => {
      localStorage.setItem('aiProvider', btn.dataset.aiProvider);
      renderCuts();
    });
  });

  const products = db.products.filter((p) => cutsFilter === 'All' || p.category === cutsFilter);

  $('#cuts-grid').innerHTML = products.map((p) => {
    const rows = db.stores
      .map((s) => ({ store: s, rec: priceFor(p.id, s.id) }))
      .filter((r) => r.rec)
      .sort((a, b) => effectivePrice(a.rec) - effectivePrice(b.rec));
    const noPrice = db.stores.filter((s) => !priceFor(p.id, s.id));
    const best = rows.length ? effectivePrice(rows[0].rec) : null;
    const inList = shoppingList[p.id] != null;

    return `
      <div class="cut-card">
        <div class="cut-head">
          <span class="cut-emoji">${CATEGORY_EMOJI[p.category] || '🛒'}</span>
          <div>
            <div class="cut-name">${esc(p.name)}</div>
            <div class="muted small">${esc(p.category)} · per lb</div>
          </div>
          <button class="btn small ${inList ? '' : 'primary'}" data-cut-add="${p.id}">
            ${inList ? '✓ On list' : '+ Add to list'}
          </button>
        </div>
        ${aiAvailable ? `<button class="btn small ai-check" data-ai-check="${p.id}">🤖 AI price check</button>` : ''}
        ${rows.length === 0 ? '<p class="hint">No prices yet — add some in the Price Board tab.</p>' : `
        <table class="mini cut-prices">
          ${rows.map((r, i) => {
            const eff = effectivePrice(r.rec);
            const link = r.store.searchUrl
              ? `<a class="check-link" target="_blank" rel="noopener" title="Check on ${esc(r.store.name)}'s site"
                   href="${esc(r.store.searchUrl.replace('{q}', encodeURIComponent(p.name)))}">🔗</a>` : '';
            return `<tr class="${i === 0 ? 'best-row' : ''}">
              <td>${i === 0 ? '🏆 ' : ''}${esc(r.store.name)}${link}</td>
              <td class="r">${fmt(eff)}${r.rec.salePricePerLb != null ? ' 🔥' : ''}${r.rec.source === 'estimate' ? '<sup>~</sup>' : ''} ${trendBadge(r.rec)}</td>
              <td class="r muted small">${i === 0 ? '' : '+' + fmt(eff - best)}</td>
            </tr>`;
          }).join('')}
        </table>`}
        ${noPrice.length > 0 && rows.length > 0
          ? `<p class="hint no-carry">Not priced: ${noPrice.map((s) => esc(s.name)).join(', ')}</p>` : ''}
      </div>`;
  }).join('');

  $('#cuts-grid').querySelectorAll('[data-cut-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.cutAdd;
      if (shoppingList[id] != null) delete shoppingList[id];
      else shoppingList[id] = 1;
      saveList();
      renderShopList();
      renderResults();
      renderCuts();
    });
  });
  $('#cuts-grid').querySelectorAll('[data-ai-check]').forEach((btn) => {
    btn.addEventListener('click', () => aiPriceCheck(btn.dataset.aiCheck, btn));
  });
}

// Ask the backend to research this product's current prices with AI
// (Claude + web search) and fold the findings into the shared database.
async function aiPriceCheck(productId, btn) {
  btn.disabled = true;
  btn.textContent = '🤖 Checking…';
  toast(`🤖 Researching ${productName(productId)} prices online — this can take a minute or two…`);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { 'Content-Type': 'application/json' };
      const pin = localStorage.getItem('editPin');
      if (pin) headers['x-edit-pin'] = pin;
      const res = await fetch('/api/refresh-prices', {
        method: 'POST',
        headers,
        body: JSON.stringify({ productId, provider: aiProvider() }),
      });
      if (res.status === 401 && attempt === 0) {
        const entered = prompt('This site requires a PIN to save changes:');
        if (entered == null) return;
        localStorage.setItem('editPin', entered.trim());
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) localStorage.removeItem('editPin');
        toast('⚠️ AI check failed: ' + (data.error || res.status), true);
        return;
      }
      // Reload the shared database so the new prices and trend badges show.
      const fresh = await fetch('/api/db');
      if (fresh.ok) db = await fresh.json();
      renderAll();
      toast(`✅ ${data.product} (${AI_LABELS[data.provider] || data.provider}): updated ${data.updated.length} store price${data.updated.length === 1 ? '' : 's'}` +
        (data.skipped.length ? ` (${data.skipped.length} skipped)` : ''));
      return;
    }
  } catch (e) {
    toast('⚠️ AI check failed: ' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 AI price check';
  }
}

// ---------- rendering: price board tab ----------

function renderPriceTable() {
  const table = $('#price-table');
  const categories = [...new Set(db.products.map((p) => p.category))];

  let html = `<thead><tr><th>Item</th>${db.stores.map((s) => `<th>${esc(s.name)}</th>`).join('')}</tr></thead><tbody>`;

  for (const cat of categories) {
    html += `<tr class="cat-row"><td colspan="${db.stores.length + 1}">${esc(cat)}</td></tr>`;
    for (const p of db.products.filter((p) => p.category === cat)) {
      const recs = db.stores.map((s) => priceFor(p.id, s.id));
      const min = Math.min(...recs.filter(Boolean).map(effectivePrice));
      html += `<tr><td class="item-name">${esc(p.name)}</td>` + db.stores.map((s, i) => {
        const rec = recs[i];
        const link = s.searchUrl
          ? `<a class="check-link" title="Check price on ${esc(s.name)}'s site" target="_blank" rel="noopener" href="${esc(s.searchUrl.replace('{q}', encodeURIComponent(p.name)))}">🔗</a>`
          : '';
        if (!rec) {
          return `<td class="price-cell na" data-product="${p.id}" data-store="${s.id}"><span class="price">—</span>${link}</td>`;
        }
        const eff = effectivePrice(rec);
        const isBest = Math.abs(eff - min) < 0.005;
        const stale = daysOld(rec.updated) > 30;
        return `<td class="price-cell ${isBest ? 'best' : ''}" data-product="${p.id}" data-store="${s.id}"
          title="Updated ${rec.updated}${rec.source === 'estimate' ? ' (estimate)' : ''}${rec.note ? ' — ' + esc(rec.note) : ''}">
          <span class="price">${fmt(eff)}${rec.salePricePerLb != null ? ' 🔥' : ''}${rec.source === 'estimate' ? '<sup>~</sup>' : ''}${stale ? ' ⏰' : ''}</span> ${trendBadge(rec)}${link}</td>`;
      }).join('') + '</tr>';
    }
  }
  html += '</tbody>';
  table.innerHTML = html;

  table.querySelectorAll('.price-cell').forEach((cell) => {
    cell.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // let the 🔗 link work normally
      editPrice(cell.dataset.product, cell.dataset.store);
    });
  });
}

function daysOld(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / 86400000;
}

async function editPrice(productId, storeId) {
  const store = db.stores.find((s) => s.id === storeId);
  const rec = priceFor(productId, storeId);
  const current = rec ? effectivePrice(rec) : '';
  const input = prompt(
    `${productName(productId)} at ${store.name} — price per lb?\n` +
    `(current: ${current === '' ? 'none' : fmt(current)}; enter a number, or "x" to remove)`,
    current
  );
  if (input == null || input.trim() === '') return;

  if (input.trim().toLowerCase() === 'x') {
    db.prices = db.prices.filter((p) => !(p.productId === productId && p.storeId === storeId));
  } else {
    const val = parseFloat(input.replace('$', ''));
    if (isNaN(val) || val <= 0) return toast('⚠️ Not a valid price', true);
    if (rec) {
      const prevEff = effectivePrice(rec);
      if (Math.abs(prevEff - val) > 0.004) {
        rec.history = rec.history || [];
        rec.history.push({ price: prevEff, date: rec.updated });
        if (rec.history.length > 200) rec.history.shift();
      }
      rec.pricePerLb = val;
      rec.salePricePerLb = null;
      rec.updated = today();
      rec.source = 'user';
    } else {
      db.prices.push({ productId, storeId, pricePerLb: val, salePricePerLb: null, note: '', updated: today(), source: 'user', history: [] });
    }
  }
  if (await saveDb()) {
    toast('✅ Price saved');
    renderAll();
  }
}

// ---------- rendering: manage tab ----------

function renderManage() {
  $('#category-list').innerHTML = [...new Set(db.products.map((p) => p.category))]
    .map((c) => `<option value="${esc(c)}">`).join('');

  $('#manage-products').innerHTML = db.products.map((p) => `
    <div class="manage-row">
      <span>${esc(p.name)} <span class="muted">(${esc(p.category)})</span></span>
      <button class="btn danger small" data-del-product="${p.id}">Remove</button>
    </div>`).join('');

  $('#manage-stores').innerHTML = db.stores.map((s) => `
    <div class="manage-row">
      <span>${esc(s.name)}${s.notes ? ` <span class="muted">— ${esc(s.notes)}</span>` : ''}</span>
      <button class="btn danger small" data-del-store="${s.id}">Remove</button>
    </div>`).join('');

  document.querySelectorAll('[data-del-product]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delProduct;
      if (!confirm(`Remove "${productName(id)}" and all its prices?`)) return;
      db.products = db.products.filter((p) => p.id !== id);
      db.prices = db.prices.filter((p) => p.productId !== id);
      delete shoppingList[id];
      saveList();
      if (await saveDb()) { toast('Removed'); renderAll(); }
    });
  });
  document.querySelectorAll('[data-del-store]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delStore;
      const store = db.stores.find((s) => s.id === id);
      if (!confirm(`Remove "${store.name}" and all its prices?`)) return;
      db.stores = db.stores.filter((s) => s.id !== id);
      db.prices = db.prices.filter((p) => p.storeId !== id);
      if (await saveDb()) { toast('Removed'); renderAll(); }
    });
  });
}

// ---------- misc ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAll() {
  renderShopList();
  renderResults();
  renderCuts();
  renderPriceTable();
  renderManage();
}

// Tabs
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
  });
});

// Forms
$('#add-product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#new-product-name').value.trim();
  const category = $('#new-product-category').value.trim();
  if (!name || !category) return;
  db.products.push({ id: slugify(name), name, category });
  if (await saveDb()) {
    toast(`✅ Added ${name} — set its prices in the Price Board tab`);
    e.target.reset();
    renderAll();
  }
});

$('#add-store-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#new-store-name').value.trim();
  if (!name) return;
  db.stores.push({
    id: slugify(name),
    name,
    searchUrl: $('#new-store-url').value.trim(),
    notes: $('#new-store-notes').value.trim(),
  });
  if (await saveDb()) {
    toast(`✅ Added ${name}`);
    e.target.reset();
    renderAll();
  }
});

// Boot
async function loadDb() {
  // Prefer the backend API: the local server (node server.js) or, when
  // hosted on Vercel with Blob storage connected, the cloud-synced database.
  try {
    const res = await fetch('/api/db');
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
      // The cloud endpoint reports x-db-writable: 0 when storage isn't
      // connected yet — saves would fail, so use browser-only mode instead.
      if (res.headers.get('x-db-writable') !== '0') {
        return res.json();
      }
    }
  } catch (_) { /* no backend — fall through to static mode */ }

  // Static hosting (e.g. Vercel): edits live in this browser's localStorage,
  // seeded from the bundled copy of the database.
  staticMode = true;
  const res = await fetch('db-seed.json');
  if (!res.ok) throw new Error('seed fetch failed');
  const seed = await res.json();
  const saved = localStorage.getItem('dbLocal');
  if (saved) {
    try {
      const local = JSON.parse(saved);
      // A newer seed carries fixes: corrected store search links and
      // updated/verified prices. Adopt them — but never overwrite a price
      // the user edited themselves (source === 'user').
      if ((seed.meta?.version || 0) > (local.meta?.version || 0)) {
        for (const s of local.stores) {
          const fresh = seed.stores.find((x) => x.id === s.id);
          if (fresh) s.searchUrl = fresh.searchUrl;
        }
        for (const fresh of seed.prices) {
          const rec = local.prices.find(
            (x) => x.productId === fresh.productId && x.storeId === fresh.storeId
          );
          if (rec && rec.source !== 'user') Object.assign(rec, fresh);
          else if (!rec) local.prices.push(fresh);
        }
        local.meta = local.meta || {};
        local.meta.version = seed.meta.version;
        localStorage.setItem('dbLocal', JSON.stringify(local));
      }
      return local;
    } catch (_) { /* corrupted — reseed */ }
  }
  return seed;
}

// Learn whether the backend supports AI price research (non-blocking).
fetch('/api/refresh-prices')
  .then((r) => (r.ok && (r.headers.get('content-type') || '').includes('json') ? r.json() : null))
  .then((info) => {
    if (info && info.available) {
      aiAvailable = true;
      aiProviders = info.providers || [];
      if (db) renderCuts();
    }
  })
  .catch(() => {});

loadDb()
  .then((data) => {
    db = data;
    // Drop shopping-list entries for products that no longer exist.
    for (const id of Object.keys(shoppingList)) {
      if (!db.products.some((p) => p.id === id)) delete shoppingList[id];
    }
    if (staticMode) {
      const note = document.createElement('p');
      note.textContent = 'Browser-only mode: your price edits and items are saved on this device.';
      document.querySelector('footer').appendChild(note);
    }
    renderAll();
  })
  .catch(() => {
    document.body.innerHTML = '<p style="padding:2rem">Could not load the price database. If you are running locally, start the server with <code>node server.js</code>.</p>';
  });
