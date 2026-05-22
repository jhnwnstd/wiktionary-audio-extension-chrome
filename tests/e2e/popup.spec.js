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
        // Chrome 137+ blocks --load-extension by default via this feature
        // flag. Chrome for Testing (the chromium channel) doesn't enforce
        // it, so this is a no-op there but essential for the chrome channel.
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
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

  test('persists Convert selection across reload', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.getByTestId('wad-mode-convert').check();

    // Poll storage directly -- proves chrome.storage.sync.set settled before
    // reloading. Avoids racing the async set against page.reload().
    await expect
      .poll(async () => page.evaluate(async () => (await chrome.storage.sync.get('mode')).mode))
      .toBe('convert');

    await page.reload();

    await expect(page.getByTestId('wad-mode-convert')).toBeChecked();
  });

  test('persists Both selection across reload', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.getByTestId('wad-mode-both').check();
    await expect
      .poll(async () => page.evaluate(async () => (await chrome.storage.sync.get('mode')).mode))
      .toBe('both');

    await page.reload();

    await expect(page.getByTestId('wad-mode-both')).toBeChecked();
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
});
