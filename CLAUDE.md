# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local Node tool that scrapes the user's own JD (jd.com) and Taobao orders, then pre-declares the parcels into the `shexp68` (盛世领航) freight-forwarder warehouse. Every shexp68 submission is gated behind user review/confirmation. There is no official consumer order API for JD or Taobao, so all data comes from an authenticated Playwright browser session.

## Commands

Requires Node >= 22.5 (uses built-in `node:sqlite`). Only dependency is `playwright`.

```powershell
npm install
node src/cli.js login [--only jd|taobao|shexp68]   # headed; log in once, session saved to data/pw-profile
node src/cli.js sync [--source jd|taobao]          # scrape orders into data/ecom.db (default jd)
node src/cli.js orders [--status 等待收货]
node src/cli.js set-tracking <orderId> <快递单号>
node src/cli.js declare [--order <id>]             # fill shexp68 form, confirm each submit
node src/cli.js shexp68-login                      # test automated shexp68 login from .env
node src/cli.js dashboard [--port 8765] [--no-open]
.\start.ps1 [-Command <cmd>] [-Port N] [-NoOpen]   # preflight (node/deps/chromium/.env) + launch
```

`npm run ecom -- <command>` is equivalent. `npm test` runs `node --test` over `test/*.test.js` (pure parser and prefill tests, no browser). For a single test, run `node --test --test-name-pattern "parseTrace"`. Fixtures must be synthetic; never copy real captures from `data/raw/`. There is no linter. CI (`.github/workflows/ci.yml`) runs `node --check` on every source file, then `npm test`.

`npm run release` builds `dist/ecom-agent-<version>.zip` for sharing with other shexp68 users (`scripts/release.mjs`). It copies only an allowlist (`src/`, start scripts, README, `.env.example`, package files), then fails if any shipped file contains a secret value from `.env` or a string listed in `RELEASE_DENYLIST`. When you add a new top-level file that users need, add it to `INCLUDE` there and to `files` in `package.json`.

## Distribution rule

This tool is shared with other people. Never hard-code anything specific to one user (shexp68 member id, names, addresses, credentials). Per-user settings go in `.env`, documented in `.env.example`: `SHEXP68_USERNAME`, `SHEXP68_PASSWORD`, optional `SHEXP68_WAREHOUSE` and `ECOM_DATA_DIR`. They are read in `src/config.js`.

## Architecture

- `src/config.js` — all fragile site constants (URLs, gateway hosts, status strings, in-transit sets, shexp68 warehouse ids, member id) plus path setup under `data/` and `.env` loading. Update here first when a site changes.
- `src/browser.js` — `withContext`/`withPage` launch a **persistent** Playwright context (`data/pw-profile`), preferring system Chrome (`channel: 'chrome'`) and falling back to bundled Chromium.
- `src/scrapers/jd.js`, `src/scrapers/taobao.js` — load the real order-list page and **capture the page's own signed gateway JSON responses** (JD `api.m.jd.com` `pcorder_center_list`; Taobao `h5api.m.taobao.com` `mtop.taobao.order.queryboughtlistV2`), parsing them authoritatively; DOM extraction is only a fallback. Raw responses are dumped to `data/raw/`. Never try to replay or re-sign these calls (`h5st`, mtop signatures).
- `src/forwarders/shexp68.js` — login (username/password from `.env`), filling the 添加包裹 form, and the match-first flow for parcels already received by the warehouse.
- `src/actions.js` — orchestration shared by CLI and dashboard (`scanOrders`, `scanTaobaoOrders`, `refetchTracking`, `submitDeclaration`). All browser work goes through `withLock` because the persistent profile can only be opened once.
- `src/db.js` — `node:sqlite` store (`orders`, `order_items`, `parcels`, `followups`). Schema uses `CREATE TABLE IF NOT EXISTS` plus try/catch `ALTER TABLE` migrations in `getDb()`. `orders.source` distinguishes `'jd'` vs `'taobao'`. Every upserted order gets a `parcels` row.
- `src/dashboard.js` + `src/dashboard.html` — zero-dep `node:http` server at `127.0.0.1:8765`. Routes: `GET /api/state`, `POST /api/sync`, `POST /api/track/refetch`, `GET /api/declare/prepare` (DB-only prefill), `POST /api/declare/submit`.
- `src/cli.js` — argument parsing and command dispatch. `declare` shows the values, asks for confirmation, then calls `actions.submitDeclaration`, the same path the dashboard uses.
- Order source (`'jd'` | `'taobao'`) affects the default 备注 label (`JD#`/`TB#`, `shexp68.orderLabel`) and the in-transit check (`actions.isInTransit`). Taobao 快递单号 auto-capture isn't implemented: `refetchTracking` rejects Taobao orders, and users paste the number manually.

## Non-obvious constraints

- **Browser runs must be headed.** JD risk control returns 403 for the order gateway in headless Chrome. Defaults are `headless: false` everywhere; don't flip them. Taobao runs headed so a person can solve the slider captcha.
- **One process per profile.** `withLock` serializes only within a process. Running a CLI browser command while the dashboard is doing one makes the second launch get a logged-out profile. Restart the dashboard after code changes.
- **Courier tracking (快递单号):** in-transit JD orders come from the list's 查看物流 drawer (`pcorder_center_traceMultiPackage`); completed orders come from the per-order detail page (`orders.detail_url`, which contains a per-order PassKey). `refetchTracking` tries the detail page first.
- **shexp68 match-first declare:** if the warehouse already holds the parcel (待完善 list, `users.php?act=order_list&mark=4`), `submitDeclaration` completes that entry via its edit form instead of adding a duplicate. Otherwise it fills `act=addlist`. 单价 is required, so `valuesFromParcel` derives it from `order.amount / totalQty`. `markDeclared` runs only when shexp68 accepts the submission.
- shexp68's session cookie doesn't persist between launches, so `ensureLoggedIn` logs in on every declare run using `SHEXP68_USERNAME`/`SHEXP68_PASSWORD` from `.env`. JD and Taobao use manual or QR login only. The app never automates those passwords.
- JD and Taobao order pages use hashed CSS-module classes, so DOM fallbacks anchor on text labels (订单号, ¥, 共X件) and item hrefs, not class names.
- `data/` (profile, DB, raw dumps) and `.env` are gitignored.
