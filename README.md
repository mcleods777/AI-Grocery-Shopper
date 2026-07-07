# 🥩 Grocery Price Scout

A local grocery price comparison app for the West Des Moines / Des Moines metro (50265). Track meat prices (and eventually anything else you shop for) at your local stores — **Hy-Vee, Walmart, Fareway, Aldi, Trader Joe's, Costco, Sam's Club, Target, Whole Foods, Fresh Thyme, and Natural Grocers** — check items off a shopping list, and instantly see **which store saves you the most money**.

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer (no other installs — the app has zero dependencies).

```bash
node server.js
```

Then open **http://localhost:3000** in your browser. That's it.

## How it works

### 🛒 Shopping List tab
Check off the meats you want and set how many pounds of each. The app instantly shows:

- **🏆 Best store** — the single store where your whole list costs the least, with a line-by-line breakdown and how much you save vs. the most expensive store.
- **✂️ Worth a second stop?** — the best *two-store* combo, if splitting the trip would save you extra money.
- **All stores compared** — every store ranked, with the price gap from the winner.
- Stores that don't carry something on your list are flagged separately.

Your list is saved automatically in the browser, so it's still there next time.

### 💲 Price Board tab
A full matrix of every item × every store, per-lb. The cheapest store for each item is highlighted in green.

- **Click any price** to update it (or add a price to an empty cell). Your edits are saved to the database file.
- **Click 🔗** to open that store's own website search for the item — the fastest way to check the real current price online.
- `~` marks seeded estimates you haven't verified yet; ⏰ marks prices more than 30 days old; 🔥 marks sale prices.

### 📈 Price history & trends
Every time you update a price, the old price is kept in that item's history (`history` in `data/db.json`). Wherever a price is shown — the Cuts & Prices cards and the Price Board — a badge appears once there's history:

- <b>▼ green</b> — the price **dropped** since last time (good news)
- <b>▲ red</b> — the price **went up** since last time

Hover the badge to see the previous price and the date it was recorded.

### ⚙️ Manage tab
Add new items (any grocery item works, not just meat), add new stores, or remove either.

## The database

Everything lives in one human-readable file: **`data/db.json`** — stores, items, and prices. You can edit it directly if you prefer; the app validates it on save. Each price records when it was last updated and whether it's an estimate or user-verified.

> **Important:** the seeded prices are realistic *estimates* (Midwest, mid-2026) meant as a starting point. Meat prices swing week to week — use the 🔗 links and weekly ads to verify, click the price, and type in the real number. After one shopping cycle of updates the comparisons will reflect *your* actual stores.

## Hosted on Vercel (browser-only mode)

The app also runs as a static site (no server) — that's how the Vercel deployment works. In this mode the seeded database ships with the site (`public/db-seed.json`, generated from `data/db.json` at build time) and **your price edits, added items, and stores are saved in your browser's localStorage** — private to your device, and they survive reloads. Different devices keep their own copies. To make a price change part of the site for every device, edit `data/db.json` in the repo and redeploy.

## Why not automatic live prices?

Grocery chains don't offer public price APIs, and their websites actively block automated scraping (and prices vary by *store location*, not just chain). So this app takes the reliable route: a price database **you control**, plus one-click links to each store's site to make manual verification fast. 

Ideas on the roadmap:

- [ ] Weekly-ad reminder (Aldi/Hy-Vee/Fareway ads flip on Wednesdays)
- [ ] Price history tracking, so you can see if a "sale" is actually a good price
- [ ] Import prices from a photo of a receipt or weekly ad
- [ ] Common non-meat staples (eggs, milk, butter, coffee) seeded for all stores
- [ ] Factor in gas/trip cost when deciding if a second stop is worth it
