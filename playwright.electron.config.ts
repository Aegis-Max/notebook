import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/electron',
  testMatch: '**/*.spec.ts',
  outputDir: '/tmp/cornell-notebook-electron-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
