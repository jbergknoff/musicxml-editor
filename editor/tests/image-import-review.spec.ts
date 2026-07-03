import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";

// Round-trips the "Embed review data" feature (see ImageImportDialog and
// editor/src/import-review-persistence.ts): a document carrying embedded OMR
// review data opens with its review panel restored, the panel survives an
// export, and reopening the exported file restores it again — without ever
// running real OMR recognition (this suite is deliberately weight/network
// free; see playwright.editor.config.ts). The fixture stands in for what a
// live OMR import would have embedded: one two-measure system with one
// flagged note.
const OMR_REVIEW_FIXTURE = fileURLToPath(
  new URL("./fixtures/omr-review-embedded.musicxml", import.meta.url),
);

async function exportXml(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  const path = await download.path();
  return readFileSync(path, "utf8");
}

async function importFile(page: Page, filePath: string): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles(filePath);
}

async function importXmlContent(page: Page, xml: string): Promise<void> {
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

test("review data embedded in a file round-trips through export and reopen", async ({
  page,
}) => {
  // Opening a file with embedded review data restores the review panel, as if
  // it were the tail of a fresh OMR import.
  await importFile(page, OMR_REVIEW_FIXTURE);
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

  await importXmlContent(page, exported);
  await expect(reviewPanel(page)).toBeVisible();
  await expect(page.getByText("line 1/1 · measures 1–2")).toBeVisible();
  await expect(page.getByText(/1 amber note on this line/)).toBeVisible();
});

test("a plain import with no embedded data does not open the review panel", async ({
  page,
}) => {
  const SINGLE_STAFF = fileURLToPath(
    new URL("./fixtures/single-staff.musicxml", import.meta.url),
  );
  await importFile(page, SINGLE_STAFF);
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
  await expect(reviewPanel(page)).toBeHidden();
});
