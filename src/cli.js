#!/usr/bin/env node
// eCom Agent CLI.
//   login | sync | orders | set-tracking | declare | dashboard
// Run: node src/cli.js <command> [options]   (or: npm run ecom -- <command>)

// Silence node:sqlite's experimental warning (DB is constructed at runtime).
const _emit = process.emitWarning.bind(process);
process.emitWarning = (w, ...a) => {
  if (String(w).includes('SQLite is an experimental')) return;
  return _emit(w, ...a);
};

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as config from './config.js';
import * as db from './db.js';
import * as browser from './browser.js';
import * as shexp68 from './forwarders/shexp68.js';
import * as actions from './actions.js';
import { serve } from './dashboard.js';

const c = {
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
};

async function ask(question) {
  const rl = readline.createInterface({ input, output });
  const ans = await rl.question(question);
  rl.close();
  return ans;
}
async function confirm(question) {
  const ans = (await ask(`${question} [y/N] `)).trim().toLowerCase();
  return ans === 'y' || ans === 'yes';
}

// ---- commands --------------------------------------------------------------

async function cmdLogin(opts) {
  const maxMs = Number(opts.wait ?? 300) * 1000;
  // --only lets you re-log a single site (jd | taobao | shexp68) without touching the others.
  const only = opts.only ? String(opts.only).toLowerCase() : null;
  const want = { jd: !only || only === 'jd', taobao: !only || only === 'taobao', shexp68: !only || only === 'shexp68' };

  console.log(c.bold('Opening browser.') + ' Log into: ' +
    [want.jd && 'JD', want.taobao && 'Taobao', want.shexp68 && 'shexp68'].filter(Boolean).join(', ') + '.');
  console.log(c.dim('It auto-detects each login and saves the session — no need to press Enter.'));
  await browser.withContext({ headless: false }, async (ctx) => {
    const first = ctx.pages()[0] ?? (await ctx.newPage());
    let pJd = null, pTb = null, pSh = null;
    if (want.jd)      { pJd = first; await pJd.goto(config.JD_ORDER_LIST_URL).catch(() => {}); }
    if (want.taobao)  { pTb = want.jd ? await ctx.newPage() : first; await pTb.goto(config.TAOBAO_LOGIN_URL).catch(() => {}); }
    if (want.shexp68) { pSh = (want.jd || want.taobao) ? await ctx.newPage() : first; await pSh.goto(config.SHEXP68_USER_URL).catch(() => {}); }

    const start = Date.now();
    let jdOk = !want.jd, tbOk = !want.taobao, shOk = !want.shexp68, lastReload = 0;
    const anchor = pJd ?? pTb ?? pSh;
    while (Date.now() - start < maxMs) {
      if (want.jd && !jdOk) {
        const cookies = await ctx.cookies('https://order.jd.com').catch(() => []);
        jdOk = cookies.some(ck => ck.name === 'pt_key' && ck.value);
      }
      if (want.taobao && !tbOk) {
        const cookies = await ctx.cookies('https://buyertrade.taobao.com').catch(() => []);
        tbOk = config.TAOBAO_LOGIN_COOKIES.every(n => cookies.some(ck => ck.name === n && ck.value));
      }
      if (want.shexp68 && !shOk) {
        shOk = await pSh.getByText('会员号').first().isVisible().catch(() => false);
        // Gently reload shexp68 every ~12s in case login redirected elsewhere.
        if (!shOk && Date.now() - lastReload > 12000) { lastReload = Date.now(); await pSh.reload().catch(() => {}); }
      }
      const st = s => s ? c.green('OK ') : '... ';
      process.stdout.write('\r  ' +
        [want.jd && `JD: ${st(jdOk)}`, want.taobao && `Taobao: ${st(tbOk)}`, want.shexp68 && `shexp68: ${st(shOk)}`]
          .filter(Boolean).join('  ') + '   ');
      if (jdOk && tbOk && shOk) break;
      await anchor.waitForTimeout(2000).catch(() => {});
    }
    process.stdout.write('\n');
    if (jdOk && tbOk && shOk) console.log(c.green('All requested sites logged in — session saved.') + ' You can now run `sync`.');
    else console.log(c.yellow(`Timed out (JD=${jdOk}, Taobao=${tbOk}, shexp68=${shOk}).`) +
      ' Re-run `login --only <site>` for whichever is still pending.');
  });
}

async function cmdSync(opts) {
  const source = (opts.source ?? 'jd').toLowerCase();
  if (source === 'taobao') return cmdSyncTaobao(opts);
  if (source !== 'jd') { console.log(c.red(`Unknown --source ${source}`) + ' (use jd | taobao)'); process.exitCode = 1; return; }
  try {
    const r = await actions.scanOrders({ waitMs: Number(opts.wait ?? 4000) });
    if (!r.count) {
      console.log(c.yellow('No orders parsed.') + ' Raw gateway JSON saved to data/raw for inspection.');
      return;
    }
    console.log(c.green(`Synced ${r.count} orders`) + `, captured ${c.bold(r.tracked)} tracking number(s).`);
    printOrders(db.listOrders());
  } catch (e) {
    if (e.code === 'jd-login') console.log(c.red('Not logged into JD.') + ' Run `login` first.');
    else console.log(c.red('Sync failed: ') + e.message);
    process.exitCode = 1;
  }
}

async function cmdSyncTaobao(opts) {
  try {
    const r = await actions.scanTaobaoOrders({ waitMs: Number(opts.wait ?? 5000) });
    if (r.captcha) {
      console.log(c.yellow('Taobao showed a slider/security check.') +
        ' Solve it in the browser window, then re-run `sync --source taobao`.');
    }
    if (!r.count) {
      console.log(c.yellow('No Taobao orders parsed.') +
        ` ${r.rawCount} mtop response(s) captured — raw JSON saved to data/raw/taobao_*.json for inspection.`);
      return;
    }
    console.log(c.green(`Synced ${r.count} Taobao orders`) + `, ${c.bold(r.inTransit)} in transit.`);
    printOrders(db.listOrders());
  } catch (e) {
    if (e.code === 'taobao-login') console.log(c.red('Not logged into Taobao.') + ' Run `login --only taobao` first.');
    else console.log(c.red('Taobao sync failed: ') + e.message);
    process.exitCode = 1;
  }
}

function cmdOrders(opts) {
  const rows = db.listOrders(opts.status ?? null);
  if (!rows.length) { console.log(c.yellow('No orders in DB.') + ' Run `sync`.'); return; }
  printOrders(rows);
}

function cmdSetTracking(args) {
  const [orderId, trackingNo] = args._;
  if (!orderId || !trackingNo) { console.log(c.red('usage: set-tracking <order_id> <tracking_no> [--carrier X]')); return; }
  if (!db.getOrder(orderId)) { console.log(c.red(`Unknown order ${orderId}.`)); process.exitCode = 1; return; }
  db.setTracking(orderId, trackingNo, args.carrier ?? '');
  console.log(c.green('Tracking set') + ` for ${orderId}: ${trackingNo} ${args.carrier ?? ''}`);
}

async function cmdDeclare(opts) {
  let pending = db.undeclaredParcels();
  if (opts.order) pending = pending.filter(p => p.order_id === opts.order);
  const ready = pending.filter(p => (p.tracking_no || '').trim());
  const missing = pending.filter(p => !(p.tracking_no || '').trim());

  if (missing.length) {
    console.log(c.yellow(`${missing.length} undeclared parcels have no 快递单号`) +
      ` (use \`set-tracking <order_id> <no>\`): ` + missing.slice(0, 10).map(p => p.order_id).join(', '));
  }
  if (!ready.length) { console.log(c.yellow('Nothing ready to declare.')); return; }

  console.log(c.bold(`${ready.length} parcel(s) ready to declare.`));
  for (const p of ready) await declareOne(p, !!opts.yes);
}

/**
 * Show the derived values, confirm, then submit via actions.submitDeclaration — the
 * same path as the dashboard (auto-login from .env, completes 待完善 entries first).
 */
async function declareOne(p, autoYes) {
  const order = db.getOrder(p.order_id);
  const values = {
    orderId: p.order_id,
    ...shexp68.valuesFromParcel({
      orderId: p.order_id,
      source: order ? order.source : 'jd',
      trackingNo: p.tracking_no,
      warehouse: p.warehouse || config.SHEXP68_DEFAULT_WAREHOUSE,
      items: order ? order.items : [],
      amount: order ? order.amount : null,
    }),
  };
  const label = shexp68.orderLabel(order ? order.source : 'jd', p.order_id);

  console.log('\n' + c.bold(`Declare parcel for ${label}`));
  console.log(`  集运仓库   ${values.warehouse}`);
  console.log(`  快递单号   ${values.trackingNo}`);
  console.log(`  品名/单价  ${values.itemName}  ¥${values.unitPrice} ×${values.qty}`);
  console.log(`  备注       ${values.remark}`);

  if (!autoYes && !(await confirm('Submit this declaration?'))) {
    console.log(c.dim('Skipped.'));
    return;
  }
  try {
    const r = await actions.submitDeclaration(values);
    console.log(c.green(r.mode === 'completed' ? 'Completed 待完善 entry' : 'Submitted') + ` ${label} → ${r.result}`);
  } catch (e) {
    console.log(c.red(`${label}: `) + e.message);
    if (e.code === 'shexp68-login') process.exitCode = 1;
  }
}

async function cmdShexpLogin() {
  if (!config.SHEXP68_USERNAME || !config.SHEXP68_PASSWORD) {
    console.log(c.red('No shexp68 credentials.') + ' Add SHEXP68_USERNAME/PASSWORD to .env (see .env.example).');
    process.exitCode = 1;
    return;
  }
  console.log(`Logging into shexp68 as ${c.bold(config.SHEXP68_USERNAME)} …`);
  await browser.withPage({ headless: false }, async (page) => {
    const ok = await shexp68.ensureLoggedIn(page);
    console.log(ok
      ? c.green('shexp68 login OK.') + c.dim(' (auto-logs-in before each declare — the session cookie is not persisted)')
      : c.red('Login failed — check credentials in .env.'));
    if (!ok) process.exitCode = 1;
  });
}

function cmdDashboard(opts) {
  serve({ port: Number(opts.port ?? 8765), openBrowser: !opts['no-open'] });
}

// ---- helpers ---------------------------------------------------------------

function printOrders(rows) {
  const head = ['Order#', 'Time', 'Status', '¥', 'Items', 'Shop'];
  const data = rows.map(o => [
    o.orderId,
    o.orderTime || '',
    o.status || '-',
    o.amount != null ? o.amount.toFixed(2) : '-',
    (o.items || []).slice(0, 3).map(i => `${i.name.slice(0, 16)}×${i.qty}`).join('; ') || '-',
    o.shop || '-',
  ]);
  const widths = head.map((h, i) => Math.max(dispLen(h), ...data.map(r => dispLen(r[i]))));
  const line = cells => cells.map((v, i) => pad(v, widths[i])).join('  ');
  console.log(c.bold(line(head)));
  for (const r of data) console.log(line(r));
}
// Rough display width: CJK counts as 2 columns.
function dispLen(s) { let n = 0; for (const ch of String(s)) n += ch.charCodeAt(0) > 0x2e7f ? 2 : 1; return n; }
function pad(s, w) { return String(s) + ' '.repeat(Math.max(0, w - dispLen(s))); }

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const HELP = `eCom Agent — sync JD / Taobao orders and pre-declare them into shexp68

Commands:
  login [--only jd|taobao|shexp68]  headed browser to log into JD + Taobao + shexp68 (once)
  sync [--source jd|taobao] [--wait 4000]   scrape orders into the local DB (default jd)
  orders [--status 等待收货]    list stored orders
  set-tracking <id> <no> [--carrier X]   record a courier tracking number
  declare [--order <id>] [--yes]         pre-declare parcels into shexp68 (confirm each)
  shexp68-login                          test automated shexp68 login (creds from .env)
  dashboard [--port 8765] [--no-open]    serve the live web dashboard`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case 'login': return cmdLogin(args);
    case 'sync': return cmdSync(args);
    case 'orders': return cmdOrders(args);
    case 'set-tracking': return cmdSetTracking(args);
    case 'declare': return cmdDeclare(args);
    case 'shexp68-login': return cmdShexpLogin();
    case 'dashboard': return cmdDashboard(args);
    case undefined:
    case '--help':
    case '-h':
    case 'help': console.log(HELP); return;
    default: console.log(c.red(`Unknown command: ${cmd}`)); console.log(HELP); process.exitCode = 1;
  }
}

main().catch(e => { console.error(c.red('Error:'), e.message); process.exitCode = 1; });
