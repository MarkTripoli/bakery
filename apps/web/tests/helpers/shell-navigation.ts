import type { Page } from "@playwright/test";

/**
 * On the phone profile the app shell keeps its sidebar in a navigation
 * drawer; open it so sidebar destinations are reachable. Wider profiles show
 * the sidebar inline and need nothing.
 */
export async function revealShellNavigation(page: Page): Promise<void> {
  await page.locator("main#bakery-main").waitFor();
  const opener = page.getByRole("button", { name: "Open navigation" });
  if (await opener.isVisible()) await opener.click();
}

/** Opens the sidebar account menu of the signed-in person `name`. */
export async function openAccountMenu(page: Page, name: string) {
  await revealShellNavigation(page);
  await page.getByRole("button", { name, exact: true }).click();
  return page.getByRole("navigation", { name });
}
