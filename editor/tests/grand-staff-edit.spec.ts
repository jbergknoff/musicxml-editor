import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";

// A grand staff (piano: treble + bass, one voice each) is editable, and — the
// behaviour under test — a note can be added onto the *bass* staff, not just the
// treble. Clicking the bass note selects a bass slot, and typing a letter fills
// a bass rest with a note carrying <staff>2</staff>. ←/→ walks the shared rhythm
// spine (the union of both staves' onsets), staying on the current staff when it
// has an onset at the destination beat and crossing to the other when it does
// not — so navigation reaches every beat, not just the current staff's onsets.

const GRAND_STAFF_LEDGER = fileURLToPath(
  new URL("./fixtures/grand-staff-ledger.musicxml", import.meta.url),
);
const GRAND_STAFF_SPINE = fileURLToPath(
  new URL("./fixtures/grand-staff-spine.musicxml", import.meta.url),
);
const GRAND_STAFF_SHIFT_SPINE = fileURLToPath(
  new URL("./fixtures/grand-staff-shift-spine.musicxml", import.meta.url),
);
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

function pitchCount(xml: string): number {
  return (xml.match(/<pitch>/g) ?? []).length;
}

// Count the pitched (non-rest) notes assigned to a given staff number.
function pitchedNotesOnStaff(xml: string, staff: number): number {
  const noteRe = /<note\b[^>]*>([\s\S]*?)<\/note>/g;
  let count = 0;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex scan loop
  while ((match = noteRe.exec(xml)) !== null) {
    const body = match[1];
    if (
      /<pitch>/.test(body) &&
      new RegExp(`<staff>${staff}</staff>`).test(body)
    ) {
      count++;
    }
  }
  return count;
}

// Click a notehead by its glyph center (a direct element click can be
// intercepted by a neighbouring glyph box on a grand staff).
async function clickNotehead(page: Page, id: string): Promise<void> {
  const box = await page.locator(id).boundingBox();
  if (!box) {
    throw new Error(`notehead ${id} has no bounding box`);
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
});

test("a note can be added onto the bass staff of a grand staff", async ({
  page,
}) => {
  await page.locator('input[type="file"]').first().setInputFiles(GRAND_STAFF);
  // Both staves render: p0 is treble, p1 is bass.
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
  await expect(page.locator("#p1-m1-n0-v0")).toBeVisible();
  // A simple grand staff is editable, not view-only.
  await expect(page.getByText(/view-only/i)).toHaveCount(0);

  const before = await exportXml(page);
  expect(pitchedNotesOnStaff(before, 1)).toBe(1); // treble C5
  expect(pitchedNotesOnStaff(before, 2)).toBe(1); // bass G2

  const inspector = page.locator("aside");

  // Click the bass G2 → selects the beat-1 slot on the bass staff (not treble).
  await clickNotehead(page, "#p1-m1-n0-v0");
  await expect(inspector.getByText("G2", { exact: true })).toBeVisible();

  // → advances along the spine to beat 2; the bass has its own onset there, so
  // the selection stays on the bass staff.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText(/Sel: m\.1 .*b2 /)).toBeVisible();
  // Both staves rest at beat 2 — the inspector shows one group per staff.
  await expect(inspector.getByText("Rest · quarter")).toHaveCount(2);

  // Typing a letter fills that bass rest with a note on the bass staff.
  await page.keyboard.press("e");

  const after = await exportXml(page);
  expect(pitchCount(after)).toBe(3);
  // The treble is untouched; the new note landed on the bass staff (staff 2).
  expect(pitchedNotesOnStaff(after, 1)).toBe(1);
  expect(pitchedNotesOnStaff(after, 2)).toBe(2);
  // It was placed near the bass staff (an E in octave 2–3), not treble range.
  expect(after).toMatch(/<step>E<\/step>\s*<octave>[23]<\/octave>/);
});

test("a ledger-line bass note selects the bass staff even when the click is nearer the treble staff", async ({
  page,
}) => {
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(GRAND_STAFF_LEDGER);
  // p1 is the bass staff; its D4 sits on ledger lines between the staves.
  const head = page.locator("#p1-m1-n0-v0");
  await expect(head).toBeVisible();
  const box = await head.boundingBox();
  if (!box) {
    throw new Error("notehead has no bounding box");
  }

  // Click slightly ABOVE the notehead's center — vertically nearer the treble
  // staff's band than the bass staff's. The screen-space notehead pick must
  // still resolve the tap to the bass note's own slot, not the treble rest.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 - 4);
  // The click selects that one bass note directly (a single-note selection),
  // not the treble rest whose band the tap was nearer.
  await expect(page.getByText(/Sel: m\.1 .*· 1 note/)).toBeVisible();
});

test("→ walks the shared spine, crossing to the other staff mid-note", async ({
  page,
}) => {
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(GRAND_STAFF_SPINE);
  const inspector = page.locator("aside");

  // Select the treble half note at beat 1 (C5). The treble's own next onset is
  // beat 3, but the bass subdivides beat 2 — so → must land on beat 2, crossing
  // to the bass staff (the treble has no onset there).
  await clickNotehead(page, "#p0-m1-n0-v0");
  await expect(inspector.getByText("C5", { exact: true })).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(page.getByText(/Sel: m\.1 .*b2 /)).toBeVisible();
  // The bass A2 onset at beat 2 is what we crossed to.
  await expect(inspector.getByText("A2", { exact: true })).toBeVisible();

  // → again reaches beat 3, where both staves have an onset; still on bass (B2).
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText(/Sel: m\.1 .*b3 /)).toBeVisible();
  await expect(inspector.getByText("B2", { exact: true })).toBeVisible();
});

test("shift-right lands a quarter note on a half-beat-offset target on another staff", async ({
  page,
}) => {
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(GRAND_STAFF_SHIFT_SPINE);
  const inspector = page.locator("aside");

  // The treble's final quarter note (F5, n3 — the fixture's three eighth notes
  // ahead of it are n0-n2) lands on beat 2.5 — the eighths in its own staff
  // shifted it off the beat grid the bass (plain quarters) sits on. Stepping
  // by the note's own duration (1 beat) would only ever visit other
  // half-beats (1.5, 3.5, ...) and never reach beat 3, where the bass's final
  // quarter (A2, n1) lands.
  await clickNotehead(page, "#p0-m1-n3-v0");
  await expect(inspector.getByText("F5", { exact: true })).toBeVisible();

  await page.keyboard.press(".");

  // No badge: the shifted quarter fits exactly into the bar's remaining
  // space rather than growing an over-full bar.
  await expect(page.getByText(/beats$/)).toHaveCount(0);

  // Re-select via the bass note now at the same onset: both F5 and A2 show up
  // together as one shared-beat position, confirming the two staves' onsets
  // now coincide exactly (not merely close).
  await clickNotehead(page, "#p1-m1-n1-v0");
  await expect(inspector.getByText("F5", { exact: true })).toBeVisible();
  await expect(inspector.getByText("A2", { exact: true })).toBeVisible();

  const xml = await exportXml(page);
  expect(xml).toMatch(/<step>F<\/step>\s*<octave>5<\/octave>/);
  expect(xml).toMatch(/<step>A<\/step>\s*<octave>2<\/octave>/);
});
