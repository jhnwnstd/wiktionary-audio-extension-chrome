// @ts-check
// Content script spec — navigates to a Wiktionary URL (intercepted with a local
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
 * Build a canned Action API response (formatversion=2 — pages is an array).
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
    // Parser → human-readable display end-to-end.
    await expect(page.getByTestId('wad-audio-filename').first()).toHaveText("English American 'water' .ogg");
    await expect(page.getByTestId('wad-audio-filename').nth(1)).toHaveText("English British 'water' .ogg");
  });

  test('filters out non-audio files using mediatype', async () => {
    // Mix audio + image pages — only the audio one should survive the filter.
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
    // Single item → no "Download All" button is rendered.
    await expect(page.getByTestId('wad-download-all')).toHaveCount(0);
  });

  test('renders preview button per item', async () => {
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
    await expect(page.getByTestId('wad-preview')).toHaveCount(1);
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
