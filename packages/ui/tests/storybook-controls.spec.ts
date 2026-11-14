import { expect, test } from "@playwright/test";
import {
  baseURL,
  canonicalStories,
  openByTitle,
  storyPath,
  waitForSpecimen,
} from "./storybook-harness.ts";

test.describe("Storybook coarse controls", () => {
  test("keeps every canonical coarse interaction at least 44px", async ({ browser }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({
      baseURL,
      hasTouch: true,
      isMobile: true,
      viewport: { width: 1280, height: 960 },
    });
    const page = await context.newPage();
    try {
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches))
        .toBe(true);
      for (const story of await canonicalStories(page)) {
        await page.goto(
          `${storyPath(story.id)}&globals=${
            encodeURIComponent("pointer:coarse")
          }`,
        );
        await waitForSpecimen(page);
        const undersized = await page.locator(
          "a, button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], label:has(input:not([type=hidden]))",
        ).evaluateAll((elements) =>
          elements.flatMap((element) => {
            const style = getComputedStyle(element);
            const rectangle = element.getBoundingClientRect();
            // A skip link is clipped to nothing until it has focus: it is not
            // a target at rest, so it is measured as the target it becomes.
            if (
              element instanceof HTMLElement &&
              element.classList.contains("bakery-app-shell__skip-link")
            ) {
              element.focus();
              const focused = element.getBoundingClientRect();
              element.blur();
              return focused.width >= 44 && focused.height >= 44 ? [] : [{
                role: "skip-link-focused",
                text: element.textContent?.trim().slice(0, 80),
                width: focused.width,
                height: focused.height,
              }];
            }
            if (
              element instanceof HTMLInputElement &&
              ["checkbox", "radio"].includes(element.type) &&
              element.closest("label")
            ) return [];
            if (
              style.display === "none" || style.visibility === "hidden" ||
              rectangle.width === 0 || rectangle.height === 0 ||
              Number(style.opacity) === 0
            ) return [];
            return rectangle.width >= 44 && rectangle.height >= 44 ? [] : [{
              role: element.getAttribute("role"),
              text: element.textContent?.trim().slice(0, 80),
              width: rectangle.width,
              height: rectangle.height,
            }];
          })
        );
        expect(undersized, story.title).toEqual([]);
      }
    } finally {
      await context.close();
    }
  });

  test("keeps two Tabs instances isolated with unique IDs", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/Tabs");
    const taskTabs = page.getByRole("tablist", { name: "Task views" });
    const projectTabs = page.getByRole("tablist", { name: "Project views" });
    await expect(taskTabs).toBeVisible();
    await expect(projectTabs).toBeVisible();
    const projectBefore = await projectTabs.getByRole("tab").evaluateAll(
      (tabs) => tabs.map((tab) => tab.getAttribute("aria-selected")),
    );
    const ids = await page.locator('[role="tab"], [role="tabpanel"]')
      .evaluateAll((elements) => elements.map((element) => element.id));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    const taskTab = taskTabs.getByRole("tab").first();
    await taskTab.focus();
    await taskTab.press("ArrowRight");
    await expect(taskTabs.getByRole("tab").nth(1)).toBeFocused();
    await expect(taskTabs.getByRole("tab").nth(1)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      await projectTabs.getByRole("tab").evaluateAll((tabs) =>
        tabs.map((tab) => tab.getAttribute("aria-selected"))
      ),
    ).toEqual(projectBefore);
  });

  test("skips disabled Tabs for arrows, Home, and End", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/Tabs");
    const tabs = page.getByRole("tablist", { name: "Disabled views" })
      .getByRole("tab");
    await tabs.first().focus();
    await tabs.first().press("ArrowRight");
    await expect(tabs.nth(2)).toBeFocused();
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await tabs.nth(2).press("ArrowLeft");
    await expect(tabs.first()).toBeFocused();
    await tabs.first().press("End");
    await expect(tabs.nth(2)).toBeFocused();
    await tabs.nth(2).press("Home");
    await expect(tabs.first()).toBeFocused();
  });

  test("associates and announces SearchField result updates", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/SearchField");
    const search = page.getByTestId("results-search");
    await expect(search).toHaveAccessibleDescription("2 matching tasks");
    await search.fill("");
    await expect(search).toBeFocused();
    await expect(search).toHaveAccessibleDescription("No matching tasks");
    await search.fill("work");
    await expect(search).toBeFocused();
    await expect(search).toHaveAccessibleDescription("2 matching tasks");
    await expect(
      page.getByRole("status").filter({ hasText: "2 matching tasks" }),
    ).toBeVisible();
  });

  test("preserves caller-provided SearchField ARIA state", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/SearchField");
    const search = page.getByTestId("external-search-state");
    await expect(search).toHaveAttribute("aria-busy", "true");
    await expect(search).toHaveAttribute("aria-invalid", "true");
  });

  test("never lets the PasswordInput value render under the reveal toggle", async ({ page }) => {
    for (const direction of ["ltr", "rtl"] as const) {
      await openByTitle(
        page,
        "Bakery/Molecules/PasswordInput",
        `direction:${direction}`,
      );
      const overlaps = await page.locator(".ui-password-input").evaluateAll(
        (wrappers) =>
          wrappers.map((wrapper) => {
            const field = wrapper.querySelector("input")!;
            const toggle = wrapper.querySelector(".ui-icon-button")!;
            const fieldStyle = getComputedStyle(field);
            const fieldRect = field.getBoundingClientRect();
            const toggleRect = toggle.getBoundingClientRect();
            // Positive = the padded text area extends past the toggle (overlap); negative/zero =
            // a real gap. The reserved padding sits on the toggle's side regardless of direction,
            // so the same sign convention holds whichever inline edge the toggle mirrors to.
            return fieldStyle.direction === "rtl"
              ? toggleRect.right -
                (fieldRect.left + parseFloat(fieldStyle.paddingLeft))
              : (fieldRect.right - parseFloat(fieldStyle.paddingRight)) -
                toggleRect.left;
          }),
      );
      expect(overlaps.length, direction).toBeGreaterThan(0);
      for (const overlap of overlaps) {
        expect(overlap, direction).toBeLessThanOrEqual(0);
      }
    }
  });

  test("keeps the OneTimeCodeInput field monospaced", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/OneTimeCodeInput");
    const fontFamily = await page.locator(".ui-one-time-code-input").first()
      .evaluate((field) => getComputedStyle(field).fontFamily);
    expect(fontFamily).toContain("Geist Mono");
  });

  test("keeps the brand pane split and context card width bound across breakpoints", async ({ page }) => {
    for (const direction of ["ltr", "rtl"] as const) {
      await openByTitle(
        page,
        "Bakery/Templates/AuthEntry",
        `direction:${direction}`,
      );
      for (const width of [700, 900, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const brand = await page.locator(".ui-auth-entry--brand").first()
          .evaluate((entry) => {
            const rect = entry.getBoundingClientRect();
            const pane = entry.querySelector(".ui-auth-entry__brand-pane");
            const formPane = entry.querySelector(".ui-auth-entry__form-pane")!;
            const content = formPane.querySelector(".ui-auth-entry__content")!;
            const form = content.lastElementChild!;
            const formRect = form.getBoundingClientRect();
            const contentRect = content.getBoundingClientRect();
            const paneVisible = pane !== null &&
              getComputedStyle(pane).display !== "none";
            return {
              display: getComputedStyle(entry).display,
              paneVisible,
              paneWidth: paneVisible ? pane!.getBoundingClientRect().width : 0,
              rectWidth: rect.width,
              formWidth: formRect.width,
              formCentred: Math.abs(
                (formRect.left + formRect.right) / 2 -
                  (contentRect.left + contentRect.right) / 2,
              ),
            };
          });
        const label = `${direction}/${width}`;
        if (width < 744) {
          // auth.css:13 — the brand pane hides and the layout collapses to
          // a single column below the phone breakpoint.
          expect(brand.display, label).toBe("block");
          expect(brand.paneVisible, label).toBe(false);
        } else {
          // auth.css:9 — the 44%/56% split holds unchanged through the
          // tablet band; only spacing tightens (auth.css:12).
          expect(brand.display, label).toBe("grid");
          expect(brand.paneVisible, label).toBe(true);
          expect(brand.paneWidth, label).toBeCloseTo(brand.rectWidth * 0.44, 0);
        }
        expect(brand.formWidth, label).toBeGreaterThanOrEqual(
          Math.min(width - 40, 380),
        );
        expect(brand.formCentred, label).toBeLessThan(1);

        const context = await page.locator(".ui-auth-entry--context").first()
          .evaluate((entry) => {
            const shell = entry.querySelector(".ui-auth-entry__context-shell")!;
            return { width: shell.getBoundingClientRect().width };
          });
        // auth.css:10/13 — the context card never exceeds 740px and shrinks
        // to the viewport below that, regardless of direction.
        expect(context.width, `${label}/context`).toBeLessThanOrEqual(
          Math.min(740, width) + 1,
        );
      }
    }
  });
});
