// @ts-check
// Live Wiktionary smoke + profiling. Tagged @live so it is excluded from the
// default deterministic suite. Run with: npm run test:live
//
// Hits real Wikimedia endpoints — keep it sequential and gentle. Network or
// content drift will surface as a failure; deterministic specs cover schema.

const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const extensionPath = path.resolve(__dirname, '../../src');
const urls = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/wiktionary-urls.json'), 'utf8')
);

/** @type {Array<{url: string, panelMs: number|null, firstItemMs: number|null, itemCount: number, sampleNames: string[], err?: string}>} */
const discoveryMetrics = [];
/** @type {Array<{label: string, ms: number}>} */
const downloadMetrics = [];

async function launchContext() {
  return chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

async function getExtensionId(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return sw.url().split('/')[2];
}

// No module-level serial mode. With workers:1 in playwright.config.js tests
// already run sequentially; we just don't want a single bad URL to skip the
// download tests that follow. Each describe controls its own ordering.

test.describe('discovery sweep', { tag: '@live' }, () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;

  test.beforeEach(async () => {
    context = await launchContext();
  });

  test.afterEach(async () => {
    await context.close();
  });

  for (const url of urls) {
    test(`discovers audio on ${url}`, async () => {
      const page = await context.newPage();
      const start = Date.now();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      let panelMs = null;
      let firstItemMs = null;
      let itemCount = 0;
      let sampleNames = [];
      let err;

      try {
        // Successful URLs all panel-render in <8s on a warm Wikimedia connection;
        // 15s buffer fails fast for entries with no audio (e.g., ja/水).
        await page.getByTestId('wad-panel').waitFor({ state: 'visible', timeout: 15_000 });
        panelMs = Date.now() - start;
        await page.getByTestId('wad-audio-item').first().waitFor({ state: 'visible', timeout: 5_000 });
        firstItemMs = Date.now() - start;
        const allNames = await page.getByTestId('wad-audio-filename').allTextContents();
        itemCount = allNames.length;
        // Capture more samples so we can spot parser/display issues across
        // a wider variety of real filenames.
        sampleNames = allNames.slice(0, 5);
      } catch (e) {
        err = String(e instanceof Error ? e.message : e).split('\n')[0].slice(0, 100);
      }

      discoveryMetrics.push({ url, panelMs, firstItemMs, itemCount, sampleNames, err });

      // Live discovery is informational, not assertive — Wiktionary entries
      // vary by edition. The afterAll summary lists which URLs found audio;
      // a catastrophic regression would surface as 0/N across all URLs.
    });
  }

  test.afterAll(() => {
    if (!discoveryMetrics.length) return;
    console.log('\n========= Live discovery metrics =========');
    console.log(
      'URL'.padEnd(58) +
        ' Panel(ms)' +
        ' First(ms)' +
        ' Items' +
        ' Note'
    );
    for (const m of discoveryMetrics) {
      const u = m.url.padEnd(58);
      const p = String(m.panelMs ?? '-').padStart(9);
      const f = String(m.firstItemMs ?? '-').padStart(9);
      const c = String(m.itemCount).padStart(5);
      const note = m.err ? `  ${m.err}` : '';
      console.log(`${u}${p}${f}${c}${note}`);
      if (m.sampleNames && m.sampleNames.length) {
        for (const name of m.sampleNames) console.log(`    ${name}`);
      }
    }
    const ok = discoveryMetrics.filter((m) => m.itemCount > 0);
    if (ok.length) {
      const avgPanel = Math.round(ok.reduce((s, m) => s + (m.panelMs || 0), 0) / ok.length);
      const avgFirst = Math.round(ok.reduce((s, m) => s + (m.firstItemMs || 0), 0) / ok.length);
      console.log(
        `\n  Avg over ${ok.length}/${discoveryMetrics.length} successful URLs:` +
          ` panel ${avgPanel}ms, first item ${avgFirst}ms`
      );
    }

    // Catastrophic-regression guard: if NO URLs find audio, that's a real
    // regression (network, API shape change, content script broken). Per-URL
    // misses are expected and ignored.
    if (ok.length === 0 && discoveryMetrics.length > 0) {
      throw new Error(
        `Discovery regression: 0/${discoveryMetrics.length} URLs found audio.`
      );
    }
  });
});

test.describe('download paths', { tag: '@live' }, () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;

  test.beforeEach(async () => {
    context = await launchContext();
  });

  test.afterEach(async () => {
    await context.close();
    if (downloadMetrics.length) {
      console.log('\n========= Download timing =========');
      for (const m of downloadMetrics) {
        console.log(`  ${m.label}: ${m.ms}ms`);
      }
      downloadMetrics.length = 0;
    }
  });

  test('Original mode downloads first audio item', async () => {
    const page = await context.newPage();
    await page.goto('https://en.wiktionary.org/wiki/water', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    const btn = page.getByTestId('wad-download').first();
    await btn.waitFor({ state: 'visible', timeout: 20_000 });

    const start = Date.now();
    await btn.click();
    // Content script flips the button text to "Downloaded" (or localized
    // equivalent) on success — see src/content-script.js downloadFile.
    await expect(btn).toContainText(/Downloaded/, { timeout: 30_000 });
    downloadMetrics.push({ label: 'Original click→ack', ms: Date.now() - start });
  });

  test('Convert mode produces WAV (full FFmpeg cold path)', async () => {
    const extensionId = await getExtensionId(context);

    // Flip mode to convert via the popup, confirm storage.sync.set ran.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.getByTestId('wad-mode-convert').check();
    await expect(popup.locator('#status')).toContainText(/Saved/);
    await popup.close();

    const page = await context.newPage();
    await page.goto('https://en.wiktionary.org/wiki/water', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    const btn = page.getByTestId('wad-download').first();
    await btn.waitFor({ state: 'visible', timeout: 20_000 });

    const start = Date.now();
    await btn.click();

    // Proves Convert mode was actually requested (Original mode skips this
    // preparingConverter feedback entirely). If storage.sync.set didn't stick,
    // this assertion fails fast instead of letting an Original-path download
    // masquerade as a successful conversion.
    await expect(btn).toContainText(/Converting/, { timeout: 5_000 });
    const preparingMs = Date.now() - start;

    // Cold FFmpeg load + transcode can take up to ~60s on first run.
    await expect(btn).toContainText(/Downloaded/, { timeout: 120_000 });
    const ackMs = Date.now() - start;

    downloadMetrics.push({ label: 'Convert: click→preparing', ms: preparingMs });
    downloadMetrics.push({ label: 'Convert: click→ack (cold full path)', ms: ackMs });
  });
});
