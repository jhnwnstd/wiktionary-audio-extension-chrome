// @ts-check
// Download-path timing baselines. Tagged @profile so it stays out of CI.
// Run with:
//   npx playwright test --config=tests/playwright.config.js --grep @profile
//
// For each flow, opens a fresh context per trial (cold cache, cold service
// worker) and measures click-to-ack. Reports mean and stddev so a future
// regression is visible against the recorded baseline rather than against a
// hard threshold (which would be flaky given Wikimedia network jitter).

const { test, expect, chromium } = require('@playwright/test');
const path = require('node:path');

const extensionPath = path.resolve(__dirname, '../../src');
const WATER_URL = 'https://en.wiktionary.org/wiki/water';
const TRIALS = 5;

async function launchCtx() {
  return chromium.launchPersistentContext('', {
    channel: process.env.PW_CHANNEL || 'chromium',
    headless: true,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

async function setMode(ctx, mode) {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByTestId(`wad-mode-${mode}`).check();
  await expect
    .poll(async () => popup.evaluate(async () => (await chrome.storage.sync.get('mode')).mode))
    .toBe(mode);
  await popup.close();
}

/** @param {number[]} ns */
function stats(ns) {
  const mean = ns.reduce((s, n) => s + n, 0) / ns.length;
  const variance = ns.reduce((s, n) => s + (n - mean) ** 2, 0) / ns.length;
  return {
    mean: Math.round(mean),
    stddev: Math.round(Math.sqrt(variance)),
    min: Math.min(...ns),
    max: Math.max(...ns),
  };
}

/** @param {string} label @param {ReturnType<typeof stats>} s */
function row(label, s) {
  return `  ${label.padEnd(38)} mean ${String(s.mean).padStart(5)} ms  sd ${String(s.stddev).padStart(4)}  min ${String(s.min).padStart(4)}  max ${String(s.max).padStart(4)}`;
}

test.describe('download path baselines', { tag: '@profile' }, () => {
  test('Original click-to-ack @profile', async () => {
    test.setTimeout(300_000);
    const samples = [];
    for (let i = 0; i < TRIALS; i++) {
      const ctx = await launchCtx();
      try {
        const page = await ctx.newPage();
        await page.goto(WATER_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const btn = page.getByTestId('wad-download').first();
        await btn.waitFor({ state: 'visible', timeout: 20_000 });
        const t0 = Date.now();
        await btn.click();
        await expect(btn).toContainText(/Downloaded/, { timeout: 30_000 });
        samples.push(Date.now() - t0);
      } finally {
        await ctx.close();
      }
    }
    console.log(`\n========= Original click->ack (n=${TRIALS}) =========`);
    console.log(row('Original (fresh, may prefetch-hit)', stats(samples)));
    console.log('  per-trial:', samples);
  });

  test('Convert click-to-ack cold @profile', async () => {
    test.setTimeout(600_000);
    const samples = [];
    for (let i = 0; i < TRIALS; i++) {
      const ctx = await launchCtx();
      try {
        await setMode(ctx, 'convert');
        const page = await ctx.newPage();
        await page.goto(WATER_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const btn = page.getByTestId('wad-download').first();
        await btn.waitFor({ state: 'visible', timeout: 20_000 });
        const t0 = Date.now();
        await btn.click();
        await expect(btn).toContainText(/Downloaded/, { timeout: 120_000 });
        samples.push(Date.now() - t0);
      } finally {
        await ctx.close();
      }
    }
    console.log(`\n========= Convert click->ack cold (n=${TRIALS}) =========`);
    console.log(row('Convert cold (click before speculative)', stats(samples)));
    console.log('  per-trial:', samples);
  });

  test('Convert click-to-ack warm (post-speculative) @profile', async () => {
    test.setTimeout(600_000);
    const samples = [];
    for (let i = 0; i < TRIALS; i++) {
      const ctx = await launchCtx();
      try {
        await setMode(ctx, 'convert');
        const page = await ctx.newPage();
        await page.goto(WATER_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.getByTestId('wad-panel').waitFor({ state: 'visible', timeout: 20_000 });

        // Wait for the speculative transcode to populate the cache before
        // clicking. This is what a real user does: read the panel for a
        // moment, then click. We model "moment" as "transcodedCache > 0".
        let [sw] = ctx.serviceWorkers();
        if (!sw) sw = await ctx.waitForEvent('serviceworker');
        await expect
          .poll(async () => sw.evaluate(() => globalThis._wadInspectAudioCache().transcodedCount), { timeout: 60_000 })
          .toBeGreaterThan(0);

        const btn = page.getByTestId('wad-download').first();
        await btn.waitFor({ state: 'visible', timeout: 5_000 });
        const t0 = Date.now();
        await btn.click();
        await expect(btn).toContainText(/Downloaded/, { timeout: 30_000 });
        samples.push(Date.now() - t0);
      } finally {
        await ctx.close();
      }
    }
    console.log(`\n========= Convert click->ack warm (n=${TRIALS}) =========`);
    console.log(row('Convert warm (speculative cache hit)', stats(samples)));
    console.log('  per-trial:', samples);
  });
});
