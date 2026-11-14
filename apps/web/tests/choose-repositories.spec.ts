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
        if (setup.save === "conflict") {
          return route.fulfill({
            status: 409,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "https://bakery.example/problems/test",
              title: "Conflict",
              detail: "Conflict.",
              status: 409,
              code: "STATE_CONFLICT",
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

    /** Opens the sheet from the page's More menu (a wide screen puts it in the top bar). */
    const openSheet = async (page: Page) => {
      await page.goto("/issues");
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("dialog", { name: "More" }).getByRole("button", {
        name: "Choose repositories",
      }).click();
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
        await expect(sheet.getByRole("heading", { name })).toBeVisible();
      }
      // Archived repositories are not listed.
      await expect(sheet.getByRole("heading", { name: "acme/old" }))
        .toHaveCount(0);
      await expect(sheet.getByRole("switch", {
        name: "Take issues from this repository",
      })).toHaveCount(2);
      await expect(sheet.getByText(
        "Your GitHub connection does not offer this repository.",
      )).toBeVisible();
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

    test("Save starts taking issues from a repository with exactly its defaults", async ({ page }) => {
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
          preset: "fixed-coding",
        },
      });
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
      // Off.
      const again = await openSheet(page);
      await again.getByRole("switch", {
        name: "Take issues from this repository",
      }).nth(1).uncheck();
      await again.getByRole("button", { name: "Save" }).click();
      await expect.poll(() => seen.updates.length).toBe(2);
      expect(seen.updates[1]).toMatchObject({
        id: LEDGER_SOURCE.id,
        ifMatch: '"v4"',
        body: { enabled: false },
      });
    });

    test("a refused save says so, keeps the sheet and keeps the change", async ({ page }) => {
      await fixture(page, { save: "conflict" });
      const sheet = await openSheet(page);
      await sheet.getByRole("switch", {
        name: "Take issues from this repository",
      }).first().check();
      await sheet.getByRole("button", { name: "Save" }).click();
      await expect(sheet.getByText(
        "Someone else changed this just now. The latest is shown; make your change again.",
      )).toBeVisible();
      await expect(
        sheet.getByRole("switch", {
          name: "Take issues from this repository",
        }).first(),
      ).toBeChecked();
      await page.mouse.move(700, 700);
      await shot(page, "choose-repositories-refused", [], { windowOnly: true });
    });

    test("Escape closes the sheet and returns focus to the More button", async ({ page }) => {
      await fixture(page);
      await page.goto("/issues");
      const more = page.getByRole("button", { name: "More", exact: true });
      await more.click();
      await page.getByRole("dialog", { name: "More" }).getByRole("button", {
        name: "Choose repositories",
      }).click();
      await expect(page.getByRole("dialog", { name: "Choose repositories" }))
        .toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(more).toBeFocused();
    });

    test("a member does not see the menu", async ({ page }) => {
      await fixture(page, { role: "developer" });
      await page.goto("/issues");
      await expect(page.getByRole("heading", { name: "Issues", level: 1 }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "More", exact: true }))
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
