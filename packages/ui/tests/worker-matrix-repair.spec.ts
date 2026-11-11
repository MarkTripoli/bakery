import { expect, test } from "@playwright/test";
import { createTranslator } from "@bakery/i18n";
import {
  openRuntimeFixture,
  renderedContainmentIssues,
  runtime,
  runtimeAssertions,
} from "./storybook-harness.ts";

function assertExpandedCatalogCopy(
  actual: string | null,
  english: string,
  pseudo: string,
) {
  expect(actual).toBe(pseudo);
  expect(actual!.length).toBeGreaterThanOrEqual(english.length * 1.35);
}

for (const surface of ["list", "enrollment"] as const) {
  for (const state of ["ready", "worstcase"] as const) {
    test(`${surface} ${state}: catalog pseudo copy and reserved rail mark`, async ({ page }) => {
      const item = runtime.cases.find((c) =>
        c.id === `wr.${surface}.${state}.pseudo-locale`
      )!;
      const { context, runtimeCase } = await openRuntimeFixture(
        page,
        item.storyId,
        item.context,
        item.assertions ?? [],
        item.args,
      );
      const en = createTranslator({ locale: "en" });
      const pseudo = createTranslator({ locale: "en-XA" });
      const key = surface === "list"
        ? "workerList.ownershipHint"
        : "workerEnrollment.prepareHint";
      const root = page.locator(
        surface === "list" ? ".ui-worker-catalog" : ".ui-worker-enrollment",
      );
      await expect(root.getByText(pseudo(key), { exact: true })).toBeVisible();
      assertExpandedCatalogCopy(
        await root.getByText(pseudo(key), { exact: true }).textContent(),
        en(key),
        pseudo(key),
      );
      // The same regression contract rejects English, unexpanded pseudo text,
      // and a long sentinel that does not come from the actual catalog.
      expect(() => assertExpandedCatalogCopy(en(key), en(key), pseudo(key)))
        .toThrow();
      expect(() => assertExpandedCatalogCopy(en(key), en(key), en(key)))
        .toThrow();
      expect(() =>
        assertExpandedCatalogCopy("x".repeat(500), en(key), pseudo(key))
      )
        .toThrow();
      await runtimeAssertions(page, runtimeCase, context);
      const logo = root.locator(".ui-logo-mark--rail");
      expect((await logo.boundingBox())?.width).toBe(28);
      expect((await logo.locator("img:visible").boundingBox())?.width).toBe(28);
      expect(await page.evaluate(renderedContainmentIssues)).toEqual([]);
    });
  }
  test(`${surface}: English source copy and normal rail geometry`, async ({ page }) => {
    const item = runtime.cases.find((c) =>
      c.id === `wr.${surface}.ready.desktop-light-fine`
    )!;
    await openRuntimeFixture(page, item.storyId, item.context, [], item.args);
    const en = createTranslator({ locale: "en" });
    const root = page.locator(
      surface === "list" ? ".ui-worker-catalog" : ".ui-worker-enrollment",
    );
    const key = surface === "list"
      ? "workerList.ownershipHint"
      : "workerEnrollment.prepareHint";
    await expect(root.getByText(en(key), { exact: true })).toBeVisible();
    expect((await root.locator(".ui-logo-mark--rail").boundingBox())?.width)
      .toBe(28);
    expect(await page.evaluate(renderedContainmentIssues)).toEqual([]);
  });
}
