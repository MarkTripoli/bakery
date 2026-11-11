import { expect, test } from "@playwright/test";
import { openByTitle, renderedContainmentIssues } from "./storybook-harness.ts";

test.describe("Storybook containment rails", () => {
  test("detects overlapping and escaping reflow content", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Text");
    await page.locator(".storybook-story").evaluate((story) => {
      story.innerHTML = `
        <div style="block-size: 10px">content<br>escapes</div>
        <div style="display: grid">
          <span style="grid-area: 1 / 1">first</span>
          <span style="grid-area: 1 / 1">second</span>
        </div>
      `;
    });
    const issues = await page.evaluate(renderedContainmentIssues);
    expect(issues.some((issue) => issue.includes("content escapes vertically")))
      .toBe(true);
    expect(issues.some((issue) => issue.includes("overlaps sibling"))).toBe(
      true,
    );
  });

  test("detects clipping on the specimen root", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Text");
    await page.locator(".storybook-story").evaluate((story) => {
      story.style.setProperty("display", "block", "important");
      story.style.setProperty("block-size", "20px", "important");
      story.style.setProperty("inline-size", "20px", "important");
      story.style.setProperty("width", "20px", "important");
      story.style.setProperty("min-width", "0", "important");
      story.style.setProperty("max-width", "20px", "important");
      story.style.setProperty("height", "20px", "important");
      story.style.setProperty("min-height", "0", "important");
      story.style.setProperty("max-height", "20px", "important");
      story.style.setProperty("box-sizing", "border-box", "important");
      story.style.setProperty("padding", "0", "important");
      story.style.setProperty("margin", "0", "important");
      story.style.setProperty("overflow", "hidden", "important");
      story.innerHTML = [
        '<div style="display:block; width:10px; height:10px; position:relative; left:-100px; top:-100px"></div>',
        '<div style="display:block; width:100px; height:100px; position:relative; left:100px; top:100px"></div>',
      ].join("");
    });
    const issues = await page.evaluate(renderedContainmentIssues);
    expect(
      issues.some((issue) =>
        issue.includes("storybook-story") && issue.includes("horizontally") &&
        issue.includes("<")
      ),
    ).toBe(true);
    expect(
      issues.some((issue) =>
        issue.includes("storybook-story") && issue.includes("vertically") &&
        issue.includes("<")
      ),
    ).toBe(true);
    expect(
      issues.some((issue) =>
        issue.includes("storybook-story") && issue.includes("horizontally") &&
        issue.includes(">")
      ),
    ).toBe(true);
    expect(
      issues.some((issue) =>
        issue.includes("storybook-story") && issue.includes("vertically") &&
        issue.includes(">")
      ),
    ).toBe(true);
  });

  test("allows content contained by a native scroll owner", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Text");
    await page.locator(".storybook-story").evaluate((story) => {
      story.style.setProperty("display", "block", "important");
      story.style.setProperty("block-size", "20px", "important");
      story.style.setProperty("inline-size", "20px", "important");
      story.style.setProperty("width", "20px", "important");
      story.style.setProperty("min-width", "0", "important");
      story.style.setProperty("max-width", "20px", "important");
      story.style.setProperty("height", "20px", "important");
      story.style.setProperty("min-height", "0", "important");
      story.style.setProperty("max-height", "20px", "important");
      story.style.setProperty("box-sizing", "border-box", "important");
      story.style.setProperty("padding", "0", "important");
      story.style.setProperty("margin", "0", "important");
      story.style.setProperty("overflow", "hidden", "important");
      story.innerHTML =
        '<div style="display:block; flex:none; width:20px; min-width:20px !important; height:20px; overflow:auto"><div style="width:100px; height:10px"></div></div>';
    });
    const issues = await page.evaluate(renderedContainmentIssues);
    expect(issues).toEqual([]);
  });

  test("allows explicitly annotated truncation", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Text");
    await page.locator(".storybook-story").evaluate((story) => {
      story.innerHTML =
        '<div data-rail="truncation-allowed" style="width: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">truncated fixture</div>';
    });
    const issues = await page.evaluate(renderedContainmentIssues);
    expect(issues).toEqual([]);
  });

  test("reads vector art as drawing and the glyph itself as layout", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Text");
    await page.locator(".storybook-story").evaluate((story) => {
      story.innerHTML = `
        <svg height="24" viewBox="0 0 24 24" width="24">
          <rect height="18" width="20" x="2" y="3"></rect>
          <path d="M2 3 12 13 22 3"></path>
        </svg>
      `;
    });
    expect(await page.evaluate(renderedContainmentIssues)).toEqual([]);
    await page.locator(".storybook-story").evaluate((story) => {
      story.innerHTML = `
        <div style="block-size: 24px; inline-size: 24px"></div>
        <svg height="24" style="margin-block-start: -12px" viewBox="0 0 24 24" width="24">
          <rect height="18" width="20" x="2" y="3"></rect>
        </svg>
      `;
    });
    expect(
      (await page.evaluate(renderedContainmentIssues)).some((issue) =>
        issue.includes("overlaps sibling svg")
      ),
    ).toBe(true);
  });

  test("does not let vertical scrolling hide horizontal text clipping", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Text");
    await page.locator(".storybook-story").evaluate((story) => {
      story.innerHTML =
        '<div style="width: 20px; height: 20px; overflow-x: hidden; overflow-y: auto; white-space: nowrap">horizontally clipped text</div>';
    });
    const issues = await page.evaluate(renderedContainmentIssues);
    expect(
      issues.some((issue) => issue.includes("content escapes horizontally")),
    ).toBe(true);
  });

  test("does not let a positioned descendant hide in-flow overflow", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Text");
    await page.locator(".storybook-story").evaluate((story) => {
      story.innerHTML =
        '<div style="width: 10px"><span style="position: absolute; width: 1px; height: 1px"></span><span style="display: block; width: 100px">overflow fixture</span></div>';
    });
    const issues = await page.evaluate(renderedContainmentIssues);
    expect(
      issues.some((issue) => issue.includes("content escapes horizontally")),
    ).toBe(true);
  });

  test("detects clipping at an intermediate clipping owner", async ({ page }) => {
    await openByTitle(page, "Bakery/Atoms/Text");
    await page.locator(".storybook-story").evaluate((story) => {
      story.style.setProperty("display", "block", "important");
      story.style.setProperty("block-size", "20px", "important");
      story.style.setProperty("inline-size", "20px", "important");
      story.style.setProperty("width", "20px", "important");
      story.style.setProperty("height", "20px", "important");
      story.style.setProperty("min-width", "0", "important");
      story.style.setProperty("min-height", "0", "important");
      story.style.setProperty("max-width", "20px", "important");
      story.style.setProperty("max-height", "20px", "important");
      story.style.setProperty("box-sizing", "border-box", "important");
      story.style.setProperty("padding", "0", "important");
      story.style.setProperty("margin", "0", "important");
      story.style.setProperty("overflow", "visible", "important");
      story.innerHTML =
        '<div style="width:20px; height:20px; overflow:hidden"><div style="width:10px; height:10px; position:relative; left:-100px; top:-100px"></div></div>';
    });
    const issues = await page.evaluate(renderedContainmentIssues);
    expect(
      issues.some((issue) =>
        issue.includes("horizontally") && issue.includes("<")
      ),
    ).toBe(true);
    expect(
      issues.some((issue) =>
        issue.includes("vertically") && issue.includes("<")
      ),
    ).toBe(true);
  });
});
