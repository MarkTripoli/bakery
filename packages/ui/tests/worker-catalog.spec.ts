import { expect, test } from "@playwright/test";
import {
  analyzeAxe,
  openRuntimeFixture,
  runtime,
} from "./storybook-harness.ts";
for (
  const item of runtime.cases.filter((entry) => entry.id.startsWith("wr.list."))
) {
  test(item.id, async ({ page }) => {
    await openRuntimeFixture(
      page,
      item.storyId,
      item.context,
      item.assertions ?? [],
      item.args,
    );
    const root = page.locator('[data-ui-component="workerCatalog"]');
    await expect(root).toHaveAttribute("data-source", "synthetic-fixture");
    await expect(root).toHaveAttribute("data-state", item.args?.state ?? "");
    await expect(root.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(root.getByRole("status")).not.toBeEmpty();
    await expect(
      root.locator("a, button, input, select, textarea, [role=button]"),
    ).toHaveCount(0);
    await expect(root.locator(".ui-worker-catalog__rows > li")).toHaveCount(
      ["ready", "worstcase"].includes(item.args?.state ?? "") ? 3 : 0,
    );
    if (item.context.startsWith("paper-list-")) {
      const phone = item.context.endsWith("phone");
      const search = root.locator(".ui-worker-catalog__search-preview");
      await expect(search).toHaveCSS("border-radius", "6px");
      await expect(search.locator('[data-variant="list-search"]')).toHaveCount(
        1,
      );
      await expect(search.locator("svg")).toHaveAttribute("width", "18");
      await expect(search.locator("svg")).toHaveAttribute("height", "18");
      await expect(search.locator("svg")).toHaveCSS("width", "18px");
      await expect(search.locator("svg")).toHaveCSS("height", "18px");
      await expect(root.locator(".ui-worker-catalog__search-preview .ui-text"))
        .toHaveCSS("font-size", phone ? "16px" : "14px");
      for (
        const capacity of await root.locator(
          ".ui-worker-catalog__facts > .ui-text",
        ).all()
      ) {
        await expect(capacity).toHaveCSS("font-size", phone ? "13px" : "14px");
        await expect(capacity).toHaveCSS("line-height", "20px");
      }
      if (phone) {
        await expect(root.locator(".ui-worker-catalog__view").first())
          .toHaveText("View →");
        await expect(
          root.locator(".ui-worker-catalog__summary .ui-text").last(),
        )
          .toHaveCSS("font-size", "13px");
        const ink = item.context.includes("dark")
          ? "rgb(242, 244, 248)"
          : "rgb(0, 0, 0)";
        for (
          const icon of await root.locator(
            ".ui-worker-catalog__phone-status .ui-icon, .ui-worker-catalog__machine > .ui-icon, .ui-worker-catalog__search-preview > .ui-icon, .ui-worker-catalog__mobile-header > .ui-icon",
          ).all()
        ) {
          await expect(icon).toHaveCSS("color", ink);
        }
      }
    }
    expect((await analyzeAxe(page)).violations).toEqual([]);
    expect(await root.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    if (item.context.includes("coarse")) {
      for (
        const preview of await root.locator('[data-ui-component="button"]')
          .all()
      ) {
        expect((await preview.boundingBox())?.height).toBeGreaterThanOrEqual(
          44,
        );
      }
    }
    if (item.context === "keyboard-focus") {
      await page.keyboard.press("Tab");
      await expect(root.getByRole("status")).toBeFocused();
    }
  });
}
