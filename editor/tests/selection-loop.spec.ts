import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
import { moreAction } from "./toolbar";

// The core selection loop: click a notehead to select that note, see it
// mirrored in the inspector, and edit it via the inspector
// controls and the keyboard map (Esc step-out, A–G add, accidentals, + Measure).

const SINGLE_STAFF = fileURLToPath(
  new URL("./fixtures/single-staff.musicxml", import.meta.url),
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
  return (xml.match(/<measure /g) ?? []).length;
}

// The inspector's pitch-label button for a specific pitch string (e.g. "C5",
// "F♯5"). Unique within the panel when only one note is selected.
function pitchButton(page: Page, label?: string) {
  const buttons = page
    .locator("aside")
    .getByRole("button")
    .filter({ hasText: /^[A-G][♯♭]*\d$/ });
  return label ? buttons.filter({ hasText: label }) : buttons.first();
}

// Load the single-staff fixture (three quarter notes C5/E5/G5) and wait for it.
async function loadSingleStaff(page: Page): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles(SINGLE_STAFF);
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
});

test("clicking a notehead selects that note directly", async ({ page }) => {
  await loadSingleStaff(page);
  const inspector = page.locator("aside");

  // Before any selection the inspector shows its empty state.
  await expect(inspector.getByText(/click a note or rest/i)).toBeVisible();

  // A single click on a notehead selects that note — no drill step. The
  // transport readout names the position and the note is listed with its pitch.
  await page.locator("#p0-m1-n0-v0").click();
  await expect(page.getByText(/Sel: m\.1 .*· 1 note/)).toBeVisible();
  await expect(pitchButton(page, "C5")).toBeVisible();
});

test("the inspector sets an accidental on the selected note", async ({
  page,
}) => {
  await loadSingleStaff(page);
  const inspector = page.locator("aside");

  await page.locator("#p0-m1-n0-v0").click();
  await inspector.getByTitle("Sharp").click();

  // The export carries the alteration and the row label gains a sharp.
  expect(await exportXml(page)).toContain("<alter>1</alter>");
  await expect(pitchButton(page)).toHaveText(/♯/);
});

test("the inspector stepper moves the note up a staff-step", async ({
  page,
}) => {
  await loadSingleStaff(page);
  const inspector = page.locator("aside");

  await page.locator("#p0-m1-n0-v0").click();
  const before = (await pitchButton(page).textContent()) ?? "";
  await inspector.getByTitle("Up one step").click();
  // The note moved, so its label changed.
  await expect(pitchButton(page)).not.toHaveText(before);
});

test("Add note stacks a chord member on the selected beat", async ({
  page,
}) => {
  await loadSingleStaff(page);
  expect(pitchCount(await exportXml(page))).toBe(3);

  await page.locator("#p0-m1-n0-v0").click();
  await page.locator("aside").getByText("+ Add note").click();

  // The beat now has two stacked notes (a third up), so a fourth pitch overall.
  expect(pitchCount(await exportXml(page))).toBe(4);
});

test("Esc clears the selection without deleting", async ({ page }) => {
  await loadSingleStaff(page);
  const inspector = page.locator("aside");

  await page.locator("#p0-m1-n0-v0").click();
  await expect(page.getByText(/Sel: m\.1 .*· 1 note/)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(inspector.getByText(/click a note or rest/i)).toBeVisible();

  // Clearing the selection deleted nothing.
  expect(pitchCount(await exportXml(page))).toBe(3);
});

test("a letter key adds a note to the selected beat", async ({ page }) => {
  await loadSingleStaff(page);
  await page.locator("#p0-m1-n0-v0").click();
  await page.keyboard.press("e");
  expect(pitchCount(await exportXml(page))).toBe(4);
});

test("the + Measure button appends a measure", async ({ page }) => {
  await loadSingleStaff(page);
  expect(measureCount(await exportXml(page))).toBe(1);

  await moreAction(page, "Add measure");
  expect(measureCount(await exportXml(page))).toBe(2);
});
