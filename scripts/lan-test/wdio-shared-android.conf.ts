import path from "node:path";
import { browser } from "@wdio/globals";
import type { Options } from "@wdio/types";

// Use an existing Appium server with UiAutomator2. No destructive app-data reset.
const packageName = "dev.syncpeer.app";
const serial = process.env.ANDROID_SERIAL?.trim();
if (!serial?.startsWith("emulator-")) {
  throw new Error("Set ANDROID_SERIAL to a disposable emulator serial (emulator-...).");
}
const chromedriver = process.env.SYNCPEER_UI_CHROMEDRIVER?.trim();

export const config = {
  runner: "local",
  specs: [path.resolve("scripts/lan-test/shared-onboarding.spec.ts")],
  maxInstances: 1,
  logLevel: "warn",
  hostname: process.env.SYNCPEER_APPIUM_HOST ?? "127.0.0.1",
  port: Number(process.env.SYNCPEER_APPIUM_PORT ?? 4723),
  path: process.env.SYNCPEER_APPIUM_BASE_PATH ?? "/",
  capabilities: [{
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:deviceName": "Syncpeer disposable emulator",
    "appium:udid": serial,
    "appium:appPackage": packageName,
    "appium:appActivity": `${packageName}.MainActivity`,
    "appium:noReset": true,
    "appium:forceAppLaunch": true,
    ...(chromedriver ? { "appium:chromedriverExecutable": chromedriver } : {}),
  }],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { timeout: 180_000 },
  before: async () => {
    await browser.waitUntil(async () => {
      const contexts = await browser.getContexts();
      const webview = contexts.find(context =>
        typeof context === "string" && context.startsWith("WEBVIEW_"));
      if (!webview) return false;
      await browser.switchContext(webview as string);
      return true;
    }, {
      timeout: 60_000, interval: 1_000,
      timeoutMsg: "Tauri WebView unavailable: check WebView debugging and ChromeDriver version.",
    });
  },
} satisfies Options.Testrunner & { capabilities: unknown };
