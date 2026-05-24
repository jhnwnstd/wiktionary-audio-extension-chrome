// @ts-check
// Content script spec. Navigates to a Wiktionary URL (intercepted with a local
// HTML fixture) and asserts the panel renders given mocked MediaWiki API responses.
// The content script uses a single Action API call (generator=images + prop=imageinfo)
// with formatversion=2, so pages come back as an array.

const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { enableInspectHook } = require('./_helpers');

const extensionPath = path.resolve(__dirname, '../../src');
const waterFixture = fs.readFileSync(
  path.resolve(__dirname, '../fixtures/wiktionary-water.html'),
  'utf8'
);

const WATER_URL = 'https://en.wiktionary.org/wiki/water';

/**
 * Build a canned Action API response (formatversion=2, so pages is an array).
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
    await enableInspectHook(context);

    // Always intercept the Wiktionary page itself with the local fixture.
    await context.route(WATER_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: waterFixture })
    );
  });

  test.afterEach(async () => {
    // Guard against beforeEach having failed to launch: an undefined
    // context would throw a TypeError here and mask the real error.
    if (context) await context.close();
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

  test('filters out non-audio files using mediatype (BITMAP, VIDEO)', async () => {
    // Mix audio + image + video pages. Only the audio one should survive.
    // The video case is critical: a .ogg URL that's actually video must be
    // rejected on the mediatype signal, since the URL extension alone would
    // otherwise match the AUDIO_EXT_RE whitelist.
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
                title: 'File:Water-flowing.ogv',
                imageinfo: [{ url: 'https://upload.wikimedia.org/x/Water-flowing.ogv', mime: 'video/ogg', mediatype: 'VIDEO' }],
              },
              {
                pageid: 3,
                title: 'File:Water-but-actually-video.ogg',
                // Pathological case: extension says .ogg but mediatype says
                // it's video. The new strict-mediatype path must reject it.
                imageinfo: [{ url: 'https://upload.wikimedia.org/x/Water-but-actually-video.ogg', mime: 'video/ogg', mediatype: 'VIDEO' }],
              },
              {
                pageid: 4,
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
  //   * Assert the click did NOT trigger a second network fetch, proving
  //     the cached-bytes path was taken (Original mode uses a data: URL when
  //     bytes are cached, which doesn't hit the network).
  test('Original download uses prefetched cache (no second network fetch)', async () => {
    const AUDIO_URL = 'https://upload.wikimedia.org/x/En-us-water.ogg';
    // OggS magic + a few padding bytes. chrome.downloads doesn't validate
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
    // built from the cached bytes, so no second network fetch should occur.
    const downloadBtn = page.getByTestId('wad-download').first();
    await downloadBtn.click();
    await expect(downloadBtn).toContainText(/Downloaded/, { timeout: 15_000 });

    // The assertion that earns the test: the click triggered zero new fetches.
    // A regression that bypasses the cache would bump this to 2.
    expect(audioFetchCount).toBe(1);
  });

  // Regression: successful Download buttons stay green/Downloaded (no auto-
  // reset), and when EVERY individual button has been clicked successfully,
  // the Download All button auto-flips to Downloaded too, so the user can
  // tell at a glance which items they've already saved.
  test('Downloaded state persists; all-individual completes auto-flips Download All', async () => {
    const URL_A = 'https://upload.wikimedia.org/x/En-us-water.ogg';
    const URL_B = 'https://upload.wikimedia.org/x/En-uk-water.ogg';
    const FAKE_OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);
    await context.route(URL_A, (route) => route.fulfill({ status: 200, contentType: 'audio/ogg', body: FAKE_OGG }));
    await context.route(URL_B, (route) => route.fulfill({ status: 200, contentType: 'audio/ogg', body: FAKE_OGG }));
    await context.route('**/w/api.php**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(actionApiResponse([
          { title: 'File:En-us-water.ogg', url: URL_A },
          { title: 'File:En-uk-water.ogg', url: URL_B },
        ])),
      })
    );

    const page = await context.newPage();
    await page.goto(WATER_URL);
    await expect(page.getByTestId('wad-panel')).toBeVisible();

    const btnA = page.getByTestId('wad-download').nth(0);
    const btnB = page.getByTestId('wad-download').nth(1);
    const btnAll = page.getByTestId('wad-download-all');

    // Click the first individual download, wait for Downloaded.
    await btnA.click();
    await expect(btnA).toContainText(/Downloaded/, { timeout: 15_000 });

    // Confirm persistence: well past the old 2 s auto-reset window, button
    // A is still in Downloaded state. The other buttons are unchanged.
    await page.waitForTimeout(2500);
    await expect(btnA).toContainText(/Downloaded/);
    await expect(btnB).not.toContainText(/Downloaded/);
    await expect(btnAll).not.toContainText(/Downloaded/);

    // Downloaded buttons stay clickable so the user can re-download.
    await expect(btnA).toBeEnabled();

    // Click the second individual download. Now both items are downloaded,
    // so Download All should auto-flip to Downloaded without being clicked.
    await btnB.click();
    await expect(btnB).toContainText(/Downloaded/, { timeout: 15_000 });
    await expect(btnAll).toContainText(/Downloaded/, { timeout: 5_000 });
  });

  // Symmetric direction: clicking Download All should flip every individual
  // row's button to Downloaded too, mirroring the all-individual-flips-the-
  // batch behavior above.
  test('Download All flips each row\'s individual button to Downloaded', async () => {
    const URL_A = 'https://upload.wikimedia.org/x/En-us-water.ogg';
    const URL_B = 'https://upload.wikimedia.org/x/En-uk-water.ogg';
    const FAKE_OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);
    await context.route(URL_A, (route) => route.fulfill({ status: 200, contentType: 'audio/ogg', body: FAKE_OGG }));
    await context.route(URL_B, (route) => route.fulfill({ status: 200, contentType: 'audio/ogg', body: FAKE_OGG }));
    await context.route('**/w/api.php**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(actionApiResponse([
          { title: 'File:En-us-water.ogg', url: URL_A },
          { title: 'File:En-uk-water.ogg', url: URL_B },
        ])),
      })
    );

    const page = await context.newPage();
    await page.goto(WATER_URL);
    await expect(page.getByTestId('wad-panel')).toBeVisible();

    const btnA = page.getByTestId('wad-download').nth(0);
    const btnB = page.getByTestId('wad-download').nth(1);
    const btnAll = page.getByTestId('wad-download-all');

    // Before: nothing is Downloaded.
    await expect(btnA).not.toContainText(/Downloaded/);
    await expect(btnB).not.toContainText(/Downloaded/);

    await btnAll.click();

    // Download All shows 2/2 Downloaded once everything settles.
    await expect(btnAll).toContainText(/2\/2/, { timeout: 30_000 });

    // Symmetric flip: every row's individual button is also Downloaded.
    await expect(btnA).toContainText(/Downloaded/);
    await expect(btnB).toContainText(/Downloaded/);
  });

  // Regression: minimize >2s -> background evicts cached bytes and aborts
  // in-flight prefetch. Re-opening after dismissal triggers a fresh prefetch.
  // This pins the "user signaled disengagement" cleanup path.
  // Regression for the dismiss-aborts-real-download bug: when the click
  // path issues its own validated fetch (source='click' inflight entry),
  // a PANEL_DISMISSED that fires during that fetch must NOT abort it.
  // Only opportunistic prefetches should be abortable on dismiss.
  //
  // Setup that forces the click path to its own-fetch branch: the prefetch
  // is made to fail, so when the click hits ensureValidatedBytes there is
  // no cached bytes and no in-flight prefetch to await. It registers
  // source='click' and fetches itself.
  test('PANEL_DISMISSED does not abort a click-initiated Original download', async () => {
    const AUDIO_URL = 'https://upload.wikimedia.org/x/En-us-water.ogg';
    const FAKE_OGG = Buffer.from([
      0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    let fetchCount = 0;
    await context.route(AUDIO_URL, async (route) => {
      fetchCount++;
      if (fetchCount === 1) {
        // First fetch is the auto-prefetch; fail it so the click path
        // is forced into its own-fetch branch.
        await route.abort();
      } else {
        // Click-path fetch: delay long enough for the dismiss timer
        // (minimize + 2 s) to land while we're still in flight.
        await new Promise(r => setTimeout(r, 4000));
        await route.fulfill({ status: 200, contentType: 'audio/ogg', body: FAKE_OGG });
      }
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

    // Wait long enough for the prefetch to have failed (it aborts fast).
    await page.waitForTimeout(300);

    const downloadBtn = page.getByTestId('wad-download').first();
    await downloadBtn.click();

    // Minimize while the click-path fetch is in flight (~500 ms in);
    // the dismiss timer (2 s) will fire ~2.5 s into the fetch.
    await page.waitForTimeout(500);
    await page.getByTestId('wad-minimize').click();

    // The fetch still has ~3 s left; PANEL_DISMISSED will fire mid-fetch.
    // The fix asserts: the click-source inflight survives, fetch completes,
    // button reaches Downloaded. Pre-fix it would have flipped to Failed.
    await expect(downloadBtn).toContainText(/Downloaded/, { timeout: 10_000 });
  });

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

  // Geometry sweep. Verifies the clamp()-based responsive sizing keeps the
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

  // Closure-binding regression. The shadow root is open (so Playwright +
  // tooling can pierce it), which also means a hostile page script could in
  // principle reach into the panel via host.shadowRoot. The defence is NOT
  // shadow opacity; it is that each button's click handler captures its own
  // AudioItem in a closure. No DOM attribute the page can rewrite (testid,
  // data-i, textContent, any data-* we ever add later) can retarget a real
  // user click to a different item.
  test('shadow-DOM click handler resists page DOM tampering', async () => {
    const URL_A = 'https://upload.wikimedia.org/x/En-us-water.ogg';
    const URL_B = 'https://upload.wikimedia.org/x/En-uk-water.ogg';
    const FAKE_OGG = Buffer.from([
      0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    await context.route(URL_A, (route) => route.fulfill({ status: 200, contentType: 'audio/ogg', body: FAKE_OGG }));
    await context.route(URL_B, (route) => route.fulfill({ status: 200, contentType: 'audio/ogg', body: FAKE_OGG }));
    await context.route('**/w/api.php**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(actionApiResponse([
          { title: 'File:En-us-water.ogg', url: URL_A },
          { title: 'File:En-uk-water.ogg', url: URL_B },
        ])),
      })
    );

    // Monkey-patch chrome.downloads.download in the SW to capture the opts
    // it's called with. We then assert on the captured filename: data: URL
    // downloads from the cached-bytes path don't always fire Playwright's
    // download event, but the SW call is deterministic.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await sw.evaluate(() => {
      globalThis.__capturedDownloads = [];
      const orig = chrome.downloads.download;
      chrome.downloads.download = function(opts, cb) {
        globalThis.__capturedDownloads.push({ filename: opts.filename, url: opts.url });
        return orig.call(this, opts, cb);
      };
    });

    const page = await context.newPage();
    await page.goto(WATER_URL);
    await expect(page.getByTestId('wad-panel')).toBeVisible();
    await expect(page.getByTestId('wad-audio-item')).toHaveCount(2);

    // Simulate a hostile page script reaching into the (open) shadow root
    // and rewriting everything it can on the FIRST download button to make
    // it impersonate the second. If the handler resolved its target item
    // from any DOM attribute or text, the click would download item B.
    await page.evaluate(() => {
      let host = null;
      for (const el of document.documentElement.querySelectorAll('div')) {
        if (el.shadowRoot && el.shadowRoot.querySelector('[data-testid="wad-panel"]')) {
          host = el;
          break;
        }
      }
      if (!host || !host.shadowRoot) throw new Error('panel host not found');
      const buttons = host.shadowRoot.querySelectorAll('[data-testid="wad-download"]');
      if (buttons.length !== 2) throw new Error(`expected 2 download buttons, got ${buttons.length}`);
      // Rewrite anything a page might exploit.
      buttons[0].setAttribute('data-i', '1');
      buttons[0].setAttribute('data-preview', '1');
      buttons[0].setAttribute('data-target-item', '1');
      buttons[0].textContent = '(impersonating B)';
    });

    // Click the first row's last button (we just clobbered its testid, so a
    // testid query would be wrong). A real Playwright click is isTrusted.
    const firstRow = page.getByTestId('wad-audio-item').nth(0);
    const dlBtn = firstRow.locator('button').last();
    await dlBtn.click();
    // Confirm the click reached our handler at all: the button text flips.
    await expect(dlBtn).toContainText(/Downloaded/, { timeout: 15_000 });

    // Read what the SW actually passed to chrome.downloads.download.
    const captured = await sw.evaluate(() => globalThis.__capturedDownloads);
    expect(captured.length).toBeGreaterThanOrEqual(1);
    // The closure-captured item is A (En-us → "american" in the friendly
    // name). If tampering had succeeded, the filename would say "british".
    const filename = String(captured[captured.length - 1].filename).toLowerCase();
    expect(filename).toContain('american');
    expect(filename).not.toContain('british');
  });

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
