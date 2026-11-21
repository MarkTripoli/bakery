import { expect, type Page, test } from "@playwright/test";
import { batch, type BatchSeed } from "./helpers/batches-fixture.ts";
import { chooseFilter, issuesFixture, uuid } from "./helpers/issues-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * The Issues page and batches (design-ux, #58 slice 2b and its rulings): a
 * batch that is still live in a repository is said under the header, in the
 * wording and tone of its state, and the issues it has taken wear "In the
 * batch". The fixture's repositories are uuid(903) (acme/web) and uuid(913)
 * (acme/api, only with secondSource).
 */

const WEB = uuid(903);
const API = uuid(913);

/** A batch of the fixture's repository, waiting on a person when asked. */
function live(
  seed: BatchSeed,
  waitingOn?: "approval" | "question",
) {
  return {
    ...batch({ repositoryId: WEB, ...seed }),
    waitingOn: waitingOn === undefined ? null : {
      kind: waitingOn,
      questionId: uuid(7100),
      taskId: uuid(7200),
      since: new Date(Date.now() - 12 * 60_000).toISOString(),
      askedOf: [],
    },
  };
}

/** One merged issue (#190, closed on GitHub), then #204 being worked on. */
const AT_WORK: BatchSeed = {
  maxIssues: 5,
  issuesDone: 1,
  issues: [
    { position: 1, number: 190, state: "merged" },
    { position: 2, number: 204, state: "started" },
  ],
};

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: the Issues page and batches`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    const row = (page: Page, number: number) =>
      page.locator(`[data-issue-id="${uuid(number)}"]`);
    const notice = (page: Page) => page.locator("[data-batch-notice]");

    test("a running batch is said under the header, and the issues it has taken wear In the batch", async ({ page }) => {
      await issuesFixture(page, { batches: [live(AT_WORK)] });
      await page.goto("/issues");
      await expect(notice(page)).toHaveText(
        /A batch is running: 1 of 5 merged, working on #204\./,
      );
      await expect(notice(page)).toHaveAttribute("data-variant", "information");
      await chooseFilter(page, "All open");
      // The one being worked on wears it; no other open issue does.
      await expect(row(page, 204)).toContainText("In the batch");
      await expect(row(page, 201)).not.toContainText("In the batch");
      await expect(row(page, 202)).not.toContainText("In the batch");
      await expect(row(page, 203)).not.toContainText("In the batch");
      // The row's own status is still there beside it, and the title link names both.
      await expect(row(page, 204)).toContainText("In progress");
      await expect(
        row(page, 204).getByRole("link", {
          name:
            "#204 Fix rounding on totals, In progress, In the batch, acme/web · Bakery is working on this.",
        }),
      ).toBeVisible();
      // The notice has one way on: the batch's page, named for the screen reader.
      await expect(
        notice(page).getByRole("button", { name: "Open the batch" }),
      ).toBeVisible();
      await page.mouse.move(700, 700);
      await shot(page, "issues-batch-running");
      // The issue it merged, now closed, is marked too.
      await chooseFilter(page, "Closed");
      await expect(row(page, 190)).toContainText("In the batch");
    });

    test("a batch that waits for a person says for what, in the warning tone", async ({ page }) => {
      await issuesFixture(page, { batches: [live(AT_WORK, "approval")] });
      await page.goto("/issues");
      await expect(notice(page)).toHaveText(
        /A batch is running: 1 of 5 merged, #204 is waiting for approval\./,
      );
      await expect(notice(page)).toHaveAttribute("data-variant", "warning");
      await shot(page, "issues-batch-waiting-approval");
    });

    test("a question on the issue reads as waiting for an answer", async ({ page }) => {
      await issuesFixture(page, { batches: [live(AT_WORK, "question")] });
      await page.goto("/issues");
      await expect(notice(page)).toHaveText(
        /A batch is running: 1 of 5 merged, #204 is waiting for an answer\./,
      );
      await expect(notice(page)).toHaveAttribute("data-variant", "warning");
    });

    test("a running batch that has chosen no issue yet says it is choosing the next one", async ({ page }) => {
      await issuesFixture(page, {
        batches: [live({
          maxIssues: 5,
          issuesDone: 1,
          issues: [{ position: 1, number: 190, state: "merged" }],
        })],
      });
      await page.goto("/issues");
      await expect(notice(page)).toHaveText(
        /A batch is running: 1 of 5 merged, choosing the next issue\./,
      );
    });

    test("a batch that asks before the next issue says so in the warning tone, and tags what it merged", async ({ page }) => {
      await issuesFixture(page, {
        batches: [live({
          ...AT_WORK,
          state: "waiting",
          issues: [{ position: 1, number: 190, state: "merged" }],
        })],
      });
      await page.goto("/issues");
      await expect(notice(page)).toHaveText(
        /A batch is waiting: 1 of 5 merged\. It asks before starting the next issue\./,
      );
      await expect(notice(page)).toHaveAttribute("data-variant", "warning");
      await chooseFilter(page, "Closed");
      await expect(row(page, 190)).toContainText("In the batch");
      await shot(page, "issues-batch-waiting-next");
    });

    test("a paused, finishing or stopping batch says its state and the issue it is still on", async ({ page }) => {
      await issuesFixture(page, {
        batches: [live({
          ...AT_WORK,
          state: "paused",
          pauseReason: "paused_by_person",
        })],
      });
      await page.goto("/issues");
      await expect(notice(page)).toHaveText(
        /A batch is paused: 1 of 5 merged, working on #204\./,
      );
      await expect(notice(page)).toHaveAttribute("data-variant", "information");
      await chooseFilter(page, "All open");
      await expect(row(page, 204)).toContainText("In the batch");
      await shot(page, "issues-batch-paused");
    });

    test("with no repository chosen, each live batch names its own repository", async ({ page }) => {
      await issuesFixture(page, {
        secondSource: true,
        batches: [
          live(AT_WORK),
          {
            ...batch({
              repositoryId: API,
              state: "waiting",
              maxIssues: 3,
              issuesDone: 2,
              issues: [],
            }),
            waitingOn: null,
          },
        ],
      });
      await page.goto("/issues");
      await expect(notice(page)).toHaveCount(2);
      await expect(
        page.locator(`[data-batch-notice][data-batch-state="running"]`),
      ).toHaveText(
        /A batch is running in acme\/web: 1 of 5 merged, working on #204\./,
      );
      await expect(
        page.locator(`[data-batch-notice][data-batch-state="waiting"]`),
      ).toHaveText(
        /A batch is waiting in acme\/api: 2 of 3 merged\. It asks before starting the next issue\./,
      );
      // Each Open names the repository it opens.
      await expect(
        page.getByRole("button", { name: "Open the batch in acme/api" }),
      ).toBeVisible();
      await shot(page, "issues-batch-two-repositories");
    });

    test("a finished or stopped batch says nothing and tags nothing", async ({ page }) => {
      await issuesFixture(page, {
        batches: [
          live({
            ...AT_WORK,
            state: "finished",
            finishReason: "issues_reached",
            finishedAt: "2026-11-20T10:00:00.000Z",
          }),
          live({
            ...AT_WORK,
            state: "stopped",
            finishedAt: "2026-11-20T11:00:00.000Z",
          }),
        ],
      });
      await page.goto("/issues");
      await expect(page.getByRole("heading", { name: "Issues", level: 1 }))
        .toBeVisible();
      await expect(row(page, 201)).toBeVisible();
      await chooseFilter(page, "All open");
      await expect(row(page, 204)).toBeVisible();
      await expect(notice(page)).toHaveCount(0);
      await expect(page.getByText("In the batch")).toHaveCount(0);
      await shot(page, "issues-batch-finished");
    });

    test("a person who may not read batches is told nothing about them, and no batch is asked for", async ({ page }) => {
      // No batches option: the person has no batch:read, and the server would answer 403.
      const asked: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/v1/batches") {
          asked.push(request.url());
        }
      });
      await issuesFixture(page);
      await page.goto("/issues");
      await expect(row(page, 201)).toBeVisible();
      await expect(notice(page)).toHaveCount(0);
      expect(asked).toEqual([]);
    });
  });
}
