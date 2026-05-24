// Shared helpers for the Playwright suite. Kept tiny so each spec file can
// import without pulling in unrelated state.

/**
 * Flip the SW-side `__WAD_TEST__` flag so background.js's introspection
 * hook returns real cache state instead of null. Production extension runs
 * never set this flag, so the cached-URL list is unreachable outside tests.
 *
 * @param {import('@playwright/test').BrowserContext} ctx
 */
async function enableInspectHook(ctx) {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate(() => { globalThis.__WAD_TEST__ = true; });
}

module.exports = { enableInspectHook };
