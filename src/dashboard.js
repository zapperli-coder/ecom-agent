// Operational web dashboard — read state AND drive the automation:
//   POST /api/sync              scan JD or Taobao orders ({source}) and upsert
//   GET  /api/declare/prepare   compute the prefill for the review modal (no browser)
//   POST /api/declare/submit    fill shexp68 with reviewed values and submit
//
// Node http + fs only (no extra deps). Browser work is serialized in actions.js.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDb, getOrder, undeclaredParcels } from './db.js';
import * as config from './config.js';
import * as shexp68 from './forwarders/shexp68.js';
import * as actions from './actions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, 'dashboard.html');
const OPEN_CMD = { win32: 'start ""', darwin: 'open' };

function state() {
  const db = getDb();
  let orders = [], items = [], follow = [];
  try {
    orders = db.prepare(`
      SELECT o.order_id, o.order_time, o.status, o.amount, o.shop, o.recipient, o.source,
             p.tracking_no, p.declared, p.declared_at
      FROM orders o LEFT JOIN parcels p ON p.order_id = o.order_id
      ORDER BY o.order_time DESC`).all();
    items = db.prepare('SELECT order_id, name, qty FROM order_items').all();
    follow = db.prepare("SELECT order_id, kind, due_at, status, note FROM followups WHERE status='open' ORDER BY due_at").all();
  } catch { /* tables may not exist yet */ }

  const byOrder = {};
  for (const it of items) (byOrder[it.order_id] ||= []).push({ name: it.name, qty: it.qty });
  const out = orders.map(o => ({ ...o, declared: !!o.declared, items: byOrder[o.order_id] || [] }));

  const total = out.length;
  const declared = out.filter(o => o.declared).length;
  const withTracking = out.filter(o => (o.tracking_no || '').trim()).length;
  const inTransit = out.filter(o => actions.isInTransit(o.status)).length;
  const spend = out.reduce((s, o) => s + (o.amount || 0), 0);

  return {
    summary: { orders: total, declared, with_tracking: withTracking, in_transit: inTransit,
               undeclared: total - declared, spend: Math.round(spend * 100) / 100 },
    orders: out, followups: follow,
  };
}

function preparePrefill(orderId) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: `Unknown order ${orderId}` };
  const pr = undeclaredParcels().find(p => p.order_id === orderId);
  const values = shexp68.valuesFromParcel({
    orderId,
    source: order.source,
    trackingNo: pr ? (pr.tracking_no || '') : '',
    warehouse: pr ? (pr.warehouse || config.SHEXP68_DEFAULT_WAREHOUSE) : config.SHEXP68_DEFAULT_WAREHOUSE,
    items: order.items,
    amount: order.amount,
  });
  return {
    ok: true,
    values,
    warehouses: [...new Set([values.warehouse, ...Object.keys(config.SHEXP68_WAREHOUSES)])],
    order: { shop: order.shop, amount: order.amount, status: order.status, source: order.source },
  };
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const body = fs.readFileSync(HTML_PATH);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
    return res.end(body);
  }
  if (req.method === 'GET' && p === '/api/state') return sendJson(res, 200, state());

  if (req.method === 'GET' && p === '/api/declare/prepare') {
    const orderId = url.searchParams.get('orderId') || '';
    const out = preparePrefill(orderId);
    return sendJson(res, out.ok ? 200 : 404, out);
  }

  if (req.method === 'POST' && p === '/api/sync') {
    const { source = 'jd' } = await readBody(req);
    try {
      if (source === 'taobao') {
        const r = await actions.scanTaobaoOrders();  // headed so a person can solve a slider captcha
        return sendJson(res, 200, { ok: true, source, count: r.count, inTransit: r.inTransit, tracked: 0, captcha: r.captcha });
      }
      if (source !== 'jd') return sendJson(res, 400, { ok: false, code: 'bad-input', error: `Unknown source ${source}` });
      const r = await actions.scanOrders();  // headed — JD 403s headless
      return sendJson(res, 200, { ok: true, source, count: r.count, inTransit: r.inTransit, tracked: r.tracked, trackingError: r.trackingError });
    } catch (e) {
      return sendJson(res, 200, { ok: false, code: e.code || 'error', error: e.message });
    }
  }

  if (req.method === 'POST' && p === '/api/track/refetch') {
    const body = await readBody(req);
    try {
      const r = await actions.refetchTracking(body.orderId);
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) {
      return sendJson(res, 200, { ok: false, code: e.code || 'error', error: e.message });
    }
  }

  if (req.method === 'POST' && p === '/api/declare/submit') {
    const body = await readBody(req);
    try {
      const r = await actions.submitDeclaration(body);  // headed
      return sendJson(res, 200, { ok: true, result: r.result, mode: r.mode });
    } catch (e) {
      return sendJson(res, 200, { ok: false, code: e.code || 'error', error: e.message });
    }
  }

  res.writeHead(404); res.end('not found');
}

export function serve({ host = '127.0.0.1', port = 8765, openBrowser = true } = {}) {
  const server = http.createServer((req, res) => { handle(req, res).catch(e => { try { sendJson(res, 500, { ok: false, error: e.message }); } catch {} }); });
  server.listen(port, host, () => {
    const url = `http://${host}:${port}/`;
    console.log(`eCom Agent dashboard: ${url}  (Ctrl+C to stop)`);
    if (openBrowser) exec(OPEN_CMD[process.platform] ? `${OPEN_CMD[process.platform]} "${url}"` : `xdg-open "${url}"`, () => {});
  });
  return server;
}
