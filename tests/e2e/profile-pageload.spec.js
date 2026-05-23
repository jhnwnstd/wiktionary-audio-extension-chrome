// @ts-check
// A/B page-load profiler. Tagged @profile so it doesn't run in CI. Use to
// answer "does the extension measurably slow Wiktionary page load?"
//
// Run with:
//   npx playwright test --config=tests/playwright.config.js --grep @profile
//
// For each of N trials, opens a fresh context (so each trial is cold-cache),
// navigates to a Wiktionary page, and reads three timing milestones from the
// Navigation Timing + Paint Timing APIs:
//   * domContentLoaded -- DOM parsed and ready
//   * load             -- all sync resources finished
//   * first-contentful-paint -- first text/image painted (perceptual "started")
//
// Runs both with and without the extension loaded. Prints per-trial numbers
// and means so you can eyeball whether the delta is real or noise.

const { test, chromium } = require('@playwright/test');
const path = require('node:path');

const extensionPath = path.resolve(__dirname, '../../src');

const URL = 'https://en.wiktionary.org/wiki/water';
const SECOND_URL = 'https://en.wiktionary.org/wiki/love';
const TRIALS = 5;

/**
 * @param {boolean} withExtension
 * @returns {Promise<{domContentLoaded: number, load: number, fcp: number | null}>}
 */
async function measureOnce(withExtension) {
  const ctx = await chromium.launchPersistentContext('', {
    headless: true,
    args: withExtension ? [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ] : [],
  });
  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
    // Await before returning so finally{} doesn't close the context while
    // evaluate() is still in flight.
    const result = await page.evaluate(() => {
      const nav = /** @type {PerformanceNavigationTiming} */ (
        performance.getEntriesByType('navigation')[0]
      );
      const paint = performance.getEntriesByName('first-contentful-paint')[0];
      return {
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.fetchStart),
        load: Math.round(nav.loadEventEnd - nav.fetchStart),
        fcp: paint ? Math.round(paint.startTime) : null,
      };
    });
    return result;
  } finally {
    await ctx.close();
  }
}

/**
 * Measure timing of a SECONDARY navigation: load page A first, give the
 * extension time to fully run (discovery API, panel render, prefetch fan-out
 * to upload.wikimedia.org), then navigate to page B and measure that.
 *
 * This is the "click a blue link to another Wiktionary entry" scenario. It
 * stresses whatever lingering work the extension is doing -- if the service
 * worker is busy with a prefetch when the user navigates, this is where
 * we'd see it.
 *
 * @param {boolean} withExtension
 * @returns {Promise<{domContentLoaded: number, load: number, fcp: number | null}>}
 */
async function measureSecondNav(withExtension) {
  const ctx = await chromium.launchPersistentContext('', {
    headless: true,
    args: withExtension ? [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ] : [],
  });
  try {
    const page = await ctx.newPage();
    // Load page A and let extension's work settle: discovery API runs at
    // ~2-3s, panel renders at ~3-4s, prefetch fans out after that. Five
    // seconds is enough that we're measuring steady-state navigation,
    // not extension tail effects.
    await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(5000);

    // Now navigate to page B and measure THAT load. Navigation Timing
    // resets per document so the values below are about B only.
    await page.goto(SECOND_URL, { waitUntil: 'load', timeout: 60_000 });
    const result = await page.evaluate(() => {
      const nav = /** @type {PerformanceNavigationTiming} */ (
        performance.getEntriesByType('navigation')[0]
      );
      const paint = performance.getEntriesByName('first-contentful-paint')[0];
      return {
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.fetchStart),
        load: Math.round(nav.loadEventEnd - nav.fetchStart),
        fcp: paint ? Math.round(paint.startTime) : null,
      };
    });
    return result;
  } finally {
    await ctx.close();
  }
}

/** @param {number[]} ns @returns {{mean: number, stddev: number}} */
function stats(ns) {
  const mean = ns.reduce((s, n) => s + n, 0) / ns.length;
  const variance = ns.reduce((s, n) => s + (n - mean) ** 2, 0) / ns.length;
  return { mean: Math.round(mean), stddev: Math.round(Math.sqrt(variance)) };
}

test.describe('page-load A/B', { tag: '@profile' }, () => {
  test('compare page-load timings with vs without extension @profile', async () => {
    test.setTimeout(300_000);

    /** @type {{withExt: Array<{domContentLoaded: number, load: number, fcp: number|null}>, withoutExt: Array<{domContentLoaded: number, load: number, fcp: number|null}>}} */
    const samples = { withExt: [], withoutExt: [] };

    // Interleave with/without trials so any time-varying network conditions
    // affect both groups roughly equally rather than favoring one bucket.
    for (let i = 0; i < TRIALS; i++) {
      samples.withoutExt.push(await measureOnce(false));
      samples.withExt.push(await measureOnce(true));
    }

    const fmt = (rows) => {
      const dcl = stats(rows.map((r) => r.domContentLoaded));
      const load = stats(rows.map((r) => r.load));
      const fcps = rows.map((r) => r.fcp).filter((n) => n !== null);
      const fcp = fcps.length ? stats(fcps) : { mean: NaN, stddev: NaN };
      return { dcl, load, fcp };
    };

    const without = fmt(samples.withoutExt);
    const withE = fmt(samples.withExt);

    console.log(`\n========= Page-load A/B (${URL}, n=${TRIALS} each) =========`);
    console.log('Metric           | without extension      | with extension         | delta (mean)');
    console.log('-----------------+------------------------+------------------------+-------------');
    const row = (name, a, b) => {
      const delta = b.mean - a.mean;
      const sign = delta >= 0 ? '+' : '';
      console.log(
        `${name.padEnd(16)} | mean ${String(a.mean).padStart(5)} ms (sd ${String(a.stddev).padStart(4)}) | ` +
        `mean ${String(b.mean).padStart(5)} ms (sd ${String(b.stddev).padStart(4)}) | ${sign}${delta} ms`
      );
    };
    row('domContentLoaded', without.dcl, withE.dcl);
    row('load', without.load, withE.load);
    row('first-contentful', without.fcp, withE.fcp);

    console.log('\nPer-trial (ms):');
    console.log('  without: dcl=', samples.withoutExt.map((r) => r.domContentLoaded));
    console.log('  without: load=', samples.withoutExt.map((r) => r.load));
    console.log('  without: fcp=', samples.withoutExt.map((r) => r.fcp));
    console.log('  with:    dcl=', samples.withExt.map((r) => r.domContentLoaded));
    console.log('  with:    load=', samples.withExt.map((r) => r.load));
    console.log('  with:    fcp=', samples.withExt.map((r) => r.fcp));
    console.log(
      `\nInterpretation: if |delta| < stddev of either group, the difference is`,
      `noise. If |delta| >= ~2x stddev, the extension is likely contributing.`
    );
  });

  // Secondary-nav A/B: does clicking from one Wiktionary entry to another
  // get slower when the extension was active on the first page? This is
  // what the user actually does -- they look up a word, see a blue link,
  // click through.
  test('compare secondary-nav timings with vs without extension @profile', async () => {
    test.setTimeout(600_000);

    /** @type {{withExt: Array<{domContentLoaded: number, load: number, fcp: number|null}>, withoutExt: Array<{domContentLoaded: number, load: number, fcp: number|null}>}} */
    const samples = { withExt: [], withoutExt: [] };

    for (let i = 0; i < TRIALS; i++) {
      samples.withoutExt.push(await measureSecondNav(false));
      samples.withExt.push(await measureSecondNav(true));
    }

    const fmt = (rows) => {
      const dcl = stats(rows.map((r) => r.domContentLoaded));
      const load = stats(rows.map((r) => r.load));
      const fcps = rows.map((r) => r.fcp).filter((n) => n !== null);
      const fcp = fcps.length ? stats(fcps) : { mean: NaN, stddev: NaN };
      return { dcl, load, fcp };
    };

    const without = fmt(samples.withoutExt);
    const withE = fmt(samples.withExt);

    console.log(`\n========= Secondary-nav A/B (${URL} -> ${SECOND_URL}, n=${TRIALS} each) =========`);
    console.log('Metric           | without extension      | with extension         | delta (mean)');
    console.log('-----------------+------------------------+------------------------+-------------');
    const row = (name, a, b) => {
      const delta = b.mean - a.mean;
      const sign = delta >= 0 ? '+' : '';
      console.log(
        `${name.padEnd(16)} | mean ${String(a.mean).padStart(5)} ms (sd ${String(a.stddev).padStart(4)}) | ` +
        `mean ${String(b.mean).padStart(5)} ms (sd ${String(b.stddev).padStart(4)}) | ${sign}${delta} ms`
      );
    };
    row('domContentLoaded', without.dcl, withE.dcl);
    row('load', without.load, withE.load);
    row('first-contentful', without.fcp, withE.fcp);

    console.log('\nPer-trial (ms):');
    console.log('  without: dcl=', samples.withoutExt.map((r) => r.domContentLoaded));
    console.log('  without: load=', samples.withoutExt.map((r) => r.load));
    console.log('  without: fcp=', samples.withoutExt.map((r) => r.fcp));
    console.log('  with:    dcl=', samples.withExt.map((r) => r.domContentLoaded));
    console.log('  with:    load=', samples.withExt.map((r) => r.load));
    console.log('  with:    fcp=', samples.withExt.map((r) => r.fcp));
  });
});
