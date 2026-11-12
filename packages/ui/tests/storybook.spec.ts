import { expect, test } from "@playwright/test";
import {
  analyzeAxe,
  baseURL,
  canonicalStories,
  catalog,
  openStory,
  renderedContainmentIssues,
  runtime,
  runtimeAssertions,
  servedBuildIdentityIssues,
  storyPath,
  storyUrl,
  sweepTimeoutMs,
  waitForSpecimen,
} from "./storybook-harness.ts";

test.describe("canonical Storybook catalog", () => {
  test("rejects a served build that differs from its recorded identity", () => {
    expect(
      servedBuildIdentityIssues(
        { "index.json": "local", "iframe.html": "local" },
        { "index.json": "served" },
      ),
    ).toEqual([
      "Served Storybook differs from build at index.json",
      "Served Storybook is missing iframe.html",
    ]);
  });

  test("binds exactly the catalog entries", async ({ page }) => {
    const stories = await canonicalStories(page);
    expect(new Set(stories.map((story) => story.title)).size).toBe(
      catalog.entries.length,
    );
    expect(stories.map((story) => story.title).sort()).toEqual(
      catalog.entries.map((entry) => entry.storyTitle).sort(),
    );
  });

  test("renders every approved semantic variant and state", async ({ page }) => {
    test.setTimeout(sweepTimeoutMs());
    for (const entry of catalog.entries) {
      const runtimeCase = runtime.cases.find((candidate) =>
        candidate.catalogId === entry.id
      );
      if (!runtimeCase) throw new Error(`missing runtime case for ${entry.id}`);
      const context = runtime.contexts[runtimeCase.context];
      await page.setViewportSize(context.viewport);
      await page.goto(storyUrl(baseURL, runtimeCase, context), {
        waitUntil: "networkidle",
      });
      await page.evaluate(async () => await document.fonts.ready);
      await waitForSpecimen(page);
      await expect(
        runtimeAssertions(page, runtimeCase, context, entry),
        entry.storyTitle,
      ).resolves.toBeUndefined();
      if (entry.id === "template.runOutputView") {
        await expect(page.getByRole("main")).toHaveCount(1);
        await expect(page.getByRole("banner")).toHaveCount(1);
        await expect(
          page.getByRole("complementary", { name: "Primary navigation" }),
        ).toBeVisible();
        await expect(
          page.getByRole("region", { name: "Current run", exact: true }),
        ).toBeVisible();
      }
    }
  });

  test("has no axe violations in any canonical story", async ({ page }) => {
    // Every canonical story is navigated and analysed by axe: about 2 s each
    // on a fast host, several times that on a slow runner under load.
    test.setTimeout(sweepTimeoutMs());
    for (const story of await canonicalStories(page)) {
      await openStory(page, story.id, storyPath(story.id));
      const results = await analyzeAxe(page);
      expect(results.violations, story.title).toEqual([]);
    }
  });

  test("has no axe violations in the dark theme for every canonical story", async ({ page }) => {
    test.setTimeout(sweepTimeoutMs());
    for (const story of await canonicalStories(page)) {
      const specimen = await openStory(
        page,
        story.id,
        `${storyPath(story.id)}&globals=${encodeURIComponent("theme:dark")}`,
      );
      await expect(specimen.locator("xpath=.."))
        .toHaveAttribute("data-theme", "dark");
      const results = await analyzeAxe(page);
      expect(results.violations, story.title).toEqual([]);
    }
  });

  test("keeps every canonical story contained at sheet and pane widths", async ({ page }) => {
    const scenarios = [
      { width: 320, height: 844, viewportMode: "zoom-200" },
      { width: 744, height: 900, viewportMode: "pane" },
    ];
    // Each scenario visits every canonical story.
    test.setTimeout(sweepTimeoutMs(scenarios.length));
    for (const scenario of scenarios) {
      await page.setViewportSize({
        width: scenario.width,
        height: scenario.height,
      });
      for (const story of await canonicalStories(page)) {
        const specimen = await openStory(
          page,
          story.id,
          `${storyPath(story.id)}&globals=${
            encodeURIComponent(`viewportMode:${scenario.viewportMode}`)
          }`,
        );
        await expect(specimen).toHaveAttribute(
          "data-viewport-mode",
          scenario.viewportMode,
        );
        const overlayTrigger = specimen.locator(
          "[data-semantic-state-trigger]",
        ).first();
        const hasOverlayTrigger = await overlayTrigger.count() > 0;
        if (hasOverlayTrigger) {
          const outputPanel = overlayTrigger.locator(
            'xpath=ancestor::*[@data-ui-component="runOutputPanel"]',
          );
          const isCaptureLimitTrigger = await outputPanel.count() > 0;
          if (isCaptureLimitTrigger) {
            await expect(outputPanel).toHaveAttribute("data-state", "live");
          }
          await overlayTrigger.click();
          if (isCaptureLimitTrigger) {
            await expect(outputPanel).toHaveAttribute(
              "data-state",
              "truncated",
            );
            await expect(
              outputPanel.getByRole("status").filter({
                hasText: "Output truncated at the capture limit.",
              }).last(),
            ).toBeVisible();
          } else {
            await expect(specimen.locator("dialog:open")).toBeVisible();
          }
        }
        const tooltipTrigger = specimen.locator(
          '[data-ui-component="tooltip"] [data-semantic-interaction]',
        ).first();
        const hasTooltip = await tooltipTrigger.count() > 0;
        if (hasTooltip) {
          const interaction = await tooltipTrigger.getAttribute(
            "data-semantic-interaction",
          );
          if (interaction === "focus") await tooltipTrigger.focus();
          else await tooltipTrigger.hover();
          await expect(specimen.getByRole("tooltip").first()).toBeVisible();
        }
        const popoverSurface = specimen.locator(
          '[data-ui-component="popover"] [role="dialog"]',
        ).first();
        const hasPopover = await popoverSurface.count() > 0;
        if (hasPopover) await expect(popoverSurface).toBeVisible();
        if (story.title === "Bakery/Organisms/SendToAgentDialog") {
          const dialog = specimen.getByRole("dialog", {
            name: "Send to agent",
          });
          await expect(dialog).toHaveAttribute("aria-modal", "true");
          const bounds = await dialog.evaluate((element) => {
            const rectangle = element.getBoundingClientRect();
            return {
              left: rectangle.left,
              right: rectangle.right,
              viewport: innerWidth,
            };
          });
          expect(bounds.left).toBeGreaterThanOrEqual(0);
          expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
        }
        if (story.title === "Bakery/Templates/ArtifactLayout") {
          const children = specimen.locator(".ui-artifact-layout__header > *");
          expect(await children.count()).toBeGreaterThan(0);
          const escaped = await children.evaluateAll((elements) =>
            elements.flatMap((element) => {
              const parent = element.parentElement?.getBoundingClientRect();
              const child = element.getBoundingClientRect();
              return parent && child.left >= parent.left &&
                  child.right <= parent.right
                ? []
                : [element.className];
            })
          );
          expect(escaped).toEqual([]);
          await expect(
            specimen.getByRole("heading", { name: "Implementation notes" }),
          ).toBeVisible();
          await expect(
            specimen.getByRole("button", { name: "Download", exact: true }),
          ).toBeVisible();
          await expect(
            specimen.getByRole("button", { name: "Pin artifact", exact: true }),
          ).toBeVisible();
          await expect(specimen.getByRole("combobox", { name: "Version" }))
            .toBeVisible();
        }
        if (scenario.viewportMode === "zoom-200") {
          const zoomGeometry = await specimen.evaluate((element) => ({
            cssWidth: element.clientWidth,
            renderedWidth: element.getBoundingClientRect().width,
            viewportWidth: innerWidth,
          }));
          expect(zoomGeometry, story.title).toEqual({
            cssWidth: 160,
            renderedWidth: 320,
            viewportWidth: 320,
          });
        }
        await expect.poll(
          () => page.evaluate(renderedContainmentIssues),
          { message: `${story.title} at ${scenario.viewportMode}` },
        ).toEqual([]);
        if (hasOverlayTrigger) await page.keyboard.press("Escape");
      }
    }
  });
});
