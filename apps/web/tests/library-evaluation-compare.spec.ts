import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";
import { IDS } from "./helpers/evaluations-fixture.ts";
import { compareFixture } from "./helpers/evaluations-compare-fixture.ts";

registerPageHealth(test);

const compare = (left: string, right: string) =>
  `/library/evaluations/${left}/compare/${right}`;

async function axe(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, context).toEqual([]);
}

const groupIds = (page: Page) =>
  page.locator("[data-testid=evaluation-compare-groups] > [data-group]")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-group"))
    );

for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: comparing two runs`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("rates per scorer, then what changed, worst news first", async ({ page }) => {
      await compareFixture(page);
      await page.goto(compare(IDS.met, IDS.gaps));
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Reviewed coding: version 4 and version 5",
        }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Both measured on Support questions, 4 test cases, with the same 2 scorers",
        ),
      ).toBeVisible();
      const scorers = page.getByTestId("evaluation-compare-scorers");
      for (
        const text of [
          "exact-answer",
          "A check",
          "polite-tone",
          "A rubric read by a model",
          "50% passed",
          "70% passed",
          "100% passed",
          "90% passed",
          "Up 20 points",
          "Down 10 points",
        ]
      ) {
        await expect(scorers).toContainText(text);
      }
      await expect(scorers).not.toContainText("of 10 measured");
      await expect(
        page.getByText(
          "A pass rate counts only results that were measured. Where a version measured fewer, the two rates are not over the same test cases.",
        ),
      ).toBeVisible();
      await expect(page.getByTestId("evaluation-compare-groups")).toBeVisible();
      expect(await groupIds(page)).toEqual([
        "nowFailing",
        "nowPassing",
        "notMeasured",
        "stillFailing",
        "passingBoth",
        "only-left",
        "only-right",
      ]);
      const failing = page.locator('[data-group="nowFailing"]');
      await expect(failing).toContainText(
        "Now failing · 2 · passed in version 4, failed in version 5",
      );
      await expect(failing).toContainText("Refund for a duplicate charge");
      await expect(failing).toContainText("Change the delivery address");
      await expect(failing).toContainText("exact-answer · Passed, then Failed");
      const passing = page.locator('[data-group="nowPassing"]');
      await expect(passing).toContainText(
        "Now passing · 2 · failed in version 4, passed in version 5",
      );
      await expect(passing).toContainText("A question in French");
      await expect(passing).toContainText("polite-tone · Failed, then Passed");
      const unmeasured = page.locator('[data-group="notMeasured"]');
      await expect(unmeasured).toContainText(
        "Not measured in one of them · 2 · no change can be shown",
      );
      await expect(unmeasured).toContainText(
        "polite-tone · Passed, then Not run",
      );
      await expect(unmeasured).toContainText(
        "polite-tone · Failed, then Could not be scored",
      );
      await expect(unmeasured).not.toContainText("not a score of zero");
      await expect(page.locator('[data-group="only-left"]')).toContainText(
        "Only in version 4 · 1 · No match in the other run.",
      );
      await expect(page.locator('[data-group="only-left"]')).toContainText(
        "Cancel after the cutoff",
      );
      await expect(page.locator('[data-group="only-right"]')).toContainText(
        "Only in version 5 · 1",
      );
      await axe(page, "compare page");
      await still(page, "library-evaluation-compare");
    });

    test("the groups that held nothing new are closed and open on demand", async ({ page }) => {
      await compareFixture(page);
      await page.goto(compare(IDS.met, IDS.gaps));
      const still_ = page.locator('[data-group="stillFailing"]');
      await expect(still_).toContainText("Still failing · 1");
      await expect(still_.locator("details")).not.toHaveAttribute("open", "");
      await still_.locator("summary").click();
      await expect(still_).toContainText("A very angry customer");
      await expect(still_).toContainText("exact-answer · Failed, then Failed");
      const both = page.locator('[data-group="passingBoth"]');
      await expect(both).toContainText("Passing in both · 1");
    });

    test("a group shows ten rows, then the rest on request", async ({ page }) => {
      await compareFixture(page, { many: 12 });
      await page.goto(compare(IDS.met, IDS.gaps));
      const passing = page.locator('[data-group="nowPassing"]');
      await expect(passing).toContainText("Now passing · 14 ·");
      await expect(passing.locator("[data-row]")).toHaveCount(10);
      await passing.getByRole("button", { name: "Show 4 more" }).click();
      await expect(passing.locator("[data-row]")).toHaveCount(14);
      await expect(passing.getByRole("button", { name: /Show .* more/ }))
        .toHaveCount(0);
    });

    test("two different things read as two titles", async ({ page }) => {
      await compareFixture(page);
      await page.goto(compare(IDS.met, IDS.notMet));
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Reviewed coding, version 4 and Reviewer, version 2",
        }),
      ).toBeVisible();
    });

    test("a run still going is named", async ({ page }) => {
      await compareFixture(page);
      await page.goto(compare(IDS.notMet, IDS.running));
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Reviewer: version 2 and version 3",
        }),
      ).toBeVisible();
      await expect(page.getByTestId("evaluation-compare-running")).toHaveText(
        "Version 3 is still running. This compares what is measured so far.",
      );
    });

    for (
      const refusal of [
        {
          reason: "different_dataset" as const,
          text:
            "They used different test cases: Support questions and Plan quality. A change between them would mean nothing.",
        },
        {
          reason: "different_case_revision" as const,
          text: "A test case was changed between the two runs.",
        },
        {
          reason: "different_scorer_version" as const,
          text: "They used different scorers, or different revisions of one.",
        },
      ]
    ) {
      test(`${refusal.reason}: says why in one place and offers another run`, async ({ page }) => {
        await compareFixture(page, { refusal: refusal.reason });
        await page.goto(compare(IDS.met, IDS.notMet));
        const banner = page.getByTestId("evaluation-compare-refused");
        await expect(banner).toContainText("These runs cannot be compared");
        await expect(banner).toContainText(refusal.text);
        await expect(page.getByTestId("evaluation-compare-groups")).toHaveCount(
          0,
        );
        await expect(page.getByTestId("evaluation-compare-scorers"))
          .toHaveCount(
            0,
          );
        await axe(page, `refused ${refusal.reason}`);
        if (refusal.reason === "different_dataset") {
          await still(page, "library-evaluation-compare-refused");
        }
        await banner.getByRole("button", { name: "Choose another run" })
          .click();
        await expect(
          page.getByRole("dialog", { name: "Compare with another run" }),
        ).toBeVisible();
      });
    }

    test("the run page offers Compare with another run, same test cases first, older run on the left", async ({ page }) => {
      await compareFixture(page, { otherSetRun: IDS.notMet });
      await page.goto(`/library/evaluations/${IDS.met}`);
      await page.getByRole("button", { name: "Compare with another run" })
        .first().click();
      const dialog = page.getByRole("dialog", {
        name: "Compare with another run",
      });
      await expect(dialog).toBeVisible();
      const sections = await dialog.locator("[data-section]").evaluateAll(
        (nodes) => nodes.map((node) => node.getAttribute("data-section")),
      );
      expect(sections).toEqual(["same", "other"]);
      await expect(dialog.locator('[data-section="other"]')).toContainText(
        "Reviewer, version 2",
      );
      await expect(dialog.locator('[data-section="other"]')).toContainText(
        "Plan quality",
      );
      await expect(dialog.locator(`[data-run="${IDS.met}"]`)).toHaveCount(0);
      await axe(page, "picker");
      await dialog.locator(`[data-run="${IDS.gaps}"]`).getByRole("button")
        .click();
      await expect(page).toHaveURL(compare(IDS.met, IDS.gaps));
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Reviewed coding: version 4 and version 5",
        }),
      ).toBeVisible();
    });

    test("choosing the older run from the newer page puts the older on the left", async ({ page }) => {
      await compareFixture(page);
      await page.goto(`/library/evaluations/${IDS.gaps}`);
      await page.getByRole("button", { name: "Compare with another run" })
        .first().click();
      await page.getByRole("dialog", { name: "Compare with another run" })
        .locator(`[data-run="${IDS.met}"]`).getByRole("button").click();
      await expect(page).toHaveURL(compare(IDS.met, IDS.gaps));
    });

    test("a run that was not found says so", async ({ page }) => {
      await compareFixture(page, { getStatus: 404 });
      await page.goto(compare(IDS.met, IDS.gaps));
      await expect(page.getByText("This run was not found")).toBeVisible();
    });

    test("a comparison that fails to load says so and can be tried again", async ({ page }) => {
      await compareFixture(page, { compareStatus: 500 });
      await page.goto(compare(IDS.met, IDS.gaps));
      await expect(page.getByText("This comparison could not be loaded."))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Try again" }))
        .toBeVisible();
      await axe(page, "compare error");
    });
  });
}
