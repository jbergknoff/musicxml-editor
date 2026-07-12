import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";

// The "Redistribute" toolbar command opens a modal (explanation + split-point
// slider) and, on confirm, splits every note across a treble/bass grand staff
// by pitch — the editor-side analogue of the MIDI import's "arrange into one
// piano part" option. Loaded here from a single-staff fixture whose notes span
// a wide range (C5/G5 high, C3/G2 low).

const REDISTRIBUTE_SOURCE = fileURLToPath(
  new URL("./fixtures/redistribute-source.musicxml", import.meta.url),
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

test("Redistribute splits a single staff into a treble/bass grand staff", async ({
  page,
}) => {
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(REDISTRIBUTE_SOURCE);
  // The source is a single staff (no second staff-part rendered yet).
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
  await expect(page.locator("#p1-m1-n0-v0")).toHaveCount(0);
  const before = await exportXml(page);
  expect(before).not.toMatch(/<staves>/);

  // Open the confirmation modal and confirm with the default split (middle C).
  await page.getByRole("button", { name: "Redistribute" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Redistribute across staves",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Redistribute" }).click();
  await expect(dialog).toBeHidden();

  // A second (bass) staff now exists and carries notes.
  await expect(page.locator("#p1-m1-n0-v0")).toBeVisible();

  const after = await exportXml(page);
  // Two staves with a treble (G) and a bass (F) clef.
  expect(after).toMatch(/<staves>2<\/staves>/);
  expect(after).toMatch(/<sign>G<\/sign>/);
  expect(after).toMatch(/<sign>F<\/sign>/);
  // High notes (C5/G5) tag onto staff 1; low notes (C3/G2) onto staff 2.
  expect(after).toMatch(
    /<step>C<\/step>\s*<octave>5<\/octave>[\s\S]*?<staff>1<\/staff>/,
  );
  expect(after).toMatch(
    /<step>G<\/step>\s*<octave>2<\/octave>[\s\S]*?<staff>2<\/staff>/,
  );
  // Still an editable single part (no view-only banner).
  await expect(page.getByText(/view-only/i)).toHaveCount(0);
});

test("Redistribute can be cancelled without changing the score", async ({
  page,
}) => {
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(REDISTRIBUTE_SOURCE);
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();

  await page.getByRole("button", { name: "Redistribute" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Redistribute across staves",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // Still a single staff — nothing changed.
  const xml = await exportXml(page);
  expect(xml).not.toMatch(/<staves>/);
});
