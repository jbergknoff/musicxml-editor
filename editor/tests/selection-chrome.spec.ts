import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";

// Integration tests for the selection overlay chrome:
//   - Note ring: clicking a notehead rings that note (with a dashed beat-box
//     behind it marking the beat).
//   - Beat-box: selecting a rest slot draws a solid tinted column, no ring.
//   - Reselect after chord-member removal: removing one note from a multi-note
//     chord re-selects the remaining chord rather than clearing to null.
//   - Key-signature-aware pitch stepping: ↑/↓ stays diatonic in the active key
//     (F→F♯ in G major, not F♮).

const SINGLE_STAFF = fileURLToPath(
  new URL("./fixtures/single-staff.musicxml", import.meta.url),
);
// G major (1 sharp = F♯): E5, G5, B5 quarter notes + a rest.
const G_MAJOR = fileURLToPath(
  new URL("./fixtures/g-major.musicxml", import.meta.url),
);

async function exportXml(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  return readFileSync(await download.path(), "utf8");
}

async function loadFile(page: Page, path: string): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles(path);
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
}

// Note-pitch label buttons in the inspector panel.
function pitchButtons(page: Page) {
  return page
    .locator("aside")
    .getByRole("button")
    .filter({ hasText: /^[A-G][♯♭]*\d$/ });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
});

// ── Screenshots: beat-box and note ring ─────────────────────────────────────

test("clicking a notehead rings that note", async ({ page }) => {
  await loadFile(page, SINGLE_STAFF);

  // A single click selects the note directly — no drill step.
  await page.locator("#p0-m1-n0-v0").click();
  await expect(page.getByText(/Sel: m\.1 .*· 1 note/)).toBeVisible();

  // The staff SVG shows a ring over the C5 notehead (dashed beat-box behind).
  await expect(page.locator("svg").first()).toHaveScreenshot("note-ring.png");
});

test("selecting a rest slot draws a beat-box, no ring", async ({ page }) => {
  await loadFile(page, SINGLE_STAFF);

  // Select the last note, then step right onto the beat-4 quarter rest — a slot
  // (not note) selection, which draws a solid beat-box and no note ring.
  await page.locator("#p0-m1-n2-v0").click();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("aside").getByText(/Rest · /)).toBeVisible();

  await expect(page.locator("svg").first()).toHaveScreenshot(
    "beat-box-rest.png",
  );
});

// ── Reselect after removing a chord member ───────────────────────────────────

test("removing one note from a chord keeps the inspector on the remaining chord", async ({
  page,
}) => {
  await loadFile(page, SINGLE_STAFF);
  const inspector = page.locator("aside");

  // Select C5, then add E5 to form a two-note chord.
  await page.locator("#p0-m1-n0-v0").click();
  await page.keyboard.press("e");

  // Two note rows appear: E5 (top) and C5 (bottom).
  await expect(pitchButtons(page)).toHaveCount(2);

  // Remove the top note via the ✕ button in its inspector row.
  await inspector.getByTitle("Remove note").first().click();

  // The inspector must stay open on the remaining chord (C5), not close to
  // idle — that was the bug.
  await expect(pitchButtons(page)).toHaveCount(1);
  await expect(pitchButtons(page).first()).toHaveText("C5");
});

// ── Key-signature-aware pitch stepping ──────────────────────────────────────

test("↑ steps into F♯ (not F♮) when the key signature is G major", async ({
  page,
}) => {
  await loadFile(page, G_MAJOR); // E5 is note 0; key = G major (F♯)

  // Select E5 directly.
  await page.locator("#p0-m1-n0-v0").click();
  await expect(
    page.locator("aside").getByText("E5", { exact: true }),
  ).toBeVisible();

  // Step up once: E → F, and F is ♯ in G major.
  await page.keyboard.press("ArrowUp");

  // The exported pitch should have alter=1 (F♯), not the old alter=0 (F♮).
  const xml = await exportXml(page);
  expect(xml).toMatch(/<step>F<\/step>\s*<alter>1<\/alter>/);
});
