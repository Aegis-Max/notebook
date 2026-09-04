import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './tests',
  testMatch: 'e2e.spec.js',
  outputDir: '/tmp/cornell-notebook-playwright-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL,
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: {
        viewport: { width: 1_440, height: 900 },
      },
    },
    {
      name: 'mobile-chrome',
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: 'npm run start',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
