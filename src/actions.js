// Orchestration shared by the CLI and the dashboard: run a browser task,
// serialized so we never open the persistent profile twice at once.
import * as browser from './browser.js';
import * as jd from './scrapers/jd.js';
import * as taobao from './scrapers/taobao.js';
import * as shexp68 from './forwarders/shexp68.js';
import * as db from './db.js';
import * as config from './config.js';

let _chain = Promise.resolve();
let _busy = false;

/** Serialize browser operations (persistent profile can't be launched concurrently). */
export function withLock(fn) {
  const run = _chain.then(async () => {
    _busy = true;
    try { return await fn(); }
    finally { _busy = false; }
  });
  _chain = run.then(() => {}, () => {});
  return run;
}

export function isBusy() { return _busy; }

/** True if the order's status means it is shipped/shipping (JD or Taobao wording). */
export function isInTransit(status) {
  return config.JD_IN_TRANSIT.has(status || '') || config.TAOBAO_IN_TRANSIT.has(status || '');
}

// NOTE: JD's risk control returns 403 for the order-list gateway in HEADLESS
// Chrome (easily fingerprinted). Headed real Chrome returns 200, so scraping
// defaults to headed. shexp68 has no such control but we keep it headed too so
// you can watch the declaration happen.

/** Scrape JD orders and upsert them. Throws Error with .code='jd-login' if not signed in. */
export function scanOrders({ headless = false, waitMs = 4000 } = {}) {
  return withLock(() =>
    browser.withPage({ headless }, async (page) => {
      if (!(await jd.isLoggedIn(page))) {
        const e = new Error('Not logged into JD. Run: node src/cli.js login');
        e.code = 'jd-login';
        throw e;
      }
      const orders = await jd.fetchOrders(page, { waitMs });
      for (const o of orders) db.upsertOrder(o);
      const inTransit = orders.filter(o => config.JD_IN_TRANSIT.has(o.status || '')).length;
      // Auto-capture courier waybill numbers for in-transit orders (clicks 查看物流).
      let tracked = 0;
      let trackingError = null;
      try {
        // Fast path: in-transit orders via the list 查看物流 drawer.
        const tracking = await jd.fetchTracking(page);
        for (const [orderId, t] of Object.entries(tracking)) {
          db.setTracking(orderId, t.trackingNo, t.carrier);
          tracked++;
        }
        // Completed/other shipped orders: fetch via each order's DETAIL page.
        // Only those still missing a 快递单号 (so re-scans stay fast).
        const missing = db.undeclaredParcels().filter(p => !(p.tracking_no || '').trim());
        for (const p of missing) {
          const order = db.getOrder(p.order_id);
          if (!order || !order.detailUrl) continue;
          try {
            const t = await jd.fetchTrackingFromDetail(page, order.detailUrl);
            if (t) { db.setTracking(p.order_id, t.trackingNo, t.carrier); tracked++; }
          } catch { /* skip this order */ }
        }
      } catch (e) { trackingError = e.message; }
      return { count: orders.length, inTransit, tracked, trackingError };
    })
  );
}

/**
 * Scrape Taobao "已买到的宝贝" orders and upsert them. Runs headed by default so a
 * human can solve the slider captcha if it appears. Throws Error with
 * .code='taobao-login' if not signed in.
 * @returns {Promise<{count:number, inTransit:number, captcha:boolean, rawCount:number}>}
 */
export function scanTaobaoOrders({ headless = false, waitMs = 5000 } = {}) {
  return withLock(() =>
    browser.withPage({ headless }, async (page) => {
      // Login is verified via Havana cookies (no navigation needed), so fetchOrders
      // does the single page load — avoids doubling the slider-captcha exposure.
      if (!(await taobao.isLoggedIn(page))) {
        const e = new Error('Not logged into Taobao. Run: node src/cli.js login --only taobao');
        e.code = 'taobao-login';
        throw e;
      }
      const { orders, captcha, rawCount } = await taobao.fetchOrders(page, { waitMs });
      for (const o of orders) db.upsertOrder(o);
      const inTransit = orders.filter(o => config.TAOBAO_IN_TRANSIT.has(o.status || '')).length;
      return { count: orders.length, inTransit, captcha, rawCount };
    })
  );
}

/**
 * Re-fetch the courier waybill for ONE order. Primary method is the order DETAIL
 * page (works for completed orders too); falls back to the list 查看物流 drawer.
 */
export function refetchTracking(orderId, { headless = false } = {}) {
  return withLock(() => {
    const order = db.getOrder(orderId);
    if (order && order.source === 'taobao') {
      const e = new Error('Taobao 快递单号 auto-capture is not supported yet — paste it into the Declare form.');
      e.code = 'no-tracking';
      throw e;
    }
    return browser.withPage({ headless }, async (page) => {
      let t = null;
      if (order && order.detailUrl) t = await jd.fetchTrackingFromDetail(page, order.detailUrl);
      if (!t) {
        await page.goto(config.JD_ORDER_LIST_URL, { waitUntil: 'domcontentloaded' });
        const hasCards = await page.waitForSelector('[class^="orderCard-"]', { timeout: 15000 })
          .then(() => true).catch(() => false);
        if (hasCards) { await page.waitForTimeout(1500); t = await jd.fetchTrackingForOrder(page, orderId); }
      }
      if (!t) {
        const e = new Error('No 快递单号 found (order may not be shipped yet, or not logged into JD).');
        e.code = 'no-tracking';
        throw e;
      }
      db.setTracking(orderId, t.trackingNo, t.carrier);
      return { trackingNo: t.trackingNo, carrier: t.carrier };
    });
  });
}

/**
 * Fill the shexp68 form with explicit (reviewed) values and submit.
 * Throws Error with .code='shexp68-login' if not signed in, 'bad-input' if invalid.
 */
export function submitDeclaration(values, { headless = false } = {}) {
  return withLock(async () => {
    if (!values || !values.orderId) { const e = new Error('orderId required'); e.code = 'bad-input'; throw e; }
    if (!values.trackingNo || !String(values.trackingNo).trim()) {
      const e = new Error('快递单号 is required'); e.code = 'bad-input'; throw e;
    }
    const result = await browser.withPage({ headless }, async (page) => {
      if (!(await shexp68.ensureLoggedIn(page))) {
        const hasCreds = !!(config.SHEXP68_USERNAME && config.SHEXP68_PASSWORD);
        const e = new Error(hasCreds
          ? 'shexp68 auto-login failed — check SHEXP68_USERNAME/PASSWORD in .env.'
          : 'Not logged into shexp68. Add SHEXP68_USERNAME/PASSWORD to .env.');
        e.code = 'shexp68-login';
        throw e;
      }
      // Match-first: if the warehouse already received this parcel (待完善),
      // complete that entry instead of adding a new one (which would be rejected).
      const editUrl = await shexp68.findPendingEditUrl(page, values.trackingNo);
      if (editUrl) {
        const r = await shexp68.completePending(page, editUrl, values);
        return { ...r, mode: 'completed' };
      }
      await shexp68.applyValues(page, values);
      const r = await shexp68.submit(page);
      return { ...r, mode: 'added' };
    });
    if (!result.ok) {
      const e = new Error(`shexp68 rejected: ${result.message}`);
      e.code = 'submit-rejected';
      throw e;
    }
    db.markDeclared(values.orderId, values.remark || '');
    return { result: result.message, mode: result.mode };
  });
}
