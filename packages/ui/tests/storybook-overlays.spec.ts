import { expect, test } from "@playwright/test";
import { openByTitle } from "./storybook-harness.ts";

test.describe("Storybook overlay interactions", () => {
  test("keeps ResourcePicker unavailable state visible", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/ResourcePicker");
    const picker = page.getByTestId("resource-picker-unavailable");
    await expect(picker).toBeVisible();
    await expect(picker.locator("select")).toBeDisabled();
  });

  test("keeps the submitting Dialog native and keyboard-modal", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/Dialog");
    const dialog = page.getByTestId("native-dialog");
    const trigger = page.getByTestId("native-dialog-trigger");
    const dismiss = dialog.getByRole("button", { name: "Close dialog" });
    const closePreview = dialog.getByRole("button", {
      name: "Close preview",
      exact: true,
    });
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-state", "submitting");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.evaluate((element) => element.matches(":modal")))
      .resolves.toBe(true);
    await expect(dismiss).toBeFocused();
    await dialog.evaluate((element) => {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "More context";
      details.append(summary);
      element.append(details);
    });
    const summary = dialog.getByText("More context");
    await dismiss.press("Shift+Tab");
    await expect(summary).toBeFocused();
    await summary.press("Tab");
    await expect(dismiss).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("status")).toHaveText("dialog:Escape");
    await dialog.evaluate((element) => {
      (element as HTMLDialogElement).hidden = true;
    });
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(
      dialog.evaluate((element) => (element as HTMLDialogElement).open),
    ).resolves.toBe(
      false,
    );
    await dialog.evaluate((element) => {
      (element as HTMLDialogElement).hidden = false;
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.evaluate((element) => element.matches(":modal")))
      .resolves.toBe(true);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await closePreview.click();
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await closePreview.focus();
    await closePreview.press("Tab");
    await expect(summary).toBeFocused();
    await summary.press("Tab");
    await expect(dismiss).toBeFocused();
  });

  test("exposes and dismisses the confirming native AlertDialog", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/AlertDialog");
    const dialog = page.getByTestId("native-alert");
    const trigger = page.getByTestId("native-alert-trigger");
    await trigger.click();
    await expect(
      page.getByRole("alertdialog", { name: "Archive task?" }),
    ).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(
      "You can restore this task later.",
    );
    await expect(dialog).toHaveAttribute("data-state", "confirming");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.evaluate((element) => element.matches(":modal")))
      .resolves.toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("status")).toHaveText("alert:Escape");
    await trigger.click();
    const archive = dialog.getByRole("button", {
      name: "Archive",
      exact: true,
    });
    await archive.focus();
    await archive.press("Tab");
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeFocused();
    await cancel.click();
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test("keeps the error Sheet native and keyboard-modal", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/Sheet");
    const sheet = page.getByTestId("native-sheet");
    const trigger = page.getByTestId("native-sheet-trigger");
    await trigger.click();
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-state", "error");
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    await expect(sheet.evaluate((element) => element.matches(":modal")))
      .resolves.toBe(true);
    const geometry = await sheet.evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      return {
        bottom: rectangle.bottom,
        height: rectangle.height,
        viewportHeight: innerHeight,
      };
    });
    expect(geometry.height).toBeGreaterThan(0);
    expect(geometry.bottom).toBe(geometry.viewportHeight);
    await page.keyboard.press("Escape");
    await expect(sheet).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("status")).toHaveText("sheet:Escape");
    await trigger.click();
    const closePreview = sheet.getByRole("button", {
      name: "Close preview",
      exact: true,
    });
    await closePreview.focus();
    await closePreview.press("Tab");
    await expect(sheet.getByRole("button", { name: "Close sheet" }))
      .toBeFocused();
    await closePreview.click();
    await expect(sheet).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });
});
