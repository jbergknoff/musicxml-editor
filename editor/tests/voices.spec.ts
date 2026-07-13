import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";

// A single staff carrying two <voice>s (a sustained whole-note chord in voice 1
// over a moving quarter-note line in voice 2) renders both voices, lets each be
// selected independently, shifts one voice without disturbing the other, and can
// move a note between voices with the `v` key.

const TWO_VOICE = fileURLToPath(
  new URL("./fixtures/two-voice.musicxml", import.meta.url),
);

async function exportXml(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  return readFileSync(await download.path(), "utf8");
}

async function clickNotehead(page: Page, id: string): Promise<void> {
  const box = await page.locator(id).boundingBox();
  if (!box) {
    throw new Error(`notehead ${id} has no bounding box`);
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// The number of *pitched* (non-rest) <note> elements belonging to voice `voice`
// in measure 1. Fill rests carry a <voice> too, so they must be excluded; and a
// note with no <voice> child is voice 1 by the MusicXML default.
function voiceNoteCount(xml: string, voice: number): number {
  const measure1 =
    xml.match(/<measure number="1">([\s\S]*?)<\/measure>/)?.[1] ?? "";
  const noteRe = /<note\b[^>]*>([\s\S]*?)<\/note>/g;
  let count = 0;
  for (const match of measure1.matchAll(noteRe)) {
    const body = match[1];
    if (!body.includes("<pitch>")) {
      continue;
    }
    const voiceMatch = body.match(/<voice>(\d+)<\/voice>/);
    const noteVoice = voiceMatch ? Number.parseInt(voiceMatch[1], 10) : 1;
    if (noteVoice === voice) {
      count += 1;
    }
  }
  return count;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles(TWO_VOICE);
  // Both voices of measure 1 render: voice 1's held chord (n0) and voice 2's
  // first moving quarter (n1).
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
  await expect(page.locator("#p0-m1-n1-v0")).toBeVisible();
});

test("a two-voice staff is editable, not view-only", async ({ page }) => {
  await expect(page.getByText(/view-only/i)).toHaveCount(0);
});

test("selecting the inner voice shows a Voice 2 badge in the inspector", async ({
  page,
}) => {
  const inspector = page.locator("aside");
  // Click voice 2's first quarter note (C5). The inspector labels it Voice 2.
  await clickNotehead(page, "#p0-m1-n1-v0");
  await expect(inspector.getByText("Voice 2")).toBeVisible();
});

test("shifting the inner voice leaves the sustained voice in place", async ({
  page,
}) => {
  // Select voice 2's first quarter (beat 1) and shift the run later in time.
  await clickNotehead(page, "#p0-m1-n1-v0");
  await page.keyboard.press(".");
  const xml = await exportXml(page);
  // Voice 1 still holds one whole note; voice 2 still has its four quarters
  // (now starting a beat later, with a leading rest) — the voices didn't merge.
  expect(voiceNoteCount(xml, 1)).toBe(2); // the E4+G4 whole-note chord
  expect(voiceNoteCount(xml, 2)).toBe(4); // the four moving quarters
});

test("the v key moves a note to the staff's other voice", async ({ page }) => {
  const before = await exportXml(page);
  // Voice 1 starts with the E4+G4 whole-note chord (two pitched <voice>1 notes);
  // voice 2 has four moving quarters, the first (C5) at beat 1 alongside them.
  expect(voiceNoteCount(before, 1)).toBe(2);
  expect(voiceNoteCount(before, 2)).toBe(4);
  // Drill into voice 2's first quarter (C5) and move it to the other voice.
  // C5 shares its onset with the voice-1 chord, so it merges there rather than
  // overlapping — an allowed move.
  await clickNotehead(page, "#p0-m1-n1-v0");
  await clickNotehead(page, "#p0-m1-n1-v0"); // second click drills to the note
  await page.keyboard.press("v");
  const after = await exportXml(page);
  // C5 left voice 2 (three quarters remain) and joined the voice-1 chord.
  expect(voiceNoteCount(after, 2)).toBe(3);
  expect(voiceNoteCount(after, 1)).toBe(3);
});
