// Taobao / Tmall order-list scraper ("已买到的宝贝").
//
// Same strategy as the JD scraper: we do NOT re-implement Taobao's mtop request
// signing (_m_h5_tk / sign). We render buyertrade.taobao.com in the logged-in
// persistent profile, let the page fire its own signed mtop XHR, and parse the
// captured JSON. A text-anchored DOM parse is kept as a fallback.
//
// Two Taobao-specific wrinkles vs JD:
//   1. A slider captcha ("滑动验证") often appears on first load. We detect it and
//      surface `captcha:true` so the caller can pause for a human (headed).
//   2. mtop responses are usually JSONP-wrapped: `mtopjsonpN({...})`. We unwrap
//      before JSON.parse. The response shape varies by rollout, so the parser is
//      defensive and every raw body is dumped to data/raw for refinement.
import fs from 'node:fs';
import path from 'node:path';
import * as config from '../config.js';

const SOURCE = 'taobao';

/** True once the account is authenticated (not sitting on a login page). */
export async function isLoggedIn(page) {
  const url = page.url();
  if (/login\.taobao\.com|login\.tmall\.com/.test(url)) return false;
  // The Havana session cookies are the authoritative signal (set at login,
  // independent of which trade page is currently rendered).
  try {
    const cookies = await page.context().cookies('https://buyertrade.taobao.com');
    return config.TAOBAO_LOGIN_COOKIES.every(n => cookies.some(ck => ck.name === n && ck.value));
  } catch {
    return !/login\.taobao\.com/.test(url);
  }
}

/**
 * Load the "已买到的宝贝" list and return parsed orders.
 * @param {import('playwright').Page} page
 * @param {{waitMs?:number, dumpRaw?:boolean}} opts
 * @returns {Promise<{orders:object[], captcha:boolean, rawCount:number}>}
 */
export async function fetchOrders(page, { waitMs = 5000, dumpRaw = true } = {}) {
  const rawHits = [];
  const pending = [];
  const handler = (resp) => {
    const url = resp.url();
    if (!url.includes(config.TAOBAO_GATEWAY_HOST)) return;
    const low = url.toLowerCase();
    if (!config.TAOBAO_ORDER_FUNCTION_HINTS.some(h => low.includes(h))) return;
    pending.push(resp.text().then(
      body => rawHits.push({ url, status: resp.status(), body }),
      () => {}
    ));
  };
  page.on('response', handler);

  await page.goto(config.TAOBAO_ORDER_LIST_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // Give the SPA time to fire its mtop call (or a captcha to render).
  await page.waitForTimeout(waitMs);

  const captcha = await hasCaptcha(page);

  page.off('response', handler);
  await Promise.allSettled(pending);

  if (dumpRaw && rawHits.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(config.RAW_DIR, `taobao_${stamp}.json`),
      JSON.stringify(rawHits, null, 2), 'utf-8');
  }

  // Prefer authoritative JSON from a captured mtop response.
  for (const hit of rawHits) {
    if (hit.status !== 200 || !hit.body) continue;
    const orders = parseOrderListJson(hit.body);
    if (orders.length) return { orders, captcha, rawCount: rawHits.length };
  }

  // Fallback: text-anchored DOM parse.
  const raw = await page.evaluate(extractOrdersFromDom).catch(() => []);
  return { orders: raw.map(domToOrder), captcha, rawCount: rawHits.length };
}

/** Detect Taobao's slider / risk-control interstitial on the current page. */
export async function hasCaptcha(page) {
  if (/punish|_____tmd_____|nocaptcha|sec\.taobao/.test(page.url())) return true;
  try {
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 600));
    return /滑动验证|拖动滑块|安全验证|请完成.*验证|向右滑动/.test(txt);
  } catch { return false; }
}

// ---- JSON parsing ----------------------------------------------------------

/** Unwrap a possibly JSONP-wrapped mtop body (`mtopjsonp5({...})`) into an object. */
export function unwrapMtop(bodyText) {
  if (!bodyText) return null;
  let s = bodyText.trim();
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (!s.startsWith('{') && open !== -1 && close > open) s = s.slice(open + 1, close);
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Parse an mtop bought-list body into order objects. The live PC endpoint
 * (mtop.taobao.order.queryboughtlistV2) returns a DinamicX "hierarchy" component
 * tree at `data.data` — a flat map of `<tag>_<orderId>` components. We parse that
 * primarily; a legacy `mainOrders[]` shape and a generic deep-search are kept as
 * fallbacks. Refine against data/raw/taobao_*.json when Taobao changes the format.
 */
export function parseOrderListJson(bodyText) {
  const body = unwrapMtop(bodyText);
  if (!body) return [];
  const data = body.data || body;

  // Primary: the queryboughtlistV2 hierarchy (data.data is the component map).
  if (data.data && typeof data.data === 'object' &&
      Object.keys(data.data).some(k => k.startsWith('shopInfo_'))) {
    const orders = parseHierarchy(data.data);
    if (orders.length) return orders;
  }

  // Fallbacks: legacy mainOrders[]/orders[] arrays, then a generic deep search.
  const list = Array.isArray(data.mainOrders) ? data.mainOrders
    : Array.isArray(data.orders) ? data.orders
    : findOrdersArray(data);
  if (!Array.isArray(list) || !list.length) return [];
  return list.map(mapMainOrder).filter(o => o && o.orderId);
}

/**
 * Parse the DinamicX component map from queryboughtlistV2. Components are keyed
 * `<tag>_<orderId>...`; we index the ones we need by their `fields.orderId` and
 * stitch each order together. Item lines come from every `orderItemInfo_*`.
 */
export function parseHierarchy(comp) {
  const shopByOrder = new Map();     // orderId -> shopInfo.fields
  const payByOrder = new Map();      // orderId -> orderPayment.fields
  const itemsByOrder = new Map();    // orderId -> [item.fields.item, ...]

  for (const [key, node] of Object.entries(comp)) {
    const f = node && node.fields;
    if (!f) continue;
    if (key.startsWith('shopInfo_') && f.orderId) shopByOrder.set(String(f.orderId), f);
    else if (key.startsWith('orderPayment_')) {
      const id = key.slice('orderPayment_'.length);
      if (id) payByOrder.set(id, f);
    } else if (key.startsWith('orderItemInfo_') && f.item) {
      const id = String(f.orderId || key.slice('orderItemInfo_'.length).split('_')[0]);
      if (!itemsByOrder.has(id)) itemsByOrder.set(id, []);
      itemsByOrder.get(id).push(f.item);
    }
  }

  const orders = [];
  for (const [orderId, shop] of shopByOrder) {
    const pay = payByOrder.get(orderId) || {};
    const rawItems = itemsByOrder.get(orderId) || [];
    orders.push({
      orderId,
      orderTime: shop.createTime || shop.createDay || '',
      status: normalizeStatus(shop.tradeTitle || ''),
      amount: parseMoney(pay.actualFee && pay.actualFee.value),
      shop: shop.shopName || shop.sellerName || '',
      recipient: '',
      parentOrderId: null,
      detailUrl: absolutize(shop.orderDetailUrl),
      source: SOURCE,
      items: rawItems.map(mapHierarchyItem).filter(Boolean),
    });
  }
  return orders;
}

/** Map one `orderItemInfo.fields.item` object into our item shape. */
function mapHierarchyItem(it) {
  const name = (it.title || '').trim();
  if (!name) return null;
  const qty = Number(it.quantity ?? 1) || 1;
  const lineTotal = parseMoney(it.priceInfo && (it.priceInfo.actualTotalFee ?? it.priceInfo.promotion));
  return {
    name,
    qty,
    skuId: String(it.itemId || '') || null,
    unitPrice: lineTotal != null && qty ? round2(lineTotal / qty) : null,
  };
}

function normalizeStatus(s) {
  const t = String(s || '').trim();
  const hit = config.TAOBAO_STATUSES.find(k => t.includes(k));
  return hit || t;
}

function absolutize(u) {
  if (!u) return null;
  return u.startsWith('//') ? 'https:' + u : u;
}

function mapMainOrder(o) {
  if (!o || typeof o !== 'object') return null;
  const orderId = String(o.id ?? o.orderId ?? o.bizOrderId ?? (o.orderInfo && o.orderInfo.id) ?? '').trim();
  if (!orderId) return null;
  const seller = o.seller || o.shopInfo || {};
  const status = pickStatus(o);
  const subs = Array.isArray(o.subOrders) ? o.subOrders
    : Array.isArray(o.subOrder) ? o.subOrder
    : Array.isArray(o.itemList) ? o.itemList : [];
  const items = subs.map(mapSubOrder).filter(Boolean);
  return {
    orderId,
    orderTime: o.createTime || (o.orderInfo && o.orderInfo.createTime) || '',
    status,
    amount: pickAmount(o),
    shop: seller.shopName || seller.nick || seller.title || seller.name || '',
    recipient: '',                 // not present on the list; filled from detail later
    parentOrderId: null,
    detailUrl: null,
    source: SOURCE,
    items,
  };
}

function mapSubOrder(s) {
  const info = s.itemInfo || s.item || s;
  const name = info.title || info.name || '';
  if (!name) return null;
  const qty = Number(s.quantity ?? s.buyAmount ?? s.num ?? 1) || 1;
  const price = s.priceInfo || s.price || {};
  const unit = parseMoney(price.realTotal ?? price.price ?? info.price);
  return {
    name,
    qty,
    skuId: String(info.itemId || info.id || info.skuId || '') || null,
    unitPrice: unit != null && qty ? round2(unit / (price.realTotal ? qty : 1)) : (unit ?? null),
  };
}

function pickStatus(o) {
  const cand = (o.statusInfo && (o.statusInfo.text || o.statusInfo.name))
    || (o.orderInfo && (o.orderInfo.statusName || o.orderInfo.status))
    || o.statusName || o.status || '';
  const s = String(cand).trim();
  // Normalize to one of our known status labels when possible.
  const hit = config.TAOBAO_STATUSES.find(k => s.includes(k));
  return hit || s;
}

function pickAmount(o) {
  const pay = o.payInfo || o.priceInfo || {};
  return parseMoney(pay.actualFee ?? pay.realPay ?? pay.totalFee ?? o.actualFee ?? o.payment);
}

/** Parse a money value that may be a number, "￥12.34", "12.34", or cents. */
function parseMoney(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
function round2(n) { return Math.round(n * 100) / 100; }

/** Best-effort: find the deepest array whose items look like orders. */
function findOrdersArray(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v) && v.some(el => el && typeof el === 'object' &&
        (el.subOrders || el.orderInfo || el.id || el.bizOrderId))) {
      return v;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findOrdersArray(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ---- DOM fallback ----------------------------------------------------------
// Runs in the page. Anchored on visible text (order id, ¥, 共X件) rather than
// hashed CSS-module class names, which change on redeploy.
function extractOrdersFromDom() {
  const STATUSES = ['等待付款','等待买家付款','等待发货','等待卖家发货','等待收货','卖家已发货',
    '等待确认收货','交易成功','交易关闭','退款中','退款成功','售后中'];
  // Order rows on the PC page are grouped by an order-id bearing header.
  const blocks = [...document.querySelectorAll('[class*="order"], tbody, .bought-wrapper, [data-testid]')];
  const seen = new Set();
  const out = [];
  for (const b of blocks) {
    const t = (b.innerText || '').replace(/ /g, ' ');
    const idM = t.match(/订单号[:：]?\s*(\d{10,})/);
    if (!idM) continue;
    const orderId = idM[1];
    if (seen.has(orderId)) continue;
    seen.add(orderId);
    const timeM = t.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?/);
    let status = '';
    for (const s of STATUSES) { if (t.includes(s)) { status = s; break; } }
    const amtM = t.match(/(?:实付款|合计|应付)[^\d]*([\d,]+\.\d{2})/) || t.match(/[¥￥]\s*([\d,]+\.\d{2})/);
    const amount = amtM ? parseFloat(amtM[1].replace(/,/g, '')) : null;
    const shopM = t.match(/(?:店铺[:：]?\s*)?([^\n]{2,30}?)(?:旗舰店|专营店|专卖店|官方店)/);
    const items = [];
    for (const a of b.querySelectorAll('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]')) {
      const name = (a.textContent || '').trim();
      const idm = (a.getAttribute('href') || '').match(/id=(\d{6,})/);
      if (name && name.length > 1) items.push({ name, sku: idm ? idm[1] : '', qty: 1 });
    }
    out.push({ orderId, orderTime: timeM ? timeM[0] : '', status, amount,
      shop: shopM ? shopM[0] : '', items });
  }
  return out;
}

function domToOrder(o) {
  return {
    orderId: String(o.orderId),
    orderTime: o.orderTime || '',
    status: o.status || '',
    amount: o.amount ?? null,
    shop: o.shop || '',
    recipient: '',
    parentOrderId: null,
    detailUrl: null,
    source: SOURCE,
    items: (o.items || []).map(i => ({ name: i.name, qty: Number(i.qty || 1), skuId: i.sku || null, unitPrice: null })),
  };
}
