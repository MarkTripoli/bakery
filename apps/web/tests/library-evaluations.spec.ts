import { expect, test } from "@playwright/test";
import { registerPageHealth } from "./helpers/page-health.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";
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
        page.getByText("Finished with gaps · 7 of 10 results measured").first(),
      ).toBeVisible();
      await expect(page.getByText("Running · 4 of 10 results measured"))
        .toBeVisible();
      await expect(
        page.getByText("Finished · 10 of 10 results passed").first(),
      ).toBeVisible();
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
      // The set a run measured is named on its row, with when it started.
      await expect(page.getByText(/Support questions · /).first())
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
      await expect(page.locator("[data-run]")).toHaveCount(30);
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
          "7 of 10 measured. The six counts always add up to 10.",
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
      await expect(used.getByText(/Support questions, as it stood on /))
        .toBeVisible();
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
      const toggle = page.getByRole("button", { name: "3 attempts" }).first();
      await toggle.click();
      // Open: the label says what the next press does, and it toggles back.
      await expect(page.getByRole("button", { name: "Hide 3 attempts" }))
        .toBeVisible();
      await expect(
        page.getByRole("button", { name: "3 attempts", exact: true }),
      ).toHaveCount(0);
      const list = page.getByRole("list", { name: "Attempts at exact-answer" });
      await expect(list.getByRole("listitem")).toHaveCount(3);
      // Newest first: attempt 3 leads.
      await expect(list.getByRole("listitem").first()).toHaveText(
        /^Attempt 3 · Nov 20, 2026, \d{1,2}:03 [AP]M · Passed$/,
      );
      await expect(list.getByRole("listitem").first()).toContainText("Passed");
      await expect(list.getByRole("listitem").nth(1)).toContainText(
        "Could not be scored: The model did not answer in time. This is not a score of zero.",
      );
      await expect(list.getByText("Trace reference")).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-attempts");
      // Pressing it again closes the attempts and the label goes back.
      await page.getByRole("button", { name: "Hide 3 attempts" }).click();
      await expect(
        page.getByRole("button", { name: "3 attempts", exact: true }),
      ).toBeVisible();
      await expect(list).toHaveCount(0);
    });

    test("a gate whose unmeasured results sit in two states has no button and says where they are", async ({ page }) => {
      await evaluationsFixture(page);
      await page.goto(run(IDS.twoStates));
      const gate = page.getByTestId("evaluation-gate");
      await expect(gate.getByText("The quality gate cannot be judged"))
        .toBeVisible();
      await expect(
        gate.getByText(
          "3 of 10 required results were not measured, so nobody can say whether at least 80% of required results pass. This is not a pass. They are under Not run (2) and Stopped (1) below.",
        ),
      ).toBeVisible();
      await expect(gate.getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("radio", { name: "Not run 2" }))
        .toBeVisible();
      await expect(page.getByRole("radio", { name: "Stopped 1" }))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-two-states");
    });

    test("results in every state each have a chip, and a chip shows only its state", async ({ page }) => {
      await evaluationsFixture(page);
      await page.goto(run(IDS.everyState));
      for (
        const chip of [
          "Passed 3",
          "Failed 2",
          "Could not be scored 2",
          "Not run 1",
          "Stopped 1",
          "Skipped 1",
        ]
      ) {
        await expect(page.getByRole("radio", { name: chip })).toBeVisible();
      }
      await expect(page.getByTestId("evaluation-gate").getByRole("button"))
        .toHaveCount(0);
      // One chip holds both scoring states: the error rows come first.
      await page.getByRole("radio", { name: "Could not be scored 2" }).check();
      const scoring = page.getByText(/Could not be scored/);
      await expect(
        page.getByText("Could not be scored: The model did not answer in time.")
          .first(),
      ).toBeVisible();
      await expect(page.getByText(/: Passed/)).toHaveCount(0);
      await expect(scoring.first()).toBeVisible();
      await page.getByRole("radio", { name: "Skipped 1" }).check();
      await expect(
        page.getByText("Skipped: The test case needs a file that was removed.")
          .first(),
      ).toBeVisible();
      await expect(page.getByText(/: Passed/)).toHaveCount(0);
      await page.getByRole("radio", { name: "All" }).check();
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-every-state");
    });

    test("a run no list names says its kind and version, in the list and on its page", async ({ page }) => {
      await evaluationsFixture(page);
      await page.goto(LIST);
      await expect(page.getByText("An agent, version 4")).toBeVisible();
      await expect(page.getByText("A version that is not named")).toHaveCount(
        0,
      );
      await expect(page.getByText("Version 1", { exact: true })).toBeVisible();
      await page.goto(run(IDS.noName));
      await expect(
        page.getByRole("heading", { name: "An agent, version 4", level: 1 }),
      ).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-no-name");
    });

    test("a result that never ran says Not run yet while the run works and Not run after, never its state as the reason", async ({ page }) => {
      await evaluationsFixture(page, { placeholderReasons: true });
      await page.goto(run(IDS.running));
      await expect(page.getByText("Not run yet").first()).toBeVisible();
      await expect(page.getByText("Not run: Not run yet.")).toHaveCount(0);
      await page.goto(run(IDS.gaps));
      await expect(page.getByText(/Not run$/).first()).toBeVisible();
      await expect(page.getByText(/Not run: Not run/)).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-not-run");
    });

    test("repeats of one scorer read how many passed", async ({ page }) => {
      await evaluationsFixture(page, { repeats: true });
      await page.goto(run(IDS.met));
      await expect(page.getByText(/: \d of 3 repeats passed$/)).toHaveCount(1);
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-repeats");
    });

    test("Stop run is offered to whoever holds the evaluationRun:write right, not by role name", async ({ page }) => {
      await evaluationsFixture(page, { noStopRight: true });
      await page.goto(run(IDS.running));
      await expect(
        page.getByRole("heading", { name: "Reviewer, version 3", level: 1 }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop run" })).toHaveCount(
        0,
      );
    });

    test("an administrator without the evaluationRun:write right is not offered Stop run", async ({ page }) => {
      await evaluationsFixture(page, { adminWithoutStopRight: true });
      await page.goto(run(IDS.running));
      await expect(
        page.getByRole("heading", { name: "Reviewer, version 3", level: 1 }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop run" })).toHaveCount(
        0,
      );
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

    test("while the run is read the page shows a loading state", async ({ page }) => {
      const fixture = await evaluationsFixture(page, { holdGet: true });
      await page.goto(run(IDS.gaps));
      await expect(page.getByText("Loading the run")).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-loading");
      fixture.release();
      await expect(
        page.getByRole("heading", {
          name: "Reviewed coding, version 5",
          level: 1,
        }),
      ).toBeVisible();
    });

    test("a finished run has no Stop button, and neither does a viewer", async ({ page }) => {
      await evaluationsFixture(page);
      await page.goto(run(IDS.met));
      await expect(
        page.getByRole("heading", {
          name: "Reviewed coding, version 4",
          level: 1,
        }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop run" })).toHaveCount(
        0,
      );
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-finished");
      const viewer = await page.context().newPage();
      await evaluationsFixture(viewer, { viewer: true });
      await viewer.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await viewer.goto(run(IDS.running));
      await expect(
        viewer.getByRole("heading", { name: "Reviewer, version 3", level: 1 }),
      ).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Stop run" }))
        .toHaveCount(0);
      await viewer.mouse.move(700, 700);
      await still(viewer, "evaluation-run-viewer");
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
      await failing.mouse.move(700, 700);
      await still(failing, "evaluation-run-load-failed");
      await failing.close();
    });

    test("Not scored reads every page of errors before it reads the unscored ones", async ({ page }) => {
      const fixture = await evaluationsFixture(page, { manyErrors: true });
      await page.goto(run(IDS.manyErrors));
      const results = () =>
        fixture.seen.filter((entry) =>
          entry.path.endsWith("/results") && entry.method === "GET"
        ).map((entry) => new URLSearchParams(entry.search).get("state"));
      await page.getByRole("radio", { name: /65$/ }).check();
      await expect.poll(results).toContain("error");
      // The first page of errors is on screen and nothing unscored was asked for.
      await expect(page.getByRole("button", { name: "Show more" }))
        .toBeVisible();
      expect(results()).not.toContain("unscored");
      await page.getByRole("button", { name: "Show more" }).click();
      await expect.poll(results).toContain("unscored");
      // The errors were read to the end first: the second page of errors came
      // before the first page of unscored results.
      const asked = results().filter((state) => state !== null);
      expect(asked.indexOf("unscored")).toBeGreaterThan(
        asked.lastIndexOf("error"),
      );
    });

    test("Not scored with no errors waits for the unscored read and never says there are no results", async ({ page }) => {
      await evaluationsFixture(page, { manyErrors: true });
      await page.route(
        (url) =>
          /^\/v1\/evaluation-batches\/[^/]+\/results$/.test(url.pathname),
        async (route) => {
          const state = new URL(route.request().url()).searchParams.get(
            "state",
          );
          if (state === "error") {
            return route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ items: [], nextCursor: null }),
            });
          }
          if (state === "unscored") {
            await new Promise((resolve) => setTimeout(resolve, 2500));
          }
          return route.fallback();
        },
      );
      await page.goto(run(IDS.manyErrors));
      await page.getByRole("radio", { name: /65$/ }).check();
      const empty = page.getByText("No results in this state.");
      // While the unscored read is still in flight the page is loading, not empty.
      await page.waitForTimeout(1200);
      await expect(empty).toHaveCount(0);
      // Then the unscored results land and the empty state never showed.
      await expect(page.getByText(/polite-tone|exact-answer/).first())
        .toBeVisible({ timeout: 10_000 });
      await expect(empty).toHaveCount(0);
    });

    test("names come from the run itself: no list of agents, workflows, sets or test cases is read", async ({ page }) => {
      await evaluationsFixture(page);
      const listed: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (
          /^\/v1\/(agents|workflows|evaluation-datasets|evaluation-cases)$/
            .test(path)
        ) listed.push(path);
      });
      await page.goto(LIST);
      await expect(page.getByText(/Support questions · /).first())
        .toBeVisible();
      await page.goto(run(IDS.gaps));
      await expect(page.getByText("Measured on Support questions"))
        .toBeVisible();
      await expect(
        page.getByText("Refund for a duplicate charge").first(),
      ).toBeVisible();
      expect(listed).toEqual([]);
    });

    test("a run whose definition has no name says its kind and its version", async ({ page }) => {
      await evaluationsFixture(page);
      await page.goto(run(IDS.noName));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText("Reviewed coding, version 5")).toHaveCount(0);
      await expect(page.getByText(/version 4/).first()).toBeVisible();
    });

    test("a running run reads again on its own and its counts change in place", async ({ page }) => {
      test.setTimeout(laneBudgetMs(60_000));
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

    // What a run cost, and the report numbers (#75, design-ux revision 6).
    test("a run within its limit shows what was spent, what it stops at and what is unknown", async ({ page }) => {
      await evaluationsFixture(page, { costRuns: true });
      await page.goto(run(IDS.costWithin));
      const cost = page.getByTestId("evaluation-cost");
      // The same heading scale as Results and What this run used, with its
      // help tip beside the title.
      const title = cost.getByRole("heading", { name: "Cost", level: 2 });
      await expect(title).toBeVisible();
      await expect(title.getByRole("button", { name: "About the cost" }))
        .toBeVisible();
      await expect(
        page.getByTestId("evaluation-results").getByRole("heading", {
          name: "Results",
          level: 2,
        }),
      ).toBeVisible();
      await expect(cost).toContainText("Spent");
      await expect(cost).toContainText("$12.40");
      await expect(cost).toContainText(
        "$3.10 of it is Bakery's estimate. The rest was reported by the provider.",
      );
      await expect(cost).toContainText("Stops at");
      await expect(cost).toContainText("$20.00");
      await expect(cost).toContainText(
        "No new model call starts once the cost reaches this.",
      );
      await expect(cost).toContainText("Cost unknown");
      await expect(cost).toContainText(
        "The cost of every model call is known.",
      );
      // The meter says only what is left; the figures above say the rest.
      await expect(cost.getByRole("meter", { name: "Cost against the limit" }))
        .toHaveAttribute("aria-valuetext", "$7.60 left");
      await expect(cost.getByTestId("evaluation-cost-notice")).toHaveCount(0);
      // Every result was attempted, so the counts already say it: no rate line.
      await expect(page.getByTestId("evaluation-attempted-rate")).toHaveCount(
        0,
      );
      await expect(page.getByTestId("evaluation-sampled")).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-cost-within");
    });

    test("two costs that are not known say so: at least, no figure for zero, and what stops", async ({ page }) => {
      await evaluationsFixture(page, { costRuns: true });
      await page.goto(run(IDS.costUnsettled));
      const cost = page.getByTestId("evaluation-cost");
      await expect(cost).toContainText("At least $18.20");
      await expect(cost).toContainText(
        "No cost was reported. Unknown is not zero.",
      );
      // Each fact once: the calls with no cost are counted in one tile, the
      // limit is in one tile, and Spent adds no line saying the same.
      await expect(cost.getByText("2 model calls")).toHaveCount(1);
      await expect(cost.getByText("$20.00")).toHaveCount(1);
      await expect(cost).not.toContainText("not in this figure");
      await expect(cost.getByRole("meter", { name: "Cost against the limit" }))
        .toHaveAttribute("aria-valuetext", "Cannot say what is left");
      const notice = cost.getByTestId("evaluation-cost-notice");
      await expect(notice).toContainText(
        "Bakery cannot say this run stayed within its limit",
      );
      await expect(notice).toContainText(
        "No new model call starts until the missing cost is known. Bakery checks again by itself.",
      );
      await expect(notice).not.toContainText("$");
      // All ten results were attempted: no rate line. Two were interrupted.
      await expect(page.getByTestId("evaluation-attempted-rate")).toHaveCount(
        0,
      );
      await expect(page.getByTestId("evaluation-interrupted")).toHaveText(
        "2 results were interrupted part-way. 1 of them was measured on a later attempt.",
      );
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-cost-unsettled");
    });

    test("a run that reached its limit says where it stopped and that checks still run", async ({ page }) => {
      await evaluationsFixture(page, { costRuns: true });
      await page.goto(run(IDS.costExhausted));
      const cost = page.getByTestId("evaluation-cost");
      await expect(cost.getByRole("meter", { name: "Cost against the limit" }))
        .toHaveAttribute("aria-valuetext", "Nothing left");
      const notice = cost.getByTestId("evaluation-cost-notice");
      await expect(notice).toContainText("This run reached its limit");
      await expect(notice).toContainText(
        "Checks still run, and they cost nothing.",
      );
      // Four results never ran, so the rate line says what it is out of.
      await expect(page.getByTestId("evaluation-attempted-rate")).toHaveText(
        "100% of the 6 results attempted passed. Results never attempted are not in this rate.",
      );
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-cost-reached");
    });

    test("a run of checks has one line where the cost would be", async ({ page }) => {
      await evaluationsFixture(page, { costRuns: true });
      await page.goto(run(IDS.checksOnly));
      await expect(page.getByTestId("evaluation-cost")).toHaveText(
        "This run used only checks, which cost nothing.",
      );
      await expect(page.getByRole("meter")).toHaveCount(0);
      await expect(page.getByText("Stops at")).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-cost-checks-only");
    });

    test("a run with no limit shows no meter and no notice, and its unknown cost is still a floor", async ({ page }) => {
      await evaluationsFixture(page, { costRuns: true });
      await page.goto(run(IDS.noLimit));
      const cost = page.getByTestId("evaluation-cost");
      await expect(cost).toContainText("At least $4.20");
      await expect(cost).toContainText("No limit");
      await expect(cost).toContainText("This run was started without one.");
      await expect(cost.getByRole("meter")).toHaveCount(0);
      await expect(cost.getByTestId("evaluation-cost-notice")).toHaveCount(0);
    });

    test("sampled opinions are reported apart: Results lists required results only, and the sampled ones open on request", async ({ page }) => {
      const fixture = await evaluationsFixture(page, { costRuns: true });
      await page.goto(run(IDS.sampled));
      const sampled = page.getByTestId("evaluation-sampled");
      const title = sampled.getByRole("heading", {
        name: "Sampled opinions",
        level: 2,
      });
      await expect(title).toBeVisible();
      await expect(
        title.getByRole("button", { name: "About sampled opinions" }),
      )
        .toBeVisible();
      await expect(sampled).toContainText("3 passed");
      await expect(sampled).toContainText("1 failed");
      await expect(sampled).toContainText("1 could not be scored");
      await expect(sampled).toContainText("0 not run");
      await expect(sampled).toContainText(
        "These never count toward the quality gate.",
      );
      // Results counts and lists only what counts toward the run.
      const results = page.getByTestId("evaluation-results");
      await expect(results).toContainText("5 passed");
      await expect(results.getByText(/exact-answer: Passed/)).toHaveCount(5);
      await expect(results.getByText(/polite-tone/)).toHaveCount(0);
      await expect(results.getByText("Sampled", { exact: true })).toHaveCount(
        0,
      );
      const sampledReads = () =>
        fixture.seen.filter((entry) =>
          entry.path.endsWith("/results") &&
          entry.search.includes("required=false")
        );
      const requiredReads = fixture.seen.filter((entry) =>
        entry.path.endsWith("/results") &&
        entry.search.includes("required=true")
      );
      expect(requiredReads.length).toBeGreaterThan(0);
      // Nothing sampled is read until the person opens it.
      expect(sampledReads()).toHaveLength(0);
      const used = page.getByTestId("evaluation-used");
      await expect(used).toContainText("exact-answer, revision 2");
      await expect(
        used.getByText("polite-tone, revision 1 · not in the quality gate"),
      ).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-sampled");
      const open = page.getByTestId("evaluation-sampled-results");
      await open.getByText("Show the 5 sampled results").click();
      const list = open.getByRole("list", { name: "Sampled results" });
      await expect(list.getByText(/polite-tone: Passed/)).toHaveCount(3);
      await expect(list.getByText(/polite-tone: Failed/)).toHaveCount(1);
      await expect(list.getByText(/polite-tone: Could not be scored/))
        .toHaveCount(1);
      expect(sampledReads()).toHaveLength(1);
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-sampled-open");
    });

    test("an attempt says what it cost, or that the cost is not known, and an interrupted one says so", async ({ page }) => {
      await evaluationsFixture(page, { attemptCosts: true });
      await page.goto(run(IDS.gaps));
      await page.getByRole("button", { name: "3 attempts" }).first().click();
      // The run's cost agrees with its attempts: $0.06 + $0.04, one not known.
      const spent = page.getByTestId("evaluation-cost");
      await expect(spent).toContainText("At least $0.10");
      await expect(spent).toContainText("1 model call");
      await expect(spent).not.toContainText("No model call has finished yet.");
      const list = page.getByRole("list", { name: "Attempts at exact-answer" });
      await expect(list.getByRole("listitem").first()).toContainText(
        "Passed · $0.06",
      );
      await expect(list.getByRole("listitem").nth(1)).toContainText(
        "about $0.04",
      );
      await expect(list.getByRole("listitem").nth(2)).toContainText(
        "Interrupted: The machine went away. · cost not known",
      );
      await page.mouse.move(700, 700);
      await still(page, "evaluation-run-attempt-costs");
    });
  });
}
