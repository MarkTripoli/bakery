import { expect, type Page, test } from "@playwright/test";
import { issuesFixture, uuid as issueUuid } from "./helpers/issues-fixture.ts";
import {
  application,
  CONNECTION_ID,
  type Options as ProjectsOptions,
  projectsFixture,
  repository,
} from "./helpers/projects-fixture.ts";
import { MOCK_ORGANIZATION_ID } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * Choose repositories (design-ux, #56): where Bakery takes issues from. One row
 * per repository Bakery works in, a switch, and for one that is on the Start
 * work and On hold labels; Save changes them one repository at a time.
 */

const STAMP = "2026-01-01T00:00:00.000Z";
const PAYMENTS = application(1, "Payments");
const WORLD: ProjectsOptions = {
  applications: [PAYMENTS],
  repositories: [
    repository(1, PAYMENTS.id, "ledger"),
    repository(2, PAYMENTS.id, "billing"),
    repository(3, PAYMENTS.id, "unlisted"),
    repository(4, PAYMENTS.id, "old", { archivedAt: STAMP }),
  ],
  // The connection offers ledger (5001) and billing (5002), not unlisted.
  offered: [
    { id: "5001", name: "acme/ledger" },
    { id: "5002", name: "acme/billing" },
  ],
};

type Source = {
  id: string;
  repositoryId: string;
  resourceId: string;
  enabled: boolean;
  version: number;
  labels: { execute: string; planOnly: string | null; hold: string };
};

const sourceBody = (source: Source) => ({
  id: source.id,
  organizationId: MOCK_ORGANIZATION_ID,
  integrationConnectionId: CONNECTION_ID,
  integrationResourceId: source.resourceId,
  applicationId: PAYMENTS.id,
  repositoryId: source.repositoryId,
  externalContainerId: "acme/ledger",
  enabled: source.enabled,
  policy: {
    version: 1,
    labels: source.labels,
    delegation: null,
    automatic: { enabled: false, since: null },
    readiness: { requireAcceptanceCriteria: false },
    approval: { plan: "human_approval" },
    preset: "fixed-coding",
  },
  policyRevision: 1,
  syncHealth: "healthy",
  lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastProblemCode: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: source.version,
});
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type Setup = {
  role?: "admin" | "developer";
  sources?: Source[];
  save?: "ok" | "conflict";
  /** Refuse the create for one repository (by its owner/name) with a status. */
  refuse?: { name: string; status: 409 | 500 };
  projects?: ProjectsOptions;
};

/** Stubs the Projects reads, the issues, and the ticket sources the sheet reads and writes. */
async function fixture(page: Page, setup: Setup = {}) {
  const sources = (setup.sources ?? []).map((source) => ({ ...source }));
  const projects = { role: setup.role, ...(setup.projects ?? WORLD) };
  // The issues page itself first (its list, and an administrator's role), then
  // the Projects reads, whose role wins.
  await issuesFixture(page, { open: [], closed: [], sources: "none" });
  await projectsFixture(page, projects);
  const seen = {
    /** Changed by a test to let a refused repository through on a retry. */
    refuse: setup.refuse ?? null as Setup["refuse"] | null,
    created: [] as Record<string, unknown>[],
    updates: [] as {
      id: string;
      ifMatch: string | null;
      body: Record<string, unknown>;
    }[],
  };
  await page.route(
    (url) => url.pathname === "/v1/ticket-sources",
    (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        seen.created.push(body);
        const refused = seen.refuse !== null &&
          body.externalContainerId === seen.refuse.name;
        if (setup.save === "conflict" || refused) {
          const status = refused ? seen.refuse!.status : 409;
          return route.fulfill({
            status,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "https://bakery.example/problems/test",
              title: status === 409 ? "Conflict" : "Internal error",
              detail: status === 409 ? "Conflict." : "Internal error.",
              status,
              code: status === 409 ? "STATE_CONFLICT" : "INTERNAL_ERROR",
              retryable: false,
              requestId: crypto.randomUUID(),
              traceId: crypto.randomUUID(),
            }),
          });
        }
        const created: Source = {
          id: issueUuid(700 + sources.length),
          repositoryId: String(body.repositoryId),
          resourceId: String(body.resourceId),
          enabled: true,
          version: 1,
          labels: (body.policy as { labels: Source["labels"] }).labels,
        };
        sources.push(created);
        return route.fulfill(json(sourceBody(created), 201));
      }
      return route.fulfill(
        json({ items: sources.map(sourceBody), nextCursor: null }),
      );
    },
  );
  await page.route(
    (url) => /^\/v1\/ticket-sources\/[^/]+$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3] ?? "";
      const body = route.request().postDataJSON() as Record<string, unknown>;
      seen.updates.push({
        id,
        ifMatch: route.request().headers()["if-match"] ?? null,
        body,
      });
      const target = sources.find((source) => source.id === id);
      if (!target) return route.fulfill(json({ status: 404 }, 404));
      if (typeof body.enabled === "boolean") target.enabled = body.enabled;
      const labels = (body.policy as { labels?: Source["labels"] } | undefined)
        ?.labels;
      if (labels) target.labels = labels;
      target.version += 1;
      return route.fulfill(json(sourceBody(target)));
    },
  );
  return seen;
}

const LEDGER_SOURCE: Source = {
  id: issueUuid(701),
  repositoryId: repository(1, PAYMENTS.id, "ledger").id,
  resourceId: issueUuid(900),
  enabled: true,
  version: 3,
  labels: { execute: "go", planOnly: "plan", hold: "wait" },
};

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: choose repositories`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    /** Opens the sheet from the page's button (a wide screen puts it in the top bar). */
    const openSheet = async (page: Page) => {
      await page.goto("/issues");
      // The page's button beside Refresh (the empty list has its own as well).
      await page.getByRole("button", { name: "Choose repositories" }).first()
        .click();
      const sheet = page.getByRole("dialog", { name: "Choose repositories" });
      await expect(sheet).toBeVisible();
      return sheet;
    };
    test("lists the repositories Bakery works in, with a switch each, and says what the connection does not offer", async ({ page }) => {
      await fixture(page);
      const sheet = await openSheet(page);
      await expect(sheet.getByText(
        "Bakery takes issues from the repositories you turn on.",
      )).toBeVisible();
      for (const name of ["acme/billing", "acme/ledger", "acme/unlisted"]) {
        await expect(sheet.getByRole("group", { name })).toBeVisible();
      }
      // Archived repositories are not listed.
      await expect(sheet.getByRole("group", { name: "acme/old" }))
        .toHaveCount(0);
      await expect(sheet.getByRole("switch", {
        name: "Take issues from this repository",
      })).toHaveCount(2);
      await expect(sheet.getByText(
        "Your GitHub connection does not offer this repository.",
      )).toBeVisible();
      // The way on is a link, directly under its sentence, at the start.
      const unlisted = sheet.getByRole("group", { name: "acme/unlisted" });
      const integrations = unlisted.getByRole("link", {
        name: "Open Integrations",
      });
      await expect(integrations).toHaveAttribute(
        "href",
        "/settings/organization/integrations",
      );
      const sentence = (await unlisted.getByText(
        "Your GitHub connection does not offer this repository.",
      ).boundingBox())!;
      const link = (await integrations.boundingBox())!;
      expect(link.y).toBeGreaterThanOrEqual(sentence.y + sentence.height - 1);
      expect(Math.abs(link.x - sentence.x)).toBeLessThanOrEqual(2);
      // Row titles are smaller than the sheet's own title.
      const title = await sheet.getByRole("heading", {
        name: "Choose repositories",
      }).evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
      const rowTitle = await sheet.getByRole("group", { name: "acme/billing" })
        .getByText("acme/billing", { exact: true }).evaluate((element) =>
          parseFloat(getComputedStyle(element).fontSize)
        );
      expect(rowTitle).toBeLessThan(title);
      await page.mouse.move(700, 700);
      await shot(page, "choose-repositories", [], { windowOnly: true });
    });

    test("turning a repository on shows the two labels, prefilled, with their help; the same label twice is named and Save waits", async ({ page }) => {
      await fixture(page);
      const sheet = await openSheet(page);
      await expect(sheet.getByRole("button", { name: "Save" })).toBeDisabled();
      await sheet.getByRole("switch", {
        name: "Take issues from this repository",
      }).first().check();
      await expect(sheet.getByLabel(/^Start work label/)).toHaveValue("bakery");
      await expect(sheet.getByLabel(/^On hold label/)).toHaveValue("hold");
      await expect(sheet.getByText("Issues with this label can be started."))
        .toBeVisible();
      await expect(sheet.getByText("Never started while it has this."))
        .toBeVisible();
      await expect(sheet.getByRole("button", { name: "Save" })).toBeEnabled();
      await sheet.getByLabel(/^On hold label/).fill("Bakery");
      await expect(sheet.getByText("Each label must be different."))
        .toBeVisible();
      await expect(sheet.getByRole("button", { name: "Save" })).toBeDisabled();
      await sheet.getByLabel(/^Start work label/).fill("");
      await expect(sheet.getByText("Enter a label.")).toBeVisible();
      await page.mouse.move(700, 700);
      await shot(page, "choose-repositories-labels", [], { windowOnly: true });
    });

    test("Save starts taking issues from a repository with exactly its defaults, and no workflow", async ({ page }) => {
      const seen = await fixture(page);
      const sheet = await openSheet(page);
      // The first row in name order is acme/billing.
      await sheet.getByRole("switch", {
        name: "Take issues from this repository",
      }).first().check();
      await sheet.getByRole("button", { name: "Save" }).click();
      await expect.poll(() => seen.created.length).toBe(1);
      expect(seen.created[0]).toMatchObject({
        connectionId: CONNECTION_ID,
        applicationId: PAYMENTS.id,
        repositoryId: repository(2, PAYMENTS.id, "billing").id,
        externalContainerId: "acme/billing",
        policy: {
          version: 1,
          labels: { execute: "bakery", planOnly: null, hold: "hold" },
          delegation: null,
          automatic: { enabled: false },
          readiness: { requireAcceptanceCriteria: true },
          approval: { plan: "human_approval" },
        },
      });
      expect(seen.created[0]?.policy).not.toHaveProperty("preset");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("a repository that already takes issues shows on, with its labels; off and relabel send what changed with the version it saw", async ({ page }) => {
      const seen = await fixture(page, { sources: [LEDGER_SOURCE] });
      const sheet = await openSheet(page);
      const ledger = sheet.getByRole("switch", {
        name: "Take issues from this repository",
      }).nth(1);
      await expect(ledger).toBeChecked();
      await expect(sheet.getByLabel(/^Start work label/)).toHaveValue("go");
      await expect(sheet.getByLabel(/^On hold label/)).toHaveValue("wait");
      // Relabel: the labels change and the rest of the policy is kept.
      await sheet.getByLabel(/^Start work label/).fill("ship");
      await sheet.getByRole("button", { name: "Save" }).click();
      await expect.poll(() => seen.updates.length).toBe(1);
      expect(seen.updates[0]).toMatchObject({
        id: LEDGER_SOURCE.id,
        ifMatch: '"v3"',
        body: {
          enabled: true,
          policy: {
            labels: { execute: "ship", planOnly: "plan", hold: "wait" },
            readiness: { requireAcceptanceCriteria: false },
          },
        },
      });
      // Off, with what that does said before Save.
      const again = await openSheet(page);
      await expect(again.getByText("Work already started continues."))
        .toHaveCount(0);
      await again.getByRole("switch", {
        name: "Take issues from this repository",
      }).nth(1).uncheck();
      await expect(again.getByText(
        "Bakery stops taking issues from this repository. Issues it already took cannot be started. Work already started continues.",
      )).toBeVisible();
      await again.getByRole("button", { name: "Save" }).click();
      await expect.poll(() => seen.updates.length).toBe(2);
      expect(seen.updates[1]).toMatchObject({
        id: LEDGER_SOURCE.id,
        ifMatch: '"v4"',
        body: { enabled: false },
      });
    });

    test("a refused save says so in warning tone, keeps the sheet and shows what is there now", async ({ page }) => {
      await fixture(page, { save: "conflict" });
      const sheet = await openSheet(page);
      await sheet.getByRole("switch", {
        name: "Take issues from this repository",
      }).first().check();
      await sheet.getByRole("button", { name: "Save" }).click();
      await expect(sheet.getByText(
        "Someone else changed this just now. The latest is shown; make your change again.",
      )).toBeVisible();
      // The latest is shown, as the sentence says: not the refused change.
      await expect(
        sheet.getByRole("switch", {
          name: "Take issues from this repository",
        }).first(),
      ).not.toBeChecked();
      await expect(sheet.getByRole("button", { name: "Save" })).toBeDisabled();
      // A change by someone else is a warning, not a failure of the person.
      await expect(
        sheet.locator(
          '[data-ui-component="inlineNotice"][data-variant="warning"]',
        )
          .filter({ hasText: "Someone else changed this just now." }),
      ).toBeVisible();
      await page.mouse.move(700, 700);
      await shot(page, "choose-repositories-refused", [], { windowOnly: true });
    });

    test("a save where one repository is refused keeps what went through and says which did not", async ({ page }) => {
      const seen = await fixture(page, {
        refuse: { name: "acme/ledger", status: 409 },
      });
      const sheet = await openSheet(page);
      const switches = sheet.getByRole("switch", {
        name: "Take issues from this repository",
      });
      await switches.nth(0).check();
      await switches.nth(1).check();
      await sheet.getByRole("button", { name: "Save" }).click();
      await expect.poll(() => seen.created.length).toBe(2);
      expect(seen.created.map((body) => body.externalContainerId)).toEqual([
        "acme/billing",
        "acme/ledger",
      ]);
      const billing = sheet.getByRole("group", { name: "acme/billing" });
      const ledger = sheet.getByRole("group", { name: "acme/ledger" });
      // The first went through: it is on, from the server, and no longer a change.
      await expect(billing.getByRole("switch")).toBeChecked();
      await expect(billing.getByText("Someone else changed this just now."))
        .toHaveCount(0);
      // The second says so and shows what is there now (off); nothing is pending.
      await expect(ledger.getByText("Someone else changed this just now."))
        .toBeVisible();
      await expect(ledger.getByRole("switch")).not.toBeChecked();
      await expect(sheet.getByRole("button", { name: "Save" })).toBeDisabled();
    });

    test("a save that fails keeps the person's change for that repository only, and retrying sends only it", async ({ page }) => {
      const seen = await fixture(page, {
        refuse: { name: "acme/ledger", status: 500 },
      });
      const sheet = await openSheet(page);
      const switches = sheet.getByRole("switch", {
        name: "Take issues from this repository",
      });
      await switches.nth(0).check();
      await switches.nth(1).check();
      await sheet.getByRole("button", { name: "Save" }).click();
      await expect.poll(() => seen.created.length).toBe(2);
      const ledger = sheet.getByRole("group", { name: "acme/ledger" });
      await expect(ledger.getByText("This did not save. Try again."))
        .toBeVisible();
      // Its change is kept, the first one is saved.
      await expect(ledger.getByRole("switch")).toBeChecked();
      await expect(
        sheet.getByRole("group", { name: "acme/billing" })
          .getByRole("switch"),
      ).toBeChecked();
      await expect(sheet.getByRole("button", { name: "Save" })).toBeEnabled();
      seen.refuse = null;
      await sheet.getByRole("button", { name: "Save" }).click();
      await expect.poll(() => seen.created.length).toBe(3);
      expect(seen.created[2]?.externalContainerId).toBe("acme/ledger");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("the sheet opens from the end of the window, over the page and not the navigation, and is the full width on a phone", async ({ page }) => {
      await fixture(page);
      const sheet = await openSheet(page);
      const box = (await sheet.boundingBox())!;
      const width = viewport.width;
      expect(Math.abs(box.x + box.width - width)).toBeLessThanOrEqual(1);
      if (viewport.name === "phone") {
        expect(box.width).toBeGreaterThanOrEqual(width - 1);
      } else {
        // Not over the main rail (208 wide) at the start of the window.
        expect(box.x).toBeGreaterThan(208);
      }
    });

    test("Escape closes the sheet and returns focus to the button that opened it", async ({ page }) => {
      await fixture(page);
      await page.goto("/issues");
      const more = page.getByRole("button", { name: "Choose repositories" })
        .first();
      await more.click();
      await expect(page.getByRole("dialog", { name: "Choose repositories" }))
        .toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(more).toBeFocused();
    });

    test("the side-sheet rule leaves the navigation drawer where and as wide as it was", async ({ page }) => {
      test.skip(
        viewport.name !== "phone",
        "The navigation drawer is a phone and tablet control.",
      );
      await fixture(page);
      await page.goto("/issues");
      await page.getByRole("button", { name: "Open navigation" }).click();
      const drawer = page.locator(".bakery-app-shell__drawer .ui-sheet--side");
      await expect(drawer).toBeVisible();
      const box = (await drawer.boundingBox())!;
      // At the start edge, and the rail plus 64px wide (208 + 64), as before.
      expect(Math.abs(box.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - 272)).toBeLessThanOrEqual(1);
      await page.mouse.move(380, 700);
      await shot(page, "navigation-drawer", [], { windowOnly: true });
    });

    test("Cancel returns focus to the button that opened the sheet", async ({ page }) => {
      await fixture(page);
      await page.goto("/issues");
      const more = page.getByRole("button", { name: "Choose repositories" })
        .first();
      await more.click();
      const sheet = page.getByRole("dialog", { name: "Choose repositories" });
      await sheet.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(more).toBeFocused();
    });

    test("opened from the address (the issue page's action), closing returns focus to the button beside Refresh", async ({ page }) => {
      await fixture(page, { sources: [LEDGER_SOURCE] });
      await page.goto("/issues?choose=true");
      const sheet = page.getByRole("dialog", { name: "Choose repositories" });
      await expect(sheet).toBeVisible();
      await sheet.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page).not.toHaveURL(/choose=/);
      await expect(
        page.getByRole("button", { name: "Choose repositories" }).first(),
      ).toBeFocused();
    });

    test("a member does not see the button", async ({ page }) => {
      await fixture(page, { role: "developer" });
      await page.goto("/issues");
      await expect(page.getByRole("heading", { name: "Issues", level: 1 }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Choose repositories" }))
        .toHaveCount(0);
    });

    test("with no repository in use, an administrator is offered Choose repositories, or Connect GitHub when there is no connection", async ({ page }) => {
      await fixture(page);
      await page.goto("/issues");
      await expect(page.getByText("Choose where Bakery takes issues from"))
        .toBeVisible();
      await page.getByRole("button", { name: "Choose repositories" }).first()
        .click();
      await expect(page.getByRole("dialog", { name: "Choose repositories" }))
        .toBeVisible();
    });

    test("with no GitHub connection the empty list says to connect it", async ({ page }) => {
      await fixture(page, {
        projects: { ...WORLD, offered: null },
      });
      await page.goto("/issues");
      await expect(page.getByText("Connect GitHub to see issues"))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Connect GitHub" }))
        .toBeVisible();
    });
  });
}
