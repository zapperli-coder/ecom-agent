// Central configuration: paths, URLs, and site-specific constants.
// The fragile bits (URLs, warehouse ids) live here so they are easy to update
// when JD or shexp68 change.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');

// Load each user's own settings from .env (gitignored, never shipped). Template: .env.example.
const ENV_PATH = path.join(ROOT, '.env');
try { if (fs.existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH); } catch { /* ignore malformed .env */ }

// All personal state (login profile, DB, raw dumps) lives here. ECOM_DATA_DIR overrides it.
export const DATA_DIR = path.resolve(ROOT, process.env.ECOM_DATA_DIR || 'data');
export const PROFILE_DIR = path.join(DATA_DIR, 'pw-profile'); // Playwright persistent login
export const RAW_DIR = path.join(DATA_DIR, 'raw');            // raw gateway JSON dumps
export const DB_PATH = path.join(DATA_DIR, 'ecom.db');

for (const d of [DATA_DIR, PROFILE_DIR, RAW_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// --- JD ---------------------------------------------------------------------
export const JD_ORDER_LIST_URL = 'https://order.jd.com/center/list.action';
export const JD_LOGIN_HOSTS = ['passport.jd.com', 'plogin.m.jd.com'];
export const JD_GATEWAY_HOST = 'api.m.jd.com';
export const JD_ORDER_FUNCTION_PREFIXES = ['pcorder_', 'pcorderop_'];

export const JD_STATUSES = [
  '等待付款', '待付款',
  '等待收货', '待收货',
  '等待发货', '待发货',
  '已发货', '已完成', '已取消', '待评价', '退款', '售后',
];
// Statuses that mean "in transit" -> candidates for pre-declaration & delivery watch.
export const JD_IN_TRANSIT = new Set(['等待收货', '待收货', '已发货', '等待发货', '待发货']);

// --- Taobao / Tmall ---------------------------------------------------------
export const TAOBAO_LOGIN_URL = 'https://login.taobao.com/';
export const TAOBAO_ORDER_LIST_URL = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
export const TAOBAO_GATEWAY_HOST = 'h5api.m.taobao.com';   // mtop XHR gateway (signed; do not replay)
// Cookies that indicate an authenticated Taobao session. Set by the Havana login
// system on login.taobao.com immediately after sign-in (before any trade page is
// visited), so they are the reliable signal. `_tb_token_`/`unb`/`cookie2` only
// appear once the buyertrade/order domain is loaded, so they are NOT used here.
export const TAOBAO_LOGIN_COOKIES = ['sgcookie', 'lgc', 'tracknick'];
// mtop XHR functions the "已买到的宝贝" page fires; captured for the raw dump + parse.
// (The exact function name varies by rollout — match on any of these substrings.)
export const TAOBAO_ORDER_FUNCTION_HINTS = ['getpurchaselist', 'getboughtlist', 'querybought', 'orderlist'];

export const TAOBAO_STATUSES = [
  '等待付款', '等待买家付款',
  '等待发货', '等待卖家发货',
  '等待收货', '卖家已发货', '等待确认收货',
  '交易成功', '交易关闭', '退款中', '退款成功', '售后中',
];
// Statuses meaning "in transit" -> candidates for pre-declaration & delivery watch.
export const TAOBAO_IN_TRANSIT = new Set(['等待收货', '卖家已发货', '等待确认收货']);

// --- shexp68 (盛世领航 forwarder) -------------------------------------------
export const SHEXP68_LOGIN_URL = 'http://www.shexp68.com/mobile/users.php?act=profile'; // mobile account-login form
export const SHEXP68_USER_URL = 'http://www.shexp68.com/mobile/users.php';
export const SHEXP68_NAV_TIMEOUT = 60000;   // the site is slow; give navigations room
// Credentials for automated account login (from .env — NEVER hard-code here).
export const SHEXP68_USERNAME = process.env.SHEXP68_USERNAME || '';
export const SHEXP68_PASSWORD = process.env.SHEXP68_PASSWORD || '';
export const SHEXP68_ADD_URL = 'http://www.shexp68.com/mobile/users.php?act=addlist';
// 集运仓库 <select> label → option value on the 添加包裹 form. Labels not listed here
// are still selectable by label, so SHEXP68_WAREHOUSE in .env can name any warehouse.
export const SHEXP68_WAREHOUSES = { '深圳集运仓库': '5' };
export const SHEXP68_DEFAULT_WAREHOUSE = (process.env.SHEXP68_WAREHOUSE || '').trim() || '深圳集运仓库';
if (!(SHEXP68_DEFAULT_WAREHOUSE in SHEXP68_WAREHOUSES)) SHEXP68_WAREHOUSES[SHEXP68_DEFAULT_WAREHOUSE] = null;

// Short label per order source, used in the default 备注 so the warehouse can tell parcels apart.
export const SOURCE_LABELS = { jd: 'JD', taobao: 'TB' };

export const DECLARE_NAME_MAXLEN = 20;
