import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const screens = [
  { screen: "devices", expected: ["My peers", "Home workstation", "Family laptop"] },
  { screen: "folders", expected: ["New shared folder", "Family photos", "Private backup"] },
  { screen: "sync", expected: ["Family photos", "weekend.mov", "beach.jpg"] },
] as const;

const names = screens.map(({ screen }) => `syncpeer-${screen}.png`).sort();

test.beforeAll(async () => {
  await rm(".screenshots", { recursive: true, force: true });
  await mkdir(".screenshots", { recursive: true });
});

for (const { screen, expected } of screens) {
  test(`capture mobile ${screen} with synthetic content`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/screenshots.html?screen=${screen}`);
    await expect(page.getByTestId("screenshot-ready")).toHaveAttribute("data-screen", screen);
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    for (const value of expected) await expect(page.getByText(value).first()).toBeVisible();
    if (screen === "devices") {
      await expect(page.locator("[data-saved-peer-id]")).toHaveCount(2);
    } else if (screen === "folders") {
      await expect(page.getByTestId("folder-root-photos")).toBeVisible();
    } else {
      await expect(page.getByTestId("folder-entry-weekend.mov")).toBeInViewport();
      await expect(page.getByRole("progressbar", { name: "Download progress" }))
        .toHaveAttribute("aria-valuenow", "68");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: path.join(".screenshots", `syncpeer-${screen}.png`),
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  });
}

test.afterAll(async () => {
  expect((await readdir(".screenshots")).sort()).toEqual(names);
});
