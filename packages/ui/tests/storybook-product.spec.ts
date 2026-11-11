import { expect, test } from "@playwright/test";
import {
  baseURL,
  openByTitle,
  runtime,
  runtimeStoryPath,
  waitForSpecimen,
} from "./storybook-harness.ts";

test.describe("Storybook product interactions", () => {
  test("runs a filtered Command story", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/Command");
    const input = page.getByRole("searchbox", {
      name: "Search commands",
      exact: true,
    });
    await input.fill("Create task");
    await page.getByRole("button", { name: "Create task" }).first().click();
    await expect(page.getByRole("status")).toContainText("new");
  });

  test("dismisses Popover and Tooltip stories with Escape", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/Popover");
    await page.getByRole("button", { name: "Show task information" }).click();
    await expect(
      page.getByRole("dialog", { name: "Task information", exact: true }),
    )
      .toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Task information", exact: true }),
    )
      .not.toBeVisible();

    await openByTitle(page, "Bakery/Molecules/Tooltip");
    const trigger = page.getByRole("button", { name: "Hover for help" });
    const tooltip = page.getByRole("tooltip", { name: "Create a new task" });
    const owner = page.locator(".ui-tooltip").first();
    await trigger.focus();
    await expect(trigger).toBeFocused();
    const tooltipId = await tooltip.getAttribute("id");
    expect(tooltipId).not.toBeNull();
    await expect(trigger).toHaveAttribute("aria-describedby", tooltipId!);
    await expect(tooltip).toBeVisible();
    await trigger.hover();
    await page.mouse.move(0, 0);
    await expect(owner).toHaveAttribute("data-state", "focus");
    await expect(tooltip).toBeVisible();
    await trigger.press("Escape");
    await expect(owner).toHaveAttribute("data-dismissed", "true");
    await expect(tooltip).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test("keeps input owner metadata synchronized with native state", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Checkbox");
    const checkbox = page.getByRole("checkbox", {
      name: "Notify me when the task finishes",
    });
    const checkboxOwner = checkbox.locator("xpath=ancestor::label[1]");
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await expect(checkboxOwner).toHaveAttribute("data-variant", "checked");
    await expect(checkboxOwner).toHaveAttribute("data-state", "focus");
    await page.keyboard.press("Tab");
    await expect(checkboxOwner).toHaveAttribute("data-state", "default");
    await page.getByRole("button", { name: "Reset checkbox settings" }).click();
    await expect(checkbox).not.toBeChecked();
    await expect(checkboxOwner).toHaveAttribute("data-variant", "unchecked");
    const mixed = page.getByRole("checkbox", {
      name: "Notify me about partial progress",
    });
    const mixedOwner = mixed.locator("xpath=ancestor::label[1]");
    await mixed.click();
    await expect.poll(() =>
      mixed.evaluate((element) => (element as HTMLInputElement).indeterminate)
    ).toBe(true);
    await expect(mixed).toHaveAttribute("aria-checked", "mixed");
    await expect(mixedOwner).toHaveAttribute("data-variant", "mixed");

    await openByTitle(page, "Bakery/Atoms/Switch");
    const switchControl = page.getByRole("switch", {
      name: "Notifications on",
    });
    const switchOwner = switchControl.locator("xpath=ancestor::label[1]");
    await switchControl.click();
    await expect(switchControl).not.toBeChecked();
    await expect(switchOwner).toHaveAttribute("data-variant", "off");
    await page.getByRole("button", { name: "Reset switch settings" }).click();
    await expect(switchControl).toBeChecked();
    await expect(switchOwner).toHaveAttribute("data-variant", "on");

    await openByTitle(page, "Bakery/Atoms/Radio");
    const team = page.getByRole("radio", { name: "Team visibility" });
    const privateOption = page.getByRole("radio", {
      name: "Private visibility",
    });
    await privateOption.click();
    await expect(privateOption).toBeChecked();
    await expect(team).not.toBeChecked();
    await expect(privateOption.locator("xpath=ancestor::label[1]"))
      .toHaveAttribute("data-variant", "checked");
    await expect(team.locator("xpath=ancestor::label[1]"))
      .toHaveAttribute("data-variant", "unchecked");
    await page.getByRole("button", { name: "Reset radio settings" }).click();
    await expect(team).toBeChecked();
    await expect(privateOption).not.toBeChecked();
    await expect(team.locator("xpath=ancestor::label[1]"))
      .toHaveAttribute("data-variant", "checked");
    await expect(privateOption.locator("xpath=ancestor::label[1]"))
      .toHaveAttribute("data-variant", "unchecked");
  });

  test("tracks focus even when caller handlers prevent default", async ({ page }) => {
    const cases = [
      {
        title: "Bakery/Atoms/Checkbox",
        testId: "checkbox-prevent-default-focus",
        blurredState: "default",
      },
      {
        title: "Bakery/Atoms/Radio",
        testId: "radio-prevent-default-focus",
        blurredState: "default",
      },
      {
        title: "Bakery/Atoms/Switch",
        testId: "switch-prevent-default-focus",
        blurredState: "default",
      },
      {
        title: "Bakery/Molecules/Tooltip",
        testId: "tooltip-prevent-default-focus",
        blurredState: "closed",
      },
    ];
    for (const fixture of cases) {
      await openByTitle(page, fixture.title);
      const control = page.getByTestId(fixture.testId);
      const owner = control.locator(
        "xpath=ancestor::*[@data-ui-component][1]",
      );
      await control.focus();
      await expect(control).toBeFocused();
      await expect(owner).toHaveAttribute("data-state", "focus");
      await control.evaluate((element) => element.blur());
      await expect(control).not.toBeFocused();
      await expect(owner).toHaveAttribute(
        "data-state",
        fixture.blurredState,
      );
    }
  });

  test("exposes visited Link state after real hash navigation", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Link");
    const link = page.getByRole("link", { name: "Visited link" });
    const beforeColor = await link.evaluate((element) =>
      getComputedStyle(element).color
    );
    await expect(link).toHaveAttribute("data-state", "default");
    await link.click();
    await expect(page).toHaveURL(/#visited$/);
    await expect(link).toHaveAttribute("data-state", "visited");
    await expect.poll(() =>
      link.evaluate((element) => getComputedStyle(element).color)
    ).not.toBe(beforeColor);
  });

  test("keeps the story viewport contained on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await openByTitle(page, "Bakery/Templates/AppShell");
    await expect.poll(() =>
      page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      )
    ).toBe(true);
  });

  test("executes every named runtime context", async ({ browser }) => {
    test.setTimeout(240_000);
    for (const [contextId, context] of Object.entries(runtime.contexts)) {
      const runtimeCase = runtime.cases.find((entry) =>
        entry.context === contextId
      );
      if (!runtimeCase) {
        throw new Error(`missing runtime case for ${contextId}`);
      }
      const browserContext = await browser.newContext({
        baseURL,
        viewport: context.viewport,
        deviceScaleFactor: context.dpr,
        colorScheme: context.theme,
        reducedMotion: context.reducedMotion,
        hasTouch: context.pointer === "coarse",
        locale: context.locale,
        timezoneId: context.timezone,
      });
      await browserContext.addInitScript(({ key, value }) => {
        localStorage.setItem(key, value);
      }, { key: "bakery.theme.v1", value: context.storedPreference });
      const page = await browserContext.newPage();
      try {
        await page.goto(runtimeStoryPath(runtimeCase.storyId, context), {
          waitUntil: "networkidle",
        });
        await waitForSpecimen(page);
        const observed = await page.evaluate(() => {
          const story = document.querySelector<HTMLElement>(
            ".storybook-story",
          );
          if (!story) throw new Error("missing Storybook specimen");
          return {
            direction: story?.getAttribute("dir"),
            pointer: story?.getAttribute("data-pointer"),
            locale: story?.closest("[data-theme]")?.getAttribute("lang"),
            reducedMotion: story?.getAttribute("data-reduced-motion"),
            viewportMode: story?.getAttribute("data-viewport-mode"),
            width: innerWidth,
            height: innerHeight,
            pointerMedia: matchMedia(
              `(pointer: ${story?.getAttribute("data-pointer")})`,
            ).matches,
            reducedMotionMedia: matchMedia("(prefers-reduced-motion: reduce)")
              .matches,
            targetMinimum: Number.parseFloat(
              getComputedStyle(story).getPropertyValue("--target-min"),
            ),
            pseudoCopy: document.querySelector(
              '[data-pseudo-locale="true"] [data-testid="text-specimen-copy"]',
            )?.textContent ?? null,
            zoom: Number(story?.style.zoom || 1),
            contained: document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          };
        });
        expect(observed.direction).toBe(context.direction);
        expect(observed.pointer).toBe(context.pointer);
        expect(observed.locale).toBe(context.locale);
        expect(observed.reducedMotion).toBe(
          context.reducedMotion === "reduce" ? "true" : "false",
        );
        expect(observed.width).toBe(context.viewport.width);
        expect(observed.height).toBe(context.viewport.height);
        expect(observed.pointerMedia).toBe(true);
        expect(observed.reducedMotionMedia).toBe(
          context.reducedMotion === "reduce",
        );
        expect(observed.targetMinimum).toBe(
          context.pointer === "coarse" ? 44 : 28,
        );
        expect(observed.zoom).toBe(context.zoom);
        if (context.locale === "en-XA") {
          expect(observed.pseudoCopy?.length).toBeGreaterThan(100);
        } else expect(observed.pseudoCopy).toBeNull();
        if (context.zoom === 2) expect(observed.contained).toBe(true);
      } finally {
        await browserContext.close();
      }
    }
  });
});
