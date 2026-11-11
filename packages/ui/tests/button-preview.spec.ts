import { expect, test } from "@playwright/test";
import { openRuntimeFixture } from "./storybook-harness.ts";

test("shared button previews are static while native disabled controls retain semantics", async ({ page }) => {
  await openRuntimeFixture(
    page,
    "bakery-atoms-button--contract",
    "desktop-light-fine",
    [],
  );
  const previews = page.locator(
    '[data-variant^="preview-"]:not([data-density])',
  );
  await expect(previews).toHaveCount(2);
  for (const preview of await previews.all()) {
    expect(
      await preview.evaluate((el) => ({
        tag: el.tagName,
        role: el.getAttribute("role"),
        tabIndex: el.getAttribute("tabindex"),
        height: el.getBoundingClientRect().height,
        padding: getComputedStyle(el).paddingInlineStart,
        lineHeight: getComputedStyle(el).lineHeight,
        weight: getComputedStyle(el).fontWeight,
        opacity: getComputedStyle(el).opacity,
      })),
    ).toEqual({
      tag: "SPAN",
      role: null,
      tabIndex: null,
      height: 36,
      padding: "14px",
      lineHeight: "16px",
      weight: "500",
      opacity: "1",
    });
    await preview.click();
    await expect(page.getByRole("status")).toHaveText("0 preview actions");
    await expect(preview).not.toBeFocused();
  }
  const disabled = page.getByRole("button", { name: "Disabled", exact: true });
  await expect(disabled).toBeDisabled();
  await expect(disabled).toHaveCSS("opacity", "0.55");
  await page.getByRole("button", { name: "Run preview", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("1 preview actions");
});

for (const context of ["phone-light-fine", "phone-light-coarse"]) {
  test(`static preview retains phone/coarse geometry: ${context}`, async ({ page }) => {
    await openRuntimeFixture(
      page,
      "bakery-atoms-button--contract",
      context,
      [],
    );
    for (
      const el of await page.locator(
        '[data-variant^="preview-"]:not([data-density])',
      ).all()
    ) {
      await expect(el).toHaveCSS("min-height", "44px");
      await expect(el).toHaveCSS("padding-inline-start", "18px");
      await expect(el).toHaveCSS("line-height", "18px");
    }
  });
}

for (
  const context of [
    "desktop-light-fine",
    "phone-light-fine",
    "phone-light-coarse",
  ]
) {
  test(`standard preview density is opt-in and inert: ${context}`, async ({ page }) => {
    await openRuntimeFixture(
      page,
      "bakery-atoms-button--contract",
      context,
      [],
    );
    const previews = page.locator('[data-density="standard"]');
    await expect(previews).toHaveCount(2);
    for (const preview of await previews.all()) {
      await expect(preview).toHaveCSS("line-height", "20px");
      await expect(preview).toHaveCSS("font-size", "14px");
      await expect(preview).toHaveCSS("padding-inline-start", "14px");
      await expect(preview).toHaveCSS(
        "min-height",
        context.startsWith("phone") ? "44px" : "36px",
      );
      expect(
        await preview.evaluate((el) => ({
          tag: el.tagName,
          role: el.getAttribute("role"),
          tabIndex: el.getAttribute("tabindex"),
        })),
      ).toEqual({ tag: "SPAN", role: null, tabIndex: null });
      await preview.click();
      await expect(preview).not.toBeFocused();
      await expect(page.getByRole("status")).toHaveText("0 preview actions");
    }
  });
}

for (
  const context of [
    "desktop-light-fine",
    "phone-light-fine",
    "phone-light-coarse",
  ]
) {
  test(`compact static artwork never changes hit areas: ${context}`, async ({ page }) => {
    await openRuntimeFixture(
      page,
      "bakery-atoms-button--contract",
      context,
      [],
    );
    for (
      const primary of await page.locator(".ui-button--primary").all()
    ) {
      const colors = await primary.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          preview: el.classList.contains("ui-button--preview"),
          background: style.backgroundColor,
          borders: [
            style.borderTopColor,
            style.borderRightColor,
            style.borderBottomColor,
            style.borderLeftColor,
          ],
        };
      });
      expect(colors.borders).toEqual(
        Array(4).fill(colors.preview ? colors.background : "rgba(0, 0, 0, 0)"),
      );
    }
    const previews = page.locator('[data-density="static-compact"]');
    await expect(previews).toHaveCount(2);
    for (const preview of await previews.all()) {
      expect(
        await preview.evaluate((el) => ({
          tag: el.tagName,
          role: el.getAttribute("role"),
          tabIndex: el.getAttribute("tabindex"),
          height: el.getBoundingClientRect().height,
          minHeight: getComputedStyle(el).minHeight,
          padding: getComputedStyle(el).padding,
          fontSize: getComputedStyle(el).fontSize,
          lineHeight: getComputedStyle(el).lineHeight,
          radius: getComputedStyle(el).borderRadius,
        })),
      ).toEqual({
        tag: "SPAN",
        role: null,
        tabIndex: null,
        height: 38,
        minHeight: "36px",
        padding: "8px 14px",
        fontSize: "14px",
        lineHeight: "20px",
        radius: "6px",
      });
      await preview.click();
      await expect(preview).not.toBeFocused();
      await expect(page.getByRole("status")).toHaveText("0 preview actions");
    }
    if (context.startsWith("phone")) {
      for (
        const control of await page.locator(
          context.endsWith("coarse")
            ? '[data-ui-component="button"]:not([data-density="static-compact"])'
            : '[data-density="standard"]',
        ).all()
      ) {
        expect(
          await control.evaluate((el) => el.getBoundingClientRect().height),
        ).toBeGreaterThanOrEqual(44);
      }
    }
  });
}
