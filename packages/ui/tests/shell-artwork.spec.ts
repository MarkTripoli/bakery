import { expect, test } from "@playwright/test";
import { openRuntimeFixture } from "./storybook-harness.ts";

test("registered shell glyphs retain source paths and non-square viewports", async ({ page }) => {
  await openRuntimeFixture(
    page,
    "bakery-atoms-iconglyph--contract",
    "desktop-light-fine",
    [],
  );
  const glyph = (name: string) =>
    page.locator(`[data-ui-component="iconGlyph"][data-variant="${name}"]`);
  await expect(glyph("monitor").locator("rect")).toHaveAttribute("rx", "2");
  await expect(glyph("integration").locator("circle")).toHaveCount(2);
  await expect(glyph("settings-sun").locator("circle")).toHaveAttribute(
    "r",
    "4",
  );
  await expect(glyph("search").locator("circle")).toHaveAttribute("r", "7");
  for (
    const [name, cx, radius, stroke, path] of [
      ["search", "11", "7", "1.8", "m20 20-3.5-3.5"],
      ["list-search", "10.5", "6.5", "1.5", "m16 16 4 4"],
    ]
  ) {
    const circle = glyph(name).locator("circle");
    await expect(circle).toHaveAttribute("cx", cx);
    await expect(circle).toHaveAttribute("cy", cx);
    await expect(circle).toHaveAttribute("r", radius);
    await expect(circle).toHaveAttribute("fill", "none");
    await expect(circle).toHaveAttribute("stroke", "currentColor");
    await expect(circle).toHaveAttribute("stroke-width", stroke);
    const handle = glyph(name).locator("path");
    await expect(handle).toHaveAttribute("d", path);
    await expect(handle).toHaveAttribute("stroke-width", stroke);
    await expect(handle).toHaveAttribute("stroke", "currentColor");
    await expect(handle).toHaveAttribute("fill", "none");
    expect(await handle.getAttribute("stroke-linecap")).toBe(
      name === "list-search" ? "round" : null,
    );
    await expect(glyph(name).locator("..")).toHaveAttribute(
      "viewBox",
      "0 0 24 24",
    );
  }

  await expect(glyph("terminal").locator("path")).toHaveAttribute(
    "d",
    "m5 6 6 6-6 6M14 18h6",
  );
  for (
    const [name, width, height] of [["phone-status", 82, 22], [
      "listening",
      15,
      20,
    ]] as const
  ) {
    const svg = glyph(name).locator("..");
    await expect(svg).toHaveAttribute("viewBox", `0 0 ${width} ${height}`);
    await expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(
      await svg.evaluate(
        (el) => [
          el.getBoundingClientRect().width,
          el.getBoundingClientRect().height,
        ],
      ),
    ).toEqual([width, height]);
  }
  await expect(glyph("listening").locator("rect")).toHaveCount(3);
});

test("plain heading and rail identity are shared opt-in variants", async ({ page }) => {
  await openRuntimeFixture(
    page,
    "bakery-atoms-heading--contract",
    "desktop-light-fine",
    [],
  );
  await expect(page.locator('[data-variant="page-plain"]')).toHaveCSS(
    "letter-spacing",
    "normal",
  );
  await expect(page.locator('[data-variant="section-plain"]')).toHaveCSS(
    "letter-spacing",
    "normal",
  );
  await expect(page.locator('[data-variant="page"]')).toHaveCSS(
    "letter-spacing",
    "-0.48px",
  );
  await openRuntimeFixture(
    page,
    "bakery-atoms-logomark--contract",
    "desktop-light-fine",
    [],
  );
  await expect(page.locator('[data-variant="rail"] img:visible')).toHaveCSS(
    "width",
    "28px",
  );
  await expect(page.locator('[data-variant="compact"] img:visible')).toHaveCSS(
    "width",
    "24px",
  );
  expect(
    await page.locator('[data-variant="rail"] img:visible').getAttribute("src"),
  )
    .toBe(
      await page.locator('[data-variant="compact"] img:visible').getAttribute(
        "src",
      ),
    );
});

for (const theme of ["light", "dark"] as const) {
  test(`LogoMark ${theme} art and inverse contrast follow the surface matrix`, async ({ page }) => {
    await openRuntimeFixture(
      page,
      "bakery-atoms-logomark--contract",
      `desktop-${theme}-fine`,
      [],
    );
    for (const variant of ["compact", "rail", "wordmark"] as const) {
      const wrapper = page.locator(
        `[data-ui-component="logoMark"][data-variant="${variant}"][data-state="default"]`,
      );
      const visible = wrapper.locator("img:visible");
      await expect(visible).toHaveAttribute(
        "data-logo-variant",
        `color-${theme}`,
      );
      await expect(visible).toHaveAttribute(
        "data-logo-art",
        variant === "wordmark" ? "lockup" : "mark",
      );
      await expect(
        wrapper.locator(
          `.ui-logo-mark__art--${theme === "light" ? "dark" : "light"}`,
        ),
      )
        .toBeHidden();
      await expect.poll(() =>
        visible.evaluate((img: HTMLImageElement) => img.naturalWidth)
      )
        .toBeGreaterThan(0);
    }
    const inverse = page.locator(
      '[data-ui-component="logoMark"][data-state="inverse"]',
    );
    await expect(inverse.locator("img:visible")).toHaveAttribute(
      "data-logo-variant",
      theme === "light" ? "color-dark" : "color-light",
    );
    await expect(inverse.locator("img:visible")).toHaveAttribute(
      "data-logo-art",
      "lockup",
    );
    await expect(
      inverse.locator(
        `.ui-logo-mark__art--${theme === "light" ? "dark" : "light"}`,
      ),
    )
      .toBeHidden();
    const wordmark = page.locator(
      '[data-ui-component="logoMark"][data-variant="wordmark"][data-state="default"] img:visible',
    );
    const previousSource = await wordmark.getAttribute("src");
    if (theme === "light") {
      // A document-only theme change must work even with a light provider.
      await page.evaluate(() =>
        document.documentElement.setAttribute("data-theme", "dark")
      );
      await expect(wordmark).toHaveAttribute("data-logo-variant", "color-dark");
      await expect(inverse.locator("img:visible")).toHaveAttribute(
        "data-logo-variant",
        "color-light",
      );
      await page.evaluate(() =>
        document.documentElement.setAttribute("data-theme", "light")
      );
      await expect(wordmark).toHaveAttribute(
        "data-logo-variant",
        "color-light",
      );
    }
    await wordmark.evaluate((image, nextTheme) => {
      image.closest("[data-theme]")!.setAttribute("data-theme", nextTheme);
      document.documentElement.setAttribute("data-theme", nextTheme);
    }, theme === "light" ? "dark" : "light");
    await expect(wordmark).toHaveAttribute(
      "data-logo-variant",
      theme === "light" ? "color-dark" : "color-light",
    );
    await expect(inverse.locator("img:visible")).toHaveAttribute(
      "data-logo-variant",
      `color-${theme}`,
    );
    expect(await wordmark.getAttribute("src")).not.toBe(previousSource);
    const box = await wordmark.boundingBox();
    expect(box?.width).toBe(120);
    expect(box?.height).toBe(32);
  });
}

test("dark AuthEntry wordmark has transparent art without a plate", async ({ page }) => {
  await openRuntimeFixture(
    page,
    "bakery-templates-authentry--contract",
    "desktop-dark-fine",
    [],
  );
  const image = page.locator(
    ".ui-auth-entry__brand-content .ui-logo-mark--wordmark img:visible",
  );
  await expect(image).toHaveAttribute("data-logo-variant", "color-dark");
  await expect(image).toHaveAttribute("data-logo-art", "lockup");
  await expect(image).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(image).toHaveCSS("padding", "0px");
});

for (const theme of ["light", "dark"] as const) {
  for (
    const [width, selector, expectedWidth, expectedHeight] of [
      [
        1440,
        ".ui-auth-entry__brand-content",
        320,
        127.953125,
      ],
      [
        960,
        ".ui-auth-entry__brand-content",
        260,
        103.96875,
      ],
      [
        390,
        ".ui-auth-entry__mobile-logo",
        180,
        71.96875,
      ],
    ] as const
  ) {
    test(`AuthEntry ${theme} logo preserves its base box at ${width}px`, async ({ page }) => {
      await openRuntimeFixture(
        page,
        "bakery-templates-authentry--contract",
        `desktop-${theme}-fine`,
        [],
      );
      await page.setViewportSize({ width, height: 960 });
      const image = page.locator(
        `${selector} .ui-logo-mark--wordmark img:visible`,
      );
      await expect(image).toBeVisible();
      const box = await image.boundingBox();
      expect(box?.width).toBe(expectedWidth);
      expect(box?.height).toBe(expectedHeight);
      await expect(image).toHaveCSS("object-fit", "contain");
      await expect(image).toHaveCSS("object-position", "50% 50%");
      await expect(image).toHaveCSS("padding", "0px");
    });
  }
}
