// @ts-check
// Content script spec -- navigates to a Wiktionary URL (intercepted with a local
// HTML fixture) and asserts the panel renders given mocked MediaWiki API responses.
// The content script uses a single Action API call (generator=images + prop=imageinfo)
// with formatversion=2, so pages come back as an array.

const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const extensionPath = path.resolve(__dirname, '../../src');
const waterFixture = fs.readFileSync(
  path.resolve(__dirname, '../fixtures/wiktionary-water.html'),
  'utf8'
);

const WATER_URL = 'https://en.wiktionary.org/wiki/water';

/**
 * Build a canned Action API response (formatversion=2 -- pages is an array).
 * @param {Array<{title: string, url: string, mime?: string, mediatype?: string}>} entries
 */
function actionApiResponse(entries) {
  return {
    query: {
      pages: entries.map((entry, i) => ({
        pageid: i + 1,
        title: entry.title,
        imageinfo: [{
          url: entry.url,
          mime: entry.mime || 'application/ogg',
          mediatype: entry.mediatype || 'AUDIO',
          size: 12345,
        }],
      })),
    },
  };
}

test.describe('content script audio discovery', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;

  test.beforeEach(async () => {
    context = await chromium.launchPersistentContext('', {
      channel: process.env.PW_CHANNEL || 'chromium',
      headless: true,
      acceptDownloads: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    // Always intercept the Wiktionary page itself with the local fixture.
    await context.route(WATER_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: waterFixture })
    );
  });

  test.afterEach(async () => {
    await context.close();
  });

  test('discovers audio via Action API generator=images', async () => {
    await context.route('**/w/api.php**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          actionApiResponse([
            {
              title: 'File:En-us-water.ogg',
              url: 'https://upload.wikimedia.org/wikipedia/commons/4/4c/En-us-water.ogg',
            },
            {
              title: 'File:En-uk-water.ogg',
              url: 'https://upload.wikimedia.org/wikipedia/commons/5/5d/En-uk-water.ogg',
            },
          ])
        ),
      })
    );

    const page = await context.newPage();
    await page.goto(WATER_URL);

    await expect(page.getByTestId('wad-panel')).toBeVisible();
    await expect(page.getByTestId('wad-audio-item')).toHaveCount(2);
    await expect(page.getByTestId('wad-download-all')).toBeVisible();
    // Parser -> human-readable display end-to-end.
    await expect(page.getByTestId('wad-audio-filename').first()).toHaveText("English American 'water' .ogg");
    await expect(page.getByTestId('wad-audio-filename').nth(1)).toHaveText("English British 'water' .ogg");
  });

  test('filters out non-audio files using mediatype', async () => {
    // Mix audio + image pages -- only the audio one should survive the filter.
    await context.route('**/w/api.php**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          query: {
            pages: [
              {
                pageid: 1,
                title: 'File:Water_drop.jpg',
                imageinfo: [{ url: 'https://upload.wikimedia.org/x/Water_drop.jpg', mime: 'image/jpeg', mediatype: 'BITMAP' }],
              },
              {
                pageid: 2,
                title: 'File:En-us-water.ogg',
                imageinfo: [{ url: 'https://upload.wikimedia.org/x/En-us-water.ogg', mime: 'application/ogg', mediatype: 'AUDIO' }],
              },
            ],
          },
        }),
      })
    );

    const page = await context.newPage();
    await page.goto(WATER_URL);

    await expect(page.getByTestId('wad-panel')).toBeVisible();
    await expect(page.getByTestId('wad-audio-item')).toHaveCount(1);
    // Single item -> no "Download All" button is rendered.
    await expect(page.getByTestId('wad-download-all')).toHaveCount(0);
  });

  // Failure-mode coverage: if the MediaWiki API returns 5xx the extension
  // must fail quietly. No panel, no console crash, no infinite spinner.
  test('renders nothing when the API returns 500', async () => {
    await context.route('**/w/api.php**', (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' })
    );

    const page = await context.newPage();
    await page.goto(WATER_URL);

    // Give the content script time to attempt discovery + decide not to inject.
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    await expect(page.getByTestId('wad-panel')).toHaveCount(0);
  });

  // Minimize collapses the body/footer; clicking again restores them. Button
  // text toggles between minus (U+2212) and plus. Validates the only on-panel
  // user control beyond preview/download.
  test('minimize button toggles body visibility', async () => {
    await context.route('**/w/api.php**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          actionApiResponse([
            { title: 'File:En-us-water.ogg', url: 'https://upload.wikimedia.org/x/En-us-water.ogg' },
            { title: 'File:En-uk-water.ogg', url: 'https://upload.wikimedia.org/x/En-uk-water.ogg' },
          ])
        ),
      })
    );

    const page = await context.newPage();
    await page.goto(WATER_URL);

    const body = page.locator('.audio-panel-body');
    const minimize = page.getByTestId('wad-minimize');

    await expect(body).toBeVisible();
    await minimize.click();
    await expect(body).toBeHidden();
    await expect(minimize).toHaveText('+');

    await minimize.click();
    await expect(body).toBeVisible();
    await expect(minimize).toHaveText('−');
  });

  // Regression test for the prefetch cache wiring (background.js audioCache).
  // The cache is silent in failure: if the wiring breaks, downloads still work
  // via the URL fallback path and the existing UI tests pass. This test pins
  // the cache HIT behavior so a regression is caught explicitly.
  //
  // Setup:
  //   * Mock the audio URL with a counter-instrumented route.
  //   * Wait until background.js has the URL in its cache (via the
  //     globalThis._wadInspectAudioCache introspection hook).
  //   * Click Download.
  //   * Assert the click did NOT trigger a second network fetch -- proving
  //     the cached-bytes path was taken (Original mode uses a data: URL when
  //     bytes are cached, which doesn't hit the network).
  test('Original download uses prefetched cache (no second network fetch)', async () => {
    const AUDIO_URL = 'https://upload.wikimedia.org/x/En-us-water.ogg';
    // OggS magic + a few padding bytes -- chrome.downloads doesn't validate
    // the file contents, it just needs non-empty bytes to save.
    const FAKE_OGG = Buffer.from([
      0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    let audioFetchCount = 0;
    await context.route(AUDIO_URL, async (route) => {
      audioFetchCount++;
      await route.fulfill({ status: 200, contentType: 'audio/ogg', body: FAKE_OGG });
    });

    await context.route('**/w/api.php**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(actionApiResponse([{ title: 'File:En-us-water.ogg', url: AUDIO_URL }])),
      })
    );

    const page = await context.newPage();
    await page.goto(WATER_URL);
    await expect(page.getByTestId('wad-panel')).toBeVisible();

    // Wait for background.js to finish prefetching this URL. SW evaluate
    // reads the introspection hook directly; no message round-trip needed.
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker');
    await expect
      .poll(async () => serviceWorker.evaluate(
        (url) => globalThis._wadInspectAudioCache().cachedUrls.includes(url),
        AUDIO_URL,
      ))
      .toBe(true);

    // Sanity: prefetch did exactly one fetch.
    expect(audioFetchCount).toBe(1);

    // Click Download. With the cache populated, background uses a data: URL
    // built from the cached bytes -- no second network fetch should occur.
    const downloadBtn = page.getByTestId('wad-download').first();
    await downloadBtn.click();
    await expect(downloadBtn).toContainText(/Downloaded/, { timeout: 15_000 });

    // The assertion that earns the test: the click triggered zero new fetches.
    // A regression that bypasses the cache would bump this to 2.
    expect(audioFetchCount).toBe(1);
  });

  // Regression: minimize >2s -> background evicts cached bytes and aborts
  // in-flight prefetch. Re-opening after dismissal triggers a fresh prefetch.
  // This pins the "user signaled disengagement" cleanup path.
  test('minimize >2s evicts the prefetch cache; reopening re-prefetches', async () => {
    const AUDIO_URL = 'https://upload.wikimedia.org/x/En-us-water.ogg';
    const FAKE_OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);
    await context.route(AUDIO_URL, async (route) => {
      await route.fulfill({ status: 200, contentType: 'audio/ogg', body: FAKE_OGG });
    });
    await context.route('**/w/api.php**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(actionApiResponse([{ title: 'File:En-us-water.ogg', url: AUDIO_URL }])),
      })
    );

    const page = await context.newPage();
    await page.goto(WATER_URL);
    await expect(page.getByTestId('wad-panel')).toBeVisible();

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const cacheHasUrl = () => sw.evaluate(
      (url) => globalThis._wadInspectAudioCache().cachedUrls.includes(url),
      AUDIO_URL,
    );

    // Wait for initial prefetch to populate the cache.
    await expect.poll(cacheHasUrl).toBe(true);

    // Click minimize. The 2s dismiss timer is now armed.
    await page.getByTestId('wad-minimize').click();

    // Poll until the cache empties. The dismiss message fires at ~2s; poll
    // a few seconds past that to give it room.
    await expect.poll(cacheHasUrl, { timeout: 5000 }).toBe(false);

    // Click minimize again to restore the panel. Should re-fire PREFETCH_AUDIO.
    await page.getByTestId('wad-minimize').click();
    await expect.poll(cacheHasUrl, { timeout: 5000 }).toBe(true);
  });

  // Geometry sweep -- verifies the clamp()-based responsive sizing keeps the
  // panel inside the viewport on the screen sizes from the test matrix. Uses
  // 20 mocked items so the body fills past its height cap and the assertions
  // actually exercise the clamp ceiling.
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1920, height: 1080 },
  ]) {
    test(`panel fits viewport at ${viewport.width}x${viewport.height}`, async () => {
      await context.route('**/w/api.php**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            actionApiResponse(
              Array.from({ length: 20 }, (_, i) => ({
                title: `File:En-us-word${i}.ogg`,
                url: `https://upload.wikimedia.org/x/En-us-word${i}.ogg`,
              }))
            )
          ),
        })
      );

      const page = await context.newPage();
      await page.setViewportSize(viewport);
      await page.goto(WATER_URL);

      const panel = page.getByTestId('wad-panel');
      await expect(panel).toBeVisible();
      const box = await panel.boundingBox();
      if (!box) throw new Error('panel has no bounding box');

      // Width ceiling = clamp top (380). Floor is 260, but at 1280+ the
      // 22vw middle term always exceeds 260 so the floor is not exercised.
      expect(box.width).toBeLessThanOrEqual(380);
      expect(box.width).toBeGreaterThanOrEqual(260);

      // Panel must not extend past the viewport in either axis. 16px is the
      // resolved edge-gap on these widths (1.25vw > 16 -> clamped to 16).
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

      // Height ceiling = header + body(clamp(180, 55vh, 500)) + footer. The
      // header/footer total ~100px; cap is whichever of 55vh / 500 is smaller.
      const bodyCap = Math.min(500, viewport.height * 0.55);
      expect(box.height).toBeLessThanOrEqual(bodyCap + 120);
    });
  }

  test('renders nothing when no audio is discovered', async () => {
    await context.route('**/w/api.php**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ query: { pages: [] } }),
      })
    );

    const page = await context.newPage();
    await page.goto(WATER_URL);

    // Give the content script a moment to run discovery + decide not to inject.
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    await expect(page.getByTestId('wad-panel')).toHaveCount(0);
  });
});
