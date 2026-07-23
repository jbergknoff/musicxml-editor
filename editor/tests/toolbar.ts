import type { Page } from "@playwright/test";

// Open the toolbar's "⋯ More" overflow menu and click one of its items.
// The rarer structure/append actions (staves, measures, redistribute, append
// import) live there rather than as flat toolbar buttons.
export async function moreAction(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}
