import { defineConfig, devices } from '@playwright/test';

// Each test file starts its own server on a spare port over a temp data folder
// (e2e/server.ts), serving the build in dist/, so files can run in parallel.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 4,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  // The performance file measures typing latency, so it runs after the rest, with no other test taking the processor.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: /performance\.spec\.ts$/ },
    { name: 'performance', use: { browserName: 'chromium' }, testMatch: /performance\.spec\.ts$/, dependencies: ['chromium'] },
  ],
});
