import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";

// Adding a staff turns a single-staff score into a grand staff (a second,
// vertically aligned staff appears) and removing a staff reverses it. The new
// staff is blank and editable, and the round trip preserves the original
// staff's notes.

const GRAND_STAFF = fileURLToPath(
  new URL("./fixtures/grand-staff.musicxml", import.meta.url),
);

async function exportXml(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  return readFileSync(await download.path(), "utf8");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
});

test("adding a staff creates a second staff; removing it reverts", async ({
  page,
}) => {
  // The default blank document is single-staff.
  const initial = await exportXml(page);
  expect(initial).not.toMatch(/<staves>/);

  await page.getByRole("button", { name: "+ Staff" }).click();

  // The export now declares two staves with a treble (G) and a bass (F) clef.
  const grand = await exportXml(page);
  expect(grand).toMatch(/<staves>2<\/staves>/);
  expect(grand).toMatch(/<sign>G<\/sign>/);
  expect(grand).toMatch(/<sign>F<\/sign>/);
  // The score stays editable (no view-only banner).
  await expect(page.getByText(/view-only/i)).toHaveCount(0);

  await page.getByRole("button", { name: "− Staff" }).click();

  // Back to a single staff.
  const single = await exportXml(page);
  expect(single).not.toMatch(/<staves>/);
});

test("removing a staff drops that staff's notes and keeps the other", async ({
  page,
}) => {
  await page.locator('input[type="file"]').first().setInputFiles(GRAND_STAFF);
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
  await expect(page.locator("#p1-m1-n0-v0")).toBeVisible();

  // Remove the bottom (bass) staff — nothing selected, so it targets the bottom.
  await page.getByRole("button", { name: "− Staff" }).click();

  await expect(page.locator("#p1-m1-n0-v0")).toHaveCount(0);
  const xml = await exportXml(page);
  expect(xml).not.toMatch(/<staves>/);
  // The treble C5 survives; the bass G2 is gone.
  expect(xml).toMatch(/<step>C<\/step>\s*<octave>5<\/octave>/);
  expect(xml).not.toMatch(/<step>G<\/step>\s*<octave>2<\/octave>/);
});
