import { expect, type Page, test } from "@playwright/test";
import {
  batch,
  batchesFixture,
  batchId,
  extraRepositoryId,
  RUNNING,
  STOREFRONT,
  WEB,
} from "./helpers/batches-fixture.ts";
import { uuid } from "./helpers/issues-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const banner = (page: Page) => page.getByTestId("batch-banner");

/** Batches (#58, UX revision 2): the list, the start page and a batch's own page. */
for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: batches`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("the list shows one row per batch with its state, merged count, spend, starter and why it ended", async ({ page }) => {
      await batchesFixture(page, {
        batches: [
          RUNNING(),
          batch({
            id: batchId(2),
            repositoryId: STOREFRONT.id,
            state: "finished",
            finishReason: "spend_exhausted",
            issuesDone: 3,
            spentUsd: "43.5000",
            finishedAt: "2026-11-19T17:00:00.000Z",
          }),
          batch({
            id: batchId(3),
            state: "waiting",
            continueMode: "ask_first",
            issuesDone: 1,
          }),
        ],
      });
      await page.goto("/issues/batches");
      await expect(page.getByRole("heading", { name: "Batches", level: 1 }))
        .toBeVisible();
      await expect(
        page.getByText(/^A batch works through several ready issues/),
      )
        .toBeVisible();
      const running = page.locator(`[data-batch-id="${batchId(1)}"]`);
      await expect(running).toContainText("acme/web");
      await expect(running).toContainText("Running");
      const finished = page.locator(`[data-batch-id="${batchId(2)}"]`);
      await expect(finished).toContainText("acme/storefront");
      await expect(finished).toContainText("Finished");
      if (viewport.width > 743) {
        await expect(running).toContainText("3 of 5");
        await expect(running).toContainText("Ana Reyes");
        await expect(running).toContainText("$22.40 of $40");
        await expect(running).toContainText("Still going");
        await expect(finished).toContainText("It reached the spend limit");
        await expect(page.locator(`[data-batch-id="${batchId(3)}"]`))
          .toContainText("Asks before each next issue");
      }
      await expect(page.getByText("3 batches · newest first")).toBeVisible();
      await still(page, "batches-list");
    });

    test("choosing a repository narrows the list and is kept in the address", async ({ page }) => {
      const { seen } = await batchesFixture(page, {
        batches: [
          RUNNING(),
          batch({ id: batchId(2), repositoryId: STOREFRONT.id }),
        ],
      });
      await page.goto(`/issues/batches?repository=${STOREFRONT.id}`);
      await expect(page.locator(`[data-batch-id="${batchId(2)}"]`))
        .toBeVisible();
      await expect(page.locator(`[data-batch-id="${batchId(1)}"]`))
        .toHaveCount(0);
      expect(
        seen.lists.some((q) => q.includes(`repositoryId=${STOREFRONT.id}`)),
      )
        .toBe(true);
    });

    test("an empty list offers Start a batch, a failed one offers Try again, and 26 batches load 25 first", async ({ page }) => {
      await batchesFixture(page, { batches: [] });
      await page.goto("/issues/batches");
      await expect(page.getByText("No batches yet")).toBeVisible();
      await expect(page.getByRole("button", { name: "Start a batch" }).first())
        .toBeVisible();
      await still(page, "batches-empty");

      const failing = await page.context().newPage();
      await batchesFixture(failing, { listFails: 500 });
      await failing.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await failing.goto("/issues/batches");
      await expect(failing.getByText("Batches could not be loaded."))
        .toBeVisible();
      await expect(failing.getByRole("button", { name: "Try again" }))
        .toBeVisible();
      await failing.close();
    });

    test("more than a page of batches shows the newest 25 and loads the rest on request", async ({ page }) => {
      const many = Array.from(
        { length: 26 },
        (_, index) => batch({ id: batchId(100 + index), state: "finished" }),
      );
      await batchesFixture(page, { batches: many });
      await page.goto("/issues/batches");
      await expect(page.getByText("Showing the newest 25")).toBeVisible();
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(page.getByText("26 batches · newest first")).toBeVisible();
      await expect(page.getByRole("button", { name: "Load more" }))
        .toHaveCount(0);
    });

    test("a repository beyond the first page of issue sources can still be picked and is named", async ({ page }) => {
      // 132 repositories take issues: the last is on the second page of sources.
      const last = extraRepositoryId(129);
      await batchesFixture(page, {
        extraRepositories: 130,
        batches: [
          batch({ id: batchId(1), repositoryId: last, state: "finished" }),
        ],
      });
      await page.goto("/issues/batches");
      await expect(page.locator(`[data-batch-id="${batchId(1)}"]`))
        .toContainText("acme/extra-129");
      await page.goto(`/issues/batches/new?repository=${last}`);
      await expect(page.getByRole("combobox")).toHaveValue(last);
      await expect(page.getByRole("option", { name: "acme/extra-129" }))
        .toHaveCount(1);
    });

    test("a person who may only read sees the list without Start a batch", async ({ page }) => {
      await batchesFixture(page, { canControl: false });
      await page.goto("/issues/batches");
      await expect(page.locator(`[data-batch-id="${batchId(1)}"]`))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Start a batch" }))
        .toHaveCount(0);
    });

    test("the Issues page links to Batches for someone who may read them", async ({ page }) => {
      await batchesFixture(page);
      await page.goto("/issues");
      await page.getByRole("button", { name: "Batches" }).click();
      await expect(page).toHaveURL(/\/issues\/batches$/);
    });

    test("the start page begins with five issues, eight hours, no spend and no choice, and the summary follows the fields", async ({ page }) => {
      await batchesFixture(page);
      await page.goto(`/issues/batches/new?repository=${WEB.id}`);
      await expect(
        page.getByRole("heading", { name: "Start a batch", level: 1 }),
      )
        .toBeVisible();
      await expect(page.getByRole("combobox"))
        .toHaveValue(WEB.id);
      await expect(page.getByLabel("Issues merged")).toHaveValue("5");
      await expect(page.getByLabel("Time")).toHaveValue("8");
      await expect(page.getByLabel("Spend")).toHaveValue("");
      await expect(page.getByRole("radio", { name: "Carry on by itself" }))
        .not.toBeChecked();
      await expect(page.getByRole("radio", { name: "Ask me first" }))
        .not.toBeChecked();
      const plan = page.getByTestId("batch-plan");
      await expect(plan).toContainText("or once … is spent");
      await expect(plan).toContainText("… after each merge");
      await page.getByLabel("Spend").fill("40");
      await page.getByRole("radio", { name: "Carry on by itself" }).check();
      await expect(plan).toContainText("or once $40 is spent");
      await expect(plan).toContainText("Carry on by itself after each merge.");
      await expect(plan).toContainText("5 are merged");
      await still(page, "batch-new");
    });

    test("the start page lists the issues a batch would take, the smallest spend and a summary that names the first", async ({ page }) => {
      const { seen } = await batchesFixture(page);
      await page.goto(`/issues/batches/new?repository=${WEB.id}`);
      const list = page.getByTestId("batch-startable");
      await expect(list.getByText("It would start with")).toBeVisible();
      await expect(list.getByRole("listitem")).toHaveCount(5);
      await expect(list.getByRole("listitem").first()).toContainText(
        /^1\.\s*#409 Retry the address lookup when it times out$/,
      );
      await expect(list).toContainText(
        "Checked 12 minutes ago: Bakery reads GitHub again before each issue, so the order can change.",
      );
      await expect(
        page.getByText("From $12.50, up to $4,000", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("$12.50 is the least that starts one issue."),
      ).toBeVisible();
      // One row: the three limits share a line on a wide screen.
      if (viewport.width >= 1280) {
        const tops = await Promise.all(
          ["Issues merged", "Time", "Spend"].map(async (label) =>
            (await page.getByLabel(label).boundingBox())!.y
          ),
        );
        expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(4);
      }
      await expect(page.getByTestId("batch-plan")).toContainText(
        "one at a time, starting with #409.",
      );
      expect(seen.startable).toHaveLength(1);
      expect(seen.startable[0]).toContain(`repositoryId=${WEB.id}`);
      expect(seen.startable[0]).toContain("limit=5");
      await still(page, "batch-new-startable");
      await list.getByRole("link", { name: /#409/ }).click();
      await expect(page).toHaveURL(new RegExp(`/issues/${uuid(409)}$`));
    });

    test("more than five startable issues show five and say more can start", async ({ page }) => {
      await batchesFixture(page, {
        startable: { numbers: [401, 402, 403, 404, 405, 406, 407] },
      });
      await page.goto(`/issues/batches/new?repository=${WEB.id}`);
      const list = page.getByTestId("batch-startable");
      await expect(list.getByRole("listitem")).toHaveCount(5);
      await expect(list).toContainText("More can start after these.");
      await expect(list.getByRole("listitem").last()).toContainText("#405");
    });

    test("with nothing startable the list is a warning, the summary names no issue, and Start batch stays enabled", async ({ page }) => {
      await batchesFixture(page, { startable: { numbers: [] } });
      await page.goto(`/issues/batches/new?repository=${WEB.id}`);
      const nothing = page.getByTestId("batch-startable-nothing");
      await expect(nothing).toContainText(
        "Nothing in acme/web can start right now",
      );
      await expect(nothing).toContainText(
        "A batch started now would end at once unless an issue becomes ready first.",
      );
      await expect(page.getByTestId("batch-startable")).toHaveCount(0);
      await expect(page.getByTestId("batch-plan")).not.toContainText(
        "starting with",
      );
      await expect(page.getByRole("button", { name: "Start batch" }))
        .toBeEnabled();
      await still(page, "batch-new-nothing");
      await nothing.getByRole("link", {
        name: "See the issues in acme/web",
      }).click();
      await expect(page).toHaveURL(/\/issues$/);
    });

    test("a repository that cannot run work says so under the select and keeps the plain spend hint", async ({ page }) => {
      await batchesFixture(page, { startable: { smallestSpendUsd: null } });
      await page.goto(`/issues/batches/new?repository=${WEB.id}`);
      await expect(page.getByText("Work cannot start in acme/web right now"))
        .toBeVisible();
      await expect(
        page.getByText("A batch started now would pause until that is fixed."),
      ).toBeVisible();
      await expect(page.getByText("Up to $4,000", { exact: true }))
        .toBeVisible();
      await page.getByRole("link", { name: "Open Issue settings" }).click();
      await expect(page).toHaveURL(/\/issues\/settings$/);
    });

    test("a spend below the smallest is named under Spend and nothing is sent", async ({ page }) => {
      const { seen } = await batchesFixture(page);
      await page.goto(`/issues/batches/new?repository=${WEB.id}`);
      await expect(page.getByTestId("batch-startable")).toBeVisible();
      await page.getByLabel("Spend").fill("10");
      await page.getByRole("radio", { name: "Carry on by itself" }).check();
      await page.getByRole("button", { name: "Start batch" }).click();
      await expect(
        page.getByText(
          "Use at least $12.50. That is the least that starts one issue.",
        ),
      ).toBeVisible();
      expect(seen.created).toEqual([]);
      await page.getByLabel("Spend").fill("12.50");
      await page.getByRole("button", { name: "Start batch" }).click();
      await expect(page).toHaveURL(/\/issues\/batches\/[0-9a-f-]{36}$/);
      expect(seen.created).toHaveLength(1);
    });

    test("an amount the server refuses as too low is named under Spend", async ({ page }) => {
      await batchesFixture(page, {
        create: "spendLow",
        startable: { smallestSpendUsd: null, smallestAfterRefusal: "12.5000" },
      });
      await page.goto(`/issues/batches/new?repository=${WEB.id}`);
      await page.getByLabel("Spend").fill("1");
      await page.getByRole("radio", { name: "Carry on by itself" }).check();
      await page.getByRole("button", { name: "Start batch" }).click();
      await expect(
        page.getByText(
          "Use at least $12.50. That is the least that starts one issue.",
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("alert").filter({
          hasText: "The batch could not be started",
        }),
      ).toHaveCount(0);
    });

    test("when the list cannot be read the form still works and Try again reads it again", async ({ page }) => {
      const { seen } = await batchesFixture(page, {
        startable: { failsOnce: 500 },
      });
      await page.goto(`/issues/batches/new?repository=${WEB.id}`);
      await expect(page.getByTestId("batch-startable-failed")).toContainText(
        "The issues that can start could not be loaded.",
      );
      await page.getByLabel("Spend").fill("40");
      await expect(page.getByLabel("Spend")).toHaveValue("40");
      await page.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByTestId("batch-startable").getByRole("listitem"))
        .toHaveCount(5);
      expect(seen.startable).toHaveLength(2);
    });

    test("Start batch names each problem under its field and sends nothing until the form is right", async ({ page }) => {
      const { seen } = await batchesFixture(page);
      await page.goto("/issues/batches/new");
      await page.getByLabel("Issues merged").fill("21");
      await page.getByLabel("Time").fill("0");
      await page.getByRole("button", { name: "Start batch" }).click();
      await expect(page.getByText("Choose a repository.")).toBeVisible();
      await expect(page.getByText("Use a number from 1 to 20.")).toBeVisible();
      await expect(page.getByText("Use 1 to 24 hours.")).toBeVisible();
      await expect(page.getByText("Use an amount above 0, up to $4,000."))
        .toBeVisible();
      await expect(page.getByText("Choose what happens after each issue."))
        .toBeVisible();
      expect(seen.created).toEqual([]);
      await still(page, "batch-new-errors");
    });

    test("starting a batch sends the limits and the choice and opens the new batch's page", async ({ page }) => {
      const { seen } = await batchesFixture(page);
      await page.goto("/issues/batches/new");
      await page.getByRole("combobox").selectOption(
        STOREFRONT.id,
      );
      await page.getByLabel("Spend").fill("$40");
      await page.getByRole("radio", { name: "Ask me first" }).check();
      await page.getByRole("button", { name: "Start batch" }).click();
      await expect(page).toHaveURL(/\/issues\/batches\/[0-9a-f-]{36}$/);
      expect(seen.created).toEqual([{
        repositoryId: STOREFRONT.id,
        maxIssues: 5,
        maxHours: 8,
        maxSpendUsd: "40.00",
        continueMode: "ask_first",
      }]);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        "Batch in acme/storefront",
      );
    });

    test("a repository with a batch already running says so and opens it", async ({ page }) => {
      await batchesFixture(page, { create: "alreadyRunning" });
      await page.goto(`/issues/batches/new?repository=${WEB.id}`);
      await page.getByLabel("Spend").fill("40");
      await page.getByRole("radio", { name: "Carry on by itself" }).check();
      await page.getByRole("button", { name: "Start batch" }).click();
      await expect(page.getByText("A batch is already running in acme/web."))
        .toBeVisible();
      await page.getByRole("button", { name: "Open it" }).click();
      await expect(page).toHaveURL(
        new RegExp(`/issues/batches/${batchId(1)}$`),
      );
    });

    for (
      const [create, name, text] of [
        [
          "notTaking",
          "stopped taking issues",
          "acme/web is not taking issues. Turn that on in Issue settings.",
        ],
        [
          "notFound",
          "is gone",
          "That repository is no longer available. Choose another.",
        ],
      ] as const
    ) {
      test(`a repository that ${name} is named under the Repository field`, async ({ page }) => {
        await batchesFixture(page, { create });
        await page.goto(`/issues/batches/new?repository=${WEB.id}`);
        await page.getByLabel("Spend").fill("40");
        await page.getByRole("radio", { name: "Carry on by itself" }).check();
        await page.getByRole("button", { name: "Start batch" }).click();
        await expect(page.getByText(text)).toBeVisible();
      });
    }

    test("leaving the start page with changes asks first, and Keep editing stays", async ({ page }) => {
      await batchesFixture(page);
      await page.goto("/issues/batches/new");
      await page.getByLabel("Spend").fill("40");
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("alertdialog")).toContainText(
        "Leave without starting?",
      );
      await page.getByRole("button", { name: "Keep editing" }).click();
      await expect(page).toHaveURL(/\/issues\/batches\/new$/);
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Leave" }).click();
      await expect(page).toHaveURL(/\/issues\/batches$/);
    });

    test("a running batch names the issue, its place and the three meters, with the issues in a table", async ({ page }) => {
      await batchesFixture(page);
      await page.goto(`/issues/batches/${batchId(1)}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        "Batch in acme/web",
      );
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        "Running",
      );
      await expect(page.getByText(/^Started by Ana Reyes/)).toBeVisible();
      await expect(banner(page)).toContainText(
        "Working on #421, the 4th of up to 5",
      );
      await expect(banner(page).getByRole("button", { name: "Open task" }))
        .toBeVisible();
      // The page never reads the task's stage, so it does not say there is nothing to do.
      await expect(banner(page)).toContainText(
        "Bakery is working on it. Open the task to see where it is.",
      );
      if (viewport.width <= 743) {
        // On a phone the banner's buttons are the full width of the banner.
        const box = await banner(page).boundingBox();
        const button = await banner(page).getByRole("button", {
          name: "Open task",
        }).boundingBox();
        expect(button!.width).toBeGreaterThan(box!.width * 0.8);
      }
      const issues = page.getByTestId("batch-meter-issues");
      await expect(issues.getByRole("meter", { name: "Issues merged" }))
        .toHaveAttribute("aria-valuetext", "3 of 5");
      await expect(page.getByTestId("batch-meter-time").getByRole("meter"))
        .toHaveAttribute("aria-valuetext", "3 h 41 min of 8 h");
      await expect(page.getByTestId("batch-meter-spend").getByRole("meter"))
        .toHaveAttribute("aria-valuetext", "$22.40 of $40");
      await expect(page.getByText("3 merged · 1 passed over")).toBeVisible();
      await expect(page.getByText("Cart total ignores the gift-card balance"))
        .toBeVisible();
      await expect(page.getByText("Depends on #470, which is still open."))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
      await still(page, "batch-running");
    });

    test("Pause acts at once and the page shows who paused it, with Resume", async ({ page }) => {
      const { seen } = await batchesFixture(page);
      await page.goto(`/issues/batches/${batchId(1)}`);
      await page.getByRole("button", { name: "Pause" }).click();
      await expect(banner(page)).toContainText("Paused by Fixture Admin");
      await expect(banner(page)).toContainText(
        "Nothing new starts. #421 is still running and will finish.",
      );
      expect(seen.actions.map((a) => a.action)).toEqual(["pause"]);
      await banner(page).getByRole("button", { name: "Resume" }).click();
      await expect(banner(page)).toContainText("Working on #421");
      expect(seen.actions.map((a) => a.action)).toEqual(["pause", "resume"]);
    });

    test("Stop offers stopping after the issue or cancelling it, and sends the choice made", async ({ page }) => {
      const { seen } = await batchesFixture(page);
      await page.goto(`/issues/batches/${batchId(1)}`);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Stop this batch?");
      await expect(dialog).toContainText("A stopped batch cannot be resumed.");
      await expect(dialog.getByRole("radio", { name: "Stop after #421" }))
        .toBeChecked();
      await still(page, "batch-stop");
      await dialog.getByRole("button", { name: "Stop batch" }).click();
      await expect(banner(page)).toContainText("Stopping after #421");
      expect(seen.actions).toMatchObject([{
        action: "stop",
        body: { cancelCurrent: false },
      }]);
      await page.getByRole("button", { name: "Cancel #421 now" }).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Cancel #421",
        exact: true,
      }).click();
      await expect(banner(page)).toContainText("Cancelling #421");
      expect(seen.actions[1]).toMatchObject({
        action: "stop",
        body: { cancelCurrent: true },
      });
    });

    test("a batch waiting for a yes offers Finish here and Start the next issue", async ({ page }) => {
      const { seen } = await batchesFixture(page, {
        batches: [batch({
          id: batchId(1),
          state: "waiting",
          continueMode: "ask_first",
          elapsedSeconds: 3600,
          spentUsd: "14.1500",
          issues: [{
            position: 1,
            number: 412,
            state: "merged",
            costUsd: "7.8500",
          }],
        })],
      });
      await page.goto(`/issues/batches/${batchId(1)}`);
      await expect(banner(page)).toContainText(
        "#412 is merged. Start the next issue?",
      );
      await expect(page.getByText(/asks before each next issue/)).toBeVisible();
      // Both banner buttons keep one line: a wrapped label makes one taller than the other.
      const finish = (await banner(page).getByRole("button", {
        name: "Finish here",
      }).boundingBox())!;
      const next = (await banner(page).getByRole("button", {
        name: "Start the next issue",
      }).boundingBox())!;
      expect(Math.abs(next.height - finish.height)).toBeLessThanOrEqual(1);
      await still(page, "batch-waiting");
      await banner(page).getByRole("button", { name: "Start the next issue" })
        .click();
      await expect(banner(page)).toContainText("Choosing the next issue");
      expect(seen.actions.map((a) => a.action)).toEqual(["start-next"]);
    });

    test("a finished batch over its spend limit says so, shows the bar full and offers another batch", async ({ page }) => {
      await batchesFixture(page, {
        batches: [batch({
          id: batchId(1),
          state: "finished",
          finishReason: "spend_exhausted",
          finishedAt: "2026-11-20T15:00:00.000Z",
          issuesDone: 3,
          elapsedSeconds: 5 * 3600,
          spentUsd: "43.5000",
          issues: [
            { position: 1, number: 412, state: "merged", costUsd: "20.0000" },
            { position: 2, number: 415, state: "merged", costUsd: "10.0000" },
            { position: 3, number: 409, state: "merged", costUsd: "13.5000" },
          ],
        })],
      });
      await page.goto(`/issues/batches/${batchId(1)}`);
      await expect(banner(page)).toContainText(
        "Finished: it reached the spend limit",
      );
      await expect(banner(page)).toContainText(
        "The batch spent $43.50 of $40.",
      );
      await expect(page.getByTestId("batch-meter-spend").getByRole("meter"))
        .toHaveAttribute("aria-valuetext", "$43.50 of $40 · $3.50 over");
      await expect(
        banner(page).getByRole("button", { name: "Start another batch" }),
      )
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
      await still(page, "batch-finished");
    });

    test("a refused action because someone changed the batch says so and reads it again", async ({ page }) => {
      const { seen } = await batchesFixture(page, { conflictOnce: true });
      await page.goto(`/issues/batches/${batchId(1)}`);
      const before = seen.gets;
      await page.getByRole("button", { name: "Pause" }).click();
      await expect(page.getByText("Someone already changed this batch."))
        .toBeVisible();
      await expect.poll(() => seen.gets).toBeGreaterThan(before);
    });

    test("a batch that does not exist shows the not-found banner, and a person who may only read has no buttons", async ({ page }) => {
      await batchesFixture(page, { canControl: false });
      await page.goto(`/issues/batches/${batchId(999)}`);
      await expect(page.getByText(/This batch was not found/)).toBeVisible();
      await page.goto(`/issues/batches/${batchId(1)}`);
      await expect(banner(page)).toContainText("Working on #421");
      await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    });
  });
}

test.describe("tablet: batch start", () => {
  test.use({ viewport: { width: 1100, height: 900 } });

  test("between 744px and 1279px the start form is one column no wider than 620px, and the buttons end at its edge", async ({ page }) => {
    await batchesFixture(page);
    await page.goto(`/issues/batches/new?repository=${WEB.id}`);
    const layout = page.locator('[data-ui-component="formWithSummary"]');
    await expect(layout).toBeVisible();
    const box = (await layout.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(620.5);
    const start = (await page.getByRole("button", { name: "Start batch" })
      .boundingBox())!;
    const edge = box.x + box.width;
    expect(start.x + start.width).toBeLessThanOrEqual(edge + 0.5);
    expect(start.x + start.width).toBeGreaterThan(edge - 24);
    await still(page, "batch-new-tablet");
  });
});
