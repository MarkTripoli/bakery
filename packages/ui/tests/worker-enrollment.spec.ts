import { expect, test } from "@playwright/test";
import { workerEnrollmentPlaceholder } from "../src/fixtures/worker-readiness.ts";
import {
  analyzeAxe,
  openRuntimeFixture,
  runtime,
} from "./storybook-harness.ts";

for (
  const item of runtime.cases.filter((entry) =>
    entry.id.startsWith("wr.enrollment.")
  )
) {
  test(item.id, async ({ page }) => {
    await openRuntimeFixture(
      page,
      item.storyId,
      item.context,
      item.assertions ?? [],
      item.args,
    );
    const root = page.locator(
      '[data-ui-component="workerEnrollmentInstructions"]',
    );
    await expect(root).toHaveAttribute("data-source", "synthetic-fixture");
    await expect(root).toHaveAttribute("data-state", item.id.split(".")[2]);
    await expect(root.getByRole("status")).not.toBeEmpty();
    await expect(root.getByRole("heading", { level: 1 })).toHaveCount(1);
    // Static prototype artwork must never become an operational control.
    await expect(root.getByRole("button")).toHaveCount(0);
    await expect(
      root.locator("a, button, input, select, textarea, [role=button]"),
    )
      .toHaveCount(0);
    const previews = root.locator('[data-ui-component="button"]');
    expect(await previews.count()).toBeGreaterThanOrEqual(3);
    for (const preview of await previews.all()) {
      expect(
        await preview.evaluate((el) => ({
          tag: el.tagName,
          role: el.getAttribute("role"),
          tabIndex: el.getAttribute("tabindex"),
          onclick: el.getAttribute("onclick"),
          opacity: getComputedStyle(el).opacity,
        })),
      ).toEqual({
        tag: "SPAN",
        role: null,
        tabIndex: null,
        onclick: null,
        opacity: "1",
      });
    }
    await expect(root.locator(".ui-worker-enrollment__hint .ui-text--caption"))
      .toBeVisible();
    await expect(root.locator(".ui-worker-enrollment__steps > li")).toHaveCount(
      4,
    );
    await expect(root.locator(".ui-worker-enrollment__circle")).toHaveCount(4);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(root.locator("pre")).toHaveText(workerEnrollmentPlaceholder);
    await expect(root.locator("pre")).not.toContainText(/curl|wget|sudo/);
    await expect(root.locator(".ui-worker-enrollment__token-row"))
      .toContainText("••••");
    const positive = ["start", "listening", "connected"].includes(
      item.args?.state ?? "",
    );
    await expect(root.getByRole("status")).toHaveAttribute(
      "data-panel",
      positive ? item.args?.state ?? "" : "negative",
    );
    await expect(root.locator('[data-complete="true"]')).toHaveCount(
      item.args?.state === "connected" ? 1 : 0,
    );
    const viewport = runtime.contexts[item.context].viewport;
    if (viewport.width < 744) {
      await expect(root.locator(".ui-worker-enrollment__breadcrumb-mobile"))
        .toBeVisible();
      await expect(root.locator(".ui-worker-enrollment__breadcrumb-desktop"))
        .toBeHidden();
      await expect(root.locator(".ui-worker-enrollment__mobile-header"))
        .toBeVisible();
      await expect(root.locator(".ui-worker-enrollment__footer")).toBeVisible();
      await expect(root.locator(".ui-worker-enrollment__summary")).toBeHidden();
      expect(
        await root.locator("main").evaluate((el) =>
          getComputedStyle(el).paddingInlineStart
        ),
      ).toBe("16px");
    } else if (viewport.width >= 1280) {
      await expect(root.locator(".ui-worker-enrollment__rail")).toBeVisible();
      await expect(root.locator(".ui-worker-enrollment__summary"))
        .toBeVisible();
    }
    if (item.context.startsWith("paper-enrollment-")) {
      if (viewport.width === 390) {
        expect(
          await root.locator(".bakery-app-shell__header").evaluate((el) =>
            el.getBoundingClientRect().height
          ),
        ).toBe(114);
        expect(await page.evaluate(() => document.documentElement.scrollHeight))
          .toBe(viewport.height);
      }
      const lines = await root.locator(".ui-worker-enrollment__step").nth(2)
        .locator(".ui-worker-enrollment__step-body > .ui-text").evaluate((el) =>
          el.getBoundingClientRect().height /
          parseFloat(getComputedStyle(el).lineHeight)
        );
      expect(lines).toBe(viewport.width === 390 ? 3 : 1);
    }
    expect((await analyzeAxe(page)).violations).toEqual([]);
    expect(
      await root.evaluate((element) =>
        element.scrollWidth <= element.clientWidth
      ),
    ).toBe(true);
    if (item.context.includes("coarse")) {
      for (const preview of await previews.all()) {
        expect((await preview.boundingBox())?.height).toBeGreaterThanOrEqual(
          44,
        );
      }
    }
    if (item.context === "keyboard-focus") {
      await page.keyboard.press("Tab");
      await expect(root.locator("pre")).toBeFocused();
    }
  });
}
