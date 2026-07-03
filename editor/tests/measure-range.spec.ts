import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";

// Integration tests for measure-range selection + copy/cut/paste/delete-measure
// (deferred item 9 in IDEAS.md): shift-click and Shift+←/→ both grow a
// measure-range selection; ⌘C/⌘X/⌘V and the toolbar/context-menu act on it;
// cutting or deleting a range removes whole measures (not just their content).

// Three quarter notes C5/D5/E5, one per measure — a distinct, clickable
// notehead in every measure so selection never has to guess a pixel position
// against a layout that can shift as notes are added (a coordinate landing in
// the wrong measure after such a shift is exactly the flake this fixture
// avoids: every click below targets a note's own id instead).
const THREE_MEASURES = fileURLToPath(
  new URL("./fixtures/three-measures.musicxml", import.meta.url),
);

async function exportXml(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  return readFileSync(await download.path(), "utf8");
}

function pitchCount(xml: string): number {
  return (xml.match(/<pitch>/g) ?? []).length;
}

function measureCount(xml: string): number {
  return (xml.match(/<measure\b/g) ?? []).length;
}

async function loadThreeMeasures(page: Page): Promise<void> {
  // .first() disambiguates from the "Append Import" file input, which shares
  // the same input[type="file"] shape.
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(THREE_MEASURES);
  await expect(page.locator("#p0-m3-n0-v0")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
});

test("shift-click selects a measure range; copy + paste inserts a copy elsewhere", async ({
  page,
}) => {
  await loadThreeMeasures(page);
  expect(pitchCount(await exportXml(page))).toBe(3);

  await page.locator("#p0-m1-n0-v0").click();
  await expect(page.getByText("Sel: m.1 · 1 note")).toBeVisible();

  await page.locator("#p0-m2-n0-v0").click({ modifiers: ["Shift"] });
  await expect(page.getByText("Sel: m.1–2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" })).toBeEnabled();

  await page.keyboard.press("Control+c");

  // Select measure 3 (plain click — resets the range anchor) and paste: the
  // copied measures 1–2 (C, D) are inserted before it.
  await page.locator("#p0-m3-n0-v0").click();
  await expect(page.getByText("Sel: m.3 · 1 note")).toBeVisible();
  await page.keyboard.press("Control+v");
  // The paste reselects the pasted range (measures 3–4) — wait for it before
  // exporting, so the export doesn't race the state update.
  await expect(page.getByText("Sel: m.3–4")).toBeVisible();

  const after = await exportXml(page);
  expect(measureCount(after)).toBe(5);
  // Original C, D, E plus the pasted copy's C, D.
  expect(pitchCount(after)).toBe(5);

  await page.keyboard.press("Control+z");
  const undone = await exportXml(page);
  expect(measureCount(undone)).toBe(3);
  expect(pitchCount(undone)).toBe(3);
});

test("Shift+ArrowRight extends a measure range from the keyboard; cut removes whole measures", async ({
  page,
}) => {
  await loadThreeMeasures(page);

  await page.locator("#p0-m1-n0-v0").click();
  await expect(page.getByText("Sel: m.1 · 1 note")).toBeVisible();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.getByText("Sel: m.1–2")).toBeVisible();

  await page.keyboard.press("Control+x");
  // Wait for the cut's reselect (deleteMeasureRange lands on the surviving
  // measure) before exporting, so the export doesn't race the state update.
  await expect(page.getByText("Sel: m.1 · 1 note")).toBeVisible();
  const afterCut = await exportXml(page);
  // Only measure 3 (E) survives the cut.
  expect(measureCount(afterCut)).toBe(1);
  expect(pitchCount(afterCut)).toBe(1);

  // Paste the cut measures (C, D) back before the remaining measure.
  await page.keyboard.press("Control+v");
  await expect(page.getByText("Sel: m.1–2")).toBeVisible();
  const restored = await exportXml(page);
  expect(measureCount(restored)).toBe(3);
  expect(pitchCount(restored)).toBe(3);
});

test("the − Measure toolbar button deletes the selected measure", async ({
  page,
}) => {
  await loadThreeMeasures(page);
  expect(measureCount(await exportXml(page))).toBe(3);

  await page.locator("#p0-m2-n0-v0").click();
  await expect(page.getByRole("button", { name: "− Measure" })).toBeEnabled();
  await page.getByRole("button", { name: "− Measure" }).click();
  // The delete reselects the measure now sitting at that position (E, moved
  // down from measure 3 to measure 2) — wait before exporting.
  await expect(page.getByText("Sel: m.2 · 1 note")).toBeVisible();

  const after = await exportXml(page);
  expect(measureCount(after)).toBe(2);
  expect(pitchCount(after)).toBe(2); // measure 2 (D) is gone

  await page.keyboard.press("Control+z");
  const undone = await exportXml(page);
  expect(measureCount(undone)).toBe(3);
  expect(pitchCount(undone)).toBe(3);
});
