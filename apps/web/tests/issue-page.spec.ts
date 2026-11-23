import { expect, type Page, test } from "@playwright/test";
import {
  chooseFilter,
  issuesFixture,
  type Options,
  ready,
  type Seed,
  uuid,
} from "./helpers/issues-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";
import { still } from "./helpers/stills.ts";

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
const NO_PROFILE: Seed = {
  number: 206,
  title: "Move the export to a job",
  verdict: "rejected",
  checks: [
    ...ready,
    { id: "repository_ready", status: "reject", reason: "no_active_profile" },
  ],
  body: "Run the export as a background job.",
  links: { parent: null, subIssuesTotal: 0, blockedBy: [], blockingTotal: 0 },
};

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
      await expect(side.getByText(/^Checked \d+ minutes ago$/)).toBeVisible();
      await expect(side.getByText(
        "Uses Fixed coding in acme/web.",
      )).toBeVisible();
      await expect(side.getByRole("button", { name: "Start work" }))
        .toBeVisible();
      // Plan first is a visible second button with its own help.
      await expect(
        side.getByRole("button", { name: "Plan first", exact: true }),
      )
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
      // The dependency is said once, by the caption below; not again as "Depends on".
      await expect(side.getByText(/Depends on #201/)).toHaveCount(0);
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
      await expect(
        side.getByRole("button", { name: "Plan first", exact: true }),
      )
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

    test("a waiting issue whose dependency is not known yet never prints a hole in the caption", async ({ page }) => {
      // The check says it waits on a dependency but names none, and no link is read.
      const unknown: Seed = {
        ...WAITING,
        checks: [
          ...ready,
          {
            id: "dependencies_satisfied",
            status: "wait",
            reason: "predecessor_open",
          },
        ],
        links: {
          parent: null,
          subIssuesTotal: 0,
          blockedBy: [],
          blockingTotal: 0,
        },
      };
      await open(page, unknown, { open: [unknown] });
      const side = card(page).first();
      await expect(side.getByRole("button", { name: "Start when ready" }))
        .toBeVisible();
      await expect(side.getByText(/by itself when/)).toHaveCount(0);
      // The Start when ready note already says it: no "Depends on" sentence,
      // and no empty "#" anywhere on the card (revision 10).
      await expect(side.getByText(/Depends on/)).toHaveCount(0);
      await expect(side.getByText(/#,|#\./)).toHaveCount(0);
      await expect(side.getByText(/Uses .* in acme\/web\./)).toBeVisible();
    });

    test("a waiting issue with no dependency number and no Start when ready note says an issue, never an empty number", async ({ page }) => {
      // Two things are in the way, so there is no note; the dependency check names no issue.
      const unnamed: Seed = {
        ...WAITING,
        checks: [
          ...ready,
          {
            id: "dependencies_satisfied",
            status: "wait",
            reason: "predecessor_open",
          },
          {
            id: "acceptance_present",
            status: "wait",
            reason: "acceptance_missing",
          },
        ],
        links: {
          parent: null,
          subIssuesTotal: 0,
          blockedBy: [],
          blockingTotal: 0,
        },
      };
      await open(page, unnamed, { open: [unnamed] });
      const side = card(page).first();
      await expect(
        side.getByText("Only what this issue depends on is in the way."),
      ).toHaveCount(0);
      await expect(side.getByText("Depends on an issue that is still open."))
        .toBeVisible();
      await expect(side.getByText(/#,|#\./)).toHaveCount(0);
      await page.mouse.move(700, 700);
      await shot(page, "issue-card-no-number");
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

    test("a repository with no working settings opens its own setup when the source names it", async ({ page }) => {
      await page.route(
        (url) => url.pathname === `/v1/repositories/${uuid(903)}`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id: uuid(903),
              applicationId: uuid(904),
              slug: "web",
              integrationConnectionId: uuid(901),
              providerRepoId: "5001",
              owner: "acme",
              name: "web",
              defaultBranch: "main",
              activeProfileId: null,
              nextProfileRevision: 1,
              archivedAt: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              version: 1,
            }),
          }),
      );
      await open(page, NO_PROFILE, { open: [...SEEDS, NO_PROFILE] });
      const button = card(page).first().getByRole("button", {
        name: "Open acme/web's setup",
      });
      await expect(button).toBeVisible();
      await page.mouse.move(700, 700);
      await shot(page, "issue-cannot-start-known-repository");
      await button.click();
      await expect(page).toHaveURL(
        new RegExp(`/projects/repositories/${uuid(903)}`),
      );
    });

    test("when no source names the repository the link opens Projects", async ({ page }) => {
      await open(page, NO_PROFILE, {
        open: [...SEEDS, NO_PROFILE],
        sources: "none",
      });
      const button = card(page).first().getByRole("button", {
        name: "Open Projects",
      });
      await expect(button).toBeVisible();
      await page.mouse.move(700, 700);
      await shot(page, "issue-cannot-start-unknown-repository");
      await button.click();
      await expect(page).toHaveURL(/\/projects$/);
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
        "Bakery creates a task in acme/web. You can follow it in Work.",
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

    test("Start work names both built-in workflows, the repository's first, and sends no choice when it is kept", async ({ page }) => {
      const seen = await open(page, READY);
      await card(page).first().getByRole("button", { name: "Start work" })
        .click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog.getByRole("button", { name: "Cancel" }))
        .toBeFocused();
      const workflows = dialog.getByRole("radiogroup", { name: "Workflow" });
      await expect(workflows.getByRole("radio")).toHaveCount(2);
      // The repository's own is chosen, since nothing else was asked for.
      await expect(workflows.getByRole("radio", { name: "Fixed coding" }))
        .toBeChecked();
      await expect(
        workflows.getByRole("radio", {
          name: "Coding with independent review",
        }),
      ).not.toBeChecked();
      await expect(dialog).toContainText(
        "acme/web is set to Fixed coding. Choosing the other applies to this issue only.",
      );
      await page.mouse.move(700, 700);
      await still(page, "issue-start-dialog-workflow");
      await dialog.getByRole("button", { name: "Start work" }).click();
      await expect(page.getByText("Work on #201 is starting.")).toBeVisible();
      expect(seen.starts).toHaveLength(1);
      expect(seen.starts[0]!.preset).toBeUndefined();
    });

    test("choosing the other workflow starts this issue with it", async ({ page }) => {
      const seen = await open(page, READY);
      await card(page).first().getByRole("button", { name: "Start work" })
        .click();
      const dialog = page.getByRole("alertdialog");
      await dialog.getByRole("radio", {
        name: "Coding with independent review",
      }).check();
      await dialog.getByRole("button", { name: "Start work" }).click();
      await expect(page.getByText("Work on #201 is starting.")).toBeVisible();
      expect(seen.starts[0]!.preset).toBe("fixed-coding-reviewed");
    });

    test("a repository set to the reviewed workflow starts with it, and the standard one can be chosen for one issue", async ({ page }) => {
      const seen = await open(page, READY, {
        sourcePreset: "fixed-coding-reviewed",
      });
      await card(page).first().getByRole("button", { name: "Start work" })
        .click();
      const dialog = page.getByRole("alertdialog");
      await expect(
        dialog.getByRole("radio", { name: "Coding with independent review" }),
      ).toBeChecked();
      await expect(dialog).toContainText(
        "acme/web is set to Coding with independent review. Choosing the other applies to this issue only.",
      );
      await dialog.getByRole("radio", { name: "Fixed coding" }).check();
      // The help keeps naming the repository's own workflow after the choice changes.
      await expect(dialog).toContainText(
        "acme/web is set to Coding with independent review.",
      );
      await dialog.getByRole("button", { name: "Start work" }).click();
      await expect(page.getByText("Work on #201 is starting.")).toBeVisible();
      expect(seen.starts[0]!.preset).toBe("fixed-coding");
    });

    test("Plan first is a visible button beside Start work and changes what the confirmation says", async ({ page }) => {
      const seen = await open(page, READY);
      await card(page).first().getByRole("button", {
        name: "Plan first",
        exact: true,
      })
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
          "notAllowed",
          "You are not allowed to start work from issues in this repository. Nothing was started.",
        ],
        ["gone", "This issue is no longer there. Nothing was started."],
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
          await expect(
            side.getByRole("button", { name: "Plan first", exact: true }),
          )
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

    for (
      const address of [
        "not-a-uuid",
        "%2e%2e%2f%2e%2e%2fetc",
        "x".repeat(300),
        "%3Cimg%20src=x%20onerror=alert(1)%3E",
      ]
    ) {
      test(`an address that is not an issue (${address.slice(0, 12)}) is not found, with one title and no request`, async ({ page }) => {
        let asked = 0;
        await issuesFixture(page, { open: SEEDS });
        await page.route(
          (url) => /^\/v1\/external-tickets\/[^/]+$/.test(url.pathname),
          (route) => {
            asked += 1;
            return route.fallback();
          },
        );
        await page.goto(`/issues/${address}`);
        await expect(page.getByText(
          "This issue was not found, or you do not have access to it.",
        )).toBeVisible();
        await expect(page.locator("main h1")).toHaveCount(1);
        await expect(page.getByText("could not be loaded")).toHaveCount(0);
        expect(asked).toBe(0);
      });
    }

    test("Cancel and Escape return focus to the button that opened the confirmation", async ({ page }) => {
      await open(page, READY);
      const start = card(page).first().getByRole("button", {
        name: "Start work",
        exact: true,
      });
      for (const close of ["Cancel", "Escape"]) {
        await start.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toBeVisible();
        if (close === "Escape") await page.keyboard.press("Escape");
        else await dialog.getByRole("button", { name: "Cancel" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(start).toBeFocused();
      }
      // Plan first returns to Plan first.
      const plan = card(page).first().getByRole("button", {
        name: "Plan first",
        exact: true,
      });
      await plan.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Escape");
      await expect(plan).toBeFocused();
    });

    test("after a start the message takes focus, so it is read", async ({ page }) => {
      await open(page, READY);
      await card(page).first().getByRole("button", {
        name: "Start work",
        exact: true,
      }).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Start work",
      }).click();
      await expect(page.locator("[data-start-notice]")).toBeFocused();
      await expect(page.getByText("Work on #201 is starting.")).toBeVisible();
    });

    test("after a refused start the message takes focus", async ({ page }) => {
      await open(page, READY, { start: "unavailable" });
      await card(page).first().getByRole("button", {
        name: "Start work",
        exact: true,
      }).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Start work",
      }).click();
      await expect(page.locator("[data-start-notice]")).toBeFocused();
    });

    test("on a phone the card starts at the page's own left edge", async ({ page }) => {
      test.skip(
        viewport.name !== "phone",
        "the card is a column beside the page",
      );
      await open(page, READY);
      const [title, cardHeading] = await Promise.all([
        page.getByRole("heading", { name: /#201 Add invoice export/, level: 1 })
          .boundingBox(),
        page.getByRole("heading", { name: "Can Bakery start this?" })
          .boundingBox(),
      ]);
      expect(Math.round(cardHeading!.x)).toBe(Math.round(title!.x));
    });

    test("an issue whose repository is off sends an administrator to Choose repositories, and tells a member to ask", async ({ page }) => {
      const off: Seed = {
        number: 210,
        title: "Repository is off",
        verdict: "rejected",
        checks: [{
          id: "source_live",
          status: "reject",
          reason: "source_disabled",
        }],
        body: "Needs the repository on.",
        links: {
          parent: null,
          subIssuesTotal: 0,
          blockedBy: [],
          blockingTotal: 0,
        },
      };
      await open(page, off, { open: [off] });
      const side = card(page).first();
      await expect(
        side.getByText("Bakery is not taking issues from this repository."),
      )
        .toBeVisible();
      await side.getByRole("button", { name: "Choose repositories" }).click();
      await expect(page).toHaveURL(/\/issues\?choose=true$/);
      await expect(page.getByRole("dialog", { name: "Choose repositories" }))
        .toBeVisible();
    });

    test("a member is told to ask an administrator when the repository is off", async ({ page }) => {
      const off: Seed = {
        number: 211,
        title: "Repository is off",
        verdict: "rejected",
        checks: [{
          id: "source_live",
          status: "reject",
          reason: "source_disabled",
        }],
        body: "Needs the repository on.",
        links: {
          parent: null,
          subIssuesTotal: 0,
          blockedBy: [],
          blockingTotal: 0,
        },
      };
      await open(page, off, { open: [off], role: "developer" });
      const side = card(page).first();
      await expect(side.getByText("Ask an organization administrator."))
        .toBeVisible();
      await expect(side.getByRole("button", { name: "Choose repositories" }))
        .toHaveCount(0);
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
        "Bakery is having trouble reading GitHub. This issue may be out of date.",
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

    test("from the list, closing the confirmation returns focus to that row's Start work", async ({ page }) => {
      await issuesFixture(page, { open: SEEDS });
      await page.goto("/issues");
      const start = page.getByRole("button", {
        name: "Start work on #201 Add invoice export",
      });
      await start.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(start).toBeFocused();
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
      await chooseFilter(page, "All open");
      await page.getByRole("button", {
        name: "Open #203 Archive old invoices",
      }).click();
      await expect(page).toHaveURL(new RegExp(`/issues/${uuid(203)}$`));
    });
  });
}
