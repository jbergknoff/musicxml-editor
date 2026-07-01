import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Visual regression for repeat-barline glyphs: a plain measure, a forward
// repeat (opens measure 2), a backward repeat (closes measure 3), and a plain
// measure after. Guards the thick/thin/dot rendering added alongside repeat
// barline parsing and playback support.

const REPEAT_BARLINES = fileURLToPath(
  new URL("./fixtures/repeat-barlines.musicxml", import.meta.url),
);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
});

test("renders forward and backward repeat barline glyphs", async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles(REPEAT_BARLINES);
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
  await expect(page.locator("svg").first()).toHaveScreenshot(
    "repeat-barlines.png",
  );
});
