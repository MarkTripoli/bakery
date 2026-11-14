import { expect, type Page, test } from "@playwright/test";
import {
  issuesFixture,
  type Options,
  ready,
  type Seed,
  uuid,
} from "./helpers/issues-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * One issue (design-ux, #56 part 2): the saved description, what it depends on
 * and, in the side card, whether Bakery can start it, why not and the one next
 * step; Start work and Plan first confirm before anything starts.
 */

const BODY = [
  "Customers want to download their invoices as one CSV file.",
  "Acceptance criteria: the export lists every invoice of the year.",
].join("\n\n");

const READY: Seed = {
  number: 201,
  title: "Add invoice export",
  verdict: "ready",
  checks: [
    ...ready,
    { id: "acceptance_present", status: "pass", reason: "ok" },
    { id: "dependencies_satisfied", status: "pass", reason: "ok" },
  ],
  body: BODY,
  links: {
    parent: { id: "p", repositoryFullName: "acme/web", number: 100 },
    subIssuesTotal: 0,
    blockedBy: [{ id: "d", repositoryFullName: "acme/web", number: 150 }],
    blockingTotal: 0,
  },
  checkedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
};
const WAITING: Seed = {
  number: 202,
  title: "Show the export button",
  verdict: "waiting",
  checks: [
    ...ready,
    {
      id: "dependencies_satisfied",
      status: "wait",
      reason: "predecessor_open",
      evidence: ["blocker:acme/web#201"],
    },
  ],
  body: BODY,
  bodyTruncated: true,
  links: {
    parent: null,
    subIssuesTotal: 0,
    blockedBy: [{ id: "a", repositoryFullName: "acme/web", number: 201 }],
    blockingTotal: 0,
  },
};
const REJECTED: Seed = {
  number: 203,
  title: "Archive old invoices",
  verdict: "rejected",
  checks: [
    ...ready,
    {
      id: "acceptance_present",
      status: "reject",
      reason: "acceptance_missing",
    },
    {
      id: "intent_authorized",
      status: "reject",
      reason: "actor_role_insufficient",
    },
  ],
  body: "Move invoices older than seven years to the archive.",
  links: { parent: null, subIssuesTotal: 0, blockedBy: [], blockingTotal: 0 },
};
const RUNNING: Seed = {
  number: 204,
  title: "Fix rounding on totals",
  verdict: "ready",
  checks: ready,
  request: { disposition: "active" },
  body: "Totals are off by a cent.",
  links: { parent: null, subIssuesTotal: 0, blockedBy: [], blockingTotal: 0 },
};
const SEEDS = [READY, WAITING, REJECTED, RUNNING];

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: issue page`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    const open = async (page: Page, seed: Seed, options: Options = {}) => {
      const seen = await issuesFixture(page, { open: SEEDS, ...options });
      await page.goto(`/issues/${uuid(seed.number)}`);
      await expect(
        page.getByRole("heading", {
          name: `#${seed.number} ${seed.title}`,
          level: 1,
        }),
      ).toBeVisible();
      return seen;
    };
    const card = (page: Page) =>
      page.getByRole("complementary", { name: "Can Bakery start this?" })
        .or(page.getByRole("region", { name: "Can Bakery start this?" }));

    test("an issue that can start shows its description, what it depends on and Start work", async ({ page }) => {
      await open(page, READY);
      await expect(page.getByText("Customers want to download")).toBeVisible();
      await expect(page.getByText("acme/web · Open")).toBeVisible();
      await expect(page.getByText("Part of acme/web#100")).toBeVisible();
      // Nothing to say about sub-issues, so nothing is said.
      await expect(page.getByText("No sub-issues")).toHaveCount(0);
      // The dependency that finished, by the check's evidence.
      await expect(page.getByRole("link", { name: "acme/web#150" }))
        .toHaveAttribute("href", "https://github.com/acme/web/issues/150");
      await expect(page.getByText("Done", { exact: true })).toBeVisible();
      const side = card(page).first();
      await expect(side.getByText("Can start", { exact: true })).toBeVisible();
      await expect(side.getByText("3 other checks passed")).toBeVisible();
      await expect(side.getByText("Checked 12 minutes ago")).toBeVisible();
      await expect(side.getByText(
        "Uses the standard coding workflow in acme/web.",
      )).toBeVisible();
      await expect(side.getByRole("button", { name: "Start work" }))
        .toBeVisible();
      // Plan first is a visible second button with its own help.
      await expect(side.getByRole("button", { name: "Plan first" }))
        .toBeVisible();
      await expect(side.getByRole("button", { name: "About Plan first" }))
        .toBeVisible();
      // The buttons sit right under the verdict, and the badge is a badge, not a bar.
      const [badge, start, panel, heading] = await Promise.all([
        side.getByText("Can start", { exact: true }).boundingBox(),
        side.getByRole("button", { name: "Start work" }).boundingBox(),
        side.boundingBox(),
        page.getByRole("heading", { name: /#201 Add invoice export/, level: 1 })
          .boundingBox(),
      ]);
      expect(start!.y - badge!.y).toBeLessThan(160);
      expect(badge!.width).toBeLessThan(160);
      // On a phone the page says which issue it is before the verdict.
      if (viewport.name === "phone") {
        expect(heading!.y).toBeLessThan(panel!.y);
      }
      // The trail names the issue, and every crumb but the last is a link.
      const trail = page.getByRole("navigation", { name: "Breadcrumb" });
      if (viewport.name === "desktop") {
        await expect(trail.getByRole("link", { name: "Workspace" }))
          .toBeVisible();
        await expect(trail.getByRole("link", { name: "Issues" }))
          .toHaveAttribute("href", "/issues");
        await expect(trail.getByText("#201")).toHaveAttribute(
          "aria-current",
          "page",
        );
      }
      await page.mouse.move(700, 700);
      await shot(page, "issue-can-start");
    });

    test("a dependency on another issue waits, says so and offers Start when ready", async ({ page }) => {
      await open(page, WAITING);
      const side = card(page).first();
      await expect(side.getByText("Waiting", { exact: true })).toBeVisible();
      await expect(side.getByText("Depends on #201, which is still open."))
        .toBeVisible();
      await expect(side.getByRole("button", { name: "Start when ready" }))
        .toBeVisible();
      // Nothing is promised before the press.
      await expect(
        side.getByText("Only what this issue depends on is in the way."),
      )
        .toBeVisible();
      await expect(side.getByText(
        "Bakery will start this by itself when acme/web#201 is done.",
      )).toBeVisible();
      await expect(side.getByRole("button", { name: "Plan first" }))
        .toHaveCount(0);
      await expect(page.getByText("Still open", { exact: true }))
        .toBeVisible();
      // Only the first part of a long description is held.
      await expect(
        page.getByText("Showing the first part of a long description."),
      )
        .toBeVisible();
      await expect(page.getByRole("link", { name: "Read it all on GitHub" }))
        .toHaveAttribute("href", "https://github.com/acme/web/issues/202");
      await page.mouse.move(700, 700);
      await shot(page, "issue-waiting");
    });

    test("an issue that cannot start gives every reason with where to fix it and no button", async ({ page }) => {
      await open(page, REJECTED);
      const side = card(page).first();
      await expect(side.getByText("Cannot start", { exact: true }))
        .toBeVisible();
      await expect(side.getByText("The issue has no acceptance criteria."))
        .toBeVisible();
      await expect(side.getByRole("link", { name: /Add them on GitHub/ }))
        .toHaveAttribute("href", "https://github.com/acme/web/issues/203");
      await expect(side.getByText(
        "You are not allowed to start work from issues in this repository.",
      )).toBeVisible();
      await expect(side.getByText("Ask an organization administrator."))
        .toBeVisible();
      await expect(side.getByRole("button", { name: "Start work" }))
        .toHaveCount(0);
      // An issue with no relations shows no relations section at all.
      await expect(page.getByRole("heading", { name: "Depends on" }))
        .toHaveCount(0);
      await expect(page.getByText("This issue does not depend on"))
        .toHaveCount(0);
      await page.mouse.move(700, 700);
      await shot(page, "issue-cannot-start");
    });

    test("work that is already under way shows In progress and no Start work", async ({ page }) => {
      await open(page, RUNNING);
      const side = card(page).first();
      await expect(side.getByText("In progress", { exact: true }))
        .toBeVisible();
      await expect(side.getByText("Bakery is working on this."))
        .toBeVisible();
      await expect(side.getByRole("button", { name: "Start work" }))
        .toHaveCount(0);
    });

    test("Start work confirms, then asks the server once with the digest and policy it saw", async ({ page }) => {
      const seen = await open(page, READY);
      await card(page).first().getByRole("button", { name: "Start work" })
        .click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Start work on #201?");
      await expect(dialog).toContainText(
        "Bakery creates a task and runs the standard coding workflow in acme/web. You can follow it in Work.",
      );
      await page.mouse.move(700, 700);
      await shot(page, "issue-start-dialog", [], { windowOnly: true });
      await dialog.getByRole("button", { name: "Start work" }).click();
      await expect(page.getByText("Work on #201 is starting.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Open Work" }))
        .toBeVisible();
      expect(seen.starts).toEqual([
        { intent: "start", revision: 1, digest: "0".repeat(64) },
      ]);
    });

    test("Plan first is a visible button beside Start work and changes what the confirmation says", async ({ page }) => {
      const seen = await open(page, READY);
      await card(page).first().getByRole("button", { name: "Plan first" })
        .click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText(
        "Bakery writes a plan and waits for your approval before changing code.",
      );
      await dialog.getByRole("button", { name: "Write a plan" }).click();
      await expect(page.getByText("Work on #201 is starting.")).toBeVisible();
      expect(seen.starts[0]?.intent).toBe("plan");
    });

    for (
      const [answer, sentence] of [
        [
          "notReady",
          "This issue cannot start yet. Nothing was started. See why in the card.",
        ],
        [
          "changed",
          "This issue changed on GitHub since you opened it. Nothing was started. Review it again.",
        ],
        [
          "unavailable",
          "GitHub is not answering, so nothing was started. Try again in a moment.",
        ],
      ] as const
    ) {
      test(`a refused start (${answer}) says so, closes the dialog and starts nothing`, async ({ page }) => {
        await open(page, READY, { start: answer });
        await card(page).first().getByRole("button", { name: "Start work" })
          .click();
        await page.getByRole("alertdialog").getByRole("button", {
          name: "Start work",
        }).click();
        await expect(page.getByText(sentence)).toBeVisible();
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
        await expect(page.getByText("Work on #201 is starting."))
          .toHaveCount(0);
        if (answer === "changed") {
          // Nothing was started, and neither button works until Reload.
          const side = card(page).first();
          await expect(side.getByRole("button", { name: "Start work" }))
            .toBeDisabled();
          await expect(side.getByRole("button", { name: "Plan first" }))
            .toBeDisabled();
          await expect(page.getByRole("button", { name: "Reload" }))
            .toBeVisible();
          await page.mouse.move(700, 700);
          await shot(page, "issue-start-refused");
          await page.getByRole("button", { name: "Reload" }).click();
          await expect(side.getByRole("button", { name: "Start work" }))
            .toBeEnabled();
        }
      });
    }

    test("pressing Start work when someone else just started it shows In progress, not an error", async ({ page }) => {
      await open(page, READY, { start: "alreadyRunning" });
      await card(page).first().getByRole("button", { name: "Start work" })
        .click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Start work",
      }).click();
      const side = card(page).first();
      await expect(side.getByText("In progress", { exact: true }))
        .toBeVisible();
      await expect(page.getByText("This issue cannot start yet."))
        .toHaveCount(0);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
    });

    test("Check again asks the server to check, and is not offered while it works", async ({ page }) => {
      const seen = await open(page, WAITING);
      await card(page).first().getByRole("button", { name: "Check again" })
        .first().click();
      await expect.poll(() => seen.checks).toBe(1);
    });

    test("trouble reading GitHub says so, shows the answer as not checked and offers no Start work", async ({ page }) => {
      await open(page, READY, { sources: "degraded" });
      await expect(page.getByText(
        "Bakery is having trouble reading GitHub. This list may be out of date.",
      )).toBeVisible();
      await expect(page.getByRole("button", { name: "Refresh" }))
        .toBeVisible();
      const side = card(page).first();
      await expect(side.getByText("Not checked", { exact: true }))
        .toBeVisible();
      await expect(side.getByText(/^Checked /)).toHaveCount(0);
      await expect(side.getByRole("button", { name: "Start work" }))
        .toHaveCount(0);
      await page.mouse.move(700, 700);
      await shot(page, "issue-github-trouble");
    });

    test("an access GitHub no longer accepts offers Reconnect GitHub", async ({ page }) => {
      await open(page, READY, { sources: "authRequired" });
      await expect(page.getByText(
        "GitHub no longer accepts Bakery's access, so issues cannot be updated or started.",
      )).toBeVisible();
      await expect(page.getByRole("button", { name: "Reconnect GitHub" }))
        .toBeVisible();
    });

    test("an unknown issue says it was not found and offers Back to issues", async ({ page }) => {
      await issuesFixture(page, { open: SEEDS });
      await page.goto(`/issues/${uuid(999)}`);
      await expect(page.getByText(
        "This issue was not found, or you do not have access to it.",
      )).toBeVisible();
      await page.getByRole("button", { name: "Back to issues" }).click();
      await expect(page).toHaveURL(/\/issues$/);
    });

    test("from the list, a Can start row opens the same confirmation and an Open row opens the issue", async ({ page }) => {
      const seen = await issuesFixture(page, { open: SEEDS });
      await page.goto("/issues");
      await page.getByRole("button", {
        name: "Start work on #201 Add invoice export",
      }).click();
      await expect(page.getByRole("alertdialog")).toContainText(
        "Start work on #201?",
      );
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Cancel",
      }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      expect(seen.starts).toEqual([]);
      await page.getByRole("radio", { name: "All open" }).click({
        force: true,
      });
      await page.getByRole("button", {
        name: "Open #203 Archive old invoices",
      }).click();
      await expect(page).toHaveURL(new RegExp(`/issues/${uuid(203)}$`));
    });
  });
}
