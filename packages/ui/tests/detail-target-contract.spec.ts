import { expect, test } from "@playwright/test";
import {
  coarseTargetCheck,
  detailInertnessIssues,
  openRuntimeFixture,
  runtime,
  runtimeAssertions,
} from "./storybook-harness.ts";

test.use({ hasTouch: true });

for (
  const kind of [
    "span",
    "button",
    "role-button",
    "large-button",
    "unmarked",
    "narrow",
    "link",
    "tabindex",
  ]
) {
  test(`detail target contract ${kind}`, async ({ page }) => {
    await page.setContent(
      `<div class="storybook-story"><div data-ui-component="workerReadOnlyDetail" data-state="ready">${
        Array.from({ length: 4 }, () =>
          '<span data-ui-component="button">Artwork</span>').join("")
      }</div></div>`,
    );
    await page.locator('[data-ui-component="button"]').last().evaluate(
      (element, kind) => {
        const replacement = document.createElement(
          ["button", "large-button", "unmarked", "narrow"].includes(kind)
            ? "button"
            : "span",
        );
        replacement.innerHTML = element.innerHTML;
        if (kind !== "unmarked") {
          replacement.setAttribute("data-ui-component", "button");
          replacement.className = "ui-button--preview";
          replacement.setAttribute("data-density", "static-compact");
        }
        if (kind === "role-button" || kind === "link") {
          replacement.setAttribute("role", kind === "link" ? "link" : "button");
          replacement.tabIndex = 0;
        }
        if (kind === "tabindex") replacement.tabIndex = 0;
        replacement.style.cssText =
          `display:inline-block;box-sizing:border-box;padding:0;border:0;width:${
            kind === "narrow" ? 38 : 100
          }px;height:${["large-button", "narrow"].includes(kind) ? 44 : 38}px`;
        element.replaceWith(replacement);
      },
      kind,
    );
    const root = page.locator('[data-ui-component="workerReadOnlyDetail"]');
    const inertness = await root.evaluate(detailInertnessIssues);
    const targets = await page.locator(".storybook-story").evaluate(
      coarseTargetCheck,
    );
    if (kind === "span") {
      expect(inertness).toEqual([]);
      expect(targets).toEqual({ visibleCount: 0, undersized: [] });
    } else {
      expect(inertness.length).toBeGreaterThan(0);
      expect(targets.visibleCount).toBe(1);
      expect(targets.undersized).toHaveLength(kind === "large-button" ? 0 : 1);
      await expect(
        runtimeAssertions(page, {
          id: kind,
          catalogId: "template.workerReadOnlyDetail",
          assertions: ["target-size"],
        }, {}),
      ).rejects.toThrow("detail must remain visible and inert");
    }
  });
}

test("detail target contract catches controls outside inert detail", async ({ page }) => {
  const item = runtime.cases.find((item) =>
    item.id === "wr.detail.ready.phone-light-coarse"
  )!;
  const { context } = await openRuntimeFixture(
    page,
    item.storyId,
    item.context,
    item.assertions ?? [],
    item.args,
  );
  await runtimeAssertions(page, item, context);
  await page.locator(".storybook-story").evaluate((root) => {
    const button = document.createElement("button");
    button.textContent = "Test only";
    button.style.cssText =
      "width:38px;height:38px;min-width:0;min-height:0;padding:0;border:0";
    root.append(button);
  });
  expect(
    await page.locator('[data-ui-component="workerReadOnlyDetail"]').evaluate(
      detailInertnessIssues,
    ),
  ).toEqual([]);
  await expect(runtimeAssertions(page, item, context)).rejects.toThrow(
    "undersized targets",
  );
});
