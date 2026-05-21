// @ts-check
// Content script spec — navigates to a Wiktionary URL (intercepted with a local
// HTML fixture) and asserts the panel renders given mocked MediaWiki API responses.

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
 * Build a canned imageinfo response for the Action API.
 * @param {Array<{title: string, url: string, mime?: string}>} entries
 */
function actionApiResponse(entries) {
  const pages = {};
  entries.forEach((entry, i) => {
    pages[String(i + 1)] = {
      title: entry.title,
      imageinfo: [{ url: entry.url, mime: entry.mime || 'application/ogg' }],
    };
  });
  return { query: { pages } };
}

test.describe('content script audio discovery', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;

  test.beforeEach(async () => {
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
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

  test('renders panel from REST + Action API resolution', async () => {
    await context.route('**/api/rest_v1/page/media-list/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            { title: 'File:En-us-water.ogg', audio_type: 'generic' },
            { title: 'File:En-uk-water.ogg', audio_type: 'pronunciation' },
          ],
        }),
      })
    );

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
    // Parser → friendly format flowing through end-to-end:
    // File:En-us-water.ogg → english_american_water.ogg
    await expect(page.getByTestId('wad-audio-filename').first()).toHaveText('english_american_water.ogg');
    await expect(page.getByTestId('wad-audio-filename').nth(1)).toHaveText('english_british_water.ogg');
  });

  test('falls back to Action API generator=images when REST returns nothing', async () => {
    await context.route('**/api/rest_v1/page/media-list/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      })
    );

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
          ])
        ),
      })
    );

    const page = await context.newPage();
    await page.goto(WATER_URL);

    await expect(page.getByTestId('wad-panel')).toBeVisible();
    await expect(page.getByTestId('wad-audio-item')).toHaveCount(1);
    // Single item → no "Download All" button is rendered.
    await expect(page.getByTestId('wad-download-all')).toHaveCount(0);
  });

  test('renders nothing when no audio is discovered', async () => {
    await context.route('**/api/rest_v1/page/media-list/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      })
    );

    await context.route('**/w/api.php**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ query: { pages: {} } }),
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
