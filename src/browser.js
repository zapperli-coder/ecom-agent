// Playwright persistent browser context.
// Uses a user-data dir so JD + shexp68 logins survive between runs. You log in
// once (headed) via `ecom login`; the app never handles your password.
import { chromium } from 'playwright';
import * as config from './config.js';

const VIEWPORT = { width: 1280, height: 900 };

/**
 * Launch the persistent context and hand it to `fn`, closing it afterwards.
 * @param {{headless?:boolean, slowMo?:number}} opts
 * @param {(ctx:import('playwright').BrowserContext)=>Promise<any>} fn
 */
export async function withContext(opts, fn) {
  const { headless = true, slowMo = 0 } = opts ?? {};
  const common = {
    headless,
    viewport: VIEWPORT,
    slowMo,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(config.PROFILE_DIR, { channel: 'chrome', ...common });
  } catch {
    // Fall back to Playwright's bundled Chromium (`npx playwright install chromium`).
    ctx = await chromium.launchPersistentContext(config.PROFILE_DIR, common);
  }
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

/** Convenience: run `fn` with a single Page from the persistent context. */
export async function withPage(opts, fn) {
  return withContext(opts, async (ctx) => {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    return fn(page, ctx);
  });
}
