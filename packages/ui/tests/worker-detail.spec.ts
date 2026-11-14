import {
  coarseTargetCheck,
  detailInertnessIssues,
} from "./storybook-harness.ts";
import { expect, type Locator, test } from "@playwright/test";
import { createTranslator } from "@bakery/i18n";
import { workerDetailStates } from "../src/fixtures/worker-readiness.ts";
import {
  analyzeAxe,
  openRuntimeFixture,
  renderedContainmentIssues,
  runtime,
} from "./storybook-harness.ts";

async function expectCompactArtworkHeight(preview: Locator, zoom: number) {
  const lines = await preview.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    // Bidi runs can produce several rectangles on the same physical line.
    // Exact vertical bands retain every distinct wrapped line without tolerance.
    return new Set(
      Array.from(
        range.getClientRects(),
        (rect) => `${rect.top}:${rect.bottom}`,
      ),
    ).size;
  });
  expect(lines).toBeGreaterThan(0);
  expect((await preview.boundingBox())?.height).toBe((18 + 20 * lines) * zoom);
  return lines;
}

const cases = runtime.cases.filter((item) => item.id.startsWith("wr.detail."));
expect(cases).toHaveLength(40);
expect(cases.filter((item) => !item.context.startsWith("paper-detail-")))
  .toHaveLength(38);
for (const state of workerDetailStates) {
  const en = createTranslator({ locale: "en" });
  const pseudo = createTranslator({ locale: "en-XA" });
  expect(pseudo(`workerDetail.state.${state}`).length).toBeGreaterThanOrEqual(
    Math.ceil(en(`workerDetail.state.${state}`).length * 1.35),
  );
}
for (const item of cases) {
  test(item.id, async ({ page }, testInfo) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (/\/api\//.test(request.url()) || request.method() !== "GET") {
        requests.push(request.url());
      }
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: () => {
            throw new Error("Forbidden clipboard write");
          },
          readText: () => {
            throw new Error("Forbidden clipboard read");
          },
        },
      });
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { context } = await openRuntimeFixture(
      page,
      item.storyId,
      item.context,
      item.assertions ?? [],
      item.args,
    );
    const root = page.locator('[data-ui-component="workerReadOnlyDetail"]');
    const notice = root.locator(".ui-worker-detail__boundary");
    const state = item.args?.state;
    await expect(root).toHaveAttribute("data-source", "synthetic-fixture");
    await expect(root).toHaveAttribute("data-state", state ?? "");
    await expect(notice).toBeVisible();
    await expect(root).toHaveAttribute(
      "aria-describedby",
      await notice.locator("[id]").getAttribute("id") ?? "",
    );
    await expect(root).toHaveAccessibleDescription(
      /synthetic.*unproved.*unavailable.*Codex login/is,
    );
    await expect(root.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(
      root.locator(
        "a, button, input, select, textarea, [role=button], [role=tab], [role=link], [tabindex], [onclick], [onkeydown]",
      ),
    ).toHaveCount(0);
    if (item.context.startsWith("paper-detail-")) {
      await expect(root.locator(".ui-worker-detail__tabs [data-selected]"))
        .toHaveCSS("font-weight", "600");
      await expect(root.locator(".ui-worker-detail__tabs > span").nth(1))
        .toHaveCSS("font-weight", "400");
      for (
        const badge of await root.locator(".ui-worker-detail__badge").all()
      ) {
        await expect(badge).toHaveCSS("font-weight", "500");
        await expect(badge).toHaveCSS("font-size", "12px");
        await expect(badge).toHaveCSS("line-height", "20px");
      }
      const machineIcon = root.locator(".ui-worker-detail__machine .ui-icon");
      await expect(machineIcon).toHaveAttribute("data-variant", "large");
      await expect(machineIcon).toHaveCSS("width", "20px");
      await expect(machineIcon).toHaveCSS("color", "rgb(0, 0, 0)");
      await expect(root.locator(".ui-worker-detail__link").first())
        .toHaveText("Release notes →");
      if (item.context.endsWith("phone")) {
        await expect(
          root.locator(".ui-worker-detail__mobile-header .ui-text"),
        )
          .toHaveText("Alex’s workspace⌄");
        for (
          const icon of await root.locator(
            ".ui-worker-detail__phone-status .ui-icon, .ui-worker-detail__mobile-header .ui-icon",
          ).all()
        ) {
          await expect(icon).toHaveCSS("color", "rgb(0, 0, 0)");
        }
        const qualificationBox = await notice.boundingBox();
        const artboardBox = await root.locator("[data-paper-whole-artboard]")
          .boundingBox();
        expect(qualificationBox).not.toBeNull();
        expect(artboardBox).not.toBeNull();
        expect(qualificationBox!.height).toBeGreaterThan(0);
        expect(qualificationBox!.y + qualificationBox!.height)
          .toBeLessThanOrEqual(artboardBox!.y);
      }
    }
    const illustrated = state === "ready" || state === "worstcase";
    await expect(root.locator(".ui-worker-detail__harness")).toHaveCount(
      illustrated ? 3 : 0,
    );
    if (!illustrated) {
      await expect(root.locator(".ui-worker-detail__state")).toBeVisible();
      await expect(root).not.toContainText(
        /Machine online|0\.153\.4|2\.1\.263|0\.85\.1/,
      );
      await expect(root.locator(".ui-worker-detail__inspector"))
        .toContainText(
          /Verified enrollment, valid credentials and Codex login are unavailable/,
        );
    }
    expect(await root.evaluate(detailInertnessIssues)).toEqual([]);
    if (context.pointer === "coarse") {
      expect(
        (await page.locator(".storybook-story").evaluate(coarseTargetCheck))
          .undersized,
      ).toEqual([]);
    }
    const previews = root.locator('[data-ui-component="button"]');
    for (const preview of await previews.all()) {
      expect(
        await preview.evaluate((el) => ({
          tag: el.tagName,
          handler: (el as HTMLElement).onclick,
          role: el.getAttribute("role"),
          tabIndex: el.getAttribute("tabindex"),
        })),
      ).toEqual({ tag: "SPAN", handler: null, role: null, tabIndex: null });
      const compact =
        await preview.getAttribute("data-density") === "static-compact";
      if (compact) {
        for (
          const [property, value] of Object.entries({
            "min-height": "36px",
            "line-height": "20px",
            "padding-top": "8px",
            "padding-bottom": "8px",
            "padding-left": "14px",
            "padding-right": "14px",
            "border-top-width": "1px",
            "border-bottom-width": "1px",
            "box-sizing": "border-box",
          })
        ) {
          await expect(preview).toHaveCSS(property, value);
        }
        const lines = await expectCompactArtworkHeight(preview, context.zoom);
        if (
          state === "ready" && context.locale === "en-US" && context.zoom === 1
        ) {
          expect(lines).toBe(1);
        }
      } else if (context.pointer === "coarse") {
        expect((await preview.boundingBox())?.height).toBeGreaterThanOrEqual(
          44 * context.zoom,
        );
      }
      await preview.click();
      await expect(preview).not.toBeFocused();
    }
    await page.keyboard.press("Tab");
    expect(await root.evaluate((el) => el.contains(document.activeElement)))
      .toBe(false);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    const observed = await page.locator(".storybook-story").evaluate((
      el,
    ) => ({
      direction: el.getAttribute("dir"),
      pointer: el.getAttribute("data-pointer"),
      zoom: Number((el as HTMLElement).style.zoom || 1),
      theme: el.closest("[data-theme]")?.getAttribute("data-theme"),
      motion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    }));
    expect(observed).toEqual({
      direction: context.direction,
      pointer: context.pointer,
      zoom: context.zoom,
      theme: context.theme,
      motion: context.reducedMotion === "reduce",
    });
    expect(await page.evaluate(renderedContainmentIssues)).toEqual([]);
    expect((await analyzeAxe(page)).violations).toEqual([]);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
    await testInfo.attach("full-ui", {
      body: await page.screenshot({ fullPage: true, animations: "disabled" }),
      contentType: "image/png",
    });
  });
}

for (const forcedHeight of [36, 58]) {
  test(`compact artwork physical lines reject forced ${forcedHeight}px height`, async ({ page }) => {
    const item = cases.find((candidate) =>
      candidate.id === "wr.detail.worstcase.rtl"
    );
    if (!item) throw new Error("Required worstcase RTL fixture missing");
    const { context } = await openRuntimeFixture(
      page,
      item.storyId,
      item.context,
      item.assertions ?? [],
      item.args,
    );
    const preview = page.locator(
      '[data-ui-component="workerReadOnlyDetail"] [data-density="static-compact"]',
    );
    await expect(preview).toHaveCount(1);
    expect(await expectCompactArtworkHeight(preview, context.zoom)).toBe(1);
    await preview.evaluate((element, height) => {
      (element as HTMLElement).style.height = `${height}px`;
    }, forcedHeight);
    await expect(expectCompactArtworkHeight(preview, context.zoom)).rejects
      .toThrow();
  });
}
