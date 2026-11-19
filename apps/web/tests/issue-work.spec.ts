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
      const seen = await issuesFixture(page, { open: [ISSUE], work, ...more });
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
      await expect(work.getByText(/started by you · 12 minutes ago/))
        .toBeVisible();
      await expect(work.getByText("Fix the login redirect")).toBeVisible();
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

    test("a stopped start can be started again", async ({ page }) => {
      await open(page, { issue: 201, progress: "canceled" });
      await expect(section(page).getByText("Stopped", { exact: true }))
        .toBeVisible();
      await expect(section(page).getByRole("button", { name: "Start work" }))
        .toBeVisible();
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
