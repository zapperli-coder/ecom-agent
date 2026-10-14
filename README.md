# eCom Agent

> **中文简介**：给盛世领航（shexp68）集运用户的本地小工具。自动读取你在**京东**和**淘宝/天猫**的订单，
> 获取快递单号，并在你确认后把包裹**预报**到 shexp68 集运仓库（仓库已到件的「待完善」包裹会自动补全，不会重复添加）。
> 全部在你自己的电脑和浏览器里运行，账号密码只保存在本机 `.env` 中。京东/淘宝用扫码登录，本工具不接触其密码。
> 快速开始：安装 Node.js 22.5+ → 下载 [Releases](../../releases) 中的 zip 并解压 → 双击 `start.bat` → 在 `.env` 填写 shexp68 账号 →
> 运行 `.start.ps1 -Command login` 扫码登录 → 再次双击 `start.bat` 打开控制台。

For **shexp68 (盛世领航) forwarding customers** who buy on **JD (jd.com)** and **Taobao / Tmall**.
It reads your orders, finds the courier tracking numbers (快递单号), and pre-declares each
parcel into your shexp68 warehouse. You review every declaration before it is submitted.

Everything runs on your own computer, in your own browser session. Your logins, orders and
password stay on your machine. Nothing is sent anywhere except to JD, Taobao and shexp68.

## Requirements

- Windows 10/11 (macOS/Linux work through the CLI)
- [Node.js](https://nodejs.org/) **22.5 or newer**
- Google Chrome. If Chrome isn't available, the launcher installs Playwright's Chromium instead.
- A shexp68 account with a username and password (the 账号登录 on http://www.shexp68.com/)

## Quick start (Windows)

1. Download the zip from [Releases](../../releases) (or `git clone` this repo), unzip it anywhere, and double-click **`start.bat`**.
   The first run installs dependencies and creates a `.env` file.
2. Open `.env` in Notepad and fill in your shexp68 account:
   ```
   SHEXP68_USERNAME=your-shexp68-username
   SHEXP68_PASSWORD=your-shexp68-password
   ```
   If you ship to a warehouse other than 深圳集运仓库, also set
   `SHEXP68_WAREHOUSE=<warehouse name exactly as shown on the 添加包裹 form>`.
3. Log into JD and Taobao once. In a terminal opened in this folder, run:
   ```powershell
   .\start.ps1 -Command login
   ```
   A browser opens. Scan the QR codes for JD and Taobao (and log into shexp68 if prompted).
   The session is saved in `data/` and reused from then on.
4. Double-click **`start.bat`** again. The dashboard opens at http://127.0.0.1:8765.
   - **Scan JD** / **Scan Taobao** load your orders. JD tracking numbers are captured automatically.
   - **Declare** opens a form with the warehouse, 快递单号, 品名, 单价, 数量 and 备注 filled in.
     Check or edit the values, then click **Submit to shexp68**.
   - If the warehouse has already received the parcel (待完善), the tool completes that entry
     instead of creating a duplicate.

A visible browser window opens while scanning or submitting. This is intentional: JD blocks
hidden (headless) browsers, and Taobao sometimes shows a slider check you need to solve.
Leave the window alone until it closes.

## Command line

```powershell
node src/cli.js login [--only jd|taobao|shexp68]   # log in once (headed browser)
node src/cli.js sync [--source jd|taobao]          # fetch orders (default: jd)
node src/cli.js orders [--status 等待收货]          # list stored orders
node src/cli.js set-tracking <orderId> <快递单号>   # enter a tracking number by hand
node src/cli.js declare [--order <id>] [--yes]     # declare parcels, confirming each one
node src/cli.js shexp68-login                      # test your shexp68 credentials
node src/cli.js dashboard [--port 8765] [--no-open]
```

`.\start.ps1 -Command <command>` runs the same commands after the setup checks.

## Limitations

- **Taobao tracking numbers aren't fetched automatically yet.** Paste the 快递单号 into the
  Declare form, or use `set-tracking`.
- JD and Taobao change their sites often. If a scan returns 0 orders, the raw page data is
  saved in `data/raw/` to help diagnose the problem.
- Close the dashboard before running other CLI commands. Only one program can use the saved
  browser profile at a time.

## Your data

| Location | Contains | Shared? |
|---|---|---|
| `.env` | your shexp68 username and password | never; it stays on your computer |
| `data/pw-profile/` | JD / Taobao / shexp68 login sessions | never |
| `data/ecom.db` | your orders and declarations | never |

To sign out completely, delete the `data/` folder.

## Disclaimer

This is an independent community tool. It is **not affiliated with** shexp68 (盛世领航), JD.com or
Alibaba/Taobao. It automates your own browser session on your own accounts at human pace. It does
not bypass captchas or re-sign private APIs. You are responsible for following each site's terms
of service. Sites change without notice, so check every declaration before you submit it.

## Contributing

```powershell
npm install
npm test          # parser tests (node:test), no browser needed
```

- Site-specific URLs, status strings and warehouse ids live in `src/config.js`.
- Test fixtures must be **synthetic**. Never commit real captures from `data/raw/`: they contain
  order numbers, addresses and tracking numbers.
- Never hard-code anything specific to one user. Per-user settings belong in `.env` / `.env.example`.

## For maintainers: building a release

```powershell
npm run release
```

This writes `dist/ecom-agent-<version>.zip`, ready to attach to a GitHub Release. Only `src/`, the
start scripts, `README.md`, `LICENSE`, `.env.example` and the package files are copied, so `data/` and `.env` are never included.
Before zipping, the script checks every copied file for your `.env` secret values. It also
checks any extra strings you list in `.env` as `RELEASE_DENYLIST=member-id,real-name,...`.
If any match, the build fails.
