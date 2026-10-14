// JD order-list scraper.
//
// We do NOT re-implement JD's request signing (h5st / x-api-eid-token). We render
// order.jd.com in the logged-in persistent profile and let the page make its own
// signed gateway call (functionId=pcorder_center_list), then parse that JSON
// response authoritatively. A text-anchored DOM parser is kept as a fallback.
//
// IMPORTANT: JD risk-control returns 403 for this gateway in HEADLESS Chrome, so
// the caller must run headed (see actions.js).
import fs from 'node:fs';
import path from 'node:path';
import * as config from '../config.js';

const LIST_FN = 'pcorder_center_list';

export async function isLoggedIn(page) {
  if (config.JD_LOGIN_HOSTS.some(h => page.url().includes(h))) return false;
  // Logged-in order center renders the account pin in the header chrome.
  try {
    await page.waitForLoadState('domcontentloaded');
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 400));
    if (/请登录|立即登录/.test(txt) && !/我的订单/.test(txt)) return false;
    return true;
  } catch {
    return !config.JD_LOGIN_HOSTS.some(h => page.url().includes(h));
  }
}

export async function fetchOrders(page, { waitMs = 4000, dumpRaw = true } = {}) {
  const rawHits = [];

  // Capture every pcorder_* gateway response for the raw dump + JSON parse.
  const pending = [];
  const handler = (resp) => {
    const url = resp.url();
    if (!url.includes(config.JD_GATEWAY_HOST) || !url.includes('functionId=')) return;
    if (!config.JD_ORDER_FUNCTION_PREFIXES.some(fn => url.includes(fn))) return;
    pending.push(resp.text().then(
      body => rawHits.push({ functionId: extractFunctionId(url), status: resp.status(), body }),
      () => {}
    ));
  };
  page.on('response', handler);

  await page.goto(config.JD_ORDER_LIST_URL, { waitUntil: 'domcontentloaded' });
  try { await page.waitForSelector('[class^="orderCard-"]', { timeout: 15000 }); } catch {}
  await page.waitForTimeout(waitMs);

  page.off('response', handler);
  await Promise.allSettled(pending);

  if (dumpRaw && rawHits.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(config.RAW_DIR, `gateway_${stamp}.json`),
      JSON.stringify(rawHits, null, 2), 'utf-8');
  }

  // Prefer authoritative JSON from the list endpoint.
  const listHit = rawHits.find(h => h.functionId === LIST_FN && h.status === 200 && h.body);
  if (listHit) {
    const orders = parseOrderListJson(listHit.body);
    if (orders.length) return orders;
  }

  // Fallback: text-anchored DOM parse (used if the JSON wasn't captured).
  const raw = await page.evaluate(extractOrdersFromDom);
  return raw.map(domToOrder);
}

const TRACE_FN = 'pcorder_center_traceMultiPackage';

/**
 * Capture courier waybill numbers for the in-transit orders on the currently
 * loaded order-list page. Clicks each "查看物流" (checkLogistics) span so the
 * page fires its own signed tracking call, then parses the response.
 * @returns {Promise<Record<string,{trackingNo:string,carrier:string,packages:{shipId:string,carrier:string}[]}>>}
 */
export async function fetchTracking(page) {
  const bodies = [];
  const pending = [];
  const handler = (resp) => {
    if (!resp.url().includes(TRACE_FN)) return;
    pending.push(resp.text().then(b => bodies.push(b), () => {}));
  };
  page.on('response', handler);

  const spans = page.locator('span[class^="checkLogistics-"]');
  const n = await spans.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const s = spans.nth(i);
    try {
      await s.scrollIntoViewIfNeeded();
      await s.click({ timeout: 5000 });
      await page.waitForTimeout(1500);              // let the trace call return
      await page.keyboard.press('Escape').catch(() => {});
      // Some skins use a close icon rather than Escape:
      await page.locator('[class*="close"]:visible').first().click({ timeout: 800 }).catch(() => {});
      await page.waitForTimeout(400);
    } catch { /* overlay may block; continue */ }
  }

  page.off('response', handler);
  await Promise.allSettled(pending);

  const out = {};
  for (const b of bodies) {
    const parsed = parseTrace(b);
    if (parsed && parsed.orderId) out[parsed.orderId] = parsed;
  }
  return out;
}

/**
 * Fetch tracking for a SINGLE order on the currently loaded order-list page.
 * Clicks that order card's 查看物流 span and parses the trace response.
 */
export async function fetchTrackingForOrder(page, orderId) {
  const bodies = [];
  const pending = [];
  const handler = (resp) => {
    if (resp.url().includes(TRACE_FN)) pending.push(resp.text().then(b => bodies.push(b), () => {}));
  };
  page.on('response', handler);
  try {
    const card = page.locator('[class^="orderCard-"]').filter({ hasText: String(orderId) }).first();
    const span = card.locator('span[class^="checkLogistics-"]').first();
    await span.scrollIntoViewIfNeeded();
    await span.click({ timeout: 6000 });
    await page.waitForTimeout(1800);
    await page.keyboard.press('Escape').catch(() => {});
  } catch { /* no 查看物流 for this order (e.g. not shipped) */ }
  page.off('response', handler);
  await Promise.allSettled(pending);

  for (const b of bodies) { const p = parseTrace(b); if (p && p.orderId === String(orderId)) return p; }
  for (const b of bodies) { const p = parseTrace(b); if (p) return p; }  // fallback
  return null;
}

/**
 * Fetch tracking from an order's DETAIL page (details.jd.com/normal/item.action?orderid=..&PassKey=..).
 * Works for COMPLETED orders (which have no 查看物流 drawer on the list). Reads the rendered
 * "货运单号 / 承运人 / 送货方式" text. Must run headed (JD 403s headless).
 */
export async function fetchTrackingFromDetail(page, detailUrl) {
  if (!detailUrl) return null;
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
  try { await page.waitForFunction(() => /货运单号|运单号/.test(document.body.innerText), { timeout: 12000 }); } catch {}
  const text = await page.evaluate(() => document.body.innerText || '');

  const wm = text.match(/(?:货运单号|运单号|物流单号)[：:\s]*([A-Za-z0-9]{6,})/);
  if (!wm) return null;
  const trackingNo = wm[1];
  // Prefer 承运人 (real carrier, e.g. 中通快递); non-greedy stops at the 快递/速递/物流 suffix
  // so "京东快递快递咨询" -> "京东快递". Fall back to 送货方式 (may be generic like 快递运输).
  const cm = text.match(/承运人[：:\s]*([一-龥]{2,8}?(?:速递|快递|物流))/)
          || text.match(/送货方式[：:\s]*([^\s|：:]+)/);
  const carrier = cm ? cm[1] : '';
  return { trackingNo, carrier, packages: [{ shipId: trackingNo, carrier }] };
}

function normalizeUrl(u) {
  if (!u) return null;
  return u.startsWith('//') ? 'https:' + u : u;
}

/** Parse a pcorder_center_traceMultiPackage body → {orderId, trackingNo, carrier, packages[]}. */
export function parseTrace(bodyText) {
  let body;
  try { body = JSON.parse(bodyText); } catch { return null; }
  const groups = body && body.data && body.data.orderTrackGroupInfoList;
  if (!Array.isArray(groups) || !groups.length) return null;
  const packages = groups
    .filter(g => g.shipId)
    .map(g => ({ shipId: String(g.shipId), carrier: g.thirdName || '' }));
  if (!packages.length) return null;
  // Derive the orderId from any tracking event.
  let orderId = '';
  for (const g of groups) {
    const ev = (g.orderTrackInfoList || [])[0];
    if (ev && ev.id) { orderId = String(ev.id); break; }
  }
  return { orderId, trackingNo: packages[0].shipId, carrier: packages[0].carrier, packages };
}

/** Parse the pcorder_center_list JSON body into order objects. */
export function parseOrderListJson(bodyText) {
  let body;
  try { body = JSON.parse(bodyText); } catch { return []; }
  const list = body && body.data && body.data.orderList;
  if (!Array.isArray(list)) return [];
  return list.map(o => ({
    orderId: String(o.orderId),
    orderTime: o.dateSubmit || '',
    status: (o.statusInfo && o.statusInfo.orderStateName) || '',
    amount: pickAmount(o.itemPayInfo),
    shop: (o.shopInfo && o.shopInfo.shopName) || '',
    recipient: (o.consigneeInfo && o.consigneeInfo.customerName) || '',
    parentOrderId: o.parentId && o.parentId !== '0' ? String(o.parentId) : null,
    showOrderTrack: !!o.showOrderTrack,
    detailUrl: normalizeUrl(o.itemDetail && o.itemDetail.itemUrl),
    items: (o.wareList || []).map(w => ({
      name: w.name,
      qty: Number(w.num || 1),
      skuId: w.productId ? String(w.productId) : null,
      unitPrice: null,
    })),
  }));
}

function pickAmount(pay) {
  if (!pay) return null;
  if (typeof pay.shouldPay === 'number') return pay.shouldPay;
  const f = parseFloat(pay.fistPrice);
  return Number.isFinite(f) ? f : null;
}

function extractFunctionId(url) {
  const m = url.match(/functionId=([a-zA-Z0-9_]+)/);
  return m ? m[1] : 'unknown';
}

// ---- DOM fallback ----------------------------------------------------------
// Anchored on visible labels; only used if the JSON response wasn't captured.
function extractOrdersFromDom() {
  const cards = [...document.querySelectorAll('[class^="orderCard-"], [class*=" orderCard-"]')];
  const STATUSES = ['等待付款','待付款','等待收货','待收货','等待发货','待发货','已发货','已完成','已取消','待评价','退款','售后'];
  function parseCard(card) {
    const t = (card.innerText || '').replace(/ /g, ' ');
    let orderId = '';
    const m = t.match(/订单号\s*[:：]?\s*(\d{8,})/);
    if (m) orderId = m[1];
    const isParent = /拆单|由于商品存储的库房不同/.test(t);
    const timeM = t.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
    let status = '';
    for (const s of STATUSES) { if (t.includes(s)) { status = s; break; } }
    const amtM = t.match(/¥\s*([\d,]+(?:\s*\.\s*\d{1,2})?)/);
    const amount = amtM ? parseFloat(amtM[1].replace(/[,\s]/g, '')) : null;
    const items = [];
    for (const a of card.querySelectorAll('a[href*="item.jd.com"]')) {
      const name = (a.textContent || '').trim();
      const sm = (a.getAttribute('href') || '').match(/(\d{6,})\.html/);
      if (name) items.push({ name, sku: sm ? sm[1] : '', qty: 1 });
    }
    return { orderId, isParent, orderTime: timeM ? timeM[0] : '', status, amount, items };
  }
  return cards.map(parseCard).filter(o => o.orderId && !o.isParent);
}

function domToOrder(o) {
  return {
    orderId: String(o.orderId),
    orderTime: o.orderTime || '',
    status: o.status || '',
    amount: o.amount ?? null,
    shop: '',
    recipient: '',
    items: (o.items || []).map(i => ({ name: i.name, qty: Number(i.qty || 1), skuId: i.sku || null, unitPrice: null })),
  };
}
