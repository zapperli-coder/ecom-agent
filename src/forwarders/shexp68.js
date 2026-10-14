// shexp68 (盛世领航) forwarder — parcel pre-declaration (添加包裹).
//
// Form (users.php?act=addlist):
//   集运仓库 <select>  ; 快递单号 <input required> ; 品名/单价/数量 <input>×N ;
//   备注 <textarea> ; 提交 <button type=submit>
//
// fill() populates and reads the form back but never submits — the CLI shows the
// values and asks you to confirm each submit.
import * as config from '../config.js';

const TRACKING_SEL = 'input[placeholder*="快递单号"]';
const REMARK_SEL = 'textarea';

export async function openAddForm(page) {
  await page.goto(config.SHEXP68_ADD_URL, { waitUntil: 'domcontentloaded', timeout: config.SHEXP68_NAV_TIMEOUT });
  await page.waitForSelector(TRACKING_SEL, { timeout: 15000 });
}

export async function isLoggedIn(page) {
  await page.goto(config.SHEXP68_USER_URL, { waitUntil: 'domcontentloaded', timeout: config.SHEXP68_NAV_TIMEOUT });
  try {
    await page.waitForSelector('text=会员号', { timeout: 6000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Automated account login on the PC site (username/password from .env).
 * Sets a session cookie for www.shexp68.com that the /mobile/ pages share.
 * Returns true if login succeeded. No creds in .env → returns false (no-op).
 */
export async function login(page) {
  if (!config.SHEXP68_USERNAME || !config.SHEXP68_PASSWORD) return false;

  // The site pops an alert() on bad credentials — capture it so we don't hang.
  const dialogs = [];
  const onDialog = async (d) => { dialogs.push(d.message()); await d.accept(); };
  page.on('dialog', onDialog);

  try {
    await page.goto(config.SHEXP68_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: config.SHEXP68_NAV_TIMEOUT });
    const form = page.locator('form:has(input[type="password"])').first();
    const user = form.locator('input[name="username"]');
    await user.waitFor({ state: 'visible', timeout: 10000 });
    await user.fill(config.SHEXP68_USERNAME);
    await form.locator('input[name="password"]').fill(config.SHEXP68_PASSWORD);
    await Promise.allSettled([
      page.waitForNavigation({ timeout: config.SHEXP68_NAV_TIMEOUT }).catch(() => {}),
      form.locator('input[type="submit"], input[name="submit"]').first().click({ timeout: 5000 }),
    ]);
    await page.waitForTimeout(1500);
  } finally {
    page.off('dialog', onDialog);
  }
  if (dialogs.length) return false;      // e.g. "账号或密码错误"
  return isLoggedIn(page);
}

/** True if already logged in, else attempt automated login. */
export async function ensureLoggedIn(page) {
  if (await isLoggedIn(page)) return true;
  return login(page);
}

/**
 * Compute the prefill values for a parcel WITHOUT touching a browser.
 * Used by the CLI and by the dashboard's review modal.
 * @returns {{warehouse:string, trackingNo:string, itemName:string, unitPrice:string, qty:string, remark:string}}
 */
export function valuesFromParcel(parcel) {
  const { name, unitPrice, qty } = summarizeItems(parcel);
  return {
    warehouse: parcel.warehouse || config.SHEXP68_DEFAULT_WAREHOUSE,
    trackingNo: parcel.trackingNo || '',
    itemName: name,
    unitPrice,
    qty,
    remark: parcel.remark || orderLabel(parcel.source, parcel.orderId),
  };
}

/** "JD#123" / "TB#456" — identifies the source order in the shexp68 备注. */
export function orderLabel(source, orderId) {
  return `${config.SOURCE_LABELS[source] || 'JD'}#${orderId}`;
}

/**
 * Open the form and fill it with explicit values. Does NOT submit.
 * Returns the read-back values.
 */
export async function applyValues(page, values) {
  if (!values.trackingNo) throw new Error('快递单号 (trackingNo) is required');
  await openAddForm(page);

  const warehouse = values.warehouse || config.SHEXP68_DEFAULT_WAREHOUSE;
  const value = config.SHEXP68_WAREHOUSES[warehouse];
  try {
    if (!value) throw new Error('no known option value');
    await page.selectOption('select', { value });
  } catch {
    await page.selectOption('select', { label: warehouse });
  }

  await page.fill(TRACKING_SEL, values.trackingNo);

  const rowIdx = await itemRowIndices(page);
  const inputs = page.locator('input[type="text"]');
  if (rowIdx.length >= 3) {
    await inputs.nth(rowIdx[0]).fill(values.itemName ?? '');
    await inputs.nth(rowIdx[1]).fill(String(values.unitPrice ?? ''));
    await inputs.nth(rowIdx[2]).fill(String(values.qty ?? ''));
  }

  const remark = values.remark ?? '';
  try { await page.fill(REMARK_SEL, remark); } catch {}

  return {
    warehouse,
    trackingNo: await page.inputValue(TRACKING_SEL),
    itemName: values.itemName ?? '',
    unitPrice: String(values.unitPrice ?? ''),
    qty: String(values.qty ?? ''),
    remark,
  };
}

const ERR_RE = /不能为空|错误|失败|请输入|请选择|已存在|重复|无效|不正确/;
const OK_RE = /成功|success/i;
const PENDING_LIST_URL = 'http://www.shexp68.com/mobile/users.php?act=order_list&mark=4'; // 待完善

/** Click a submit control, capture any dialog, and judge whether shexp68 accepted it. */
async function clickAndJudge(page, locator, formMarker) {
  const messages = [];
  const onDialog = async (d) => { messages.push(d.message()); await d.accept(); };
  page.on('dialog', onDialog);
  await locator.click({ timeout: 10000 });
  await page.waitForTimeout(2500);
  page.off('dialog', onDialog);

  const message = messages.join(' | ');
  let ok;
  if (message) ok = OK_RE.test(message) ? true : !ERR_RE.test(message) && false;
  else ok = !page.url().includes(formMarker);  // success redirects off the form
  return { ok, message: message || (ok ? 'submitted (redirected)' : 'no confirmation dialog') };
}

/** Click 提交 on the 添加包裹 (new pre-declaration) form. */
export async function submit(page) {
  const inForm = page.locator('form:has(input[placeholder*="快递单号"]) input[type="submit"]');
  const btn = (await inForm.count()) > 0
    ? inForm.first()
    : page.locator('input[type="submit"][value="提交"], button:has-text("提交")').first();
  return clickAndJudge(page, btn, 'addlist');
}

/**
 * Search the 待完善 list for a parcel already received by the warehouse matching
 * this 快递单号. Returns its 修改信息 edit URL (act=order_detail) or null.
 */
export async function findPendingEditUrl(page, trackingNo) {
  const map = await pendingMap(page);
  const oid = map.get(trackingNo);
  return oid ? `http://www.shexp68.com/mobile/users.php?act=order_detail&order_id=${oid}` : null;
}

/** Build a Map<快递单号, shexp68 order_id> across all pages of the 待完善 list. */
export async function pendingMap(page) {
  const map = new Map();
  for (let pg = 1; pg <= 8; pg++) {
    await page.goto(`${PENDING_LIST_URL}&page=${pg}`, { waitUntil: 'domcontentloaded', timeout: config.SHEXP68_NAV_TIMEOUT });
    // The list renders its rows after load; wait for the first entry link.
    await page.waitForSelector('a[href*="income_show"]', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(500);
    const rows = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('a[href*="income_show"]').forEach((a) => {
        let el = a;
        for (let i = 0; i < 6 && el; i++) { if (/单号/.test(el.textContent || '')) break; el = el.parentElement; }
        const tm = (el && el.textContent || '').match(/单号[：:]\s*([A-Za-z0-9]{6,})/);
        const om = (a.getAttribute('href') || '').match(/order_id=(\d+)/);
        if (tm && om) out.push([tm[1], om[1]]);
      });
      return out;
    });
    if (!rows.length) break;
    for (const [t, oid] of rows) if (!map.has(t)) map.set(t, oid);
  }
  return map;
}

/** Complete (完善) an already-received 待完善 parcel: fill 品名/单价/数量 and 确认修改. */
export async function completePending(page, editUrl, values) {
  await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: config.SHEXP68_NAV_TIMEOUT });
  await page.waitForSelector('input[name="pname_1"]', { timeout: 12000 });
  await page.fill('input[name="pname_1"]', values.itemName ?? '');
  await page.fill('input[name="pvalue_1"]', String(values.unitPrice ?? ''));
  await page.fill('input[name="pnums_1"]', String(values.qty ?? ''));
  if (values.remark) { try { await page.fill('textarea[name="content"]', values.remark); } catch {} }
  const btn = page.locator('input[type="submit"][value="确认修改"], input[value="确认修改"]').first();
  return clickAndJudge(page, btn, 'order_detail');
}

async function itemRowIndices(page) {
  const inputs = page.locator('input[type="text"]');
  const n = await inputs.count();
  const idx = [];
  for (let i = 0; i < n; i++) {
    const ph = (await inputs.nth(i).getAttribute('placeholder')) || '';
    if (!ph.includes('快递单号')) idx.push(i);
  }
  return idx;
}

function summarizeItems(parcel) {
  const items = parcel.items || [];
  const totalQty = items.reduce((s, i) => s + (i.qty || 0), 0) || 1;
  let name;
  if (items.length) {
    name = items[0].name.slice(0, config.DECLARE_NAME_MAXLEN);
    if (items.length > 1) name = (name + '等').slice(0, config.DECLARE_NAME_MAXLEN);
  } else {
    name = '杂货';
  }
  // shexp68 requires a non-empty 单价. Use item price if known, else order amount / qty.
  let unitPrice = '';
  const priced = items.find(i => i.unitPrice != null);
  if (priced) unitPrice = String(priced.unitPrice);
  else if (parcel.amount != null) unitPrice = (Number(parcel.amount) / totalQty).toFixed(2);
  return { name, unitPrice, qty: String(totalQty) };
}
