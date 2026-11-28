import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "screenshots.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 430, height: 860 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "npm run dev -w @syncpeer/app",
    url: "http://127.0.0.1:5173/screenshots.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
