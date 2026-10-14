// SQLite persistence via Node's built-in node:sqlite (no native build deps).
// Tables: orders, order_items, parcels, followups.
import { createRequire } from 'node:module';
import * as config from './config.js';

// Load node:sqlite via require (executes in order, unlike hoisted ESM imports)
// so we can silence its one-time experimental warning first.
const _emit = process.emitWarning.bind(process);
process.emitWarning = (w, ...a) => {
  if (String(w).includes('SQLite is an experimental')) return;
  return _emit(w, ...a);
};
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
process.emitWarning = _emit;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  order_id        TEXT PRIMARY KEY,
  order_time      TEXT,
  status          TEXT,
  amount          REAL,
  shop            TEXT,
  recipient       TEXT,
  parent_order_id TEXT,
  first_seen      TEXT DEFAULT (datetime('now')),
  last_seen       TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL,
  name       TEXT,
  qty        INTEGER,
  unit_price REAL,
  sku_id     TEXT,
  UNIQUE(order_id, name, sku_id)
);
CREATE TABLE IF NOT EXISTS parcels (
  order_id    TEXT PRIMARY KEY,
  tracking_no TEXT,
  carrier     TEXT,
  warehouse   TEXT,
  remark      TEXT,
  declared    INTEGER DEFAULT 0,
  declared_at TEXT
);
CREATE TABLE IF NOT EXISTS followups (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  kind     TEXT NOT NULL,
  due_at   TEXT,
  status   TEXT DEFAULT 'open',
  note     TEXT,
  UNIQUE(order_id, kind)
);
`;

let _db = null;

/** Open (once) and return the shared DB handle for this process. */
export function getDb() {
  if (!_db) {
    _db = new DatabaseSync(config.DB_PATH);
    _db.exec(SCHEMA);
    // Lightweight migrations for pre-existing DBs (ignore if the column exists).
    try { _db.exec('ALTER TABLE orders ADD COLUMN detail_url TEXT'); } catch { /* already exists */ }
    // source distinguishes 'jd' vs 'taobao'; existing rows predate Taobao support -> 'jd'.
    try { _db.exec("ALTER TABLE orders ADD COLUMN source TEXT DEFAULT 'jd'"); } catch { /* already exists */ }
  }
  return _db;
}

export function upsertOrder(order) {
  const db = getDb();
  db.prepare(`
    INSERT INTO orders (order_id, order_time, status, amount, shop, recipient, parent_order_id, detail_url, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      order_time=excluded.order_time, status=excluded.status, amount=excluded.amount,
      shop=excluded.shop, recipient=excluded.recipient,
      parent_order_id=excluded.parent_order_id,
      detail_url=COALESCE(excluded.detail_url, orders.detail_url),
      source=COALESCE(excluded.source, orders.source), last_seen=datetime('now')
  `).run(order.orderId, order.orderTime ?? '', order.status ?? '',
         order.amount ?? null, order.shop ?? '', order.recipient ?? '',
         order.parentOrderId ?? null, order.detailUrl ?? null, order.source ?? 'jd');

  const insItem = db.prepare(`
    INSERT OR IGNORE INTO order_items (order_id, name, qty, unit_price, sku_id)
    VALUES (?, ?, ?, ?, ?)`);
  for (const it of order.items ?? []) {
    insItem.run(order.orderId, it.name ?? '', it.qty ?? 1, it.unitPrice ?? null, it.skuId ?? '');
  }
  db.prepare('INSERT OR IGNORE INTO parcels (order_id, warehouse) VALUES (?, ?)')
    .run(order.orderId, config.SHEXP68_DEFAULT_WAREHOUSE);
}

export function getOrder(orderId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM orders WHERE order_id=?').get(orderId);
  if (!row) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId)
    .map(r => ({ name: r.name, qty: r.qty ?? 1, unitPrice: r.unit_price, skuId: r.sku_id || null }));
  return rowToOrder(row, items);
}

export function listOrders(status = null) {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM orders WHERE status=? ORDER BY order_time DESC').all(status)
    : db.prepare('SELECT * FROM orders ORDER BY order_time DESC').all();
  return rows.map(row => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(row.order_id)
      .map(r => ({ name: r.name, qty: r.qty ?? 1, unitPrice: r.unit_price, skuId: r.sku_id || null }));
    return rowToOrder(row, items);
  });
}

export function undeclaredParcels() {
  return getDb().prepare(`
    SELECT p.order_id, p.tracking_no, p.carrier, p.warehouse, p.remark, p.declared,
           o.status, o.amount, o.shop, o.order_time
    FROM parcels p JOIN orders o ON o.order_id = p.order_id
    WHERE p.declared = 0
    ORDER BY o.order_time DESC
  `).all();
}

export function setTracking(orderId, trackingNo, carrier = '') {
  getDb().prepare('UPDATE parcels SET tracking_no=?, carrier=? WHERE order_id=?')
    .run(trackingNo, carrier, orderId);
}

export function markDeclared(orderId, remark = '') {
  getDb().prepare("UPDATE parcels SET declared=1, declared_at=datetime('now'), remark=? WHERE order_id=?")
    .run(remark, orderId);
}

function rowToOrder(row, items) {
  return {
    orderId: row.order_id,
    orderTime: row.order_time ?? '',
    status: row.status ?? '',
    amount: row.amount,
    shop: row.shop ?? '',
    recipient: row.recipient ?? '',
    parentOrderId: row.parent_order_id,
    detailUrl: row.detail_url || null,
    source: row.source || 'jd',
    items,
  };
}
