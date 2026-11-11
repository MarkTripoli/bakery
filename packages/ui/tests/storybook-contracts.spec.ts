import { expect, type Page, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  canonicalStories,
  catalog,
  openByTitle,
  openRuntimeFixture,
  runtimeAssertions,
  storyPath,
  tokenManifest,
} from "./storybook-harness.ts";

async function expectCodeBlockFocus(page: Page) {
  await expect(
    page.locator('[data-ui-component="codeBlock"][data-state="overflowing"]'),
  ).toHaveAttribute("tabindex", "0");
  for (const state of ["default", "copied", "long-content"]) {
    const fixtures = page.locator(
      `[data-ui-component="codeBlock"][data-state="${state}"]`,
    );
    expect(await fixtures.count()).toBeGreaterThan(0);
    for (const fixture of await fixtures.all()) {
      await expect(fixture).not.toHaveAttribute("tabindex", "0");
    }
  }
}

test.describe("Storybook assertion contracts", () => {
  test("number TextInput preserves native bounds and keyboard stepping", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/TextInput");
    const input = page.getByRole("spinbutton", {
      name: "Source line",
      exact: true,
    });
    await expect(input).toHaveAttribute("min", "1");
    await expect(input).toHaveAttribute("max", "100");
    await expect(input).toHaveAttribute("step", "1");
    await expect(input).toHaveValue("1");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("2");
    await input.fill("101");
    expect(
      await input.evaluate((node: HTMLInputElement) =>
        node.validity.rangeOverflow
      ),
    ).toBe(true);
    await input.fill("0");
    expect(
      await input.evaluate((node: HTMLInputElement) =>
        node.validity.rangeUnderflow
      ),
    ).toBe(true);
    await input.fill("100");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("100");
  });

  test("detects an accessibility defect outside the Button story", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Text");
    await page.locator(".storybook-story").evaluate((story) => {
      const image = document.createElement("img");
      image.src = "missing-accessibility-fixture.png";
      story.append(image);
    });
    const results = await new AxeBuilder({ page }).include("body").analyze();
    expect(results.violations.map((violation) => violation.id)).toContain(
      "image-alt",
    );
  });

  test("exposes named Icons and hides decorative Icons", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Icon");
    await expect(page.getByRole("img", { name: "Named small icon" }))
      .toBeVisible();
    await expect(page.getByRole("img", { name: "Named medium icon" }))
      .toBeVisible();
    const decorative = page.locator("svg[aria-hidden=true]");
    await expect(decorative).toHaveCount(1);
    await expect(decorative).not.toHaveAttribute("role", "img");
  });

  test("fails containment when a specimen overflows without an intentional annotation", async ({ page }) => {
    const fixture = await openRuntimeFixture(
      page,
      "bakery-atoms-text--contract",
      "desktop-light-fine",
      ["containment"],
    );
    await page.locator(".storybook-story").evaluate((story) => {
      story.innerHTML =
        '<div style="width: 10px"><span style="display: block; width: 100px">overflow fixture</span></div>';
    });
    await expect(runtimeAssertions(page, fixture.runtimeCase, fixture.context))
      .rejects.toMatchObject({ reason: "containment" });
  });

  test("rejects a truncation annotation without truncation CSS", async ({ page }) => {
    const fixture = await openRuntimeFixture(
      page,
      "bakery-atoms-text--contract",
      "desktop-light-fine",
      ["containment"],
    );
    await page.locator(".storybook-story").evaluate((story) => {
      story.innerHTML =
        '<div style="width: 10px"><span data-rail="truncation-allowed" style="display: block; width: 100px">overflow fixture</span></div>';
    });
    await expect(runtimeAssertions(page, fixture.runtimeCase, fixture.context))
      .rejects.toMatchObject({ reason: "containment" });
  });

  test("rejects semantic markers outside the owning component", async ({ page }) => {
    const fixture = await openRuntimeFixture(
      page,
      "bakery-atoms-button--contract",
      "desktop-light-fine",
      [],
    );
    const entry = catalog.entries.find((candidate) =>
      candidate.id === "ui.button"
    );
    if (!entry) throw new Error("missing Button catalog entry");
    await page.locator(".storybook-story").evaluate(
      (story, values) => {
        story.innerHTML = values.map((value) =>
          `<section data-state="${value}" data-variant="${value}">${value}</section>`
        ).join("");
      },
      [...(entry.states ?? []), ...(entry.variants ?? [])],
    );
    await expect(
      runtimeAssertions(page, fixture.runtimeCase, fixture.context, entry),
    ).rejects.toMatchObject({ reason: "semantic-coverage" });
  });

  test("rejects non-owner state classes and absent-state prose", async ({ page }) => {
    const fixture = await openRuntimeFixture(
      page,
      "bakery-molecules-tooltip--contract",
      "desktop-light-fine",
      [],
    );
    const entry = catalog.entries.find((candidate) =>
      candidate.id === "ui.tooltip"
    );
    if (!entry) throw new Error("missing Tooltip catalog entry");
    await page.locator(".storybook-story").evaluate((story, values) => {
      story.innerHTML = [
        ...values.map((value) =>
          `<section class="ui-tooltip--${value}" data-state="${value}" data-variant="${value}">${value}</section>`
        ),
        '<p data-semantic-absent-state="closed">Closed tooltip is absent.</p>',
      ].join("");
    }, [...(entry.states ?? []), ...(entry.variants ?? [])]);
    await expect(
      runtimeAssertions(page, fixture.runtimeCase, fixture.context, entry),
    ).rejects.toMatchObject({ reason: "semantic-coverage" });
  });

  test("prevents callers from overriding owner semantic metadata", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/Tooltip");
    const owner = page.getByTestId("tooltip-owner-override");
    await expect(owner).toHaveAttribute("data-state", "closed");
    await expect(owner).toHaveAttribute("data-variant", "description");
  });

  test("ignores unexercised behavioral owner states", async ({ page }) => {
    const fixture = await openRuntimeFixture(
      page,
      "bakery-molecules-tooltip--contract",
      "desktop-light-fine",
      [],
    );
    const entry = catalog.entries.find((candidate) =>
      candidate.id === "ui.tooltip"
    );
    if (!entry) throw new Error("missing Tooltip catalog entry");
    const unexercisedStates = [
      "copied",
      "focus",
      "long-content",
      "overflowing",
      "pressed",
      "sorting",
      "truncated",
      "visited",
      "wrapped",
    ];
    await page.locator(".storybook-story").evaluate((story, states) => {
      story.innerHTML = states.map((state) =>
        `<span data-ui-component="tooltip" data-state="${state}">${state}</span>`
      ).join("");
    }, unexercisedStates);
    await expect(
      runtimeAssertions(page, fixture.runtimeCase, fixture.context, {
        ...entry,
        states: unexercisedStates,
        variants: [],
      }),
    ).rejects.toMatchObject({ reason: "semantic-coverage" });
  });

  test("ignores hidden owners for non-absence states", async ({ page }) => {
    const fixture = await openRuntimeFixture(
      page,
      "bakery-molecules-dialog--contract",
      "desktop-light-fine",
      [],
    );
    const entry = catalog.entries.find((candidate) =>
      candidate.id === "ui.dialog"
    );
    if (!entry) throw new Error("missing Dialog catalog entry");
    await page.locator(".storybook-story").evaluate((story) => {
      story.innerHTML =
        '<dialog data-ui-component="dialog" data-state="error" hidden>error</dialog>';
    });
    await expect(
      runtimeAssertions(page, fixture.runtimeCase, fixture.context, {
        ...entry,
        states: ["error"],
        variants: [],
      }),
    ).rejects.toMatchObject({ reason: "semantic-coverage" });
  });

  test("strips reserved owner metadata from nested native controls", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Checkbox");
    const input = page.getByTestId("checkbox-reserved-props");
    await expect(input).not.toHaveAttribute("data-ui-component");
    await expect(input).not.toHaveAttribute("data-state");
    await expect(input).not.toHaveAttribute("data-variant");
    const owner = input.locator("xpath=ancestor::label[1]");
    await expect(owner).toHaveAttribute("data-ui-component", "checkbox");
    await expect(owner).toHaveAttribute("data-state", "default");
    await expect(owner).toHaveAttribute("data-variant", "unchecked");
  });

  test("strips reserved owner metadata from Popover content", async ({ page }) => {
    await openByTitle(page, "Bakery/Molecules/Popover");
    const content = page.getByTestId("popover-reserved-props");
    await expect(content).not.toHaveAttribute("data-ui-component");
    await expect(content).not.toHaveAttribute("data-state");
    await expect(content).not.toHaveAttribute("data-variant");
    const owner = content.locator(
      'xpath=ancestor::*[@data-ui-component="popover"][1]',
    );
    await expect(owner).toHaveAttribute("data-state", "open");
    await expect(owner).toHaveAttribute("data-variant", "interactive");
  });

  test("ignores caller-forged nested component owners", async ({ page }) => {
    const fixture = await openRuntimeFixture(
      page,
      "bakery-molecules-popover--contract",
      "desktop-light-fine",
      [],
    );
    const entry = catalog.entries.find((candidate) =>
      candidate.id === "ui.popover"
    );
    if (!entry) throw new Error("missing Popover catalog entry");
    await page.locator('[data-ui-component="popover"]').first().evaluate(
      (owner) => {
        const forged = document.createElement("div");
        forged.dataset.state = "forged";
        forged.dataset.uiComponent = "popover";
        forged.dataset.variant = "forged";
        owner.append(forged);
      },
    );
    await expect(
      runtimeAssertions(page, fixture.runtimeCase, fixture.context, {
        ...entry,
        states: ["forged"],
        variants: ["forged"],
      }),
    ).rejects.toMatchObject({ reason: "semantic-coverage" });
  });

  test("focuses only the scrollable CodeBlock fixture", async ({ page }) => {
    await openByTitle(page, "Bakery/Organisms/CodeBlock");
    await expectCodeBlockFocus(page);
  });

  for (const variant of ["plain", "command"]) {
    test(`CodeBlock focus assertion rejects focusable ${variant} default`, async ({ page }) => {
      await openByTitle(page, "Bakery/Organisms/CodeBlock");
      const fixture = page.locator(
        `[data-ui-component="codeBlock"][data-state="default"][data-variant="${variant}"]`,
      );
      await expect(fixture).toHaveCount(1);
      await fixture.evaluate((element) =>
        element.setAttribute("tabindex", "0")
      );
      await expect(expectCodeBlockFocus(page)).rejects.toThrow();
    });
  }

  test("fails focus evidence when a focused element has no visible focus indicator", async ({ page }) => {
    const fixture = await openRuntimeFixture(
      page,
      "bakery-atoms-button--contract",
      "desktop-light-fine",
      ["focus"],
    );
    await page.addStyleTag({
      content:
        "*:focus, *:focus-visible { outline: none !important; box-shadow: none !important; }",
    });
    await expect(runtimeAssertions(page, fixture.runtimeCase, fixture.context))
      .rejects.toMatchObject({ reason: "focus-indicator" });
  });

  test("fails Axe evidence on an unnamed control", async ({ page }) => {
    const fixture = await openRuntimeFixture(
      page,
      "bakery-atoms-text--contract",
      "desktop-light-fine",
      ["axe"],
    );
    await page.locator(".storybook-story").evaluate((story) => {
      story.append(document.createElement("button"));
    });
    await expect(runtimeAssertions(page, fixture.runtimeCase, fixture.context))
      .rejects.toMatchObject({ reason: "axe", message: /button-name/ });
  });

  test("fails target-size evidence on an undersized control", async ({ page }) => {
    const fixture = await openRuntimeFixture(
      page,
      "bakery-atoms-text--contract",
      "desktop-light-fine",
      ["target-size"],
    );
    await page.locator(".storybook-story").evaluate((story) => {
      story.innerHTML = '<button style="width: 10px; height: 10px">x</button>';
    });
    await expect(runtimeAssertions(page, fixture.runtimeCase, fixture.context))
      .rejects.toMatchObject({ reason: "target-size" });
  });

  test("fails theme evidence when the observed theme is not the declared theme", async ({ page }) => {
    const fixture = await openRuntimeFixture(
      page,
      "bakery-atoms-text--contract",
      "desktop-light-fine",
      [],
    );
    await page.locator(".storybook-story").evaluate((story) => {
      story.closest("[data-theme]")?.setAttribute("data-theme", "dark");
    });
    await expect(runtimeAssertions(page, fixture.runtimeCase, fixture.context))
      .rejects.toMatchObject({ reason: "theme-mismatch" });
  });

  test("fails direction evidence when the declared direction is RTL but the story is LTR", async ({ page }) => {
    const fixture = await openRuntimeFixture(
      page,
      "bakery-atoms-text--contract",
      "rtl",
      [],
    );
    await page.locator(".storybook-story").evaluate((story) => {
      story.setAttribute("dir", "ltr");
    });
    await expect(runtimeAssertions(page, fixture.runtimeCase, fixture.context))
      .rejects.toMatchObject({ reason: "direction-mismatch" });
  });

  test("restores light tokens inside a dark theme", async ({ page }) => {
    const stories = await canonicalStories(page);
    const story = stories.find((entry) =>
      entry.title === "Bakery/Atoms/ThemeProvider"
    );
    if (!story) throw new Error("missing ThemeProvider Storybook story");
    await page.goto(
      `${storyPath(story.id)}&globals=${
        encodeURIComponent("theme:dark;direction:ltr;locale:en-US")
      }`,
    );
    const canvasRole = tokenManifest.roles.find((role) =>
      role.cssVariable === "--color-canvas"
    );
    if (!canvasRole) throw new Error("missing --color-canvas token role");
    const expected = canvasRole.values;
    const cardLocator = page.locator(".theme-provider-card");
    await expect(cardLocator).toHaveCount(3);
    const cards = await cardLocator.evaluateAll(
      (elements) =>
        elements.map((element) => ({
          theme: element.closest("[data-theme]")?.getAttribute("data-theme"),
          canvas: getComputedStyle(element).getPropertyValue("--color-canvas")
            .trim(),
        })),
    );
    if (!expected.light || !expected.dark) {
      throw new Error("canvas token role is missing a light or dark value");
    }
    expect(cards.find((card) => card.theme === "light")?.canvas.toLowerCase())
      .toBe(expected.light.toLowerCase());
    expect(cards.find((card) => card.theme === "dark")?.canvas.toLowerCase())
      .toBe(expected.dark.toLowerCase());
  });
});
