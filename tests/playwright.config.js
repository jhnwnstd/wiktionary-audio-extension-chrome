// Playwright config -- extension tests use launchPersistentContext per test,
// so we don't declare browser projects here. Paths resolve relative to this
// config file's own location (tests/), so testDir is './e2e' not './tests/e2e'.

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
