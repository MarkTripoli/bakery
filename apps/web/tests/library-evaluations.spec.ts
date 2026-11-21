import { expect, test } from "@playwright/test";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";
import { evaluationsFixture, IDS } from "./helpers/evaluations-fixture.ts";

registerPageHealth(test);

const LIST = "/library?tab=evaluations";
const run = (id: string) => `/library/evaluations/${id}`;

/** The Evaluations tab and one run (#75 slice A, UX revision 4). */
for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: evaluations`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("each run says its state in words and what its gate decided", async ({ page }) => {
      await evaluationsFixture(page);
      await page.goto(LIST);
      await expect(page.getByRole("heading", { name: "Library", level: 1 }))
        .toBeVisible();
      await expect(page.getByRole("tab", { name: "Evaluations" }))
        .toHaveAttribute(
          "aria-selected",
          "true",
        );
      await expect(page.getByText("Reviewed coding, version 5").first())
        .toBeVisible();
      await expect(
        page.getByText("Finished with gaps · 7 of 10 results measured"),
      )
        .toBeVisible();
      await expect(page.getByText("Running · 4 of 10 results measured"))
        .toBeVisible();
      await expect(page.getByText("Finished · 10 of 10 results passed"))
        .toBeVisible();
      await expect(page.getByText("Finished · 6 of 10 results passed"))
        .toBeVisible();
      await expect(page.getByText("Waiting to start")).toBeVisible();
      await expect(page.getByText("Stopped · 4 of 10 results measured"))
        .toBeVisible();
      await expect(page.getByText("Did not finish")).toBeVisible();
      await expect(page.getByText("Quality gate cannot be judged").first())
        .toBeVisible();
      await expect(page.getByText("Quality gate met").first()).toBeVisible();
      await expect(page.getByText("Quality gate not met").first())
        .toBeVisible();
      await expect(
        page.getByText("The quality gate is judged when the run ends.").first(),
      ).toBeVisible();
      // The set a run measured is named with how many test cases it holds.
      await expect(page.getByText(/Support questions, 5 test cases · /).first())
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "library-evaluations-list");
    });

    test("with no runs the tab says what a run is and offers no button", async ({ page }) => {
      await evaluationsFixture(page, { empty: true });
      await page.goto(LIST);
      await expect(page.getByText("No runs yet")).toBeVisible();
      await expect(
        page.getByText(
          "A run measures a workflow or agent on a set of test cases.",
        ),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: /Start|New run/ }))
        .toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "library-evaluations-empty");
    });

    test("more than 25 runs show 25 and Show more reads the next page", async ({ page }) => {
      await evaluationsFixture(page, { extra: 20 });
      await page.goto(LIST);
      await expect(page.locator("[data-run]")).toHaveCount(25);
      await page.getByRole("button", { name: "Show more" }).click();
      await expect(page.locator("[data-run]")).toHaveCount(27);
      await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(
        0,
      );
    });

    test("a run that finished with gaps is grey, not a pass, and Show the results filters to the gaps", async ({ page }) => {
      await evaluationsFixture(page);
      await page.goto(run(IDS.gaps));
      await expect(
        page.getByRole("heading", {
          name: "Reviewed coding, version 5",
          level: 1,
        }),
      ).toBeVisible();
      await expect(page.getByText("Measured on Support questions"))
        .toBeVisible();
      const gate = page.getByTestId("evaluation-gate");
      await expect(gate.getByText("The quality gate cannot be judged"))
        .toBeVisible();
      await expect(
        gate.getByText(
          "3 of 10 required results were not measured, so nobody can say whether at least 80% of required results pass. This is not a pass."
            .replace(
              "required results pass",
              "required results pass",
            ),
        ),
      ).toBeVisible();
      await expect(page.getByText("7 passed")).toBeVisible();
      await expect(page.getByText("3 not run")).toBeVisible();
      await expect(
        page.getByText(
          "7 of 10 measured: 5 test cases, each by 2 scorers. The six counts always add up to 10.",
        ),
      ).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-gaps");
      await gate.getByRole("button", { name: "Show the 3 results" }).click();
      await expect(page.getByRole("radio", { name: "Not run 3" }))
        .toBeChecked();
      await expect(
        page.getByText(
          "exact-answer: Not run: No machine was free to run this test case.",
        )
          .first(),
      ).toBeVisible();
      await expect(page.getByText(/exact-answer: Passed/)).toHaveCount(0);
      await page.getByRole("radio", { name: "All" }).check();
      await expect(page.getByText(/exact-answer: Passed/).first())
        .toBeVisible();
    });

    test("what the run used is listed, with the baseline only when there is one", async ({ page }) => {
      await evaluationsFixture(page);
      await page.goto(run(IDS.met));
      const used = page.getByTestId("evaluation-used");
      await expect(used.getByText("Reviewed coding, version 4")).toBeVisible();
      await expect(used.getByText("Compared with")).toBeVisible();
      await expect(used.getByText("Reviewed coding, version 3")).toBeVisible();
      await expect(used.getByText(/Support questions, fixed /)).toBeVisible();
      await expect(
        used.getByText(/exact-answer, revision 2; polite-tone, revision 1/),
      )
        .toBeVisible();
      await expect(used.getByText("at least 80% of required results pass"))
        .toBeVisible();
      await expect(
        page.getByTestId("evaluation-gate").getByText(
          "The quality gate is met",
        ),
      )
        .toBeVisible();
      await page.goto(run(IDS.gaps));
      await expect(
        page.getByTestId("evaluation-used").getByText("Compared with"),
      )
        .toHaveCount(0);
    });

    test("a gate that is not met is a warning that shows the failed results", async ({ page }) => {
      await evaluationsFixture(page);
      await page.goto(run(IDS.notMet));
      const gate = page.getByTestId("evaluation-gate");
      await expect(gate.getByText("The quality gate is not met")).toBeVisible();
      await expect(gate.getByText("4 required results failed.")).toBeVisible();
      await gate.getByRole("button", { name: "Show the 4 results" }).click();
      await expect(page.getByRole("radio", { name: "Failed 4" })).toBeChecked();
      await expect(page.getByText(/exact-answer: Failed · score 0.25/).first())
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-not-met");
    });

    test("results that could not be scored say it is not a score of zero, and attempts open under a result", async ({ page }) => {
      await evaluationsFixture(page);
      await page.goto(run(IDS.gaps));
      await expect(page.getByText("3 attempts").first()).toBeVisible();
      await page.getByRole("button", { name: "3 attempts" }).first().click();
      const list = page.getByRole("list", { name: "Attempts at exact-answer" });
      await expect(list.getByRole("listitem")).toHaveCount(3);
      // Newest first: attempt 3 leads.
      await expect(list.getByRole("listitem").first()).toContainText(
        "Attempt 3",
      );
      await expect(list.getByRole("listitem").first()).toContainText("Passed");
      await expect(list.getByRole("listitem").nth(1)).toContainText(
        "Could not be scored: The model did not answer in time. This is not a score of zero.",
      );
      await expect(list.getByRole("listitem").first()).toContainText(
        "Trace reference",
      );
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-attempts");
    });

    test("a running run can be stopped after asking, with the version, and the page then reads Stopped", async ({ page }) => {
      const seen = await evaluationsFixture(page);
      await page.goto(run(IDS.running));
      await expect(
        page.getByTestId("evaluation-gate").getByText(
          "The quality gate is judged when the run ends",
        ),
      ).toBeVisible();
      await expect(page.getByText("Not run yet").first()).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-running");
      await page.getByRole("button", { name: "Stop run" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog.getByText("Stop this run?")).toBeVisible();
      await expect(
        dialog.getByText(
          "Results already measured are kept. The rest are marked Stopped and the gate cannot be judged.",
        ),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Keep running" }).click();
      await expect(dialog).toHaveCount(0);
      expect(seen.seen.some((entry) => entry.method === "POST")).toBe(false);
      await page.getByRole("button", { name: "Stop run" }).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Stop run",
      })
        .click();
      await expect.poll(() =>
        seen.seen.some((entry) => entry.method === "POST")
      )
        .toBe(true);
      expect(seen.seen.find((entry) => entry.method === "POST")!.ifMatch).toBe(
        '"v1"',
      );
      await expect(page.getByText("Stopped · 4 of 10 results measured"))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Stop run" })).toHaveCount(
        0,
      );
    });

    test("someone else stopped it first: the latest is shown with a plain notice", async ({ page }) => {
      await evaluationsFixture(page, { conflictOnce: true });
      await page.goto(run(IDS.running));
      await page.getByRole("button", { name: "Stop run" }).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Stop run",
      })
        .click();
      await expect(
        page.getByText("This run changed just now. The latest is shown."),
      )
        .toBeVisible();
      await expect(page.getByText("Stopped · 4 of 10 results measured"))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-changed");
    });

    test("a finished run has no Stop button, and neither does a viewer", async ({ page }) => {
      await evaluationsFixture(page);
      await page.goto(run(IDS.met));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop run" })).toHaveCount(
        0,
      );
      const viewer = await page.context().newPage();
      await evaluationsFixture(viewer, { viewer: true });
      await viewer.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await viewer.goto(run(IDS.running));
      await expect(viewer.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Stop run" }))
        .toHaveCount(0);
      await viewer.close();
    });

    test("a run that is not there says so, and a failed read offers Try again", async ({ page }) => {
      await evaluationsFixture(page, { getStatus: 404 });
      await page.goto(run(IDS.gaps));
      await expect(page.getByText("This run was not found")).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-not-found");
      const failing = await page.context().newPage();
      await evaluationsFixture(failing, { getStatus: 500 });
      await failing.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await failing.goto(run(IDS.gaps));
      await expect(failing.getByText("This run could not be loaded."))
        .toBeVisible();
      await expect(failing.getByRole("button", { name: "Try again" }))
        .toBeVisible();
      await failing.close();
    });

    test("a running run reads again on its own and its counts change in place", async ({ page }) => {
      test.setTimeout(60_000);
      const fixture = await evaluationsFixture(page);
      await page.goto(run(IDS.running));
      await expect(page.getByText("Running · 4 of 10 results measured"))
        .toBeVisible();
      const live = fixture.runs.find((entry) => entry.id === IDS.running)!;
      Object.assign(live, {
        measuredCount: 6,
        counts: {
          passed: 5,
          failed: 1,
          error: 0,
          unscored: 0,
          canceled: 0,
          skipped: 0,
          missing: 4,
        },
      });
      await expect(page.getByText("Running · 6 of 10 results measured"))
        .toBeVisible({
          timeout: 20_000,
        });
    });
  });
}
