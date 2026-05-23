// @ts-check
// Popup spec -- loads the extension via persistent context, opens the popup,
// asserts radios are present, and confirms mode selection persists across reload.

const { test, expect, chromium } = require('@playwright/test');
const path = require('node:path');

const extensionPath = path.resolve(__dirname, '../../src');

test.describe('popup', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  /** @type {string} */
  let extensionId;

  test.beforeEach(async () => {
    context = await chromium.launchPersistentContext('', {
      channel: process.env.PW_CHANNEL || 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker');
    extensionId = serviceWorker.url().split('/')[2];
  });

  test.afterEach(async () => {
    await context.close();
  });

  test('renders all three mode radios with Original selected by default', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(page.getByTestId('wad-mode-original')).toBeVisible();
    await expect(page.getByTestId('wad-mode-convert')).toBeVisible();
    await expect(page.getByTestId('wad-mode-both')).toBeVisible();
    await expect(page.getByTestId('wad-mode-original')).toBeChecked();
  });

  // Persistence -- one test per non-default mode. Original is the default,
  // so it doesn't need a "persists" check (the renders-default test covers it).
  for (const mode of ['convert', 'both']) {
    test(`persists ${mode} selection across reload`, async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);

      await page.getByTestId(`wad-mode-${mode}`).check();

      // Poll storage directly -- proves chrome.storage.sync.set settled before
      // reloading. Avoids racing the async set against page.reload().
      await expect
        .poll(async () => page.evaluate(async () => (await chrome.storage.sync.get('mode')).mode))
        .toBe(mode);

      await page.reload();

      await expect(page.getByTestId(`wad-mode-${mode}`)).toBeChecked();
    });
  }

  // Failure path: if chrome.storage.sync.set rejects, the popup must surface
  // the failure to the user via #status. Stubs the API to reject so we don't
  // need to actually exhaust the sync quota.
  test('surfaces error when storage.sync.set rejects', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.evaluate(() => {
      // @ts-ignore
      window.chrome.storage.sync.set = () => Promise.reject(new Error('quota exceeded'));
    });

    await page.getByTestId('wad-mode-convert').check();

    await expect(page.locator('#status')).toContainText(/Failed to save/);
  });

  test('clicking anywhere in the radio-container row selects the radio', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // Click on the text span (not the radio dot) -- this verifies the whole
    // <label class="radio-container"> is the click target, which is the fix
    // for the "had to click twice" UX bug.
    await page.getByTestId('wad-mode-convert').locator('..').locator('span.radio-label').click();
    await expect(page.getByTestId('wad-mode-convert')).toBeChecked();
  });

  // Regression: opening the popup with Convert/Both selected is treated as
  // "download imminent" and pre-warms the offscreen FFmpeg document. This
  // pins the POPUP_OPENED -> prewarmFFmpeg wiring so a future change can't
  // silently disable it.
  test('popup-open with convert mode pre-warms offscreen document', async () => {
    // Seed convert mode via a throwaway page before the test popup opens.
    const seed = await context.newPage();
    await seed.goto(`chrome-extension://${extensionId}/popup.html`);
    await seed.getByTestId('wad-mode-convert').check();
    await expect
      .poll(async () => seed.evaluate(async () => (await chrome.storage.sync.get('mode')).mode))
      .toBe('convert');
    await seed.close();

    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker');

    // Open the popup fresh -- this is the "user clicks toolbar icon" event.
    // popup.js fires POPUP_OPENED on load; background reads mode (convert)
    // and pre-warms FFmpeg, which creates the offscreen document.
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // Poll until the offscreen document appears in the extension's context
    // list. createDocument is async; allow generous time on cold CI.
    await expect.poll(async () => serviceWorker.evaluate(async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [/** @type {any} */ ('OFFSCREEN_DOCUMENT')],
      });
      return contexts.length;
    }), { timeout: 10_000 }).toBeGreaterThan(0);
  });
});
