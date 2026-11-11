import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  openComments,
  PATH,
  stubArtifactPage,
} from "./artifact-page-fixture.ts";
import { mockUserPreferences } from "./mock-session.ts";

async function assertNoOverflow(page: Page) {
  expect(
    await page.locator("html").evaluate((node) =>
      node.scrollWidth <= node.clientWidth + 1
    ),
  ).toBe(true);
}

test(
  "artifact page and mobile comment sheet remain accessible without horizontal overflow",
  async ({ page }, testInfo) => {
    await stubArtifactPage(page);
    await page.goto(PATH);
    await expect(page.locator('[data-ui-component="artifactViewer"]'))
      .toBeVisible();
    await assertNoOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("normal.png"),
      fullPage: true,
    });
    await openComments(page);
    await assertNoOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  },
);

for (
  const presentation of [
    { locale: "en-XA", direction: "ltr", comments: "⟦Çôɱɱëñŧš…⟧" },
    { locale: "ar-XB", direction: "rtl", comments: "⟪Comments⟫" },
  ] as const
) {
  test(
    `${presentation.locale} artifact layout and discussion fit the viewport`,
    async ({ page }, testInfo) => {
      await stubArtifactPage(page);
      await mockUserPreferences(page, {
        locale: presentation.locale,
        effectiveLocale: presentation.locale,
        direction: presentation.direction,
      });
      await page.goto(PATH);
      await expect(page.locator("html")).toHaveAttribute(
        "lang",
        presentation.locale,
      );
      await expect(page.locator("html")).toHaveAttribute(
        "dir",
        presentation.direction,
      );
      await expect(page.locator('[data-ui-component="artifactViewer"]'))
        .toBeVisible();
      await assertNoOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath("normal.png"),
        fullPage: true,
      });
      const trigger = page.getByRole("button", {
        name: presentation.comments,
        exact: true,
      });
      if (await trigger.isVisible()) await trigger.click();
      await expect(page.locator("#artifact-comment-body")).toBeVisible();
      await assertNoOverflow(page);
    },
  );
}
