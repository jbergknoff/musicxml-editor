import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// A rest-targeted low-confidence flag can never be shown (no amber tint) or
// dismissed (no checkmark) since the review UI only attaches to notes/graces
// (see hit-test.ts's pickableNotes, which explicitly skips rests). The panel's
// per-line count must exclude such flags, or dismissing every visible one
// still leaves the badge stuck above zero.
const FIXTURE = fileURLToPath(
  new URL("./fixtures/rest-flag.musicxml", import.meta.url),
);

test("a flag on a rest does not inflate the review panel's amber-note count", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles(FIXTURE);
  // Only the note flag (index 0) should count; the rest flag (index 2) should not.
  await expect(page.getByText(/1 amber note on this line/)).toBeVisible();
});
