import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";

// Round-trips the "Embed review data" feature (see ImageImportDialog and
// editor/src/import-review-persistence.ts): a document carrying embedded
// review data opens with its review panel restored, the panel survives an
// export, and reopening the exported file restores it again. This suite is
// deliberately weight/network free (see playwright.editor.config.ts), so the
// fixture is a hand-built .musicxml carrying the same
// `<miscellaneous-field name="import-review-data">` a live OMR import would
// have embedded (one two-measure system, one flagged note) — it's opened via
// the plain file-open path, not a real OMR run. What's under test is the
// editor's read/export/reopen handling of that data, not OMR recognition
// itself.
const REVIEW_DATA_FIXTURE = fileURLToPath(
  new URL("./fixtures/review-data-embedded.musicxml", import.meta.url),
);

async function exportXml(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  const path = await download.path();
  return readFileSync(path, "utf8");
}

async function loadFile(page: Page, filePath: string): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles(filePath);
}

async function loadXmlContent(page: Page, xml: string): Promise<void> {
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "reopened.musicxml",
      mimeType: "application/xml",
      buffer: Buffer.from(xml, "utf8"),
    });
}

// The review panel's "Source" strip, present only while review mode is open.
function reviewPanel(page: Page) {
  return page.getByText("Source", { exact: true });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
});

test("opening a file with embedded review data shows the review panel, and it survives export + reopen", async ({
  page,
}) => {
  // Opening a file that carries embedded review data restores the review
  // panel, including the flagged (low-confidence) note count for that system.
  await loadFile(page, REVIEW_DATA_FIXTURE);
  await expect(reviewPanel(page)).toBeVisible();
  await expect(page.getByText("line 1/1 · measures 1–2")).toBeVisible();
  await expect(page.getByText(/1 amber note on this line/)).toBeVisible();

  // Exporting keeps the embedded field in the file.
  const exported = await exportXml(page);
  expect(exported).toContain('name="import-review-data"');
  expect(exported).toContain('"firstMeasure":0');
  expect(exported).toContain('"measureCount":2');

  // Close the panel, then confirm reopening the *exported* file (not the
  // original fixture) restores it again with the same data.
  await page.getByRole("button", { name: "Close review" }).click();
  await expect(reviewPanel(page)).toBeHidden();

  await loadXmlContent(page, exported);
  await expect(reviewPanel(page)).toBeVisible();
  await expect(page.getByText("line 1/1 · measures 1–2")).toBeVisible();
  await expect(page.getByText(/1 amber note on this line/)).toBeVisible();
});

test("opening a file with no embedded review data does not open the review panel", async ({
  page,
}) => {
  const SINGLE_STAFF = fileURLToPath(
    new URL("./fixtures/single-staff.musicxml", import.meta.url),
  );
  await loadFile(page, SINGLE_STAFF);
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
  await expect(reviewPanel(page)).toBeHidden();
});
