import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The run's actions live in one "Run actions" menu (#57): Resume is the one
 * primary button of a paused run; Pause, Interrupt, Cancel and "Check again"
 * are menu entries, and only what the server allows is listed. The entries are
 * plain buttons in the popover.
 */
export const runActionsTrigger = (page: Page): Locator =>
  page.getByRole("button", { name: "Run actions", exact: true });

/** One entry of the open menu: "Pause run", "Interrupt the agent", "Cancel run", "Check again". */
export const runAction = (page: Page, name: string): Locator =>
  page.locator(".ui-popover__content").getByRole("button", {
    name,
    exact: true,
  });

export async function openRunActions(page: Page): Promise<void> {
  const trigger = runActionsTrigger(page);
  await expect(trigger).toBeVisible();
  if (await trigger.getAttribute("aria-expanded") !== "true") {
    await trigger.click();
  }
}

/** Open the menu and choose an entry (not Cancel run: that asks first, see {@link cancelRun}). */
export async function chooseRunAction(page: Page, name: string): Promise<void> {
  await openRunActions(page);
  await runAction(page, name).click();
}

/** Choose "Cancel run" and confirm in the dialog that asks first. */
export async function cancelRun(page: Page): Promise<void> {
  await chooseRunAction(page, "Cancel run");
  await page.getByRole("alertdialog").getByRole("button", {
    name: "Cancel run",
    exact: true,
  }).click();
}
