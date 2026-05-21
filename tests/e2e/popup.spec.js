// @ts-check
// Popup spec — loads the extension via persistent context, opens the popup,
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
      channel: 'chromium',
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

  test('renders both mode radios with Original selected by default', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(page.getByTestId('wad-mode-original')).toBeVisible();
    await expect(page.getByTestId('wad-mode-convert')).toBeVisible();
    await expect(page.getByTestId('wad-mode-original')).toBeChecked();
  });

  test('persists Convert selection across reload', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.getByTestId('wad-mode-convert').check();

    // Wait for "Settings saved!" — confirms chrome.storage.sync.set completed.
    await expect(page.locator('#status')).toContainText('Settings saved');

    await page.reload();

    await expect(page.getByTestId('wad-mode-convert')).toBeChecked();
  });
});
