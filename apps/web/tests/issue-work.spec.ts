import { expect, type Page, test } from "@playwright/test";
import {
  issuesFixture,
  type Options,
  ready,
  type Seed,
  uuid,
  type WorkSeed,
} from "./helpers/issues-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

/**
 * #69 web (design-ux): "Bakery's work" on the issue page: how far the work has
 * got, where it went, its pull requests and Bakery's note on GitHub; and the
 * banner a paused issue earns.
 */

const ISSUE: Seed = {
  number: 201,
  title: "Add invoice export",
  verdict: "ready",
  checks: ready,
  body: "Customers want to download their invoices as one CSV file.",
  links: { parent: null, subIssuesTotal: 0, blockedBy: [], blockingTotal: 0 },
};

const ONE_REPOSITORY: WorkSeed = {
  issue: 201,
  progress: "active",
  targets: [{
    role: "api",
    repository: "api",
    pulls: [{ number: 214, status: "open" }],
  }],
};

const TWO_REPOSITORIES: WorkSeed = {
  issue: 201,
  progress: "active",
  targets: [
    {
      role: "api",
      repository: "api",
      status: "active",
      pulls: [{ number: 214, status: "open" }],
    },
    {
      role: "web",
      repository: "web",
      status: "completed",
      pulls: [{ number: 88, status: "merged" }],
    },
  ],
  mentioned: [{ title: "Tidy the auth module", status: "completed" }],
};

/** The live request the issue itself carries while this work is under way. */
const requestOf = (work: WorkSeed | undefined): Seed["request"] => {
  if (work === undefined) return undefined;
  if (work.progress === "active" || work.progress === "admitted") {
    return { disposition: "active" };
  }
  if (
    work.progress === "suspended" || work.progress === "pending" ||
    work.progress === "waiting"
  ) return { disposition: work.progress };
  return undefined;
};

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: Bakery's work`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    const open = async (
      page: Page,
      work: WorkSeed | undefined,
      more: Options = {},
    ) => {
      const seen = await issuesFixture(page, {
        open: [{ ...ISSUE, request: requestOf(work) }],
        work,
        ...more,
      });
      await page.goto(`/issues/${uuid(ISSUE.number)}`);
      await expect(
        page.getByRole("heading", {
          name: "#201 Add invoice export",
          level: 1,
        }),
      ).toBeVisible();
      return seen;
    };
    const section = (page: Page) =>
      page.getByRole("region", { name: "Bakery's work" });

    test("an issue with no work shows no section", async ({ page }) => {
      await open(page, undefined);
      await expect(page.getByRole("button", { name: "Start work" }))
        .toBeVisible();
      await expect(section(page)).toHaveCount(0);
    });

    test("one repository: the state, who started it, the pull request and the note", async ({ page }) => {
      await open(page, ONE_REPOSITORY);
      const work = section(page);
      await expect(work.getByText("Working", { exact: true })).toBeVisible();
      // Who started it, the workflow it is pinned to, and when.
      await expect(
        work.getByText(
          "started by you · Fixed coding, version 1 · 12 minutes ago",
        ),
      ).toBeVisible();
      await expect(work.getByRole("link", { name: "Fix the login redirect" }))
        .toHaveAttribute("href", `/tasks/${uuid(8100)}`);
      await expect(work.getByRole("button", { name: "Open task" }))
        .toBeVisible();
      await expect(
        work.getByRole("link", { name: "Open pull request #214 on GitHub" }),
      ).toHaveAttribute("href", "https://github.com/acme/api/pull/214");
      await expect(work.getByText("Open", { exact: true })).toBeVisible();
      await expect(work.getByText("Bakery's note on GitHub: Up to date"))
        .toBeVisible();
      await expect(work.getByRole("link", { name: "View on GitHub" }))
        .toHaveAttribute("href", "https://github.com/acme/web/issues/201");
      await page.mouse.move(700, 700);
      await still(page, "issue-work-one-repository");
    });

    test("already working: Start work on an issue somebody just started says so", async ({ page }) => {
      await open(page, undefined, {
        start: "alreadyRunning",
        workWhenRunning: ONE_REPOSITORY,
      });
      await page.getByRole("button", { name: "Start work" }).first().click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Start work",
      }).click();
      await expect(page.getByText("In progress", { exact: true }).first())
        .toBeVisible();
      // The work is read again, so the way to the task is there, not a dead end.
      await expect(section(page).getByRole("button", { name: "Open task" }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Start work" }))
        .toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "issue-work-already-working");
    });

    test("two repositories: a line each with its state and pull requests", async ({ page }) => {
      await open(page, TWO_REPOSITORIES);
      const work = section(page);
      await expect(work.getByText("acme/api")).toBeVisible();
      await expect(work.getByText("acme/web")).toBeVisible();
      // The finished repository and the finished task that only mentions it.
      await expect(work.getByText("Done", { exact: true })).toHaveCount(2);
      await expect(work.getByText("Merged", { exact: true })).toBeVisible();
      await expect(
        work.getByRole("link", { name: "Open pull request #88 on GitHub" }),
      ).toBeVisible();
      await expect(work.getByText("Also mentioned by")).toBeVisible();
      await expect(work.getByText("Tidy the auth module")).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "issue-work-two-repositories");
    });

    test("a note that could not update says why and Try again updates it", async ({ page }) => {
      const seen = await open(page, {
        ...ONE_REPOSITORY,
        note: { health: "failed", problem: "provider_forbidden" },
      });
      const work = section(page);
      await expect(work.getByText(
        "Bakery's note on GitHub: Could not update. Bakery is not allowed to comment on this issue.",
      )).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "issue-work-note-failed");
      await work.getByRole("button", { name: "Try again" }).click();
      await expect(work.getByText("Bakery's note on GitHub: Up to date"))
        .toBeVisible();
      expect(seen.resyncs).toBe(1);
    });

    test("a note nobody posted yet offers Post now; a developer may, nobody below may not", async ({ page }) => {
      await open(page, { ...ONE_REPOSITORY, note: { health: "unknown" } }, {
        role: "developer",
      });
      await expect(
        section(page).getByText("Bakery's note on GitHub: Not posted yet"),
      ).toBeVisible();
      await expect(section(page).getByRole("button", { name: "Post now" }))
        .toBeVisible();
    });

    test("each state says its words and its one next step", async ({ page }) => {
      await open(page, {
        issue: 201,
        progress: "waiting",
        reason: "predecessor_open",
      });
      const work = section(page);
      await expect(work.getByText("Waiting", { exact: true })).toBeVisible();
      // It starts by itself: nothing to press.
      await expect(work.getByRole("button", { name: "Open task" }))
        .toHaveCount(0);
      await expect(work.getByRole("button", { name: "Start work" }))
        .toHaveCount(0);
    });

    test("a stopped start is started again from the status card, not the row", async ({ page }) => {
      await open(page, { issue: 201, progress: "canceled" });
      await expect(section(page).getByText("Stopped", { exact: true }))
        .toBeVisible();
      // One Start work on the page, and it is the card's.
      await expect(section(page).getByRole("button", { name: "Start work" }))
        .toHaveCount(0);
      await expect(page.getByRole("button", { name: "Start work" }))
        .toHaveCount(1);
    });

    test("a stopped start names who stopped it; a run canceled without a person names nobody", async ({ page }) => {
      await open(page, {
        issue: 201,
        progress: "canceled",
        stoppedBy: "Ana Reyes",
      });
      await expect(section(page).getByText("Stopped", { exact: true }))
        .toBeVisible();
      await expect(
        section(page).getByText(
          "started by you · Fixed coding, version 1 · 12 minutes ago · stopped by Ana Reyes",
        ),
      ).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "issue-work-stopped-by");
    });

    test("the person who stopped it is told it was them", async ({ page }) => {
      await open(page, {
        issue: 201,
        progress: "canceled",
        stoppedBy: "Fixture Admin",
        stoppedByMe: true,
      });
      await expect(
        section(page).getByText(
          "started by you · Fixed coding, version 1 · 12 minutes ago · stopped by you",
        ),
      ).toBeVisible();
    });

    test("a run canceled without a person says Stopped and no name", async ({ page }) => {
      await open(page, { issue: 201, progress: "canceled" });
      await expect(section(page).getByText("Stopped", { exact: true }))
        .toBeVisible();
      await expect(section(page).getByText(/stopped by/)).toHaveCount(0);
    });

    test("the workflow a request runs is named with its version, as pinned", async ({ page }) => {
      await open(page, {
        ...ONE_REPOSITORY,
        preset: { id: "fixed-coding-reviewed", revision: 2 },
      });
      await expect(
        section(page).getByText(
          "started by you · Coding with independent review, version 2 · 12 minutes ago",
        ),
      ).toBeVisible();
    });

    test("work started by a label names the label, not a person", async ({ page }) => {
      await open(page, {
        ...ONE_REPOSITORY,
        origin: "webhook",
        triggerLabel: "ready for agent",
      });
      await expect(
        section(page).getByText(
          /started from the "ready for agent" label on GitHub/,
        ),
      ).toBeVisible();
    });

    test("work started by another member names them", async ({ page }) => {
      await open(page, { ...ONE_REPOSITORY, byMe: false });
      await expect(section(page).getByText(/started by Ana Reyes · /))
        .toBeVisible();
    });

    test("work started by somebody the member list does not show says a teammate", async ({ page }) => {
      await open(page, { ...ONE_REPOSITORY, byMe: "unlisted" });
      await expect(section(page).getByText(/started by a teammate · /))
        .toBeVisible();
    });

    test("an issue edited after set-up is paused with a banner and Start again", async ({ page }) => {
      await open(page, {
        issue: 201,
        progress: "suspended",
        pausedReason: "edited_after_setup",
      });
      await expect(page.getByText(
        "The issue was edited on GitHub after work was set up. Bakery paused so it does not build the old version.",
      )).toBeVisible();
      await expect(page.getByRole("link", { name: "Review on GitHub" }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Start again" }))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "issue-work-edited-after-setup");
    });

    test("a removed label and a hold label pause with an information banner", async ({ page }) => {
      await open(page, {
        issue: 201,
        progress: "suspended",
        pausedReason: "label_removed",
        triggerLabel: "ready for agent",
      });
      await expect(page.getByText(
        'Paused: the "ready for agent" label was removed. Work continues when it is back.',
      )).toBeVisible();
      await expect(page.getByRole("button", { name: "Start again" }))
        .toHaveCount(0);
    });

    test("an open question is the first row, with one way to answer it", async ({ page }) => {
      await open(page, {
        ...ONE_REPOSITORY,
        questions: [{
          status: "open",
          prompt:
            "Which database should the invoice export read from?\nThe reporting replica or the primary?\nThird line is not shown.",
        }],
      });
      const row = page.getByTestId("issue-question");
      await expect(row.getByText("Bakery needs an answer")).toBeVisible();
      await expect(
        row.getByText("Which database should the invoice export read from?"),
      )
        .toBeVisible();
      await expect(row.getByText("The reporting replica or the primary?"))
        .toBeVisible();
      await expect(row.getByText("Third line is not shown.")).toHaveCount(0);
      await expect(
        row.getByText(
          "Asked 25 minutes ago · work is paused until someone answers",
        ),
      )
        .toBeVisible();
      // The badge agrees with the row: the work waits on an answer.
      await expect(section(page).getByText("Needs an answer", { exact: true }))
        .toBeVisible();
      await expect(section(page).getByText("Working", { exact: true }))
        .toHaveCount(0);
      // Answer is the one next step: primary, beside the text on a desktop and
      // under it, the row's width and at least 44 high, on a phone.
      const answer = row.getByRole("button", { name: "Answer" });
      await expect(answer).toHaveClass(/ui-button--primary/);
      const box = (await answer.boundingBox())!;
      const rowBox = (await row.boundingBox())!;
      const asked = (await row.getByText(/^Asked /).boundingBox())!;
      if (viewport.width < 744) {
        expect(box.y).toBeGreaterThanOrEqual(asked.y + asked.height - 1);
        // The 44 high touch size comes with a touch device, the mobile project.
        if (test.info().project.name === "mobile") {
          expect(box.height).toBeGreaterThanOrEqual(44);
        }
        expect(box.width).toBeGreaterThan(rowBox.width * 0.6);
      } else {
        expect(box.x).toBeGreaterThan(rowBox.x + rowBox.width * 0.7);
      }
      // The first thing in the section, above how the work is going.
      await expect(section(page).locator("> *").nth(1)).toHaveAttribute(
        "data-testid",
        "issue-question",
      );
      await page.mouse.move(700, 700);
      await still(page, "issue-work-question");
      await row.getByRole("button", { name: "Answer" }).click();
      await expect(page).toHaveURL(new RegExp(`/tasks/${uuid(8100)}`));
    });

    test("several open questions are counted and the oldest is shown", async ({ page }) => {
      await open(page, {
        ...ONE_REPOSITORY,
        questions: [
          { status: "open", prompt: "Newest question", minutesAgo: 5 },
          { status: "open", prompt: "Oldest question", minutesAgo: 90 },
        ],
      });
      const row = page.getByTestId("issue-question");
      await expect(row.getByText("Bakery needs 2 answers")).toBeVisible();
      await expect(row.getByText("Oldest question")).toBeVisible();
      await expect(row.getByText("Newest question")).toHaveCount(0);
    });

    test("more than a page of open questions are all counted and the oldest is shown", async ({ page }) => {
      // 130 open ones: a read of the newest page (25, or even 100) would miss
      // the oldest and count too few. The expired one is older still.
      await open(page, {
        ...ONE_REPOSITORY,
        questions: [
          ...Array.from({ length: 130 }, (_, index) => ({
            status: "open" as const,
            prompt: `Question number ${index}`,
            minutesAgo: 10 + index,
          })),
          { status: "expired", prompt: "An old one", minutesAgo: 5000 },
        ],
      });
      const row = page.getByTestId("issue-question");
      await expect(row.getByText("Bakery needs 130 answers")).toBeVisible();
      // The oldest open one is number 129, asked 139 minutes ago.
      await expect(row.getByText("Question number 129")).toBeVisible();
      await expect(row.getByText("Question number 0", { exact: true }))
        .toHaveCount(0);
      await expect(row.getByText(/^Asked 2 hours ago/)).toBeVisible();
    });

    test("someone who may not answer sees the question without the button", async ({ page }) => {
      await open(page, {
        ...ONE_REPOSITORY,
        questions: [{ status: "open", prompt: "Which database?" }],
      }, { role: "viewer" });
      const row = page.getByTestId("issue-question");
      await expect(row.getByText("Bakery needs an answer")).toBeVisible();
      await expect(
        row.getByText("Someone who can work on this task needs to answer."),
      )
        .toBeVisible();
      await expect(row.getByRole("button", { name: "Answer" })).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "issue-work-question-not-allowed");
    });

    test("an expired question says so and opens the task; an answered one shows nothing", async ({ page }) => {
      await open(page, {
        ...ONE_REPOSITORY,
        questions: [{ status: "expired", prompt: "Which database?" }],
      });
      await expect(
        section(page).getByText("A question went unanswered and expired."),
      )
        .toBeVisible();
      await expect(page.getByTestId("issue-question")).toHaveCount(0);
      // One way to the task, not two: the line below carries it.
      await expect(section(page).getByRole("button", { name: "Open task" }))
        .toHaveCount(1);
      await page.mouse.move(700, 700);
      await still(page, "issue-work-question-expired");
    });

    test("an answered question and an approval show no row", async ({ page }) => {
      await open(page, {
        ...ONE_REPOSITORY,
        questions: [
          { status: "answered", prompt: "Which database?" },
          { status: "open", prompt: "Approve the plan?", kind: "approval" },
        ],
      });
      await expect(section(page).getByText("Working", { exact: true }))
        .toBeVisible();
      await expect(page.getByTestId("issue-question")).toHaveCount(0);
      await expect(
        section(page).getByText("A question went unanswered and expired."),
      )
        .toHaveCount(0);
    });

    test("questions that cannot be loaded say so and Try again reads them", async ({ page }) => {
      await open(page, { ...ONE_REPOSITORY, questionsFail: true });
      await expect(
        section(page).getByText("Bakery's questions could not be loaded."),
      )
        .toBeVisible();
      await expect(section(page).getByRole("button", { name: "Try again" }))
        .toBeVisible();
    });

    const WITH_RUN: WorkSeed = { ...ONE_REPOSITORY, run: {} };
    const stopButton = (page: Page) =>
      section(page).getByRole("button", { name: "Stop work" });

    test("Stop work asks first; Keep working sends nothing", async ({ page }) => {
      const seen = await open(page, WITH_RUN);
      await expect(stopButton(page)).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "issue-work-stop-row");
      await stopButton(page).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog.getByRole("heading", { name: "Stop work on #201?" }))
        .toBeVisible();
      await expect(
        dialog.getByText(
          "Bakery stops at the next safe point. The task, its plan and any pull request stay as they are, and nothing is deleted on GitHub. To work on this issue again, press Start work; that begins a new task.",
        ),
      ).toBeVisible();
      await still(page, "issue-work-stop-dialog");
      await dialog.getByRole("button", { name: "Keep working" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(stopButton(page)).toBeFocused();
      await expect(section(page).getByText("Working", { exact: true }))
        .toBeVisible();
      expect(seen.stops).toHaveLength(0);
    });

    test("Stop work: confirm, Stopping…, then Stopped with Start work", async ({ page }) => {
      const seen = await open(page, WITH_RUN);
      await stopButton(page).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Stop work",
      }).click();
      const work = section(page);
      await expect(work.getByText("Stopping…", { exact: true })).toBeVisible();
      // One cancel, with its own key, and nothing else to press while it stops.
      expect(seen.stops).toHaveLength(1);
      expect(seen.stops[0]!.body).toEqual({ action: "cancel" });
      expect(seen.stops[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
      await expect(stopButton(page)).toHaveCount(0);
      await expect(work.getByRole("button", { name: "Open task" }))
        .toHaveCount(0);
      await expect(work.getByText("Working", { exact: true })).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "issue-work-stopping");
      // The server reports the run ended; the page reads it again within 5 seconds.
      seen.stopEnded = true;
      await expect(work.getByText("Stopped", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(work.getByText("Stopping…")).toHaveCount(0);
      // Start work is the status card's button, shown once.
      await expect(work.getByRole("button", { name: "Start work" }))
        .toHaveCount(0);
      await expect(page.getByRole("button", { name: "Start work" }))
        .toHaveCount(1);
      await expect(stopButton(page)).toHaveCount(0);
      // The issue's own status card follows the row: nothing still says the
      // work is under way.
      await expect(page.getByText("Bakery is working on this.")).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "issue-work-stopped");
    });

    test("a paused request waits for no five-minute line once the run is stopped", async ({ page }) => {
      await page.clock.install();
      const seen = await open(page, {
        issue: 201,
        progress: "suspended",
        pausedReason: "hold_label_added",
        run: {},
      });
      await stopButton(page).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Stop work",
      }).click();
      const work = section(page);
      await expect(work.getByText("Stopping…", { exact: true })).toBeVisible();
      // Past the old 15 seconds the page still says nothing about a wait: the
      // server reports the finished run for a paused request, so the next read
      // shows Stopped.
      await page.clock.fastForward(16_000);
      await expect(work.getByText(/It can take up to 5 minutes/)).toHaveCount(
        0,
      );
      seen.stopEnded = true;
      await page.clock.fastForward(6_000);
      await expect(work.getByText("Stopped", { exact: true })).toBeVisible();
    });

    test(
      "on a phone Open task and Stop work are one row of equal buttons",
      async ({ page }, testInfo) => {
        test.skip(viewport.name !== "phone", "a phone layout");
        await open(page, WITH_RUN);
        // boundingBox does not wait: Stop work appears once the run's controls
        // are read, so wait for both buttons before measuring them.
        await expect(stopButton(page)).toBeVisible();
        await expect(section(page).getByRole("button", { name: "Open task" }))
          .toBeVisible();
        const open_ = (await section(page).getByRole("button", {
          name: "Open task",
        }).boundingBox())!;
        const stop_ = (await stopButton(page).boundingBox())!;
        expect(Math.abs(open_.y - stop_.y)).toBeLessThan(2);
        expect(Math.abs(open_.width - stop_.width)).toBeLessThan(2);
        // The 44px touch size is the phone project's; a narrow desktop window is not a touch screen.
        if (testInfo.project.name === "mobile") {
          expect(open_.height).toBeGreaterThanOrEqual(44);
          expect(stop_.height).toBeGreaterThanOrEqual(44);
        }
      },
    );

    test("an issue whose number cannot be read asks the question without a number", async ({ page }) => {
      // Number 0 is not a usable issue number, so the page shows no "#".
      await issuesFixture(page, {
        open: [{ ...ISSUE, number: 0, request: { disposition: "active" } }],
        work: { ...WITH_RUN, issue: 0 },
      });
      await page.goto(`/issues/${uuid(0)}`);
      await expect(stopButton(page)).toBeVisible();
      await stopButton(page).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog.getByRole("heading", {
        name: "Stop work on this issue?",
      })).toBeVisible();
      await expect(dialog.getByText(/#/)).toHaveCount(0);
      await still(page, "issue-work-stop-dialog-no-number");
    });

    test("a person who may not stop the run sees no Stop work", async ({ page }) => {
      await open(page, { ...ONE_REPOSITORY, run: { mayStop: false } });
      await expect(section(page).getByRole("button", { name: "Open task" }))
        .toBeVisible();
      await expect(stopButton(page)).toHaveCount(0);
    });

    test("a refused stop says so and leaves the row as it was", async ({ page }) => {
      const seen = await open(page, {
        ...ONE_REPOSITORY,
        run: { stop: "refused" },
      });
      await stopButton(page).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Stop work",
      }).click();
      const work = section(page);
      await expect(work.getByText("Work could not be stopped. Try again."))
        .toBeVisible();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(work.getByText("Working", { exact: true })).toBeVisible();
      await expect(work.getByRole("button", { name: "Open task" }))
        .toBeVisible();
      await expect(stopButton(page)).toBeVisible();
      expect(seen.stops).toHaveLength(0);
      await page.mouse.move(700, 700);
      await still(page, "issue-work-stop-failed");
    });

    test("work started from a label with no run yet says how to stop it on GitHub", async ({ page }) => {
      await open(page, {
        issue: 201,
        progress: "waiting",
        origin: "webhook",
        triggerLabel: "bakery",
        reason: "predecessor_open",
      }, {
        // The issue's own check names the one it depends on, so the sentence has its number.
        open: [{
          ...ISSUE,
          verdict: "waiting",
          checks: [{
            id: "dependencies_satisfied",
            status: "wait",
            reason: "predecessor_open",
            evidence: ["blocker:acme/web#150"],
          }],
          request: { disposition: "waiting" },
        }],
      });
      await expect(
        section(page).getByText(
          "To stop this before it starts, remove the label on GitHub.",
        ),
      ).toBeVisible();
      await expect(stopButton(page)).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "issue-work-label-sentence");
    });

    const NO_RUN: WorkSeed = {
      issue: 201,
      progress: "waiting",
      reason: "predecessor_open",
    };

    test("work a person started with no run yet is stopped by the request, with its version", async ({ page }) => {
      const seen = await open(page, { ...NO_RUN, stoppedBy: "Ana Reyes" }, {
        // The issue's own check names the one it depends on, so the sentence has its number.
        open: [{
          ...ISSUE,
          verdict: "waiting",
          checks: [{
            id: "dependencies_satisfied",
            status: "wait",
            reason: "predecessor_open",
            evidence: ["blocker:acme/web#150"],
          }],
          links: {
            parent: null,
            subIssuesTotal: 0,
            blockedBy: [{
              id: "d",
              repositoryFullName: "acme/web",
              number: 150,
            }],
            blockingTotal: 0,
          },
          request: { disposition: "waiting" },
        }],
      });
      await expect(section(page).getByText("Waiting", { exact: true }))
        .toBeVisible();
      await expect(section(page).getByText(/remove the label on GitHub/))
        .toHaveCount(0);
      // The card names what it waits for once; neither it nor the row says "Depends on".
      await expect(
        page.getByText("Bakery will start this when acme/web#150 is done."),
      ).toHaveCount(1);
      await expect(page.getByText(/Depends on #150/)).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "issue-work-stop-row-no-run");
      await stopButton(page).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Stop work",
      }).click();
      const work = section(page);
      await expect(work.getByText("Stopped", { exact: true })).toBeVisible();
      // The server's answer is accepted: nothing says the stop failed.
      await expect(work.getByText("Work could not be stopped.")).toHaveCount(0);
      // Stopped, the card offers Start when ready and names the dependency once.
      await expect(
        page.getByText(
          "Bakery will start this by itself when acme/web#150 is done.",
        ),
      ).toHaveCount(1);
      await expect(page.getByText(/Depends on #150/)).toHaveCount(0);
      // One cancellation of the request, with its own key and its version; no run was asked.
      expect(seen.cancels).toHaveLength(1);
      expect(seen.cancels[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
      expect(seen.cancels[0]!.ifMatch).toMatch(/1/);
      expect(seen.stops).toHaveLength(0);
      await expect(
        work.getByText(/started by you · .* · stopped by Ana Reyes$/),
      ).toBeVisible();
      await expect(stopButton(page)).toHaveCount(0);
    });

    test("a row whose reason differs from the card's still says its own", async ({ page }) => {
      // The card (a ready issue) gives no reason; the request waits for the label.
      await open(page, {
        issue: 201,
        progress: "waiting",
        reason: "label_missing",
      });
      await expect(section(page).getByText("Waiting", { exact: true }))
        .toBeVisible();
      await expect(section(page).getByText("Missing a required label."))
        .toBeVisible();
    });

    test("a person who may only read cannot stop work that has no run", async ({ page }) => {
      await open(page, NO_RUN, { role: "viewer" });
      await expect(section(page).getByText("Waiting", { exact: true }))
        .toBeVisible();
      await expect(stopButton(page)).toHaveCount(0);
    });

    test("a run that began while the question was open shows the row as it is now, not a failure", async ({ page }) => {
      const seen = await open(page, { ...NO_RUN, cancel: "hasRun" });
      await stopButton(page).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Stop work",
      }).click();
      const work = section(page);
      // The page read the request again: a run exists, so it is Working and the run's Stop is offered.
      await expect(work.getByText("Working", { exact: true })).toBeVisible();
      await expect(work.getByText("Work could not be stopped. Try again."))
        .toHaveCount(0);
      expect(seen.cancels).toHaveLength(1);
      await expect(stopButton(page)).toBeVisible();
      // The run began first, so the stop did not happen, and the page says so.
      await expect(
        work.getByText(
          "This work changed while you were deciding, so it was not stopped. Press Stop work again to stop it.",
        ),
      ).toBeVisible();
    });

    test("work that ended while the question was open is not reported as a failure", async ({ page }) => {
      await open(page, { ...NO_RUN, cancel: "finished" });
      await stopButton(page).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Stop work",
      }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(section(page).getByText("Work could not be stopped."))
        .toHaveCount(0);
      // The ended row says it; no second sentence.
      await expect(
        section(page).getByText(
          "This work changed while you were deciding, so it was not stopped. Press Stop work again to stop it.",
        ),
      ).toHaveCount(0);
    });

    test("a request that changed while the question was open is read again, not reported as a failure", async ({ page }) => {
      const seen = await open(page, { ...NO_RUN, cancel: "stale" });
      await stopButton(page).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Stop work",
      }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(section(page).getByText("Work could not be stopped."))
        .toHaveCount(0);
      expect(seen.cancels).toHaveLength(1);
      // The request changed first: the row reads as before, so the page says the stop did not happen.
      await expect(
        section(page).getByText(
          "This work changed while you were deciding, so it was not stopped. Press Stop work again to stop it.",
        ),
      ).toBeVisible();
      await expect(stopButton(page)).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "issue-work-stop-changed");
      // Pressing Stop work again clears the notice.
      await stopButton(page).click();
      await expect(
        section(page).getByText(
          "This work changed while you were deciding, so it was not stopped. Press Stop work again to stop it.",
        ),
      ).toHaveCount(0);
    });

    test("a stop of a request with no run that fails says so and leaves the row", async ({ page }) => {
      await open(page, { ...NO_RUN, cancel: "failed" });
      await stopButton(page).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Stop work",
      }).click();
      await expect(
        section(page).getByText("Work could not be stopped. Try again."),
      ).toBeVisible();
      await expect(section(page).getByText("Waiting", { exact: true }))
        .toBeVisible();
      await expect(stopButton(page)).toBeVisible();
    });

    test("on hold pauses with an information banner", async ({ page }) => {
      await open(page, {
        issue: 201,
        progress: "suspended",
        pausedReason: "hold_label_added",
      });
      await expect(page.getByText("Paused: on hold.", { exact: true }).first())
        .toBeVisible();
    });
  });
}
